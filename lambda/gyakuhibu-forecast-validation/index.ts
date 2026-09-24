// 逆日歩予測 精度検証(2026-09-28権利付き最終日)用スナップショットLambda。
// 本番の日次予測バッチ(lambda/gyakuhibu-forecast-batch/index.ts)とは完全に独立した
// 別系統のLambda。既存の純粋関数(lambda/shared/gyakuhibu-forecast.ts)・既存のtaisyaku.jp
// クライアント(lambda/gyakuhibu-history-batch/taisyaku-client.ts)をそのまま呼び出すが、
// どちらのファイルも変更しない。DynamoDBスキャン・グルーピングロジックは本番と同等の
// 処理になるが、本番パイプラインへの影響を避けるためあえて共有せずこのファイル専用に
// 実装する(重複コード、意図的な判断。詳細はtask-2-report.md参照)。
//
// 出力はTask 1で作成したObject Lock付きS3バケットへ、以下のキー配下に書く:
//   {prefix ?? ''}forecast-snapshots/rightsDate={rightsDate}/asof={asofLabel}/run={runId}/
//     forecast.json       銘柄ごとの予測(全銘柄まとめて1ファイル)
//     inputs/{ticker}.csv taisyaku.jpから取得した生CSV(銘柄ごとに1ファイル)
//     manifest.json       run完了の合図として最後に書く(sha256・件数内訳等を含む)
//
// 設計: .superpowers/sdd/2026-09-24-gyakuhibu-forecast-validation-plan/task-2-brief.md
import { createHash } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  toSample,
  chooseScenario,
  forecast,
  excessRatio,
  SHRINKAGE_K,
  BIN_EDGES,
  type ForecastSample,
  type GyakuhibuActualRow,
} from '../shared/gyakuhibu-forecast';
import { calcMaxRate, RIGHTS_DAY_RATE_MULTIPLIER } from '../shared/gyakuhibu-calc';
import { resolveTargetTickers } from './target-tickers';
import { fetchTickerSnapshotInput, type TickerSnapshotInput } from './snapshot-input';

const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
const GYAKUHIBU_ACTUAL_TABLE_NAME = process.env.GYAKUHIBU_ACTUAL_TABLE_NAME!;
const STOCK_PRICES_TABLE_NAME = process.env.STOCK_PRICES_TABLE_NAME!;
const VALIDATION_BUCKET_NAME = process.env.VALIDATION_BUCKET_NAME!;
// 権利付き最終日(event.rightsDate)申込分の貸借値段は、その直前の営業日の終値
// (設計書「前提となる事実」: 「9/28申込分の貸借値段は9/25終値」)。taisyaku.jpはまだ
// event.rightsDate分のデータを持たない(未来の権利日のため)ので、J-Quantsの株価
// テーブルから直接取得する。品貸日数は同じ設計書の前提により2026-09-28権利日固定で
// 1日(受渡9/30→翌営業日10/1)。このLambdaは2026-09-28権利日専用の検証実行が前提のため、
// 取引カレンダーAPIを呼ぶ一般的な計算はせず既知の値を定数化する。
const RIGHTS_DAY_DAYS = 1;
// taisyaku.jpへの連続リクエストの間隔。gyakuhibu-history-batch/index.tsの
// BETWEEN_REQUESTS_DELAY_MSと同じ考え方・同じデフォルト値(1000ms)を踏襲する
// (Task 0の実測: 303銘柄で約6.1分、Lambdaの15分制限に十分な余裕あり)。
const BETWEEN_REQUESTS_DELAY_MS = Number(process.env.TAISYAKU_REQUEST_INTERVAL_MS ?? '1000');
// 対象月(9月)固定。イベントのrightsDateから導出してもよいが、このLambdaは
// 2026-09-28権利日専用の検証実行が前提のため定数化する(Task 3から渡されるevent.rightsDate
// の月と一致することをhandler内で検証し、食い違えばログで警告する)。
const TARGET_RIGHTS_MONTH = 9;

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3Client = new S3Client({});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// DynamoDBはInfinity/-Infinity/NaNをmarshalできないが、JSON.stringifyはこれらを暗黙にnullへ
// 変換してしまう(明示的でなく分かりにくい)。本番のgyakuhibu-forecast-batch/index.tsと同じ
// finiteOrNullヘルパーをこちらにも複製し、S3へ書くJSON上でも意図を明確にする。
function finiteOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

