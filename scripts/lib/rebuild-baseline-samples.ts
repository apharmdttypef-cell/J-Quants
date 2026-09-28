// 評価スクリプト用: forecast()が内部で使った生のfillRatioサンプル配列を、
// スナップショット実行時と同じスキャン+変換ロジック(toSample)で復元する。
// lambda/gyakuhibu-forecast-validation/index.tsのscanUnitSharesByTicker/
// scanAllGyakuhibuActualと同等の処理(重複コード、意図的。Task 2(旧)のindex.tsと
// 同じ判断)。lambda/shared/gyakuhibu-forecast.tsは変更しない。
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { toSample, type ForecastSample, type GyakuhibuActualRow } from '../../lambda/shared/gyakuhibu-forecast';

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

async function scanUnitSharesByTicker(tableName: string): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await ddbDocClient.send(new ScanCommand({ TableName: tableName, ExclusiveStartKey: exclusiveStartKey }));
    for (const item of result.Items ?? []) {
      if (typeof item.ticker === 'string' && typeof item.unitShares === 'number') {
        map.set(item.ticker, item.unitShares);
      }
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return map;
}

async function scanAllGyakuhibuActual(tableName: string): Promise<GyakuhibuActualRow[]> {
  const rows: GyakuhibuActualRow[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await ddbDocClient.send(new ScanCommand({ TableName: tableName, ExclusiveStartKey: exclusiveStartKey }));
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

export interface BaselineSamples {
  allSamples: ForecastSample[];
  tickerSamplesByTicker: Map<string, ForecastSample[]>;
}

export async function rebuildBaselineSamples(
  yutaiMasterTableName: string,
  gyakuhibuActualTableName: string,
): Promise<BaselineSamples> {
  const [unitSharesByTicker, actualRows] = await Promise.all([
    scanUnitSharesByTicker(yutaiMasterTableName),
    scanAllGyakuhibuActual(gyakuhibuActualTableName),
  ]);

  const allSamples = actualRows
    .map((row) => toSample(row, unitSharesByTicker.get(row.ticker) ?? 100))
    .filter((s): s is ForecastSample => s !== null);

  const tickerSamplesByTicker = new Map<string, ForecastSample[]>();
  for (const s of allSamples) {
    const list = tickerSamplesByTicker.get(s.ticker) ?? [];
    list.push(s);
    tickerSamplesByTicker.set(s.ticker, list);
  }

  return { allSamples, tickerSamplesByTicker };
}
