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
  // 権利確定日の日付。一覧ページで「5月・11月（20日）」のように書かれた銘柄だけが持つ。
  // nullは月末(書かれていない銘柄)。
  rightsDay: number | null;
  value: number | undefined;
  // 一覧ページの「必要投資金額」。必要株数の逆算には使わない — 単元株数と異なる銘柄
  // (例: 第一興商は単元100株だが優待には200株必要、2026-09-04発見)の正確な株数は
  // yutai-detail-sync-batchが個別ページの株数段階表から取る(requiredShares)。
  // ここでの用途は2つ: 「円相当」記載が無い銘柄の優待価値の近似
  // (estimateValueFromYieldが優待利回りと掛け合わせる)と、requiredShares × 株価が
  // 大きく外れていないかの突き合わせ材料。
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

// 【権利確定月】の中身を読む。月末以外の銘柄は
// `5月・11月<span class="red-bold">（20日）</span>`のように内側のspanで日付が付く。
// 内側のspanが（N日）の形でないときは、権利日が分からないまま月末扱いにしないよう
// 'unparsable'を返す。
type RightsSchedule = { rightsMonths: number[]; rightsDay: number | null };

function parseRightsSchedule(block: string): RightsSchedule | 'missing' | 'unparsable' {
  const match = block.match(
    /【権利確定月】<span class="tousi_price">([^<]+)(?:<span class="red-bold">([^<]*)<\/span>)?<\/span>/,
  );
  if (!match) return 'missing';
  const rightsMonths = parseRightsMonths(match[1]);
  if (match[2] === undefined) return { rightsMonths, rightsDay: null };
  const dayMatch = match[2].trim().match(/^（(\d{1,2})日）$/);
  const day = dayMatch ? Number(dayMatch[1]) : NaN;
  if (!Number.isInteger(day) || day < 1 || day > 31) return 'unparsable';
  return { rightsMonths, rightsDay: day };
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
    // 銘柄コードは数字4桁に加え、2024年以降の新規上場銘柄の英字入り(例: 245A)もある。
    const nameMatch = block.match(/<p><a href="([^"]+)" class="kigyoumei">([^<]+)<\/a>（([0-9][0-9A-Z]{3})）<\/p>/);
    const contentMatch = block.match(/【優待内容】([^<]+)/);
    const schedule = parseRightsSchedule(block);
    if (!nameMatch || !contentMatch || typeof schedule === 'string') {
      // 読めないブロックを黙って飛ばすと、20日締めの銘柄のように気づかないまま
      // マスタから漏れるため、理由と(読めていれば)銘柄コードをログに残す。
      const ticker = block.match(/class="kigyoumei">[^<]*<\/a>（([0-9][0-9A-Z]{3})）/)?.[1] ?? 'unknown';
      const reason = !nameMatch
        ? 'company name'
        : !contentMatch
          ? 'yutai content'
          : schedule === 'unparsable'
            ? 'rights day'
            : 'rights months';
      console.warn(`parseListPage: could not parse ${reason} for ticker ${ticker}; skipping`);
      continue;
    }

    const content = contentMatch[1].trim();
    const minInvestment = extractMinInvestment(block);
    entries.push({
      companyName: nameMatch[2],
      ticker: nameMatch[3],
      content,
      rightsMonths: schedule.rightsMonths,
      rightsDay: schedule.rightsDay,
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

// 個別ページのURLはスクレイピングしたHTMLのhrefそのものなので、取得前にホストを検証する。
// 一覧ページが改変されたり構造が変わったりしても、Lambdaが別サイトへリクエストを出さない。
// hrefが相対パスだった場合もここでfalseになる(new URL()のTypeErrorを呼び出し元まで
// 投げずに済む)。
const KABUYUTAI_HOST_SUFFIX = 'kabuyutai.com';

function isKabuyutaiUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  return parsed.hostname === KABUYUTAI_HOST_SUFFIX || parsed.hostname.endsWith(`.${KABUYUTAI_HOST_SUFFIX}`);
}

// 個別ページを1枚取得する。呼び出し元(yutai-detail-sync-batch)が銘柄ごとに
// REQUEST_INTERVAL_MSの間隔を空ける責務を持つ。ここで間隔を取らないのは、
// 単一ページの取得関数が自分で待つと呼び出し側の進捗管理と二重になるため。
// ホスト違いはErrorで返す — 呼び出し元は銘柄ごとにtry/catchしているので、
// 1銘柄のスキップ(failed扱い)になり実行全体は止まらない。
export async function fetchDetailPage(url: string): Promise<string> {
  if (!isKabuyutaiUrl(url)) {
    throw new Error(`refusing to fetch a detail page outside ${KABUYUTAI_HOST_SUFFIX}: ${url}`);
  }
  return fetchPage(url);
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
