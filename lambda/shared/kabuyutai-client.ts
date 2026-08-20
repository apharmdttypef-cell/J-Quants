export interface KabuyutaiEntry {
  ticker: string;
  companyName: string;
  content: string;
  rightsMonths: number[];
  value: number | undefined;
}

const KABUYUTAI_BASE_URL = 'https://www.kabuyutai.com';
const USER_AGENT = 'Mozilla/5.0 (compatible; JQuantsYutaiBot/1.0)';
const REQUEST_INTERVAL_MS = Number(process.env.KABUYUTAI_REQUEST_INTERVAL_MS ?? '1000');

const BLOCK_START = '<!-- ▼ランキング_ブロック -->';
const BLOCK_END = '<!-- ▲ランキング_ブロック -->';

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 銘柄ごとのブロックを<!-- ▼ランキング_ブロック -->〜<!-- ▲ランキング_ブロック -->で分割する。
// ページ全体に直接正規表現をかけると、ブロック外にある同名クラス(kigyoumei等)に誤って
// マッチする恐れがあるため(実データで確認済み: docs/superpowers/notes/2026-08-20-kabuyutai-list-page-format.md)。
function splitBlocks(html: string): string[] {
  const blocks: string[] = [];
  let cursor = 0;
  while (true) {
    const start = html.indexOf(BLOCK_START, cursor);
    if (start === -1) break;
    const end = html.indexOf(BLOCK_END, start);
    if (end === -1) break;
    blocks.push(html.slice(start, end));
    cursor = end + BLOCK_END.length;
  }
  return blocks;
}

// 「2月・8月」形式の文字列を[2, 8]のような配列にする。
function parseRightsMonths(raw: string): number[] {
  return raw
    .split('・')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number(s.replace('月', '')))
    .filter((n) => !Number.isNaN(n));
}

// 優待内容のテキストに埋め込まれた「(XXX円相当〜)」から最低単元の優待価値を抽出する。
// 全角「（」・半角「(」どちらもあり得るため両対応。マッチしなければundefined。
function extractValue(content: string): number | undefined {
  const match = content.match(/[（(]([\d,]+)\s*円相当/);
  if (!match) return undefined;
  const value = Number(match[1].replace(/,/g, ''));
  return Number.isNaN(value) ? undefined : value;
}

export function parseListPage(html: string): KabuyutaiEntry[] {
  const entries: KabuyutaiEntry[] = [];

  for (const block of splitBlocks(html)) {
    const nameMatch = block.match(/<p><a href="[^"]+" class="kigyoumei">([^<]+)<\/a>（(\d{4})）<\/p>/);
    const contentMatch = block.match(/【優待内容】([^<]+)/);
    const monthsMatch = block.match(/【権利確定月】<span class="tousi_price">([^<]+)<\/span>/);
    if (!nameMatch || !contentMatch || !monthsMatch) continue;

    const content = contentMatch[1].trim();
    entries.push({
      companyName: nameMatch[1],
      ticker: nameMatch[2],
      content,
      rightsMonths: parseRightsMonths(monthsMatch[1]),
      value: extractValue(content),
    });
  }

  return entries;
}

async function fetchPage(url: string): Promise<string> {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) {
    throw new Error(`kabuyutai.com error ${response.status} fetching ${url}`);
  }
  return response.text();
}

function pageUrl(month: string, page: number): string {
  return page === 1 ? `${KABUYUTAI_BASE_URL}/yutai/${month}.html` : `${KABUYUTAI_BASE_URL}/yutai/${month}${page}.html`;
}

// paginationブロック内のページ番号リンク(href="{month}{n}.html")のうち最大値を総ページ数とする。
// 「次へ」リンクも同じhrefパターン(常にページ2へのリンク)で紛らわしいが、最大値を取る分には
// 影響しない。paginationブロック自体が無ければ1ページのみ。
function findTotalPages(html: string, month: string): number {
  const paginationMatch = html.match(/<div class="pagination">([\s\S]*?)<\/div>/);
  if (!paginationMatch) return 1;
  const pageNumbers = [...paginationMatch[1].matchAll(new RegExp(`href="${month}(\\d+)\\.html"`, 'g'))].map((m) =>
    Number(m[1]),
  );
  return pageNumbers.length > 0 ? Math.max(1, ...pageNumbers) : 1;
}

export async function fetchMonthListings(month: string): Promise<KabuyutaiEntry[]> {
  const firstHtml = await fetchPage(pageUrl(month, 1));
  const totalPages = findTotalPages(firstHtml, month);
  const entries = [...parseListPage(firstHtml)];

  for (let page = 2; page <= totalPages; page++) {
    await sleep(REQUEST_INTERVAL_MS);
    const html = await fetchPage(pageUrl(month, page));
    entries.push(...parseListPage(html));
  }

  return entries;
}

export async function fetchAllListings(): Promise<KabuyutaiEntry[]> {
  const all: KabuyutaiEntry[] = [];
  for (const month of MONTHS) {
    all.push(...(await fetchMonthListings(month)));
    await sleep(REQUEST_INTERVAL_MS);
  }
  return all;
}

// TDnetで変更が検知された銘柄1件について、どの月のページに載っているか分からないため
// 12ヶ月を順に走査する。見つかった時点で打ち切る。
export async function findTicker(ticker: string): Promise<KabuyutaiEntry | undefined> {
  for (const month of MONTHS) {
    const entries = await fetchMonthListings(month);
    const found = entries.find((e) => e.ticker === ticker);
    if (found) return found;
    await sleep(REQUEST_INTERVAL_MS);
  }
  return undefined;
}
