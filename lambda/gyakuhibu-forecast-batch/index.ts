// 逆日歩予測バッチ: 優待マスタ・逆日歩実績履歴を組み合わせ、
// lambda/shared/gyakuhibu-forecast.tsの純粋関数でJQuantsGyakuhibuForecastテーブルへ
// 銘柄ごとの予測(+全銘柄横断のプール曲線 `_POOL_`)を書き込む。
// 設計: docs/superpowers/specs/2026-09-05-gyakuhibu-forecast-design.md
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { buildPool, chooseScenario, forecast, toSample, type ForecastSample, type GyakuhibuActualRow } from '../shared/gyakuhibu-forecast';
import { nextRightsDate } from '../shared/trading-calendar';

const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
const GYAKUHIBU_ACTUAL_TABLE_NAME = process.env.GYAKUHIBU_ACTUAL_TABLE_NAME!;
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

interface MasterRow {
  ticker: string;
  value: number | null;
  unitShares: number;
  rightsMonths: number[];
  maxGyakuhibu: number | null;
}

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

  let written = 0;
  for (const row of master) {
    try {
      const nextDate = nextRightsDate(row.rightsMonths);
      if (!nextDate) {
        console.warn(`${row.ticker}: no upcoming rights date, skipping`);
        continue;
      }

      const tickerSamples = samplesByTicker.get(row.ticker) ?? [];
      // 過去実績ベース予測は東証信用残(スタンダードプラン依存)を使わない。実績が無い銘柄は
      // 'none'(対象外)になり、現在需給ベース予測(tse-forecast.ts)側が補う。
      const nextRightsMonth = Number(nextDate.slice(5, 7));
      const { scenario, excessRatio } = chooseScenario(tickerSamples, nextRightsMonth, null);

      // poolSamplesは「ビンで絞り込まない全件」を渡す契約(forecast内部で絞り込む)。
      const result = forecast({
        tickerSamples,
        poolSamples: allSamples,
        scenario,
        excessRatio,
        maxGyakuhibu: row.maxGyakuhibu,
        value: row.value,
      });

      await ddbDocClient.send(
        new PutCommand({
          TableName: GYAKUHIBU_FORECAST_TABLE_NAME,
          Item: { ticker: row.ticker, rightsDate: nextDate, ...result, excessRatio: finiteOrNull(result.excessRatio), computedAt },
        }),
      );
      written++;
    } catch (error) {
      console.error(`${row.ticker}: failed to compute/write forecast`, error);
    }
  }

  console.log(`gyakuhibu-forecast-batch: wrote ${written} of ${master.length} ticker forecasts`);
};
