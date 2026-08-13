export interface GyakuhibuActualPoint {
  rightsDate: string;
  totalAmount: number;
  days: number;
  avgRate: number;
}

export function extractCsrfToken(html: string): string {
  const match = html.match(/<input[^>]*name="csrf_test_name"[^>]*value="([^"]+)"/);
  if (!match) {
    throw new Error('csrf_test_name not found in taisyaku.jp page HTML (page structure may have changed)');
  }
  return match[1];
}

// CSVは「申込日」列で対象権利日の行を探し、「品貸料率(品貸日数分/円)」列がハイフン(実際の
// 品薄が発生しなかった日)や空でなければ、その値と「品貸日数」列から実績を組み立てる。
// taisyaku.jpの品貸料率・最高料率は実データで検証済みの通り1株あたり・品貸日数分の金額
// なので、unitShares(単元株数)を掛けるだけでよい(1,000株換算は不要)。
export function parseTaisyakuCsv(csvText: string, rightsDate: string, unitShares: number): GyakuhibuActualPoint | undefined {
  const lines = csvText.trim().split('\n');
  const header = lines[0].split(',').map((h) => h.trim());
  const dateIdx = header.findIndex((h) => h.includes('申込日'));
  const rateIdx = header.findIndex((h) => h.includes('品貸料率'));
  // 「品貸料率(品貸日数分/円)」列名自体に「品貸日数」が部分文字列として含まれるため、
  // rateIdxと同じ列を誤って拾わないよう除外して探す。
  const daysIdx = header.findIndex((h, i) => i !== rateIdx && h.includes('品貸日数'));
  if (dateIdx === -1 || rateIdx === -1 || daysIdx === -1) {
    throw new Error('Unexpected taisyaku.jp CSV header shape (expected 申込日/品貸料率/品貸日数 columns)');
  }

  for (const line of lines.slice(1)) {
    const cols = line.split(',').map((c) => c.trim());
    if (cols[dateIdx] !== rightsDate) continue;

    const rateRaw = cols[rateIdx];
    if (!rateRaw || rateRaw === '-') return undefined; // その日は実際の品薄(逆日歩)が発生しなかった

    const perShareRate = Number(rateRaw);
    const days = Number(cols[daysIdx]);
    if (Number.isNaN(perShareRate) || Number.isNaN(days) || days <= 0) return undefined;

    return { rightsDate, totalAmount: perShareRate * unitShares, days, avgRate: perShareRate / days };
  }

  return undefined; // 対象の申込日がCSVに含まれていない
}

const TAISYAKU_BASE_URL = 'https://www.taisyaku.jp';

// "YYYY-MM-DD" → "YYYY / MM / DD"(taisyaku.jpのフォーム入力形式)
function toSlashDate(isoDate: string): string {
  return isoDate.replaceAll('-', ' / ');
}

function cookieHeaderFrom(setCookies: string[]): string {
  return setCookies.map((c) => c.split(';')[0]).join('; ');
}

// 銘柄詳細ページ(GET)→期間検索(POST)→CSV取得(GET)の3ステップ。
// taisyaku.jpはCSRFトークン+セッションCookie必須のため、無状態の1回のリクエストでは
// 取得できない(docs/superpowers/notes/2026-08-13-taisyaku-csv-format.md 参照)。
export async function fetchTaisyakuCsv(ticker: string, from: string, to: string): Promise<string> {
  const detailUrl = `${TAISYAKU_BASE_URL}/app/stock/detail/${ticker}-01`;
  const pageResponse = await fetch(detailUrl);
  if (!pageResponse.ok) {
    throw new Error(`taisyaku.jp error ${pageResponse.status} fetching ${detailUrl}`);
  }
  const cookie = cookieHeaderFrom(pageResponse.headers.getSetCookie());
  const csrfToken = extractCsrfToken(await pageResponse.text());

  const searchUrl = `${TAISYAKU_BASE_URL}/app/stock/detail/${ticker}/search`;
  const searchBody = new URLSearchParams({
    csrf_test_name: csrfToken,
    orgMgrCd: ticker,
    orgMgrMei: '',
    sort: '',
    page: '',
    fsort: '',
    fpage: '',
    mkYmdFrom: toSlashDate(from),
    mkYmdTo: toSlashDate(to),
    kjnYmdDays: '',
    trjoKbn: '01',
  });
  const searchResponse = await fetch(searchUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: searchBody.toString(),
  });
  if (!searchResponse.ok) {
    throw new Error(`taisyaku.jp error ${searchResponse.status} posting to ${searchUrl}`);
  }
  await searchResponse.text();

  const csvUrl = `${TAISYAKU_BASE_URL}/app/stock/detail/${ticker}/csv`;
  const csvResponse = await fetch(csvUrl, { headers: { Cookie: cookie } });
  if (!csvResponse.ok) {
    throw new Error(`taisyaku.jp error ${csvResponse.status} fetching ${csvUrl}`);
  }
  return csvResponse.text();
}
