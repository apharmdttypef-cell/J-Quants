import { fetchWithRetry, normalizeDate } from '../shared/jquants-batch-client';

const API_BASE_URL = process.env.API_BASE_URL ?? 'https://api.jquants.com/v2';
// mkt-margin-int/mkt-margin-alertはStandardプラン専用のエンドポイントのため、
// Freeプラン向けの13秒デフォルトは不要。Standardプランの120req/分を想定した値。
const REQUEST_INTERVAL_MS = Number(process.env.REQUEST_INTERVAL_MS ?? '500');
const MAX_RETRIES = 5;

export interface MarginBalancePoint {
  code: string;
  date: string;
  financingBalance: number | null;
  lendingBalance: number | null;
  source: 'weekly' | 'daily-alert';
}

interface MarginIntRecord {
  Date: string;
  Code: string;
  LongStdVol: number | null;
  ShrtStdVol: number | null;
}

interface MarginIntResponse {
  data?: MarginIntRecord[];
  pagination_key?: string;
}

interface MarginAlertRecord {
  AppDate: string;
  Code: string;
  LongStdOut: number | null;
  ShrtStdOut: number | null;
}

interface MarginAlertResponse {
  data?: MarginAlertRecord[];
  pagination_key?: string;
}

// 信用取引週末残高(/markets/margin-interest)。codeを付けずdateのみ指定すると、その日の
// 全上場銘柄分のデータが1回のリクエストで返る(price-batchのfetchAllBarsForDateと同じ
// パターン)。逆日歩は制度信用固有の仕組みのため、一般信用込みの合計(ShrtVol/LongVol)では
// なく制度信用のみ(ShrtStdVol/LongStdVol)を使う。2026-09-28に日次配信へ仕様変更予定だが、
// 株数系フィールド名は新旧で同じなので、この変更を跨いでもコード変更は不要な想定。
//
// 全上場銘柄が対象のため、個別銘柄向けの旧codeパラメータ呼び出しでは登場しなかった
// 値欠損レコードが混ざりうる。DynamoDBはundefinedを書き込めないため、欠損はnullにする
// (price-batchのDailyBarと同じ number | null の扱い)。
export async function fetchAllWeeklyBalancesForDate(date: string, apiKey: string): Promise<MarginBalancePoint[]> {
  const points: MarginBalancePoint[] = [];
  let paginationKey: string | undefined;

  do {
    const params = new URLSearchParams({ date });
    if (paginationKey) params.set('pagination_key', paginationKey);

    const response = await fetchWithRetry(
      `${API_BASE_URL}/markets/margin-interest?${params}`,
      apiKey,
      REQUEST_INTERVAL_MS,
      MAX_RETRIES,
    );
    const body = (await response.json()) as MarginIntResponse;
    for (const record of body.data ?? []) {
      points.push({
        code: record.Code,
        date: normalizeDate(record.Date),
        financingBalance: record.LongStdVol ?? null,
        lendingBalance: record.ShrtStdVol ?? null,
        source: 'weekly',
      });
    }
    paginationKey = body.pagination_key;
  } while (paginationKey);

  return points;
}

// 日々公表信用取引残高(/markets/margin-alert)。「日々公表銘柄」に指定された銘柄のみが
// 対象で、mkt-margin-intとは別の独立したデータソース。codeを付けずdateのみ指定すると、
// その日に公表された全銘柄分が1回のリクエストで返る。dateパラメータは公表日ベースだが、
// レスポンスのAppDate(申込日、残高が示す基準日)をMarginBalancePoint.dateとして使い、
// fetchAllWeeklyBalancesForDateのDateと意味を揃える。常にtodayの1日分のみ呼ばれる想定
// (履歴バックフィルはしない)。
export async function fetchAllDailyAlertBalancesForDate(date: string, apiKey: string): Promise<MarginBalancePoint[]> {
  const points: MarginBalancePoint[] = [];
  let paginationKey: string | undefined;

  do {
    const params = new URLSearchParams({ date });
    if (paginationKey) params.set('pagination_key', paginationKey);

    const response = await fetchWithRetry(
      `${API_BASE_URL}/markets/margin-alert?${params}`,
      apiKey,
      REQUEST_INTERVAL_MS,
      MAX_RETRIES,
    );
    const body = (await response.json()) as MarginAlertResponse;
    for (const record of body.data ?? []) {
      points.push({
        code: record.Code,
        date: normalizeDate(record.AppDate),
        financingBalance: record.LongStdOut ?? null,
        lendingBalance: record.ShrtStdOut ?? null,
        source: 'daily-alert',
      });
    }
    paginationKey = body.pagination_key;
  } while (paginationKey);

  return points;
}
