// 逆日歩予測 精度検証(2026-09-28権利付き最終日)用実績取得Lambda。
// スナップショットLambda(lambda/gyakuhibu-forecast-validation/)とは完全に独立。
// 出力はTask 1(旧)で作成したObject Lock付きS3バケットへ、以下のキー配下に書く:
//   {prefix ?? ''}actuals/rightsDate={rightsDate}/fetchedAt={fetchedLabel}/
//     actuals.json        銘柄ごとの実績(全銘柄まとめて1ファイル)
//     inputs/{ticker}.csv taisyaku.jpから取得した生CSV(銘柄ごとに1ファイル)
//     manifest.json       run完了の合図として最後に書く
import { createHash } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { calcMaxRate, RIGHTS_DAY_RATE_MULTIPLIER } from '../shared/gyakuhibu-calc';
import { forecastStatus, type ForecastStatus } from '../shared/gyakuhibu-forecast';
import { loadSnapshotATargets, type FrozenTarget } from './target-tickers';
import { fetchTickerActualsInput, type ActualsInput } from './actuals-input';

const VALIDATION_BUCKET_NAME = process.env.VALIDATION_BUCKET_NAME!;
const GYAKUHIBU_ACTUAL_TABLE_NAME = process.env.GYAKUHIBU_ACTUAL_TABLE_NAME!;
// 実際に発火・完了済みのスナップショットAの固定キー(2026-09-28権利日専用の検証実行が
// 前提のため定数化する。Task 3(旧)完了時点でこの値は既に確定済みの過去の事実)。
const SNAPSHOT_A_KEY =
  process.env.SNAPSHOT_A_KEY ??
  'forecast-snapshots/rightsDate=2026-09-28/asof=2026-09-26T0000JST/run=run=1/forecast.json';
const BETWEEN_REQUESTS_DELAY_MS = Number(process.env.TAISYAKU_REQUEST_INTERVAL_MS ?? '1000');
// 実績照合時のavgRate許容誤差(浮動小数点の丸め対策)。
const AVG_RATE_TOLERANCE = 0.01;
const MULTIPLIER_TOLERANCE = 0.01;

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3Client = new S3Client({});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function finiteOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

async function putObject(key: string, body: string, contentType: string): Promise<void> {
  await s3Client.send(
    new PutObjectCommand({ Bucket: VALIDATION_BUCKET_NAME, Key: key, Body: body, ContentType: contentType }),
  );
}

// 既存JQuantsGyakuhibuActualの同一ticker・rightsDateの行を読み、avgRateを突き合わせる。
// 存在しない場合はundefinedを返す(まだ本番のgyakuhibu-history-batchが処理していない、
// または対象ticker自体が優待銘柄以外)。
async function crossCheckAgainstProductionTable(
  ticker: string,
  rightsDate: string,
  ourAvgRate: number | null,
): Promise<{ existingAvgRate: number; mismatch: boolean } | undefined> {
  const result = await ddbDocClient.send(
    new GetCommand({ TableName: GYAKUHIBU_ACTUAL_TABLE_NAME, Key: { ticker, rightsDate } }),
  );
  const item = result.Item as { avgRate?: number } | undefined;
  if (!item || typeof item.avgRate !== 'number') return undefined;
  const mismatch = ourAvgRate === null || Math.abs(item.avgRate - ourAvgRate) > AVG_RATE_TOLERANCE;
  return { existingAvgRate: item.avgRate, mismatch };
}

