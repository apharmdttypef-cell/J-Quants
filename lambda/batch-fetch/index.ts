import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const TABLE_NAME = process.env.TABLE_NAME!;
const SECRET_ARN = process.env.SECRET_ARN!;
const TICKERS = (process.env.TICKERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const API_BASE_URL = process.env.API_BASE_URL ?? 'https://api.jquants.com/v2';
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? '7');
// Freeプランは5req/分。余裕を持たせて13秒間隔にする(60000ms / 5req = 12000ms が下限)。
const REQUEST_INTERVAL_MS = Number(process.env.REQUEST_INTERVAL_MS ?? '13000');
const MAX_RETRIES = 5;

const secretsClient = new SecretsManagerClient({});
const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

let cachedApiKey: string | undefined;

async function getApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;
  const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: SECRET_ARN }));
  if (!result.SecretString) {
    throw new Error('J-Quants API key secret has no string value');
  }
  cachedApiKey = result.SecretString;
  return cachedApiKey;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

// APIのDateはドキュメント上 "20210907" / "2021-09-07" どちらの形式もあり得るため正規化する。
function normalizeDate(raw: string): string {
  if (raw.includes('-')) return raw;
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

async function fetchWithRetry(url: string, apiKey: string, attempt = 0): Promise<Response> {
  const response = await fetch(url, { headers: { 'x-api-key': apiKey } });

  if (response.status === 429 && attempt < MAX_RETRIES) {
    const backoffMs = REQUEST_INTERVAL_MS * 2 ** attempt;
    console.warn(`Rate limited, backing off ${backoffMs}ms (attempt ${attempt + 1})`);
    await sleep(backoffMs);
    return fetchWithRetry(url, apiKey, attempt + 1);
  }

  if (!response.ok) {
    throw new Error(`J-Quants API error ${response.status}: ${await response.text()}`);
  }

  return response;
}

async function fetchDailyBars(ticker: string, apiKey: string, from: string, to: string): Promise<DailyBar[]> {
  const bars: DailyBar[] = [];
  let paginationKey: string | undefined;

  do {
    const params = new URLSearchParams({ code: ticker, from, to });
    if (paginationKey) params.set('pagination_key', paginationKey);

    const response = await fetchWithRetry(`${API_BASE_URL}/equities/bars/daily?${params}`, apiKey);
    const body = (await response.json()) as DailyBarsResponse;
    bars.push(...body.data);
    paginationKey = body.pagination_key;

    if (paginationKey) {
      await sleep(REQUEST_INTERVAL_MS);
    }
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
  if (TICKERS.length === 0) {
    console.warn('TICKERS is empty; nothing to fetch');
    return;
  }

  const apiKey = await getApiKey();
  const to = formatDate(new Date());
  const from = formatDate(new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000));

  for (const [index, ticker] of TICKERS.entries()) {
    try {
      const bars = await fetchDailyBars(ticker, apiKey, from, to);
      await upsertBars(ticker, bars);
      console.log(`${ticker}: upserted ${bars.length} bars`);
    } catch (error) {
      console.error(`${ticker}: failed to fetch/upsert`, error);
    }

    if (index < TICKERS.length - 1) {
      await sleep(REQUEST_INTERVAL_MS);
    }
  }
};
