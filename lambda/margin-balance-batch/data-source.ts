import { fetchWithRetry, normalizeDate } from '../shared/jquants-batch-client';
import { splitCsvLine } from '../gyakuhibu-history-batch/taisyaku-client';

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
  source: 'weekly' | 'daily-alert' | 'taisyaku';
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
// (price-batchのDailyBarと同じ number | null の扱い)。保存時の`source: 'weekly'`は
// 「margin-interest由来」の意味で、日次配信化後もこの値のまま。
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
// fetchAllWeeklyBalancesForDateのDateと意味を揃える。直近14日の各日付で呼ばれる
// (index.tsのRECENT_WINDOW_DAYS)。
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

// taisyaku.jp(日証金)の全銘柄一括CSVのヘッダー(14列、全角括弧)。完全一致で検証する。
export const TAISYAKU_BALANCE_CSV_HEADER: readonly string[] = [
  '銘柄コード',
  '銘柄名',
  '市場区分',
  '貸借区分',
  '基準日',
  '制限措置等',
  '融資残高（株）',
  '貸株残高（株）',
  '差引残高（株）',
  '最高料率（円）',
  '最低料率（円）',
  '品貸料率（円）',
  '品貸料率（年率換算/％）',
  '応札ランク',
];

// CSVのヘッダーが想定と違う(仕様変更・エラーHTMLなど)場合に投げる。バッチを失敗させて気づけるようにする。
export class TaisyakuCsvFormatError extends Error {}

// カンマ除去後に整数表記のものだけ数値にする。'-'・空・非整数はnull(Number('')が0になる罠を避ける)。
function parseBalance(value: string): number | null {
  const normalized = value.replace(/,/g, '');
  return /^-?\d+$/.test(normalized) ? Number(normalized) : null;
}

// 全銘柄一括CSV(UTF-8にデコード済み)をMarginBalancePoint[]にする。
// CSVに申込日の列は無く、`基準日`は次の権利基準日なので使わない。行の日付は検索した`mkYmd`(dateで受ける)。
// 同じ銘柄に市場区分ごとの行(東証・名証など)があるので、東証だけを使う。
// 融資残高・貸株残高のどちらかが数値でない行は、0として保存せず捨てる。
export function parseTaisyakuBalanceCsv(csvText: string, date: string): MarginBalancePoint[] {
  if (csvText.trim() === '') return [];

  const lines = csvText.split(/\r?\n/);
  const header = splitCsvLine(lines[0]);
  if (
    header.length !== TAISYAKU_BALANCE_CSV_HEADER.length ||
    header.some((name, i) => name !== TAISYAKU_BALANCE_CSV_HEADER[i])
  ) {
    throw new TaisyakuCsvFormatError(
      `Unexpected taisyaku.jp CSV header: ${lines[0].slice(0, 200)}`,
    );
  }

  const codeIdx = TAISYAKU_BALANCE_CSV_HEADER.indexOf('銘柄コード');
  const marketIdx = TAISYAKU_BALANCE_CSV_HEADER.indexOf('市場区分');
  const financingIdx = TAISYAKU_BALANCE_CSV_HEADER.indexOf('融資残高（株）');
  const lendingIdx = TAISYAKU_BALANCE_CSV_HEADER.indexOf('貸株残高（株）');

  const points: MarginBalancePoint[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === '') continue;
    const cols = splitCsvLine(line);
    if (cols.length !== TAISYAKU_BALANCE_CSV_HEADER.length) {
      console.warn(`Skipping taisyaku.jp CSV row with ${cols.length} columns: ${line.slice(0, 100)}`);
      continue;
    }
    if (cols[marketIdx] !== '東証') continue;

    const financingBalance = parseBalance(cols[financingIdx]);
    const lendingBalance = parseBalance(cols[lendingIdx]);
    if (financingBalance === null || lendingBalance === null) continue;

    points.push({ code: cols[codeIdx], date, financingBalance, lendingBalance, source: 'taisyaku' });
  }
  return points;
}
