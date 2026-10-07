// 逆日歩予測バッチ: 優待マスタ・逆日歩実績履歴を組み合わせ、
// lambda/shared/gyakuhibu-forecast.tsの純粋関数でJQuantsGyakuhibuForecastテーブルへ
// 銘柄ごとの予測(+全銘柄横断のプール曲線 `_POOL_`)を書き込む。
// フラグ(TSE_MARGIN_FEATURES_ENABLED)有効時は、東証信用残ベースの現在需給予測(tse-forecast.ts)も同じ行のtseForecast属性と_POOL_TSE_行へ書く。
// 設計: docs/superpowers/specs/2026-09-05-gyakuhibu-forecast-design.md
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import {
  buildPool,
  chooseScenario,
  forecast,
  toSample,
  type ForecastResult,
  type ForecastSample,
  type GyakuhibuActualRow,
} from '../shared/gyakuhibu-forecast';
import { isGeneralMarginOnly } from '../shared/margin-name';
import { nextRightsDate } from '../shared/trading-calendar';
import { buildTsePools, buildTseSamples, computeTseForecast, scanMarginSnapshots, type TsePools } from './tse-forecast';

const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
const GYAKUHIBU_ACTUAL_TABLE_NAME = process.env.GYAKUHIBU_ACTUAL_TABLE_NAME!;
const MARGIN_BALANCE_TABLE_NAME = process.env.MARGIN_BALANCE_TABLE_NAME!;
const GYAKUHIBU_FORECAST_TABLE_NAME = process.env.GYAKUHIBU_FORECAST_TABLE_NAME!;

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// DynamoDBはInfinity/-Infinity/NaNを含む数値をmarshalできず、PutCommandが例外を投げて
// ハンドラ全体が失敗する。BIN_EDGESの融資超過/5以上ビンのlo/hiは数学的には
// -Infinity/Infinityであり(lambda/shared/gyakuhibu-forecast.tsの純粋関数側では正しい)、
// excessRatioも融資残高0の銘柄でInfinityになりうる。保存直前に必ずこのヘルパーを通し、
// 非有限値はnullに変換する。
function finiteOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

// スタンダードプラン依存の現在需給ベース予測を実行するか。テストで切り替えられるよう
// 呼び出しごとに環境変数を読む。
function tseMarginFeaturesEnabled(): boolean {
  return process.env.TSE_MARGIN_FEATURES_ENABLED === 'true';
}

function finitePools(pools: TsePools): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const [bucket, bins] of Object.entries(pools)) {
    out[bucket] = bins.map((bin) => ({ ...bin, lo: finiteOrNull(bin.lo), hi: finiteOrNull(bin.hi) }));
  }
  return out;
}

interface MasterRow {
  ticker: string;
  value: number | null;
  unitShares: number;
  rightsMonths: number[];
  maxGyakuhibu: number | null;
  // yutai-risk-precompute-batchが毎日J-Quantsから取り込む貸借区分。
  marginName: string | null;
}

// 制度信用で売れない銘柄の予測行。逆日歩が発生しえないので分布は出さない。
// 過去に貸借だった頃の実績があっても使わない(今はその条件でクロスできないため)。
const GENERAL_MARGIN_ONLY_RESULT: ForecastResult = {
  scenario: 'none',
  excessRatio: null,
  bin: null,
  pOccur: null,
  fillP50: null,
  fillP90: null,
  fillMean: null,
  forecastP50: null,
  forecastP90: null,
  forecastMean: null,
  expectedNet: null,
  forecastStatus: 'general-only',
  tickerSamples: 0,
  poolSamples: 0,
};

