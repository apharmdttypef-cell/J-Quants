import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchWriteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { getApiKey } from '../shared/jquants-batch-client';
import { fetchAllWeeklyBalancesForDate, fetchAllDailyAlertBalancesForDate, type MarginBalancePoint } from './data-source';

const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
const MARGIN_BALANCE_TABLE_NAME = process.env.MARGIN_BALANCE_TABLE_NAME!;
const SECRET_ARN = process.env.SECRET_ARN!;
// 週次データを何日分遡って取得するか。デフォルト2年分。price-batchのLOOKBACK_DAYSとは
// 無関係の別Lambda環境変数(このLambda専用)。
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? String(2 * 365));

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getYutaiTickers(): Promise<string[]> {
  const tickers: string[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await ddbDocClient.send(
      new ScanCommand({ TableName: YUTAI_MASTER_TABLE_NAME, ExclusiveStartKey: exclusiveStartKey }),
    );
    for (const item of result.Items ?? []) {
      if (typeof item.ticker === 'string') tickers.push(item.ticker);
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return tickers;
}

// 一括取得したレスポンスのcodeは5桁(例: '72030')。アプリ内のtickerは通常4桁(例: '7203')だが、
// 優先株式等を指定する5桁のticker(例: '72030')もありうる。そのため5桁の完全一致と4桁prefix
// の一致の両方をチェックする(price-batchのresolveTargetBarsと同じ変換)。同じ4桁prefixに
// 複数のcodeが存在する場合(普通株式・優先株式等)は5桁目が'0'(普通株式)のレコードを優先する。
function resolveTargetPoints(points: MarginBalancePoint[], targetTickers: Set<string>): Map<string, MarginBalancePoint> {
  const resolved = new Map<string, MarginBalancePoint>();

  for (const point of points) {
    const isCommonStock = point.code[4] === '0';

    if (targetTickers.has(point.code)) {
      resolved.set(point.code, point);
    }

    const prefix = point.code.slice(0, 4);
    if (targetTickers.has(prefix)) {
      const existing = resolved.get(prefix);
      if (!existing || isCommonStock) {
        resolved.set(prefix, point);
      }
    }
  }

  return resolved;
}

function toItems(matched: Map<string, MarginBalancePoint>): Record<string, unknown>[] {
  return [...matched.entries()].map(([ticker, point]) => ({
    ticker,
    date: point.date,
    financingBalance: point.financingBalance,
    lendingBalance: point.lendingBalance,
    source: point.source,
  }));
}

// DynamoDBのBatchWriteItemは25件までしか受け付け、スロットリング時はUnprocessedItemsに
// 未処理分を積んで200番台で返す(エラーにはならない)。ここでリトライしないと、書き込みが
// エラーなく黙って欠落する(信用残高テーブルの一括パージ作業で実際に踏んだ不具合と同じ)。
async function batchUpsert(tableName: string, items: Record<string, unknown>[]): Promise<void> {
  for (let i = 0; i < items.length; i += 25) {
    let pending: { PutRequest: { Item: Record<string, unknown> } }[] = items
      .slice(i, i + 25)
      .map((Item) => ({ PutRequest: { Item } }));
    let attempt = 0;

    while (pending.length > 0) {
      const result = await ddbDocClient.send(new BatchWriteCommand({ RequestItems: { [tableName]: pending } }));
      const unprocessed = (result.UnprocessedItems?.[tableName] ?? []) as typeof pending;
      if (unprocessed.length === 0) break;

      attempt += 1;
      if (attempt > 10) {
        throw new Error(`batchUpsert: too many retries, ${unprocessed.length} items still unprocessed`);
      }
      await sleep(Math.min(2000, 100 * 2 ** attempt));
      pending = unprocessed;
    }
  }
}

function listFridays(lookbackDays: number): string[] {
  const fridays: string[] = [];
  for (let offset = 0; offset <= lookbackDays; offset++) {
    const d = new Date(Date.now() - offset * 24 * 60 * 60 * 1000);
    if (d.getUTCDay() === 5) fridays.push(formatDate(d));
  }
  return fridays;
}

export const handler = async (): Promise<void> => {
  const tickers = await getYutaiTickers();
  if (tickers.length === 0) {
    console.warn('Yutai master is empty; nothing to fetch');
    return;
  }
  const targetTickers = new Set(tickers);

  const apiKey = await getApiKey(SECRET_ARN);
  const today = formatDate(new Date());
  const fridays = listFridays(LOOKBACK_DAYS);

  let weeklyUpserted = 0;
  for (const date of fridays) {
    try {
      const points = await fetchAllWeeklyBalancesForDate(date, apiKey);
      const matched = resolveTargetPoints(points, targetTickers);
      await batchUpsert(MARGIN_BALANCE_TABLE_NAME, toItems(matched));
      weeklyUpserted += matched.size;
      console.log(`${date}: matched ${matched.size} of ${targetTickers.size} target tickers (weekly)`);
    } catch (error) {
      console.error(`${date}: failed to fetch/upsert weekly margin balances`, error);
    }
  }

  let dailyAlertUpserted = 0;
  try {
    const alertPoints = await fetchAllDailyAlertBalancesForDate(today, apiKey);
    const matchedAlerts = resolveTargetPoints(alertPoints, targetTickers);
    await batchUpsert(MARGIN_BALANCE_TABLE_NAME, toItems(matchedAlerts));
    dailyAlertUpserted = matchedAlerts.size;
    console.log(`${today}: matched ${matchedAlerts.size} of ${targetTickers.size} target tickers (daily-alert)`);
  } catch (error) {
    console.error(`${today}: failed to fetch/upsert daily-alert margin balances`, error);
  }

  console.log(
    `margin-balance-batch: ${fridays.length} weekly dates processed, ${weeklyUpserted} weekly points upserted, ${dailyAlertUpserted} daily-alert points upserted (of ${targetTickers.size} target tickers)`,
  );
};
