// 一覧ページの長期保有バッジ。'chouki' = 「長期優遇あり」(長期保有で上乗せ。
// 1回のクロスでも最低段階は取れる)、'choukinomi' = 「長期優待のみ」
// (長期保有者限定でクロスでは取れない)、null = バッジなし(継続保有条件なし)。
// 個別ページの解析が失敗したときのクロス可否のフォールバックに使う。
export type ListBadge = 'chouki' | 'choukinomi' | null;

export interface KabuyutaiEntry {
  ticker: string;
  companyName: string;
  content: string;
  rightsMonths: number[];
  value: number | undefined;
  // 一覧ページの「必要投資金額」。単元株数(100株)と優待の権利獲得に必要な実際の株数が
  // 異なる銘柄(例: 第一興商は単元100株だが優待には200株必要、2026-09-04発見)があるため、
  // 呼び出し元(yutai-risk-precompute-batch)が現在株価と突き合わせて実際の必要株数を
  // 逆算するために使う。
  minInvestment: number | undefined;
  // 個別ページのURL。一覧ページの企業名リンク(class="kigyoumei")のhrefそのもの。
  // yutai-detail-sync-batchが株数段階・継続保有条件を取りに行くのに使う
  // (URLの命名規則を推測する必要がない)。
  detailUrl: string | undefined;
  listBadge: ListBadge;
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

// テーマパークの1日パスポート等「枚数」でしか優待内容が書かれていない銘柄(例:
// オリエンタルランド「1日パスポート券(1枚〜)」)は、extractValue()の「円相当」パターンに
// マッチせずvalueがundefinedになり、一覧ページから実質的に除外されていた(2026-09-04発見)。
// 一覧ページ自体には「必要投資金額」「優待利回り」も掲載されているため、
// 必要投資金額×優待利回り で価値を近似できる(オリエンタルランドで検証: 303,900円×2.59%=
// 7,871円、個別ページ記載の実際の価値「7,900円相当」に近い)。ただし別銘柄(ダスキン)では
// 直接記載の1,000円に対し逆算値が1,966円と乖離した — 優待利回りが上位株数区分の価値を
// 元にしている場合があるためで、この方法はあくまで近似値にとどまる。したがって直接の
// 「円相当」記載を常に優先し、それが取れない場合のみのフォールバックとする。
function estimateValueFromYield(minInvestment: number | undefined, yieldPercent: number | undefined): number | undefined {
  if (minInvestment === undefined || yieldPercent === undefined) return undefined;
  return Math.round(minInvestment * (yieldPercent / 100));
}

// 一覧ページの「必要投資金額」(例: 303,900円)を抽出する。
function extractMinInvestment(block: string): number | undefined {
  const match = block.match(/【必要投資金額】<span class="tousi_price">([\d,]+)円<\/span>/);
  if (!match) return undefined;
  const value = Number(match[1].replace(/,/g, ''));
  return Number.isNaN(value) ? undefined : value;
}

// 長期保有バッジを抽出する。class属性は「長期優遇あり」が class="chouki tooltip"、
// 「長期優待のみ」が class="chouki choukinomi tooltip" で、後者も chouki を含む。
// クラスの並び順に依存しないようトークン単位で判定する。
function extractListBadge(block: string): ListBadge {
  const match = block.match(/<div class="([^"]*\bchouki\b[^"]*)"/);
  if (!match) return null;
  return /\bchoukinomi\b/.test(match[1]) ? 'choukinomi' : 'chouki';
}

// 一覧ページの「優待利回り」(例: 2.59％)を抽出する。
function extractYieldPercent(block: string): number | undefined {
  const match = block.match(/【優待利回り】<span class="tousi_price">([\d.]+)％<\/span>/);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isNaN(value) ? undefined : value;
}

export function parseListPage(html: string): KabuyutaiEntry[] {
  const entries: KabuyutaiEntry[] = [];

  for (const block of splitBlocks(html)) {
    const nameMatch = block.match(/<p><a href="([^"]+)" class="kigyoumei">([^<]+)<\/a>（(\d{4})）<\/p>/);
    const contentMatch = block.match(/【優待内容】([^<]+)/);
    const monthsMatch = block.match(/【権利確定月】<span class="tousi_price">([^<]+)<\/span>/);
    if (!nameMatch || !contentMatch || !monthsMatch) continue;

    const content = contentMatch[1].trim();
    const minInvestment = extractMinInvestment(block);
    entries.push({
      companyName: nameMatch[2],
      ticker: nameMatch[3],
      content,
      rightsMonths: parseRightsMonths(monthsMatch[1]),
      value: extractValue(content) ?? estimateValueFromYield(minInvestment, extractYieldPercent(block)),
      minInvestment,
      detailUrl: nameMatch[1],
      listBadge: extractListBadge(block),
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

// 1ヶ月分の取得が失敗しても他の11ヶ月分の結果を失わないよう、月ごとにtry/catchして
// ログの上で継続する(本プロジェクトの他バッチと同じ「銘柄/項目ごとにcatchしてログし継続」
// という方針をここでも踏襲する)。呼び出し元(yutai-master-sync-batch)はfetchAllListings()の
// 完了を待ってからDynamoDBへの書き込みを開始するため、ここで全体を落とすと成功した月の
// 分まで丸ごと失われてしまう。
export async function fetchAllListings(): Promise<KabuyutaiEntry[]> {
  const all: KabuyutaiEntry[] = [];
  for (const month of MONTHS) {
    try {
      all.push(...(await fetchMonthListings(month)));
    } catch (error) {
      console.error(`fetchAllListings: failed to fetch listings for month "${month}"; skipping`, error);
    }
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
