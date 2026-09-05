export interface GyakuhibuActualPoint {
  rightsDate: string;
  occurred: boolean;
  totalAmount: number;
  days: number;
  avgRate: number;
  financingBalance: number;
  lendingBalance: number;
  lendingPrice: number | null;
  maxRateActual: number | null;
  bidRank: string | null;
  restriction: string | null;
  emergencyMeasure: string | null;
}

export function extractCsrfToken(html: string): string {
  const match = html.match(/<input[^>]*name="csrf_test_name"[^>]*value="([^"]+)"/);
  if (!match) {
    throw new Error('csrf_test_name not found in taisyaku.jp page HTML (page structure may have changed)');
  }
  return match[1];
}

// taisyaku.jpの実CSVは全フィールドがダブルクォートで囲まれている(例: "2026-08-26","18.00","3")。
// trim()だけではクォートが残り、Number()変換が常にNaNになって実績を取りこぼすため、
// 前後の1個ずつのダブルクォートを取り除く(フィールド内部のクォートはそのまま)。
function stripQuotes(field: string): string {
  const trimmed = field.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
}

// クォート内カンマを区切りにしない簡易CSVパーサ。1文字ずつ走査し、`"`でinQuoteをトグルし、
// inQuote外の`,`でのみフィールドを分割する。実機データ(3ヶ月・63行)では桁区切りカンマ
// ("1,234,567")を一度も観測できなかったが、将来カンマ区切りの列が来ても壊れないための
// 防御的な実装。各フィールドは最終的にstripQuotesで前後のダブルクォートを取り除く。
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuote = false;

  for (const ch of line) {
    if (ch === '"') {
      inQuote = !inQuote;
      current += ch;
    } else if (ch === ',' && !inQuote) {
      fields.push(stripQuotes(current));
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(stripQuotes(current));

  return fields;
}

// カンマ区切り("1,234,567")にも対応した数値変換ヘルパー。
// Number('')は0になってしまうJSの罠があるため、空文字列は先にnullとして弾く。
// それ以外はNumber()に通し、結果がNaNならnullを返す('-'・'*****'等の非数値マーカーは
// いずれもNumber()でNaNになるため、ここでnullに丸められる)。
function toNumber(field: string): number | null {
  const normalized = field.trim().replace(/,/g, '');
  if (normalized === '') return null;
  const value = Number(normalized);
  return Number.isNaN(value) ? null : value;
}

// 文字列フィールド用ヘルパー: 空文字列または'-'ならnull、それ以外はそのまま返す。
// 「応札ランク」の未実施は'-'、「制限措置」等の無しは空文字列と実機で表記が異なるため、
// 両方をnullに丸める共通ヘルパーとして使う。
function blankToNull(field: string): string | null {
  const trimmed = field.trim();
  return trimmed === '' || trimmed === '-' ? null : trimmed;
}

// CSVは「申込日」列で対象権利日の行を探し、「品貸料率(品貸日数分/円)」列が数値としてparse
// できるかどうかでその日に実際の品薄(逆日歩)が発生したか(occurred)を判定する。'-'かどうかの
// 直接比較はしない。実機で'*****'という別の非数値マーカーも観測されているため、NaN判定に
// 一本化して未知のマーカーにも耐えるようにしている(docs/superpowers/notes/2026-09-05-taisyaku-csv-balance-columns.md
// 参照)。taisyaku.jpの品貸料率・最高料率は実データで検証済みの通り1株あたり・品貸日数分の
// 金額なので、unitShares(単元株数)を掛けるだけでよい(1,000株換算は不要)。
// tickerはログ用(省略可)。
export function parseTaisyakuCsv(
  csvText: string,
  rightsDate: string,
  unitShares: number,
  ticker?: string,
): GyakuhibuActualPoint | undefined {
  const lines = csvText.trim().split('\n');
  const header = splitCsvLine(lines[0]);

  const dateIdx = header.findIndex((h) => h.includes('申込日'));
  const rateIdx = header.findIndex((h) => h.includes('品貸料率'));
  // 「品貸料率(品貸日数分/円)」列名自体に「品貸日数」が部分文字列として含まれるため、
  // rateIdxと同じ列を誤って拾わないよう除外して探す。
  const daysIdx = header.findIndex((h, i) => i !== rateIdx && h.includes('品貸日数'));
  if (dateIdx === -1 || rateIdx === -1 || daysIdx === -1) {
    throw new Error('Unexpected taisyaku.jp CSV header shape (expected 申込日/品貸料率/品貸日数 columns)');
  }

  // 融資残高・貸株残高は予測ロジックの根幹(貸株超過率)に使うため、列が見つからなければ
  // ヘッダー構造の変化に早期に気づけるよう例外にする。
  const financingBalanceIdx = header.findIndex((h) => h.includes('融資') && h.includes('残高'));
  const lendingBalanceIdx = header.findIndex((h) => h.includes('貸株') && h.includes('残高'));
  if (financingBalanceIdx === -1 || lendingBalanceIdx === -1) {
    throw new Error('Unexpected taisyaku.jp CSV header shape (expected 融資残高/貸株残高 columns)');
  }

  const lendingPriceIdx = header.findIndex((h) => h.includes('貸借値段'));
  const maxRateIdx = header.findIndex((h) => h.includes('最高料率'));
  const bidRankIdx = header.findIndex((h) => h.includes('応札'));
  // 実機CSVには行ごとの実測定を表す「制限措置」「臨時措置」列とは別に、先頭寄りに
  // 「直近制限措置」「直近臨時措置」という別サマリ列が存在する(docs/superpowers/notes/
  // 2026-09-05-taisyaku-csv-balance-columns.md参照)。単純な部分一致(includes)だと
  // 「直近制限措置」に「制限」が含まれるため誤ってそちらを拾ってしまうので、
  // 行の実測定列の名前に完全一致させる。
  const restrictionIdx = header.findIndex((h) => h === '制限措置');
  const emergencyMeasureIdx = header.findIndex((h) => h === '臨時措置');

  // CSV側の日付フォーマットは"YYYY / MM / DD"の可能性が高いが、それ以外もありうる。
  // 少なくとも内部形式("YYYY-MM-DD")とは異なるため、数字以外を除去した上で比較する
  // (例: "2026-08-13" と "2026 / 08 / 13" はどちらも"20260813"になる)。
  const normalizedRightsDate = rightsDate.replace(/\D/g, '');

  for (const line of lines.slice(1)) {
    if (!line.trim()) continue; // 末尾の空行などをスキップ

    const cols = splitCsvLine(line);
    if (cols.length !== header.length) {
      console.warn(
        `taisyaku.jp CSV row column count mismatch for ${ticker ?? '(unknown ticker)'} ${rightsDate} ` +
          `(expected ${header.length} columns, got ${cols.length}); skipping row: ${line}`,
      );
      continue;
    }

    if (cols[dateIdx].replace(/\D/g, '') !== normalizedRightsDate) continue;

    const fieldAt = (idx: number): string => (idx === -1 ? '' : cols[idx]);

    const financingBalance = toNumber(fieldAt(financingBalanceIdx));
    const lendingBalance = toNumber(fieldAt(lendingBalanceIdx));
    if (financingBalance === null || lendingBalance === null) {
      console.warn(
        `taisyaku.jp CSV row for ${ticker ?? '(unknown ticker)'} ${rightsDate} has a non-numeric ` +
          `financing/lending balance; skipping row: ${line}`,
      );
      return undefined;
    }

    const perShareRate = toNumber(fieldAt(rateIdx));
    const occurred = perShareRate !== null;
    const days = perShareRate !== null ? (toNumber(fieldAt(daysIdx)) ?? 0) : 0;

    return {
      rightsDate,
      occurred,
      totalAmount: perShareRate !== null ? perShareRate * unitShares : 0,
      days,
      avgRate: perShareRate !== null && days > 0 ? perShareRate / days : 0,
      financingBalance,
      lendingBalance,
      lendingPrice: toNumber(fieldAt(lendingPriceIdx)),
      maxRateActual: toNumber(fieldAt(maxRateIdx)),
      bidRank: blankToNull(fieldAt(bidRankIdx)),
      restriction: blankToNull(fieldAt(restrictionIdx)),
      emergencyMeasure: blankToNull(fieldAt(emergencyMeasureIdx)),
    };
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