async function scanYutaiMaster(): Promise<MasterRow[]> {
  const rows: MasterRow[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await ddbDocClient.send(
      new ScanCommand({ TableName: YUTAI_MASTER_TABLE_NAME, ExclusiveStartKey: exclusiveStartKey }),
    );
    for (const item of result.Items ?? []) {
      if (typeof item.ticker === 'string' && typeof item.unitShares === 'number') {
        rows.push({
          ticker: item.ticker,
          value: typeof item.value === 'number' ? item.value : null,
          unitShares: item.unitShares,
          rightsMonths: Array.isArray(item.rightsMonths) ? item.rightsMonths : [],
          maxGyakuhibu: typeof item.maxGyakuhibu === 'number' ? item.maxGyakuhibu : null,
          marginName: typeof item.marginName === 'string' ? item.marginName : null,
        });
      }
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return rows;
}

// 全ticker横断で逆日歩実績履歴をスキャンする(scanYutaiMasterと同じdo-whileページング)。
async function scanGyakuhibuActual(): Promise<GyakuhibuActualRow[]> {
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

function groupByTicker(samples: ForecastSample[]): Map<string, ForecastSample[]> {
  const map = new Map<string, ForecastSample[]>();
  for (const sample of samples) {
    const list = map.get(sample.ticker);
    if (list) list.push(sample);
    else map.set(sample.ticker, [sample]);
  }
  return map;
}

export const handler = async (): Promise<void> => {
  const master = await scanYutaiMaster();
  const unitSharesByTicker = new Map(master.map((m) => [m.ticker, m.unitShares]));

  const actualRows = await scanGyakuhibuActual();
  const allSamples = actualRows
    .map((row) => toSample(row, unitSharesByTicker.get(row.ticker) ?? 100))
    .filter((s): s is ForecastSample => s !== null);

  const samplesByTicker = groupByTicker(allSamples);
  const pool = buildPool(allSamples);
  // 現在需給ベース予測(スタンダードプラン依存)。無効時は信用残テーブルに一切触れない。
  const tse = tseMarginFeaturesEnabled()
    ? await (async () => {
        const snapshots = await scanMarginSnapshots(ddbDocClient, MARGIN_BALANCE_TABLE_NAME);
        const bucketSamples = buildTseSamples(allSamples, snapshots);
        return { snapshots, bucketSamples, pools: buildTsePools(bucketSamples) };
      })()
    : null;
  const computedAt = new Date().toISOString().slice(0, 10);

  // プール行は銘柄ループより先に書く(プールが無いと全銘柄naになるため、失敗時はログで目立たせる)。
  await ddbDocClient.send(
    new PutCommand({
      TableName: GYAKUHIBU_FORECAST_TABLE_NAME,
      Item: {
        ticker: '_POOL_',
        bins: pool.map((bin) => ({ ...bin, lo: finiteOrNull(bin.lo), hi: finiteOrNull(bin.hi) })),
        computedAt,
      },
    }),
  );

  if (tse) {
    await ddbDocClient.send(
      new PutCommand({
        TableName: GYAKUHIBU_FORECAST_TABLE_NAME,
        Item: { ticker: '_POOL_TSE_', buckets: finitePools(tse.pools), computedAt },
      }),
    );
  }

  let written = 0;
  for (const row of master) {
    try {
      const nextDate = nextRightsDate(row.rightsMonths);
      if (!nextDate) {
        console.warn(`${row.ticker}: no upcoming rights date, skipping`);
        continue;
      }

      const generalMarginOnly = isGeneralMarginOnly(row.marginName);
      const tickerSamples = samplesByTicker.get(row.ticker) ?? [];
      // 過去実績ベース予測は東証信用残(スタンダードプラン依存)を使わない。実績が無い銘柄は
      // 'none'(対象外)になり、現在需給ベース予測(tse-forecast.ts)側が補う。
      const nextRightsMonth = Number(nextDate.slice(5, 7));
      const { scenario, excessRatio } = chooseScenario(tickerSamples, nextRightsMonth, null);

      // poolSamplesは「ビンで絞り込まない全件」を渡す契約(forecast内部で絞り込む)。
      const result = generalMarginOnly
        ? GENERAL_MARGIN_ONLY_RESULT
        : forecast({
            tickerSamples,
            poolSamples: allSamples,
            scenario,
            excessRatio,
            maxGyakuhibu: row.maxGyakuhibu,
            value: row.value,
          });

      const item: Record<string, unknown> = {
        ticker: row.ticker,
        rightsDate: nextDate,
        ...result,
        excessRatio: finiteOrNull(result.excessRatio),
        computedAt,
      };
      if (tse && generalMarginOnly) {
        item.tseForecast = null;
      } else if (tse) {
        const tseForecast = computeTseForecast({
          ticker: row.ticker,
          today: computedAt,
          nextRightsDate: nextDate,
          snapshots: tse.snapshots,
          bucketSamples: tse.bucketSamples,
          maxGyakuhibu: row.maxGyakuhibu,
          value: row.value,
        });
        item.tseForecast = tseForecast
          ? {
              ...tseForecast,
              excessRatio: finiteOrNull(tseForecast.excessRatio),
              lendingGrowth4w: finiteOrNull(tseForecast.lendingGrowth4w),
            }
          : null;
      }

      await ddbDocClient.send(new PutCommand({ TableName: GYAKUHIBU_FORECAST_TABLE_NAME, Item: item }));
      written++;
    } catch (error) {
      console.error(`${row.ticker}: failed to compute/write forecast`, error);
    }
  }

  console.log(`gyakuhibu-forecast-batch: wrote ${written} of ${master.length} ticker forecasts`);
};
