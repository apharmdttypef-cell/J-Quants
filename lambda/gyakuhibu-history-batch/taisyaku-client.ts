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
// tickerはログ用(省略可)。
// taisyaku.jpの実CSVは全フィールドがダブルクォートで囲まれている(例: "2026-08-26","18.00","3")。
// trim()だけではクォートが残り、Number()変換が常にNaNになって実績を取りこぼすため、
// 前後の1個ずつのダブルクォートを取り除く(フィールド内部のクォートはそのまま)。
function stripQuotes(field: string): string {
  const trimmed = field.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
}

export function parseTaisyakuCsv(
  csvText: string,
  rightsDate: string,
  unitShares: number,
  ticker?: string,
): GyakuhibuActualPoint | undefined {
  const lines = csvText.trim().split('\n');
  const header = lines[0].split(',').map(stripQuotes);
  const dateIdx = header.findIndex((h) => h.includes('申込日'));
  const rateIdx = header.findIndex((h) => h.includes('品貸料率'));
  // 「品貸料率(品貸日数分/円)」列名自体に「品貸日数」が部分文字列として含まれるため、
  // rateIdxと同じ列を誤って拾わないよう除外して探す。
  const daysIdx = header.findIndex((h, i) => i !== rateIdx && h.includes('品貸日数'));
  if (dateIdx === -1 || rateIdx === -1 || daysIdx === -1) {
    throw new Error('Unexpected taisyaku.jp CSV header shape (expected 申込日/品貸料率/品貸日数 columns)');
  }

  // CSV側の日付フォーマットは未確認("YYYY / MM / DD"の可能性が高いが、それ以外も
  // ありうる)。少なくとも内部形式("YYYY-MM-DD")とは異なるため、数字以外を除去した
  // 上で比較する(例: "2026-08-13" と "2026 / 08 / 13" はどちらも"20260813"になる)。
  const normalizedRightsDate = rightsDate.replace(/\D/g, '');

  for (const line of lines.slice(1)) {
    if (!line.trim()) continue; // 末尾の空行などをスキップ

    const cols = line.split(',').map(stripQuotes);
    // 融資残高・貸株残高等の株数列はカンマ区切りの桁区切り("1,234,567")で入っている
    // ことがあり、素朴なsplit(',')だと列がずれる。フルRFC4180パーサまでは実装せず、
    // 列数が壊れていないかだけ確認して、ずれていれば読み違えを防ぐためスキップする。
    if (cols.length !== header.length) {
      console.warn(
        `taisyaku.jp CSV row column count mismatch for ${ticker ?? '(unknown ticker)'} ${rightsDate} ` +
          `(expected ${header.length} columns, got ${cols.length}); skipping row: ${line}`,
      );
      continue;
    }

    if (cols[dateIdx].replace(/\D/g, '') !== normalizedRightsDate) continue;

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
// 一部サイトが素のundiciリクエストを弾くことがあるため、通常のブラウザらしいUser-Agentを付与する。
const USER_AGENT = 'Mozilla/5.0 (compatible; JQuantsYutaiBot/1.0)';

// ヘッダー行にこの文字列のどちらかが含まれていれば、そのエンコーディングでの
// デコードが正しかったとみなす(逆に言えば、含まれなければセッション切れの
// HTMLログインページ等が返ってきている可能性が高い)。
const CSV_HEADER_MARKERS = ['申込日', '品貸料率'];

function looksLikeExpectedCsvHeader(decodedText: string): boolean {
  const headerLine = decodedText.split('\n', 1)[0] ?? '';
  return CSV_HEADER_MARKERS.some((marker) => headerLine.includes(marker));
}

// 日本の金融系サイトはExcel互換のためShift_JISでCSVを配信することが多い一方、
// fetchのresponse.text()は常にUTF-8としてデコードしてしまう(Fetch仕様)。
// そのためarrayBuffer()で取得し、まずShift_JISでデコードを試み、ヘッダー行に
// 想定の列名が見つからなければUTF-8にフォールバックする。どちらでも見つからない
// 場合は、セッション切れ等の診断がCloudWatchログからできるようcontent-typeと
// 先頭200文字を警告ログに残す(docs/superpowers/notes/2026-08-13-taisyaku-csv-format.md
// の「まだ確認できていないこと」参照)。
function decodeCsvResponseBody(buffer: ArrayBuffer, contentType: string | null): string {
  const shiftJisText = new TextDecoder('shift_jis').decode(buffer);
  if (looksLikeExpectedCsvHeader(shiftJisText)) return shiftJisText;

  const utf8Text = new TextDecoder('utf-8').decode(buffer);
  if (looksLikeExpectedCsvHeader(utf8Text)) return utf8Text;

  console.warn(
    `taisyaku.jp CSV response did not contain an expected header marker (${CSV_HEADER_MARKERS.join('/')}) ` +
      `in either Shift_JIS or UTF-8 decoding. content-type: ${contentType ?? '(none)'}. ` +
      `First 200 chars (UTF-8 decode): ${utf8Text.slice(0, 200)}`,
  );
  return utf8Text;
}

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
  const pageResponse = await fetch(detailUrl, { headers: { 'User-Agent': USER_AGENT } });
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
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie, 'User-Agent': USER_AGENT },
    body: searchBody.toString(),
  });
  if (!searchResponse.ok) {
    throw new Error(`taisyaku.jp error ${searchResponse.status} posting to ${searchUrl}`);
  }
  await searchResponse.text();

  const csvUrl = `${TAISYAKU_BASE_URL}/app/stock/detail/${ticker}/csv`;
  const csvResponse = await fetch(csvUrl, { headers: { Cookie: cookie, 'User-Agent': USER_AGENT } });
  if (!csvResponse.ok) {
    throw new Error(`taisyaku.jp error ${csvResponse.status} fetching ${csvUrl}`);
  }
  const buffer = await csvResponse.arrayBuffer();
  return decodeCsvResponseBody(buffer, csvResponse.headers.get('content-type'));
}
