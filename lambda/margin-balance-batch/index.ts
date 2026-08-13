import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { fetchWeeklyBalances, fetchDailyAlertBalances, type MarginBalancePoint } from './data-source';

const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
const MARGIN_BALANCE_TABLE_NAME = process.env.MARGIN_BALANCE_TABLE_NAME!;
const BACKFILL_DAYS = Number(process.env.BACKFILL_DAYS ?? String(2 * 365));
const DIFF_LOOKBACK_DAYS = Number(process.env.DIFF_LOOKBACK_DAYS ?? '14');

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
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

// 銘柄に信用残データが1件も無ければバックフィル対象とみなす。
// 優待マスタへの新規追加はアプリ外で行われるため、このバッチが毎回自動検知する。
async function hasExistingBalance(ticker: string): Promise<boolean> {
  const result = await ddbDocClient.send(
    new QueryCommand({
      TableName: MARGIN_BALANCE_TABLE_NAME,
      KeyConditionExpression: 'ticker = :ticker',
      ExpressionAttributeValues: { ':ticker': ticker },
      Limit: 1,
    }),
  );
  return (result.Items ?? []).length > 0;
}

async function upsertPoints(ticker: string, points: MarginBalancePoint[]): Promise<void> {
  for (const point of points) {
    await ddbDocClient.send(
      new PutCommand({
        TableName: MARGIN_BALANCE_TABLE_NAME,
        Item: {
          ticker,
          date: point.date,
          financingBalance: point.financingBalance,
          lendingBalance: point.lendingBalance,
          source: point.source,
        },
      }),
    );
  }
}

export const handler = async (): Promise<void> => {
  const tickers = await getYutaiTickers();
  if (tickers.length === 0) {
    console.warn('Yutai master is empty; nothing to fetch');
    return;
  }

  const today = formatDate(new Date());

  for (const ticker of tickers) {
    try {
      const isBackfill = !(await hasExistingBalance(ticker));
      const lookbackDays = isBackfill ? BACKFILL_DAYS : DIFF_LOOKBACK_DAYS;
      const from = formatDate(new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000));

      const weekly = await fetchWeeklyBalances(ticker, from, today);
      await upsertPoints(ticker, weekly);

      const dailyAlert = await fetchDailyAlertBalances([ticker], today);
      await upsertPoints(ticker, dailyAlert);

      console.log(`${ticker}: upserted ${weekly.length} weekly + ${dailyAlert.length} daily-alert points (backfill=${isBackfill})`);
    } catch (error) {
      console.error(`${ticker}: failed to fetch/upsert margin balance`, error);
    }
  }
};
