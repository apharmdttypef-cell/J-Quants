import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { getApiKey, getTargetTickers, fetchWithRetry, normalizeDate } from '../shared/jquants-batch-client';

const FINANCIAL_TABLE_NAME = process.env.FINANCIAL_TABLE_NAME!;
const WATCHLIST_TABLE_NAME = process.env.WATCHLIST_TABLE_NAME!;
const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
const SECRET_ARN = process.env.SECRET_ARN!;
const API_BASE_URL = process.env.API_BASE_URL ?? 'https://api.jquants.com/v2';
// Freeプランは5req/分。余裕を持たせて13秒間隔にする(60000ms / 5req = 12000ms が下限)。
// この値はprice-batchとfinancial-summary-batchで同じにしておくこと(1つのAPIキーのレート制限を両者で共有しているため)。
const REQUEST_INTERVAL_MS = Number(process.env.REQUEST_INTERVAL_MS ?? '13000');
const MAX_RETRIES = 5;

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

interface FinancialSummary {
  Code: string;
  DiscDate: string;
  DocType: string;
  CurPerType: string;
  Sales: string;
  OP: string;
  OdP: string;
  NP: string;
  EPS: string;
}

interface FinancialSummaryResponse {
  data: FinancialSummary[];
  pagination_key?: string;
}

// code のみ指定(from/to なし)。/fins/summary は日付範囲パラメータを持たず、
// Freeプランの配信遅延(直近12週間分は非公開)制約はAPI側で自動的にかかる。
async function fetchFinancialSummaries(ticker: string, apiKey: string): Promise<FinancialSummary[]> {
  const summaries: FinancialSummary[] = [];
  let paginationKey: string | undefined;

  do {
    const params = new URLSearchParams({ code: ticker });
    if (paginationKey) params.set('pagination_key', paginationKey);

    const response = await fetchWithRetry(`${API_BASE_URL}/fins/summary?${params}`, apiKey, REQUEST_INTERVAL_MS, MAX_RETRIES);
    const body = (await response.json()) as FinancialSummaryResponse;
    summaries.push(...body.data);
    paginationKey = body.pagination_key;
  } while (paginationKey);

  return summaries;
}

async function upsertFinancialSummaries(ticker: string, summaries: FinancialSummary[]): Promise<void> {
  const updatedAt = new Date().toISOString();

  for (const summary of summaries) {
    await ddbDocClient.send(
      new PutCommand({
        TableName: FINANCIAL_TABLE_NAME,
        Item: {
          ticker,
          discDate: normalizeDate(summary.DiscDate),
          docType: summary.DocType,
          curPerType: summary.CurPerType,
          // 桁数が大きく精度が必要なためAPIが返す文字列のまま保持する。
          sales: summary.Sales,
          operatingProfit: summary.OP,
          ordinaryProfit: summary.OdP,
          netProfit: summary.NP,
          eps: summary.EPS,
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

  for (const ticker of tickers) {
    try {
      const summaries = await fetchFinancialSummaries(ticker, apiKey);
      await upsertFinancialSummaries(ticker, summaries);
      console.log(`${ticker}: upserted ${summaries.length} financial summaries`);
    } catch (error) {
      console.error(`${ticker}: failed to fetch/upsert financial summaries`, error);
    }
  }
};
