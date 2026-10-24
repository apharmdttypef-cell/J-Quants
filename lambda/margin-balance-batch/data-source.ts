import { splitCsvLine, extractCsrfToken, toSlashDate, cookieHeaderFrom, TAISYAKU_BASE_URL, USER_AGENT } from '../gyakuhibu-history-batch/taisyaku-client';

// 信用残の取得元は日本証券金融(taisyaku.jp)の「貸借取引残高等」の全銘柄一括CSV。
// 申込日(mkYmd)を指定して検索すると、その日の全銘柄分の融資残高・貸株残高が1ファイルで取れる。
// 日証金の貸借取引残高であり、取引所公表の信用残(J-Quantsのmargin-interest等)とは異なる。
export interface MarginBalancePoint {
  code: string;
  date: string;
  financingBalance: number;
  lendingBalance: number;
  source: 'taisyaku';
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

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

// 基準日dateの全銘柄CSV(デコード済みテキスト)を取得する。検索結果が0件ならCSVを取らずnullを返す。
// 一覧ページ(GET)→検索(POST)→CSV(GET)の3ステップで、CSRFトークンとセッションCookieを使い回す。
// intervalMsは3リクエストの各間に空ける待ち時間。ヘッダーの検証はparseTaisyakuBalanceCsvに任せる。
export async function fetchTaisyakuBalanceCsv(date: string, intervalMs: number): Promise<string | null> {
  const pageUrl = `${TAISYAKU_BASE_URL}/app/stock`;
  const pageResponse = await fetch(pageUrl, { headers: { 'User-Agent': USER_AGENT } });
  if (!pageResponse.ok) {
    throw new Error(`taisyaku.jp error ${pageResponse.status} fetching ${pageUrl}`);
  }
  const cookie = cookieHeaderFrom(pageResponse.headers.getSetCookie());
  const csrfToken = extractCsrfToken(await pageResponse.text());
  await sleep(intervalMs);

  const searchUrl = `${TAISYAKU_BASE_URL}/app/stock/search`;
  const searchResponse = await fetch(searchUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie, 'User-Agent': USER_AGENT },
    body: new URLSearchParams({ csrf_test_name: csrfToken, mkYmd: toSlashDate(date) }).toString(),
  });
  if (!searchResponse.ok) {
    throw new Error(`taisyaku.jp error ${searchResponse.status} posting to ${searchUrl}`);
  }
  const searchHtml = await searchResponse.text();
  if (/検索結果(?:&nbsp;|\s)*0件/.test(searchHtml)) return null;
  await sleep(intervalMs);

  const csvUrl = `${TAISYAKU_BASE_URL}/app/stock/csv`;
  const csvResponse = await fetch(csvUrl, { headers: { Cookie: cookie, 'User-Agent': USER_AGENT } });
  if (!csvResponse.ok) {
    throw new Error(`taisyaku.jp error ${csvResponse.status} fetching ${csvUrl}`);
  }
  return new TextDecoder('shift_jis').decode(await csvResponse.arrayBuffer());
}