// 本番gyakuhibu-forecast-batch/index.tsのscanYutaiMasterと同等の処理(重複コード、意図的)。
// toSampleの第2引数unitSharesは現状使われない(gyakuhibu-forecast.tsのコメント参照: 「両方とも
// 1株あたりの値同士の比なので単元株数は約分されて消える」)が、本番と全く同じ入力の作り方を
// 踏襲することで将来の挙動変更にも自然に追従できるようにする。
async function scanUnitSharesByTicker(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await ddbDocClient.send(
      new ScanCommand({ TableName: YUTAI_MASTER_TABLE_NAME, ExclusiveStartKey: exclusiveStartKey }),
    );
    for (const item of result.Items ?? []) {
      if (typeof item.ticker === 'string' && typeof item.unitShares === 'number') {
        map.set(item.ticker, item.unitShares);
      }
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return map;
}

// 本番gyakuhibu-forecast-batch/index.tsのscanGyakuhibuActualと同等の処理(重複コード、意図的)。
async function scanAllGyakuhibuActual(): Promise<GyakuhibuActualRow[]> {
  const rows: GyakuhibuActualRow[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await ddbDocClient.send(
      new ScanCommand({ TableName: GYAKUHIBU_ACTUAL_TABLE_NAME, ExclusiveStartKey: exclusiveStartKey }),
    );
    for (const item of result.Items ?? []) {
      if (typeof item.ticker === 'string' && typeof item.rightsDate === 'string') {
        rows.push({
          ticker: item.ticker,
          rightsDate: item.rightsDate,
          financingBalance: typeof item.financingBalance === 'number' ? item.financingBalance : 0,
          lendingBalance: typeof item.lendingBalance === 'number' ? item.lendingBalance : 0,
          avgRate: typeof item.avgRate === 'number' ? item.avgRate : 0,
          days: typeof item.days === 'number' ? item.days : 0,
          maxRateActual: typeof item.maxRateActual === 'number' ? item.maxRateActual : null,
          restriction: typeof item.restriction === 'string' ? item.restriction : null,
          emergencyMeasure: typeof item.emergencyMeasure === 'string' ? item.emergencyMeasure : null,
          enriched: item.enriched === true,
          noGyakuhibu: item.noGyakuhibu === true ? true : undefined,
        });
      }
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return rows;
}

// 本番gyakuhibu-forecast-batch/index.tsのgroupByTickerと同等の処理(重複コード、意図的)。
function groupByTicker(samples: ForecastSample[]): Map<string, ForecastSample[]> {
  const map = new Map<string, ForecastSample[]>();
  for (const sample of samples) {
    const list = map.get(sample.ticker);
    if (list) list.push(sample);
    else map.set(sample.ticker, [sample]);
  }
  return map;
}

// rightsDateより前の直近営業日の終値を、JQuantsStockPrices(ticker+dateの複合キー)から
// 直接取得する。yutai-risk-precompute-batch/index.tsのlatestClose(常に「最新」を取る)とは
// 意図的に違い、「rightsDateより前」に限定したクエリにすることで、この検証が求める
// 「9/25終値」を将来の日付の終値と混同しないようにする。
async function fetchPricedClose(ticker: string, beforeDate: string): Promise<{ closePrice: number; pricedAt: string } | undefined> {
  const result = await ddbDocClient.send(
    new QueryCommand({
      TableName: STOCK_PRICES_TABLE_NAME,
      KeyConditionExpression: 'ticker = :ticker AND #date < :beforeDate',
      ExpressionAttributeNames: { '#date': 'date' },
      ExpressionAttributeValues: { ':ticker': ticker, ':beforeDate': beforeDate },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );
  const item = result.Items?.[0];
  if (!item || typeof item.close !== 'number' || typeof item.date !== 'string') return undefined;
  return { closePrice: item.close, pricedAt: item.date };
}

async function putObject(key: string, body: string, contentType: string): Promise<void> {
  await s3Client.send(
    new PutObjectCommand({ Bucket: VALIDATION_BUCKET_NAME, Key: key, Body: body, ContentType: contentType }),
  );
}

export const handler = async (event: {
  rightsDate: string;
  asofLabel: string;
  runId: string;
  prefix?: string;
  variant: 'final' | 'prelim';
  asofDate: string;
}): Promise<void> => {
  const startedAt = new Date().toISOString();
  const basePrefix = `${event.prefix ?? ''}forecast-snapshots/rightsDate=${event.rightsDate}/asof=${event.asofLabel}/run=${event.runId}/`;

  const nextRightsMonth = Number(event.rightsDate.slice(5, 7));
  if (nextRightsMonth !== TARGET_RIGHTS_MONTH) {
    console.warn(
      `gyakuhibu-forecast-validation: event.rightsDate=${event.rightsDate} (month=${nextRightsMonth}) does not match ` +
        `the expected target month ${TARGET_RIGHTS_MONTH}; proceeding anyway using the rightsDate's own month for ` +
        `target-ticker resolution and scenario selection.`,
    );
  }

  console.log(
    `gyakuhibu-forecast-validation: starting run=${event.runId} asofLabel=${event.asofLabel} variant=${event.variant} asofDate=${event.asofDate}`,
  );

  const [targetTickers, unitSharesByTicker, actualRows] = await Promise.all([
    resolveTargetTickers(nextRightsMonth),
    scanUnitSharesByTicker(),
    scanAllGyakuhibuActual(),
  ]);
  console.log(`gyakuhibu-forecast-validation: resolved ${targetTickers.length} target tickers for rights month ${nextRightsMonth}`);

  const allSamples = actualRows
    .map((row) => toSample(row, unitSharesByTicker.get(row.ticker) ?? 100))
    .filter((s): s is ForecastSample => s !== null);
  const samplesByTicker = groupByTicker(allSamples);

  const records: Record<string, unknown>[] = [];
  const csvByTicker = new Map<string, string>();
  let fetchOkCount = 0;
  let fetchErrorCount = 0;

  for (const target of targetTickers) {
    let input: TickerSnapshotInput;
    try {
      input = await fetchTickerSnapshotInput(target.ticker, event.asofDate, target.unitShares, event.variant);
    } catch (error) {
      // fetchTickerSnapshotInput自体は例外を投げずfetch_errorを返す設計だが、想定外の
      // バグ等でループ全体を止めないための最終防御(古いデータへのフォールバックはしない)。
      console.error(`${target.ticker}: unexpected error from fetchTickerSnapshotInput`, error);
      input = {
        ticker: target.ticker,
        variant: event.variant,
        dataStatus: 'fetch_error',
        financingBalance: null,
        lendingBalance: null,
        fetchStatus: 'fetch_error',
        rawCsv: null,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }

    if (input.fetchStatus === 'ok') fetchOkCount++;
    else fetchErrorCount++;
    if (input.rawCsv !== null) csvByTicker.set(target.ticker, input.rawCsv);

    const observedExcessRatio =
      input.financingBalance !== null && input.lendingBalance !== null
        ? excessRatio(input.financingBalance, input.lendingBalance)
        : null;

    // event.rightsDate(9/28)申込分の最高料率は、JQuantsYutaiMasterの事前計算済みmaxGyakuhibu
    // (yutai-risk-precompute-batchが「直近の」終値でいつ計算したか不明で、必ずしも9/25終値とは
    // 限らない)には頼らず、このLambda自身が9/25終値を直接取得して独立に算出する(設計書
    // Task 2「9/25終値を取得する」/前提事実「最高料率は9/25終値で確定計算できる」)。
    const priced = await fetchPricedClose(target.ticker, event.rightsDate);
    const maxRatePerShare = priced
      ? finiteOrNull(calcMaxRate(priced.closePrice, target.unitShares) * RIGHTS_DAY_RATE_MULTIPLIER)
      : null;
    const computedMaxGyakuhibu = maxRatePerShare !== null ? maxRatePerShare * target.unitShares * RIGHTS_DAY_DAYS : null;

    const tickerSamples = samplesByTicker.get(target.ticker) ?? [];
    // current-tseフォールバックは使わない(2026-09-09の設計変更に合わせる。task-2-brief.md Step 3.4)。
    const { scenario, excessRatio: scenarioExcessRatio } = chooseScenario(tickerSamples, nextRightsMonth, null);
    const result = forecast({
      tickerSamples,
      poolSamples: allSamples,
      scenario,
      excessRatio: scenarioExcessRatio,
      maxGyakuhibu: computedMaxGyakuhibu,
      value: target.value,
    });

    records.push({
      ticker: target.ticker,
      companyName: target.companyName,
      rightsDate: event.rightsDate,
      value: target.value,
      unitShares: target.unitShares,
      // 優待の必要株数とunitSharesが食い違う既知のケースがあるが、この検証では単純化して
      // unitSharesで統一する(task-2-brief.md Step 3.5、task-2-report.mdに前提として明記)。
      requiredShares: target.unitShares,
      // closePrice/pricedAt/maxRatePerShare/daysは設計書のforecast.jsonスキーマが要求する
      // 監査用フィールド: どの終値・どの最高料率を基準に予測したかを凍結後も追跡できるようにする
      // (下のforecast.maxGyakuhibuはこのmaxRatePerShareから算出した値で、YutaiMasterの
      // 事前計算値とは意図的に別物)。
      closePrice: priced?.closePrice ?? null,
      pricedAt: priced?.pricedAt ?? null,
      maxRatePerShare,
      days: RIGHTS_DAY_DAYS,
      asofDate: event.asofDate,
      variant: input.variant,
      dataStatus: input.dataStatus,
      fetchStatus: input.fetchStatus,
      financingBalance: input.financingBalance,
      lendingBalance: input.lendingBalance,
      // taisyaku.jpから直接観測した基準日時点の超過率(参考値)。forecast.excessRatioは
      // 過去権利日実績ベースのシナリオ由来の値で、こちらとは別物(下記forecastオブジェクト参照)。
      observedExcessRatio: finiteOrNull(observedExcessRatio),
      errorMessage: input.errorMessage ?? null,
      forecast: {
        scenario: result.scenario,
        excessRatio: finiteOrNull(result.excessRatio),
        maxGyakuhibu: finiteOrNull(computedMaxGyakuhibu),
        bin: result.bin,
        pOccur: result.pOccur,
        fillP50: result.fillP50,
        fillP90: result.fillP90,
        fillMean: result.fillMean,
        forecastP50: result.forecastP50,
        forecastP90: result.forecastP90,
        forecastMean: result.forecastMean,
        expectedNet: result.expectedNet,
        forecastStatus: result.forecastStatus,
        tickerSamples: result.tickerSamples,
        poolSamples: result.poolSamples,
        // 設計書のforecast.jsonスキーマが要求するshrinkageWeight。forecast()自身は縮小推定の
        // 重みwをローカル変数のまま返さないため、ForecastResultが返すtickerSamples/poolSamples
        // (=forecast()内部のnT/nPそのもの)を使って同じ式(gyakuhibu-forecast.ts内のw計算)を
        // ここで再現する。forecast()を変更せずに済ませるための意図的な重複(1行の式のみ)。
        // 両方0(na、tickerSamples===poolSamples===0)のときはforecast()内部でもwを一切計算
        // せず早期returnするため、ここでも意味のある値を作らずnullにする。
        shrinkageWeight:
          result.tickerSamples === 0 && result.poolSamples === 0
            ? null
            : result.poolSamples === 0
              ? 1
              : result.tickerSamples === 0
                ? 0
                : result.tickerSamples / (result.tickerSamples + SHRINKAGE_K),
      },
      computedAt: new Date().toISOString(),
    });

    await sleep(BETWEEN_REQUESTS_DELAY_MS);
  }

  const forecastJson = JSON.stringify(
    {
      rightsDate: event.rightsDate,
      asofLabel: event.asofLabel,
      runId: event.runId,
      variant: event.variant,
      asofDate: event.asofDate,
      records,
    },
    null,
    2,
  );
  await putObject(`${basePrefix}forecast.json`, forecastJson, 'application/json');

  const fileHashes: Record<string, string> = { 'forecast.json': sha256Hex(forecastJson) };

  for (const [ticker, csv] of csvByTicker) {
    const relativeKey = `inputs/${ticker}.csv`;
    try {
      await putObject(`${basePrefix}${relativeKey}`, csv, 'text/csv');
      fileHashes[relativeKey] = sha256Hex(csv);
    } catch (error) {
      // 個別銘柄の生CSV書き込み失敗はrun全体を止めない(forecast.json自体は既に書けている)。
      console.error(`${ticker}: failed to write raw CSV to S3`, error);
    }
  }

  const dataStatusCounts: Record<string, number> = {};
  const fetchStatusCounts: Record<string, number> = {};
  const forecastStatusCounts: Record<string, number> = {};
  for (const record of records) {
    const r = record as { dataStatus: string; fetchStatus: string; forecast: { forecastStatus: string } };
    dataStatusCounts[r.dataStatus] = (dataStatusCounts[r.dataStatus] ?? 0) + 1;
    fetchStatusCounts[r.fetchStatus] = (fetchStatusCounts[r.fetchStatus] ?? 0) + 1;
    forecastStatusCounts[r.forecast.forecastStatus] = (forecastStatusCounts[r.forecast.forecastStatus] ?? 0) + 1;
  }

  const completedAt = new Date().toISOString();
  const manifest = {
    startedAt,
    completedAt,
    gitCommit: process.env.GIT_COMMIT ?? 'unknown',
    rightsDate: event.rightsDate,
    asofLabel: event.asofLabel,
    runId: event.runId,
    variant: event.variant,
    asofDate: event.asofDate,
    // 評価は確報(final)を主系列として扱う想定の固定値(task-2-brief.md Step 3.8)。
    // このrun自体がprelimであっても、後日final runと突き合わせる際の目印として常に'final'を書く。
    primaryVariant: 'final',
    modelParams: {
      shrinkageK: SHRINKAGE_K,
      binEdges: BIN_EDGES.map((edge) => ({ label: edge.label, lo: finiteOrNull(edge.lo), hi: finiteOrNull(edge.hi) })),
    },
    tickerCounts: {
      total: records.length,
      byDataStatus: dataStatusCounts,
      byFetchStatus: fetchStatusCounts,
      byForecastStatus: forecastStatusCounts,
    },
    files: fileHashes,
  };

  // manifest.jsonを最後に書くことを「run完了」の合図とする(部分書き込み中に見えないようにする)。
  await putObject(`${basePrefix}manifest.json`, JSON.stringify(manifest, null, 2), 'application/json');

  console.log(
    `gyakuhibu-forecast-validation: completed run=${event.runId} — ${records.length} tickers ` +
      `(${fetchOkCount} fetch ok, ${fetchErrorCount} fetch error)`,
  );
};
