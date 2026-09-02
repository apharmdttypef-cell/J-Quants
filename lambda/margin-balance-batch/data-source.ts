import { getApiKey, fetchWithRetry } from '../shared/jquants-batch-client';

const SECRET_ARN = process.env.SECRET_ARN!;
const API_BASE_URL = process.env.API_BASE_URL ?? 'https://api.jquants.com/v2';
// mkt-margin-int/mkt-margin-alertはStandardプラン専用のエンドポイントのため、
// Freeプラン向けの13秒デフォルトは不要。Standardプランの120req/分を想定した値。
const REQUEST_INTERVAL_MS = Number(process.env.REQUEST_INTERVAL_MS ?? '500');
const MAX_RETRIES = 5;

export interface MarginBalancePoint {
  date: string;
  financingBalance: number;
  lendingBalance: number;
  source: 'weekly' | 'daily-alert';
}

interface MarginIntRecord {
  Date: string;
  Code: string;
  LongStdVol: number;
  ShrtStdVol: number;
}

interface MarginIntResponse {
  data: MarginIntRecord[];
  pagination_key?: string;
}

interface MarginAlertRecord {
  AppDate: string;
  Code: string;
  LongStdOut: number;
  ShrtStdOut: number;
}

interface MarginAlertResponse {
  data: MarginAlertRecord[];
  pagination_key?: string;
}

async function fetchMarginIntPage(params: Record<string, string>, apiKey: string): Promise<MarginIntRecord[]> {
  const records: MarginIntRecord[] = [];
  let paginationKey: string | undefined;

  do {
    const search = new URLSearchParams(params);
    if (paginationKey) search.set('pagination_key', paginationKey);

    const response = await fetchWithRetry(
      `${API_BASE_URL}/markets/margin-interest?${search}`,
      apiKey,
      REQUEST_INTERVAL_MS,
      MAX_RETRIES,
    );
    const body = (await response.json()) as MarginIntResponse;
    records.push(...body.data);
    paginationKey = body.pagination_key;
  } while (paginationKey);

  return records;
}

async function fetchMarginAlertPage(params: Record<string, string>, apiKey: string): Promise<MarginAlertRecord[]> {
  const records: MarginAlertRecord[] = [];
  let paginationKey: string | undefined;

  do {
    const search = new URLSearchParams(params);
    if (paginationKey) search.set('pagination_key', paginationKey);

    const response = await fetchWithRetry(
      `${API_BASE_URL}/markets/margin-alert?${search}`,
      apiKey,
      REQUEST_INTERVAL_MS,
      MAX_RETRIES,
    );
    const body = (await response.json()) as MarginAlertResponse;
    records.push(...body.data);
    paginationKey = body.pagination_key;
  } while (paginationKey);

  return records;
}

// 信用取引週末残高(/markets/margin-interest)から制度信用分のみを取得する。逆日歩は
// 制度信用固有の仕組みのため、一般信用込みの合計(ShrtVol/LongVol)ではなく制度信用のみ
// (ShrtStdVol/LongStdVol)を使う。2026-09-28に日次配信へ仕様変更予定だが、株数系
// フィールド名は新旧で同じなので、この変更を跨いでもコード変更は不要な想定。
export async function fetchWeeklyBalances(ticker: string, from: string, to: string): Promise<MarginBalancePoint[]> {
  const apiKey = await getApiKey(SECRET_ARN);
  const records = await fetchMarginIntPage({ code: ticker, from, to }, apiKey);

  return records.map((record) => ({
    date: record.Date,
    financingBalance: record.LongStdVol,
    lendingBalance: record.ShrtStdVol,
    source: 'weekly' as const,
  }));
}

// 日々公表信用取引残高(/markets/margin-alert)。「日々公表銘柄」に指定された銘柄のみが
// 対象で、mkt-margin-intとは別のデータソース。対象外の銘柄・日付は空配列が返る
// (エラーにはならない)。dateパラメータは公表日ベースだが、レスポンスのAppDate(申込日、
// 残高が示す基準日)をMarginBalancePoint.dateとして使い、fetchWeeklyBalancesのDateと
// 意味を揃える。
export async function fetchDailyAlertBalances(tickers: string[], date: string): Promise<MarginBalancePoint[]> {
  const apiKey = await getApiKey(SECRET_ARN);
  const points: MarginBalancePoint[] = [];

  for (const ticker of tickers) {
    const records = await fetchMarginAlertPage({ code: ticker, date }, apiKey);
    for (const record of records) {
      points.push({
        date: record.AppDate,
        financingBalance: record.LongStdOut,
        lendingBalance: record.ShrtStdOut,
        source: 'daily-alert' as const,
      });
    }
  }

  return points;
}
