import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { getApiKey, getTargetTickers, fetchWithRetry, normalizeDate, formatDate } from '../shared/jquants-batch-client';

const TABLE_NAME = process.env.TABLE_NAME!;
const WATCHLIST_TABLE_NAME = process.env.WATCHLIST_TABLE_NAME!;
const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
const SECRET_ARN = process.env.SECRET_ARN!;
const API_BASE_URL = process.env.API_BASE_URL ?? 'https://api.jquants.com/v2';
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? '7');
// Freeプランは配信12週間遅延(=84日)。この境界を過ぎた日付を要求すると
// 「Your subscription covers the following dates: ...」400エラーになるため、
// "今日" を基準にせず配信済みの範囲まで遡る。日付境界のズレを避け+1日のバッファを持たせる。
const DELIVERY_DELAY_DAYS = Number(process.env.DELIVERY_DELAY_DAYS ?? String(12 * 7 + 1));
const REQUEST_INTERVAL_MS = Number(process.env.REQUEST_INTERVAL_MS ?? '13000');
const MAX_RETRIES = 5;

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

interface DailyBar {
  Code: string;
  Date: string;
  O: number | null;
  H: number | null;
  L: number | null;
  C: number | null;
  Vo: number | null;
}

interface DailyBarsResponse {
  data: DailyBar[];
  pagination_key?: string;
}

async function fetchDailyBars(ticker: string, apiKey: string, from: string, to: string): Promise<DailyBar[]> {
  const bars: DailyBar[] = [];
  let paginationKey: string | undefined;

  do {
    const params = new URLSearchParams({ code: ticker, from, to });
    if (paginationKey) params.set('pagination_key', paginationKey);

    const response = await fetchWithRetry(
      `${API_BASE_URL}/equities/bars/daily?${params}`,
      apiKey,
      REQUEST_INTERVAL_MS,
      MAX_RETRIES,
    );
    const body = (await response.json()) as DailyBarsResponse;
    bars.push(...body.data);
    paginationKey = body.pagination_key;
  } while (paginationKey);

  return bars;
}

async function upsertBars(ticker: string, bars: DailyBar[]): Promise<void> {
  const updatedAt = new Date().toISOString();

  for (const bar of bars) {
    await ddbDocClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          ticker,
          date: normalizeDate(bar.Date),
          open: bar.O,
          high: bar.H,
          low: bar.L,
          close: bar.C,
          volume: bar.Vo,
          updated_at: updatedAt,
        },
      }),
    );
  }
}

export const handler = async (): Promise<void> => {
  const tickers = await getTargetTickers(WATCHLIST_TABLE_NAME, YUTAI_MASTER_TABLE_NAME);
  if (tickers.length === 0) {
    console.warn('No target tickers (watchlist and yutai master are both empty); nothing to fetch');
    return;
  }

  const apiKey = await getApiKey(SECRET_ARN);
  const to = formatDate(new Date(Date.now() - DELIVERY_DELAY_DAYS * 24 * 60 * 60 * 1000));
  const from = formatDate(new Date(Date.now() - (DELIVERY_DELAY_DAYS + LOOKBACK_DAYS) * 24 * 60 * 60 * 1000));

  for (const ticker of tickers) {
    try {
      const bars = await fetchDailyBars(ticker, apiKey, from, to);
      await upsertBars(ticker, bars);
      console.log(`${ticker}: upserted ${bars.length} bars`);
    } catch (error) {
      console.error(`${ticker}: failed to fetch/upsert daily bars`, error);
    }
  }
};