export const handler = async (event: {
  rightsDate: string;
  fetchedLabel: string;
  prefix?: string;
}): Promise<void> => {
  const startedAt = new Date().toISOString();
  const basePrefix = `${event.prefix ?? ''}actuals/rightsDate=${event.rightsDate}/fetchedAt=${event.fetchedLabel}/`;

  console.log(`gyakuhibu-forecast-actuals: starting fetchedLabel=${event.fetchedLabel} rightsDate=${event.rightsDate}`);

  const targets: FrozenTarget[] = await loadSnapshotATargets(s3Client, VALIDATION_BUCKET_NAME, SNAPSHOT_A_KEY);
  console.log(`gyakuhibu-forecast-actuals: loaded ${targets.length} frozen targets from Snapshot A`);

  const records: Record<string, unknown>[] = [];
  const csvByTicker = new Map<string, string>();
  const crossCheckMismatches: Array<{ ticker: string; ours: number | null; existing: number }> = [];
  let fetchOkCount = 0;
  let fetchErrorCount = 0;
  let noRowCount = 0;

  for (const target of targets) {
    let input: ActualsInput;
    try {
      input = await fetchTickerActualsInput(target.ticker, event.rightsDate);
    } catch (error) {
      console.error(`${target.ticker}: unexpected error from fetchTickerActualsInput`, error);
      input = {
        ticker: target.ticker,
        fetchStatus: 'fetch_error',
        lendingFeeTotal: null,
        days: null,
        maxRateActual: null,
        minRateActual: null,
        financingBalance: null,
        lendingBalance: null,
        bidRank: null,
        measures: [],
        rawCsv: null,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }

    if (input.fetchStatus === 'ok') fetchOkCount++;
    else if (input.fetchStatus === 'no_row') noRowCount++;
    else fetchErrorCount++;
    if (input.rawCsv !== null) csvByTicker.set(target.ticker, input.rawCsv);

    // fillRatioActual = lendingFeeTotal / maxRateActual(どちらも1株・品貸日数分なので約分される)。
    const fillRatioActual =
      input.maxRateActual === null || input.lendingFeeTotal === null
        ? null
        : input.maxRateActual === 0
          ? 0
          : input.lendingFeeTotal / input.maxRateActual;

    // multiplierActual = maxRateActual / (calcMaxRate(スナップショットAの終値, 単元株数) × days)。
    // Snapshot Aが凍結したclosePrice/unitShares/daysから、掛け算前の生の最高料率をここで
    // 再計算する(Snapshot A自身はmaxRatePerShare = 生の値×RIGHTS_DAY_RATE_MULTIPLIERを
    // 保存しているが、実績側は「実際に何倍だったか」を独立に検証する必要があるため、
    // 生の値を自前で再計算し直す)。
    const rawMaxRate =
      target.closePrice !== null ? calcMaxRate(target.closePrice, target.unitShares) : null;
    const expectedMaxRate = rawMaxRate !== null ? rawMaxRate * target.days : null;
    const multiplierActual =
      input.maxRateActual !== null && expectedMaxRate !== null && expectedMaxRate !== 0
        ? input.maxRateActual / expectedMaxRate
        : null;
    const specialMultiplier =
      multiplierActual !== null && Math.abs(multiplierActual - RIGHTS_DAY_RATE_MULTIPLIER) > MULTIPLIER_TOLERANCE;

    const costActual = input.lendingFeeTotal !== null ? input.lendingFeeTotal * target.requiredShares : null;
    const statusActual: ForecastStatus =
      target.value !== null && costActual !== null ? forecastStatus(target.value, costActual, costActual) : 'na';
    const excessGroup: 'excess' | 'no_excess' | null =
      input.financingBalance !== null && input.lendingBalance !== null
        ? input.lendingBalance > input.financingBalance
          ? 'excess'
          : 'no_excess'
        : null;

    const ourAvgRate =
      input.lendingFeeTotal !== null && input.days !== null && input.days > 0
        ? input.lendingFeeTotal / input.days
        : input.lendingFeeTotal === 0
          ? 0
          : null;
    const crossCheck = await crossCheckAgainstProductionTable(target.ticker, event.rightsDate, ourAvgRate);
    if (crossCheck?.mismatch) {
      crossCheckMismatches.push({ ticker: target.ticker, ours: ourAvgRate, existing: crossCheck.existingAvgRate });
    }

    records.push({
      ticker: target.ticker,
      fetchStatus: input.fetchStatus,
      lendingFeeTotal: finiteOrNull(input.lendingFeeTotal),
      days: input.days,
      maxRateActual: finiteOrNull(input.maxRateActual),
      minRateActual: finiteOrNull(input.minRateActual),
      financingBalance: input.financingBalance,
      lendingBalance: input.lendingBalance,
      bidRank: input.bidRank,
      measures: input.measures,
      fillRatioActual: finiteOrNull(fillRatioActual),
      multiplierActual: finiteOrNull(multiplierActual),
      specialMultiplier,
      costActual: finiteOrNull(costActual),
      statusActual,
      excessGroup,
      errorMessage: input.errorMessage ?? null,
      computedAt: new Date().toISOString(),
    });

    await sleep(BETWEEN_REQUESTS_DELAY_MS);
  }

  const actualsJson = JSON.stringify(
    { rightsDate: event.rightsDate, fetchedLabel: event.fetchedLabel, records },
    null,
    2,
  );
  await putObject(`${basePrefix}actuals.json`, actualsJson, 'application/json');

  const fileHashes: Record<string, string> = { 'actuals.json': sha256Hex(actualsJson) };
  for (const [ticker, csv] of csvByTicker) {
    const relativeKey = `inputs/${ticker}.csv`;
    try {
      await putObject(`${basePrefix}${relativeKey}`, csv, 'text/csv');
      fileHashes[relativeKey] = sha256Hex(csv);
    } catch (error) {
      console.error(`${ticker}: failed to write raw CSV to S3`, error);
    }
  }

  const completedAt = new Date().toISOString();
  const manifest = {
    startedAt,
    completedAt,
    gitCommit: process.env.GIT_COMMIT ?? 'unknown',
    rightsDate: event.rightsDate,
    fetchedLabel: event.fetchedLabel,
    snapshotAKey: SNAPSHOT_A_KEY,
    tickerCounts: {
      total: records.length,
      ok: fetchOkCount,
      noRow: noRowCount,
      fetchError: fetchErrorCount,
    },
    crossCheckMismatches,
    files: fileHashes,
  };
  await putObject(`${basePrefix}manifest.json`, JSON.stringify(manifest, null, 2), 'application/json');

  console.log(
    `gyakuhibu-forecast-actuals: completed fetchedLabel=${event.fetchedLabel} — ${records.length} tickers ` +
      `(${fetchOkCount} ok, ${noRowCount} no_row, ${fetchErrorCount} fetch_error, ${crossCheckMismatches.length} cross-check mismatches)`,
  );
};
