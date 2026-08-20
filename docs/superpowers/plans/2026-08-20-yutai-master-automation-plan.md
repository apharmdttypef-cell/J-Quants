# 優待マスタ自動化(サブプロジェクトB) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `JQuantsYutaiMaster`(優待マスタ)の投入を手動から自動化する。kabuyutai.comの一覧ページから優待実施銘柄を一括発見・投入し(`yutai-master-sync-batch`)、以後の新設・変更・廃止は無料公開TDnetサイトの週次ポーリングで検知する(`yutai-tdnet-watch-batch`)。`JQuantsYutaiRightsDate`テーブルは廃止し、権利日は`rightsMonths`から都度計算する方式に変える。

**Architecture:** kabuyutai.comの月別一覧ページ(ページネーションあり、月ごとに件数が異なる)を`lambda/shared/kabuyutai-client.ts`でパースし、`{ ticker, companyName, content, rightsMonths, value }`を抽出する。`yutai-master-sync-batch`(スケジュールなし・手動実行)がこれを全銘柄分実行して`JQuantsYutaiMaster`を一括構築し、`yutai-tdnet-watch-batch`(週次)がTDnetの開示を監視して以後の変更を反映する。既存の`reference-api`・`gyakuhibu-history-batch`は、権利日を`JQuantsYutaiRightsDate`へのクエリではなく`rightsMonths`からの計算に切り替える。

**Tech Stack:** TypeScript, AWS CDK (aws-cdk-lib), Lambda (Node.js 22, aws-lambda-nodejs), DynamoDB, Jest

## Global Constraints

- 単元株数(`unitShares`)はスクレイピングせず一律`100`固定(2018年10月の東証売買単位統一以降、内国株は原則100株。有価証券上場規程第427条の2で100株以外への変更は認められていない)
- 企業名(`companyName`)はJ-Quantsではなくkabuyutai.comの一覧ページから取得する(1,000銘柄規模でJ-Quants `/equities/master`を1件ずつ問い合わせるとFreeプランのレート制限で約3.6時間かかりLambdaの15分上限を超えるため)
- kabuyutai.com・TDnetサイトへのアクセスは礼儀正しい間隔(デフォルト1000ms、環境変数で調整可能)を空ける。既存のtaisyaku.jpクライアントと同じ流儀
- `yutai-master-sync-batch`はEventBridgeスケジュールを持たない(手動invokeのみ)。`yutai-tdnet-watch-batch`は週次
- `gyakuhibu-history-batch`は銘柄数増加に備え、taisyaku.jpへの実フェッチ件数に環境変数で上限を設ける(未処理分は`JQuantsGyakuhibuActual`に存在しないため翌日以降に自然と持ち越される、既存の`alreadyFetched`と同じ考え方)
- 詳細設計は`docs/superpowers/specs/2026-08-20-yutai-master-automation-design.md`、実データ調査結果は`docs/superpowers/notes/2026-08-20-kabuyutai-list-page-format.md`・`docs/superpowers/notes/2026-08-20-tdnet-list-page-format.md`を参照
- 既存の手動投入データ(9861含む全`JQuantsYutaiMaster`・`JQuantsYutaiRightsDate`のデータ)はデプロイ後に手動で削除し、`yutai-master-sync-batch`の初回実行で作り直す(本プランのタスクには含めない、デプロイ後の運用作業)

---

### Task 1: `trading-calendar.ts`に`rightsDateForMonth`を追加

**Files:**
- Modify: `lambda/shared/trading-calendar.ts`
- Test: `test/trading-calendar.test.ts`

**Interfaces:**
- Produces: `rightsDateForMonth(calendar: CalendarDay[], year: number, month: number): string | undefined`(指定した年月の最終営業日から2営業日前を返す。該当月に営業日が無ければ`undefined`)

- [ ] **Step 1: テストを書く**

`test/trading-calendar.test.ts`の末尾(既存の`getLocalTradingCalendar`のdescribeブロックの後)に追記する:

```typescript
describe('rightsDateForMonth', () => {
  test('2026-08 (月末最終営業日8/31・月曜) -> 2026-08-27(T、2営業日前)', () => {
    const calendar = getLocalTradingCalendar('2026-08-01', '2026-08-31');
    expect(rightsDateForMonth(calendar, 2026, 8)).toBe('2026-08-27');
  });

  test('2026-02 (月末最終営業日2/27・金曜) -> 2026-02-25(T、2営業日前)', () => {
    const calendar = getLocalTradingCalendar('2026-02-01', '2026-02-28');
    expect(rightsDateForMonth(calendar, 2026, 2)).toBe('2026-02-25');
  });

  test('該当月に営業日が1件も無いカレンダーではundefinedを返す', () => {
    const calendar = getLocalTradingCalendar('2026-08-01', '2026-08-31');
    expect(rightsDateForMonth(calendar, 2026, 9)).toBeUndefined();
  });
});
```

`rightsDateForMonth`を`import`宣言に追加すること(ファイル冒頭の`import { ... } from '../lambda/shared/trading-calendar'`相当の箇所、実際のimport文はテストファイルの既存内容を確認して合わせる)。

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx jest test/trading-calendar.test.ts`
Expected: FAIL(`rightsDateForMonth`が存在しない)

- [ ] **Step 3: 実装する**

`lambda/shared/trading-calendar.ts`の末尾に追記する:

```typescript
// year年month月の最終営業日から2営業日前(権利付き最終日T)を返す。calendarにその月の
// 営業日が1件も含まれない場合はundefined。優待マスタのrightsMonths(権利確定月)から
// 実際の権利付き最終日を都度計算するために使う(JQuantsYutaiRightsDateテーブル廃止に伴う)。
export function rightsDateForMonth(calendar: CalendarDay[], year: number, month: number): string | undefined {
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  const tradingDays = calendar.filter(isTradingDay).map((d) => d.date).sort();
  const monthTradingDays = tradingDays.filter((d) => d.startsWith(prefix));
  const record = monthTradingDays[monthTradingDays.length - 1];
  if (!record) return undefined;
  const idx = tradingDays.indexOf(record);
  return idx >= 2 ? tradingDays[idx - 2] : undefined;
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npx jest test/trading-calendar.test.ts`
Expected: PASS(既存分+新規3件)

- [ ] **Step 5: コミット**

```bash
git add lambda/shared/trading-calendar.ts test/trading-calendar.test.ts
git commit -m "Add rightsDateForMonth to trading-calendar for computed rights dates"
```

---

### Task 2: `lambda/shared/kabuyutai-client.ts`(新規)

**Files:**
- Create: `lambda/shared/kabuyutai-client.ts`
- Test: `test/kabuyutai-client.test.ts`

**Interfaces:**
- Produces:
  - `interface KabuyutaiEntry { ticker: string; companyName: string; content: string; rightsMonths: number[]; value: number | undefined }`
  - `parseListPage(html: string): KabuyutaiEntry[]`
  - `fetchMonthListings(month: string): Promise<KabuyutaiEntry[]>`(1つの月の全ページを走査)
  - `fetchAllListings(): Promise<KabuyutaiEntry[]>`(12ヶ月分すべて)
  - `findTicker(ticker: string): Promise<KabuyutaiEntry | undefined>`(12ヶ月を順に走査し、該当銘柄が見つかった時点で返す)

- [ ] **Step 1: テストを書く**

`test/kabuyutai-client.test.ts`:

```typescript
const mockFetch = jest.fn();

beforeEach(() => {
  mockFetch.mockReset();
  (global as unknown as { fetch: typeof mockFetch }).fetch = mockFetch;
});

import { parseListPage, fetchMonthListings, fetchAllListings, findTicker } from '../lambda/shared/kabuyutai-client';

// docs/superpowers/notes/2026-08-20-kabuyutai-list-page-format.md で確認した実データの
// 抜粋(コシダカホールディングス・2157、地域新聞社・2164)を1ページ2銘柄分の断片として使う。
const SAMPLE_PAGE_HTML = `
<div class="pagination"><a href ="july.html">前月</a><span class="pageNow">1</span><a href="august2.html">2</a><a href="august3.html">3</a></div>
<!-- ▼ランキング_ブロック -->
<div class="table_tr">
<p><a href="https://www.kabuyutai.com/kobetu/koshidakaholdings.html"><img src="..." alt="コシダカホールディングス" loading="lazy"></a></p>
<div class="table_tr_inner">
<div class="table_tr_info">
<p><a href="https://www.kabuyutai.com/kobetu/koshidakaholdings.html" class="kigyoumei">コシダカホールディングス</a>（2157）</p>
<p>【優待内容】「カラオケまねきねこ」のほか、グループ店舗で使える優待利用割引券（2,000円相当～）</p>
<p>【権利確定月】<span class="tousi_price">2月・8月</span></p>
<p>【必要投資金額】<span class="tousi_price">102,200円</span></p>
</div>
</div>
</div>
<!-- ▲ランキング_ブロック -->
<!-- ▼ランキング_ブロック -->
<div class="table_tr">
<p><a href="https://www.kabuyutai.com/kobetu/chiikinews.html"><img src="..." alt="地域新聞社" loading="lazy"></a></p>
<div class="table_tr_inner">
<div class="table_tr_info">
<p><a href="https://www.kabuyutai.com/kobetu/chiikinews.html" class="kigyoumei">地域新聞社</a>（2164）</p>
<p>【優待内容】自社ECサイト「ちいきの逸品」で使える優待買物割引券（9,000円相当～）など</p>
<p>【権利確定月】<span class="tousi_price">2月・8月</span></p>
<p>【必要投資金額】<span class="tousi_price">8,512円</span></p>
</div>
</div>
</div>
<!-- ▲ランキング_ブロック -->
`;

describe('parseListPage', () => {
  test('extracts ticker/companyName/content/rightsMonths/value from real-shaped HTML blocks', () => {
    const entries = parseListPage(SAMPLE_PAGE_HTML);

    expect(entries).toEqual([
      {
        ticker: '2157',
        companyName: 'コシダカホールディングス',
        content: '「カラオケまねきねこ」のほか、グループ店舗で使える優待利用割引券（2,000円相当～）',
        rightsMonths: [2, 8],
        value: 2000,
      },
      {
        ticker: '2164',
        companyName: '地域新聞社',
        content: '自社ECサイト「ちいきの逸品」で使える優待買物割引券（9,000円相当～）など',
        rightsMonths: [2, 8],
        value: 9000,
      },
    ]);
  });

  test('returns value: undefined when the content text has no "円相当" pattern', () => {
    const html = `
<!-- ▼ランキング_ブロック -->
<div class="table_tr">
<p><a href="x" class="kigyoumei">テスト企業</a>（1111）</p>
<p>【優待内容】特典あり</p>
<p>【権利確定月】<span class="tousi_price">3月</span></p>
</div>
<!-- ▲ランキング_ブロック -->
`;
    const entries = parseListPage(html);
    expect(entries).toEqual([
      { ticker: '1111', companyName: 'テスト企業', content: '特典あり', rightsMonths: [3], value: undefined },
    ]);
  });

  test('parses a single rights month (no "・" separator)', () => {
    const html = `
<!-- ▼ランキング_ブロック -->
<div class="table_tr">
<p><a href="x" class="kigyoumei">単月企業</a>（3333）</p>
<p>【優待内容】QUOカード（500円相当～）</p>
<p>【権利確定月】<span class="tousi_price">8月</span></p>
</div>
<!-- ▲ランキング_ブロック -->
`;
    expect(parseListPage(html)).toEqual([
      { ticker: '3333', companyName: '単月企業', content: 'QUOカード（500円相当～）', rightsMonths: [8], value: 500 },
    ]);
  });

  test('skips a block missing a required field entirely rather than throwing', () => {
    const html = `
<!-- ▼ランキング_ブロック -->
<div class="table_tr">
<p>企業名も権利確定月も無い壊れたブロック</p>
</div>
<!-- ▲ランキング_ブロック -->
`;
    expect(parseListPage(html)).toEqual([]);
  });
});

describe('fetchMonthListings', () => {
  test('fetches page 1, follows pagination to the last linked page number, and merges results', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, text: async () => SAMPLE_PAGE_HTML }) // august.html (has pagination up to page 3)
      .mockResolvedValueOnce({ ok: true, text: async () => '<!-- ▼ランキング_ブロック --><div class="table_tr"><p><a href="x" class="kigyoumei">ページ2企業</a>（4444）</p><p>【優待内容】商品券（1,000円相当～）</p><p>【権利確定月】<span class="tousi_price">8月</span></p></div><!-- ▲ランキング_ブロック -->' }) // august2.html
      .mockResolvedValueOnce({ ok: true, text: async () => '<!-- ▼ランキング_ブロック --><div class="table_tr"><p><a href="x" class="kigyoumei">ページ3企業</a>（5555）</p><p>【優待内容】商品券（2,000円相当～）</p><p>【権利確定月】<span class="tousi_price">8月</span></p></div><!-- ▲ランキング_ブロック -->' }); // august3.html

    const entries = await fetchMonthListings('august');

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[0][0]).toBe('https://www.kabuyutai.com/yutai/august.html');
    expect(mockFetch.mock.calls[1][0]).toBe('https://www.kabuyutai.com/yutai/august2.html');
    expect(mockFetch.mock.calls[2][0]).toBe('https://www.kabuyutai.com/yutai/august3.html');
    expect(entries.map((e) => e.ticker)).toEqual(['2157', '2164', '4444', '5555']);
  });

  test('fetches only page 1 when there is no pagination block', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        '<!-- ▼ランキング_ブロック --><div class="table_tr"><p><a href="x" class="kigyoumei">単独企業</a>（6666）</p><p>【優待内容】QUOカード（500円相当～）</p><p>【権利確定月】<span class="tousi_price">12月</span></p></div><!-- ▲ランキング_ブロック -->',
    });

    const entries = await fetchMonthListings('december');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(entries.map((e) => e.ticker)).toEqual(['6666']);
  });

  test('throws when a page request fails', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(fetchMonthListings('august')).rejects.toThrow('kabuyutai.com error 500');
  });
});

describe('fetchAllListings', () => {
  test('fetches all 12 months and concatenates the results', async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => '' }); // 空ページ(パース結果0件)を12ヶ月分返す

    const entries = await fetchAllListings();

    expect(mockFetch).toHaveBeenCalledTimes(12);
    expect(entries).toEqual([]);
  });
});

describe('findTicker', () => {
  test('stops scanning months once the ticker is found', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, text: async () => '' }) // january: not found
      .mockResolvedValueOnce({ ok: true, text: async () => SAMPLE_PAGE_HTML }); // february: found (2157)

    const result = await findTicker('2157');

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ticker: '2157', companyName: 'コシダカホールディングス' });
  });

  test('returns undefined when no month contains the ticker', async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => '' });

    const result = await findTicker('9999');

    expect(mockFetch).toHaveBeenCalledTimes(12);
    expect(result).toBeUndefined();
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx jest test/kabuyutai-client.test.ts`
Expected: FAIL(`lambda/shared/kabuyutai-client`が存在しない)

- [ ] **Step 3: 実装する**

`lambda/shared/kabuyutai-client.ts`:

```typescript
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
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npx jest test/kabuyutai-client.test.ts`
Expected: PASS(11 tests)

- [ ] **Step 5: コミット**

```bash
git add lambda/shared/kabuyutai-client.ts test/kabuyutai-client.test.ts
git commit -m "Add kabuyutai-client for scraping the monthly yutai list pages"
```

---

### Task 3: `lambda/yutai-master-sync-batch/index.ts`(新規)

**Files:**
- Create: `lambda/yutai-master-sync-batch/index.ts`
- Test: `test/yutai-master-sync-batch.test.ts`

**Interfaces:**
- Consumes: `fetchAllListings()`(Task 2)

- [ ] **Step 1: テストを書く**

`test/yutai-master-sync-batch.test.ts`:

```typescript
const mockSend = jest.fn();
const mockFetchAllListings = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  PutCommand: jest.fn((input: unknown) => input),
}));
jest.mock('../lambda/shared/kabuyutai-client', () => ({
  fetchAllListings: (...args: unknown[]) => mockFetchAllListings(...args),
}));

process.env.YUTAI_MASTER_TABLE_NAME = 'JQuantsYutaiMaster';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/yutai-master-sync-batch/index') as { handler: () => Promise<void> };

beforeEach(() => {
  mockSend.mockReset();
  mockFetchAllListings.mockReset();
});

test('upserts each listed entry with unitShares fixed at 100', async () => {
  mockFetchAllListings.mockResolvedValueOnce([
    { ticker: '2157', companyName: 'コシダカホールディングス', content: '割引券（2,000円相当～）', rightsMonths: [2, 8], value: 2000 },
  ]);
  mockSend.mockResolvedValue({});

  await handler();

  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockSend.mock.calls[0][0]).toMatchObject({
    TableName: 'JQuantsYutaiMaster',
    Item: {
      ticker: '2157',
      companyName: 'コシダカホールディングス',
      content: '割引券（2,000円相当～）',
      value: 2000,
      unitShares: 100,
      rightsMonths: [2, 8],
    },
  });
});

test('skips an entry with no extractable value, logging a warning', async () => {
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    mockFetchAllListings.mockResolvedValueOnce([
      { ticker: '1111', companyName: 'テスト企業', content: '特典あり', rightsMonths: [3], value: undefined },
    ]);

    await handler();

    expect(mockSend).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('1111'));
  } finally {
    warnSpy.mockRestore();
  }
});

test('skips an entry with no rightsMonths, logging a warning', async () => {
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    mockFetchAllListings.mockResolvedValueOnce([
      { ticker: '2222', companyName: 'テスト企業2', content: 'QUOカード（500円相当～）', rightsMonths: [], value: 500 },
    ]);

    await handler();

    expect(mockSend).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('2222'));
  } finally {
    warnSpy.mockRestore();
  }
});

test('continues past a single upsert failure and processes the remaining entries', async () => {
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    mockFetchAllListings.mockResolvedValueOnce([
      { ticker: '3333', companyName: 'A社', content: 'QUOカード（500円相当～）', rightsMonths: [3], value: 500 },
      { ticker: '4444', companyName: 'B社', content: '商品券（1,000円相当～）', rightsMonths: [9], value: 1000 },
    ]);
    mockSend.mockRejectedValueOnce(new Error('DynamoDB error')).mockResolvedValueOnce({});

    await handler();

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('3333'), expect.any(Error));
  } finally {
    errorSpy.mockRestore();
  }
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx jest test/yutai-master-sync-batch.test.ts`
Expected: FAIL(`lambda/yutai-master-sync-batch/index`が存在しない)

- [ ] **Step 3: 実装する**

`lambda/yutai-master-sync-batch/index.ts`:

```typescript
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { fetchAllListings } from '../shared/kabuyutai-client';

const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
// 2018年10月の東証売買単位統一以降、内国株の単元株数は原則100株固定
// (有価証券上場規程第427条の2により100株以外への変更は認められていない)。スクレイピング不要。
const UNIT_SHARES = 100;

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const handler = async (): Promise<void> => {
  const entries = await fetchAllListings();
  let upserted = 0;
  let skipped = 0;

  // 年複数回権利確定の銘柄は月ごとのページに重複掲載される(rightsMonths自体に全ての月が
  // 入っているため、同一ticker・同一内容のentryが複数回来る)。複数回upsertされても
  // 内容は同じなので実害は無い(冪等)。
  for (const entry of entries) {
    if (entry.value === undefined) {
      console.warn(`${entry.ticker}: could not extract value from content "${entry.content}"; skipping`);
      skipped++;
      continue;
    }
    if (entry.rightsMonths.length === 0) {
      console.warn(`${entry.ticker}: could not parse rightsMonths; skipping`);
      skipped++;
      continue;
    }

    try {
      await ddbDocClient.send(
        new PutCommand({
          TableName: YUTAI_MASTER_TABLE_NAME,
          Item: {
            ticker: entry.ticker,
            companyName: entry.companyName,
            content: entry.content,
            value: entry.value,
            unitShares: UNIT_SHARES,
            rightsMonths: entry.rightsMonths,
          },
        }),
      );
      upserted++;
    } catch (error) {
      console.error(`${entry.ticker}: failed to upsert yutai master`, error);
    }
  }

  console.log(`yutai-master-sync-batch: upserted ${upserted}, skipped ${skipped} (of ${entries.length} listed)`);
};
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npx jest test/yutai-master-sync-batch.test.ts`
Expected: PASS(4 tests)

- [ ] **Step 5: コミット**

```bash
git add lambda/yutai-master-sync-batch/index.ts test/yutai-master-sync-batch.test.ts
git commit -m "Add yutai-master-sync-batch for one-shot bulk backfill from kabuyutai.com"
```

---

### Task 4: `lambda/yutai-tdnet-watch-batch/index.ts`(新規)

**Files:**
- Create: `lambda/yutai-tdnet-watch-batch/index.ts`
- Test: `test/yutai-tdnet-watch-batch.test.ts`

**Interfaces:**
- Consumes: `findTicker(ticker: string)`(Task 2)

**実装時の注意(未検証事項、`docs/superpowers/notes/2026-08-20-tdnet-list-page-format.md`参照)**:
- TDnetの証券コードは5桁(例`24670`)で出現し、`JQuantsYutaiMaster`の4桁tickerとは先頭4桁を取れば一致すると推定しているが、複数の実例で検証できていない
- 優待関連キーワードの実際の表記ゆれ(「株主優待制度の新設/一部変更/廃止に関するお知らせ」等)の実例が取れていない。ひとまず`YUTAI_KEYWORDS = ['株主優待']`という緩いキーワードで実装し、実機で開示タイトルを見ながら調整する
- 開示が0件の日にTDnetがどう応答するか(404か、0件の一覧ページが返るか)は未検証。下記実装は404を「その日は開示なし」として扱う想定だが、実装時に実機で確認し、挙動が異なれば修正すること

- [ ] **Step 1: テストを書く**

`test/yutai-tdnet-watch-batch.test.ts`:

```typescript
const mockSend = jest.fn();
const mockFindTicker = jest.fn();
const mockFetch = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  PutCommand: jest.fn((input: unknown) => input),
}));
jest.mock('../lambda/shared/kabuyutai-client', () => ({
  findTicker: (...args: unknown[]) => mockFindTicker(...args),
}));

process.env.YUTAI_MASTER_TABLE_NAME = 'JQuantsYutaiMaster';
process.env.TDNET_LOOKBACK_DAYS = '1';
process.env.TDNET_REQUEST_INTERVAL_MS = '0';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/yutai-tdnet-watch-batch/index') as { handler: () => Promise<void> };

function dayListHtml(rows: Array<{ code: string; name: string; title: string }>): string {
  const trs = rows
    .map(
      (r) => `<tr>
<td class="oddnew-L kjTime" noWrap>18:00</td>
<td class="oddnew-M kjCode" noWrap>${r.code}</td>
<td class="oddnew-M kjName" noWrap>${r.name}</td>
<td class="oddnew-M kjTitle" align="left"><a href="x.pdf" target="_blank">${r.title}</a></td>
</tr>`,
    )
    .join('\n');
  return `<div class="kaijiSum">1～100件&nbsp;/&nbsp;全${rows.length}件</div>${trs}`;
}

beforeEach(() => {
  mockSend.mockReset();
  mockFindTicker.mockReset();
  mockFetch.mockReset();
  (global as unknown as { fetch: typeof mockFetch }).fetch = mockFetch;
});

test('matches a yutai-related disclosure, looks it up on kabuyutai.com, and upserts it', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    text: async () =>
      dayListHtml([{ code: '21570', name: 'コシダカホールディングス', title: '株主優待制度の一部変更に関するお知らせ' }]),
  });
  mockFindTicker.mockResolvedValueOnce({
    ticker: '2157',
    companyName: 'コシダカホールディングス',
    content: '割引券（3,000円相当～）',
    rightsMonths: [2, 8],
    value: 3000,
  });
  mockSend.mockResolvedValue({});

  await handler();

  expect(mockFindTicker).toHaveBeenCalledWith('2157');
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockSend.mock.calls[0][0]).toMatchObject({
    TableName: 'JQuantsYutaiMaster',
    Item: { ticker: '2157', value: 3000, unitShares: 100, rightsMonths: [2, 8] },
  });
});

test('ignores disclosures whose title has no yutai-related keyword', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    text: async () => dayListHtml([{ code: '72030', name: 'トヨタ自動車', title: '自己株式取得に関するお知らせ' }]),
  });

  await handler();

  expect(mockFindTicker).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
});

test('skips and logs a warning when a matched ticker is not found on kabuyutai.com', async () => {
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => dayListHtml([{ code: '99990', name: '廃止企業', title: '株主優待制度の廃止に関するお知らせ' }]),
    });
    mockFindTicker.mockResolvedValueOnce(undefined);

    await handler();

    expect(mockSend).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('9999'));
  } finally {
    warnSpy.mockRestore();
  }
});

test('deduplicates multiple matching disclosures for the same ticker into a single lookup', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    text: async () =>
      dayListHtml([
        { code: '21570', name: 'コシダカホールディングス', title: '株主優待制度の一部変更に関するお知らせ' },
        { code: '21570', name: 'コシダカホールディングス', title: '株主優待制度の一部変更に関するお知らせ（訂正）' },
      ]),
  });
  mockFindTicker.mockResolvedValueOnce({
    ticker: '2157',
    companyName: 'コシダカホールディングス',
    content: '割引券（3,000円相当～）',
    rightsMonths: [2, 8],
    value: 3000,
  });
  mockSend.mockResolvedValue({});

  await handler();

  expect(mockFindTicker).toHaveBeenCalledTimes(1);
});

test('treats a 404 day page as "no disclosures that day" rather than failing the run', async () => {
  mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

  await expect(handler()).resolves.not.toThrow();
  expect(mockFindTicker).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx jest test/yutai-tdnet-watch-batch.test.ts`
Expected: FAIL(`lambda/yutai-tdnet-watch-batch/index`が存在しない)

- [ ] **Step 3: 実装する**

`lambda/yutai-tdnet-watch-batch/index.ts`:

```typescript
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { findTicker } from '../shared/kabuyutai-client';

const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
const UNIT_SHARES = 100;
const TDNET_BASE_URL = 'https://www.release.tdnet.info';
const USER_AGENT = 'Mozilla/5.0 (compatible; JQuantsYutaiBot/1.0)';
const REQUEST_INTERVAL_MS = Number(process.env.TDNET_REQUEST_INTERVAL_MS ?? '1000');
// 週次実行なので、直近7日分を毎回チェックすれば取りこぼしが無い(冪等: 既に処理済みの
// 銘柄は次のkabuyutai.com再取得で同じ内容がそのままupsertされるだけで実害は無い)。
const LOOKBACK_DAYS = Number(process.env.TDNET_LOOKBACK_DAYS ?? '7');
// 実際の表記ゆれ(新設/一部変更/廃止 等)は実機で確認しながら調整する。
const YUTAI_KEYWORDS = ['株主優待'];

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Disclosure {
  code: string;
  companyName: string;
  title: string;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

// TDnetの証券コードは5桁(末尾0付き)で出現する。JQuantsYutaiMasterの4桁tickerとは
// 先頭4桁を取れば一致する(実データで確認済み。ただし複数実例での検証は未了、
// docs/superpowers/notes/2026-08-20-tdnet-list-page-format.md参照)。
function toTicker(tdnetCode: string): string {
  return tdnetCode.slice(0, 4);
}

function parseDayPage(html: string): Disclosure[] {
  const disclosures: Disclosure[] = [];
  for (const rowMatch of html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const row = rowMatch[1];
    const codeMatch = row.match(/class="[^"]*kjCode[^"]*"[^>]*>(\d+)</);
    const nameMatch = row.match(/class="[^"]*kjName[^"]*"[^>]*>([^<]+)</);
    const titleMatch = row.match(/class="[^"]*kjTitle[^"]*"[^>]*><a[^>]*>([^<]+)</);
    if (!codeMatch || !nameMatch || !titleMatch) continue;

    disclosures.push({ code: codeMatch[1], companyName: nameMatch[1].trim(), title: titleMatch[1].trim() });
  }
  return disclosures;
}

function isYutaiRelated(title: string): boolean {
  return YUTAI_KEYWORDS.some((keyword) => title.includes(keyword));
}

function totalPagesFor(html: string): number {
  const match = html.match(/(\d+)～(\d+)件\s*\/\s*全(\d+)件/);
  if (!match) return 1;
  const perPage = Number(match[2]) - Number(match[1]) + 1;
  const total = Number(match[3]);
  return perPage > 0 ? Math.max(1, Math.ceil(total / perPage)) : 1;
}

async function fetchDayDisclosures(dateStr: string): Promise<Disclosure[]> {
  const firstUrl = `${TDNET_BASE_URL}/inbs/I_list_001_${dateStr}.html`;
  const firstResponse = await fetch(firstUrl, { headers: { 'User-Agent': USER_AGENT } });
  if (firstResponse.status === 404) return []; // その日は開示が無かった
  if (!firstResponse.ok) {
    throw new Error(`TDnet error ${firstResponse.status} fetching ${firstUrl}`);
  }
  const firstHtml = await firstResponse.text();
  const disclosures = parseDayPage(firstHtml);
  const totalPages = totalPagesFor(firstHtml);

  for (let page = 2; page <= totalPages; page++) {
    await sleep(REQUEST_INTERVAL_MS);
    const url = `${TDNET_BASE_URL}/inbs/I_list_${String(page).padStart(3, '0')}_${dateStr}.html`;
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!response.ok) {
      throw new Error(`TDnet error ${response.status} fetching ${url}`);
    }
    disclosures.push(...parseDayPage(await response.text()));
  }

  return disclosures;
}

export const handler = async (): Promise<void> => {
  const matchedTickers = new Set<string>();

  for (let daysAgo = 0; daysAgo < LOOKBACK_DAYS; daysAgo++) {
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    const dateStr = formatDate(date);

    try {
      const disclosures = await fetchDayDisclosures(dateStr);
      for (const disclosure of disclosures) {
        if (isYutaiRelated(disclosure.title)) {
          matchedTickers.add(toTicker(disclosure.code));
        }
      }
    } catch (error) {
      console.error(`Failed to fetch TDnet disclosures for ${dateStr}`, error);
    }

    await sleep(REQUEST_INTERVAL_MS);
  }

  for (const ticker of matchedTickers) {
    try {
      const entry = await findTicker(ticker);
      if (!entry) {
        console.warn(`${ticker}: matched a yutai-related TDnet disclosure but not found on kabuyutai.com; skipping`);
        continue;
      }
      if (entry.value === undefined || entry.rightsMonths.length === 0) {
        console.warn(`${ticker}: found on kabuyutai.com but value/rightsMonths incomplete; skipping`);
        continue;
      }

      await ddbDocClient.send(
        new PutCommand({
          TableName: YUTAI_MASTER_TABLE_NAME,
          Item: {
            ticker: entry.ticker,
            companyName: entry.companyName,
            content: entry.content,
            value: entry.value,
            unitShares: UNIT_SHARES,
            rightsMonths: entry.rightsMonths,
          },
        }),
      );
      console.log(`${ticker}: upserted yutai master from TDnet-triggered re-sync`);
    } catch (error) {
      console.error(`${ticker}: failed to re-sync from TDnet match`, error);
    }
  }
};
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npx jest test/yutai-tdnet-watch-batch.test.ts`
Expected: PASS(5 tests)

- [ ] **Step 5: コミット**

```bash
git add lambda/yutai-tdnet-watch-batch/index.ts test/yutai-tdnet-watch-batch.test.ts
git commit -m "Add yutai-tdnet-watch-batch for weekly disclosure-driven yutai master updates"
```

---

### Task 5: `reference-api`を`rightsMonths`ベースの権利日計算に切り替え

**Files:**
- Modify: `lambda/reference-api/index.ts`
- Modify: `test/reference-api.test.ts`

**Interfaces:**
- Consumes: `rightsDateForMonth`(Task 1)

- [ ] **Step 1: 現状のテストが通ることを確認する(ベースライン)**

Run: `npx jest test/reference-api.test.ts`
Expected: PASS(現状の全テスト)

- [ ] **Step 2: 本体コードを変更する**

`lambda/reference-api/index.ts`の変更点は以下の5箇所:

**2-1. importに`rightsDateForMonth`を追加**(ファイル冒頭の`from '../shared/trading-calendar'`のimport文の`{ ... }`の中に追加する):

```typescript
import {
  getLocalTradingCalendar,
  isTradingDay,
  settlementDate,
  businessDaysAfter,
  calendarDaysBetween,
  rightsDateForMonth,
  type CalendarDay,
} from '../shared/trading-calendar';
```

**2-2. `YUTAI_RIGHTS_DATE_TABLE_NAME`の環境変数定義を削除**(15-22行目付近の定数群から、以下の1行を削除):

```typescript
const YUTAI_RIGHTS_DATE_TABLE_NAME = process.env.YUTAI_RIGHTS_DATE_TABLE_NAME!;
```

**2-3. `YutaiMasterRow`インターフェースに`rightsMonths`を追加**、`scanYutaiMaster`・`getYutaiMaster`の返り値にも追加する:

```typescript
interface YutaiMasterRow {
  ticker: string;
  companyName?: string;
  content: string;
  value: number;
  unitShares: number;
  rightsMonths: number[];
}
```

`scanYutaiMaster`内の`rows.push({...})`と`getYutaiMaster`内の`return {...}`の両方に、それぞれ`rightsMonths: item.rightsMonths ?? []`・`rightsMonths: result.Item.rightsMonths ?? []`を追加する(既存の`ticker`/`companyName`/`content`/`value`/`unitShares`の並びに1行追加するだけ)。

**2-4. `nextRightsDate`関数を丸ごと置き換える。** 現行の(`YUTAI_RIGHTS_DATE_TABLE_NAME`をクエリする)実装:

```typescript
async function nextRightsDate(ticker: string): Promise<string | undefined> {
  const today = new Date().toISOString().slice(0, 10);
  const result = await ddbDocClient.send(
    new QueryCommand({
      TableName: YUTAI_RIGHTS_DATE_TABLE_NAME,
      KeyConditionExpression: 'ticker = :ticker AND rightsDate >= :today',
      ExpressionAttributeValues: { ':ticker': ticker, ':today': today },
      ScanIndexForward: true,
      Limit: 1,
    }),
  );
  return result.Items?.[0]?.rightsDate;
}
```

を、以下に置き換える(DynamoDBを使わないただの計算になるため`async`ではなくなる。呼び出し側の`await`は残しても実害はないが、下記Step 2-5で外す):

```typescript
// rightsMonthsの各月について、今年・来年の最終営業日から2営業日前(権利付き最終日T)を
// 計算し、今日以降で最も近いものを返す(旧JQuantsYutaiRightsDateテーブルの代替)。
function nextRightsDate(rightsMonths: number[], calendarCache: Map<string, CalendarDay[]>): string | undefined {
  if (rightsMonths.length === 0) return undefined;

  const today = new Date().toISOString().slice(0, 10);
  const year = Number(today.slice(0, 4));
  const calendar = fetchTradingCalendarCached(`${year}-01-01`, `${year + 1}-12-31`, calendarCache);

  const candidates: string[] = [];
  for (const y of [year, year + 1]) {
    for (const month of rightsMonths) {
      const rightsDate = rightsDateForMonth(calendar, y, month);
      if (rightsDate) candidates.push(rightsDate);
    }
  }

  return candidates.filter((d) => d >= today).sort()[0];
}
```

この関数は`fetchTradingCalendarCached`(既存)より前に定義されているとコンパイルエラーになるので、`fetchTradingCalendarCached`関数の直後・`calcRisk`関数の直前に配置すること(`calcRisk`もこの並びに依存しないので順序の影響は無いが、依存関係が上から下に読める順序にする)。

**2-5. `listYutai`内の呼び出し箇所を更新**(372行目付近):

```typescript
    const rightsDate = await nextRightsDate(row.ticker);
```

を

```typescript
    const rightsDate = nextRightsDate(row.rightsMonths, calendarCache);
```

に変更する(`listYutai`は既に`calendarCache`をループの外で1つ作っているので、それをそのまま渡すだけでよい)。

**2-6. `getYutaiDetail`内の呼び出し箇所を更新**(479-487行目付近)。元の順序(先に`nextRightsDate`、後で`calendarCache`を作る)は新しいシグネチャと噛み合わないため、`calendarCache`の生成を先に持ってくる:

```typescript
  const rightsDate = await nextRightsDate(ticker);

  // このリクエスト限りの使い捨てキャッシュ(calcRiskの引数を共通化するために渡す)。
  const calendarCache = new Map<string, CalendarDay[]>();
  const risk = await calcRisk(
    { ticker: master.ticker, value: master.value, unitShares: master.unitShares },
    rightsDate,
    calendarCache,
  );
```

を

```typescript
  // このリクエスト限りの使い捨てキャッシュ(calcRiskの引数を共通化するために渡す)。
  const calendarCache = new Map<string, CalendarDay[]>();
  const rightsDate = nextRightsDate(master.rightsMonths, calendarCache);

  const risk = await calcRisk(
    { ticker: master.ticker, value: master.value, unitShares: master.unitShares },
    rightsDate,
    calendarCache,
  );
```

に変更する。

- [ ] **Step 3: `npx tsc --noEmit`でコンパイルが通ることを確認する**

Run: `npx tsc --noEmit -p .`
Expected: エラーなし(`test/reference-api.test.ts`はこの時点でまだ古いモックのままなので、テスト自体は次のStepまで失敗する)

- [ ] **Step 4: `test/reference-api.test.ts`を更新する**

`nextRightsDate`がDynamoDBを呼ばなくなったため、「rights-date query」を模したモックステップ(`.mockResolvedValueOnce({ Items: [{ ticker: ..., rightsDate: ... }] })`または`.mockResolvedValueOnce({ Items: [] })`という行で、コメントに"rights-date"や"next rights date"と書かれているもの)を**該当箇所から削除**し、代わりに同じテスト内のyutai-master行(`{ ticker: '1234', companyName: ..., content: ..., value: ..., unitShares: 100 }`という形のオブジェクト)に`rightsMonths`フィールドを追加する。空配列`rightsMonths: []`にすれば「次回の権利日なし」を表現できる(旧`{ Items: [] }`と等価)。非空配列(例: `rightsMonths: [8]`)にすれば「権利日あり」を表現できる(旧`{ Items: [{ rightsDate: '...' }] }`と等価)。

以下のテストが対象(1つずつ、`npx jest test/reference-api.test.ts -t "<テスト名の一部>"`で確認しながら進めること):

1. `'GET /yutai returns each ticker with its next rights date and a safe/danger/na risk badge'`(222行目〜): rights-date queryのモック行を削除し、yutai master scanの行に`rightsMonths: [8]`を追加する。このテストは具体的なrightsDateの値をassertしていないので、それ以外の変更は不要。

2. `'GET /yutai filters by keyword against company name and content'`(241行目〜): 既に`.mockResolvedValue({ Items: [] })`という汎用フォールバックを使っているため、モックチェーン自体の変更は不要。ただし2件のyutai master行に`rightsMonths: [8]`を追加しておく(無くても動作は変わらないが、実データに近づける)。

3. `'GET /yutai returns rightsDate: null...'`(257行目〜): rights-date query(`{ Items: [] }`)のモック行を削除し、yutai master scanの行に`rightsMonths: []`を追加する。

4. `'GET /yutai/{ticker} returns basic info, risk calc, and rights history'`(274行目〜): "next rights date"のモック行(279行目)を削除し、yutai master getの行(276行目)に`rightsMonths: [8]`を追加する。コメント「rightsDate=2026-08-20から実カレンダーでdays=1になる」は不正確になるので削除するか「rightsMonthsから計算されるrightsDateで、実カレンダー上のdaysが決まる」程度に書き換える。アサーション自体(`toBeGreaterThan(0)`)は変更不要。

5. `'GET /yutai/{ticker} rightsHistory excludes noGyakuhibu marker rows...'`(301行目〜): "next rights date: none upcoming"のモック行(306行目、`{ Items: [] }`)を削除し、yutai master getの行(303行目)に`rightsMonths: []`を追加する。

6. `'GET /yutai/{ticker} pins the safe/danger comparison direction...'`(320行目〜、`mockDetailCalls`ヘルパー関数): これが最も注意が必要。旧実装は`rightsDate: '2026-08-17'`を直接モックで固定し、そこから決まる`days=1`を前提に`maxGyakuhibu=100`という具体的な数値でsafe/danger境界(101円で safe、99円で danger)を検証していた。新実装では`rightsDate`は`rightsMonths`から**実カレンダーで計算**されるため、'2026-08-17'を直接指定することはできない。このテストは`test/reference-api.test.ts`の冒頭で`getLocalTradingCalendar`・`rightsDateForMonth`を`../lambda/shared/trading-calendar`からimportし、`mockDetailCalls`関数内で使う`rightsMonths`(何月でもよい。ただし当年内でまだ来ていない月を選ぶと"次回"に含まれない可能性があるため、確実に候補に入る月を選ぶこと)を1つ決め、その月に対応する実際の`rightsDateForMonth`の結果と、そこから`settlementDate`/`businessDaysAfter`/`calendarDaysBetween`(いずれも`../lambda/shared/trading-calendar`からimport)で計算した実際の`days`を使って、期待する`maxGyakuhibu`(`最高料率(1円固定になるcloseP rice=500・unitShares=100の組み合わせ) × unitShares(100) × 実際に計算されたdays`)をテスト内で計算し、それを基準にsafe/danger境界の`value`(`maxGyakuhibu+1`と`maxGyakuhibu-1`)を動的に決める形に書き換える。ハードコードされた`100`という数値ではなく、テスト自身が計算した値を使うことで、将来カレンダーロジックが変わっても正しく追従する。`mockDetailCalls`のyutai master getの行に`rightsMonths: [<選んだ月>]`を追加し、"next rights date"のモック行を削除する。

7. `'GET /yutai/{ticker} returns 404 for a ticker not in the yutai master'`(351行目〜): `nextRightsDate`に到達する前に404で返るため、変更不要。

8. `'GET /yutai/{ticker} returns rightsDate: null and companyName: null...'`(359行目〜): "next rights date: none upcoming"のモック行(364行目、`{ Items: [] }`)を削除し、yutai master getの行(361行目)に`rightsMonths: []`を追加する。

`YUTAI_RIGHTS_DATE_TABLE_NAME`の環境変数セットアップ行(30行目)も削除する。

- [ ] **Step 5: テストを実行して全て成功することを確認する**

Run: `npx jest test/reference-api.test.ts`
Expected: PASS(全テスト、テスト数は変更前と同じ)

- [ ] **Step 6: 全体のテストスイートを実行する**

Run: `npx jest`
Expected: PASS(この時点で`lib/j-quants-stack.ts`はまだ`YUTAI_RIGHTS_DATE_TABLE_NAME`を渡しているためreference-apiは動作するが、`test/j-quants.test.ts`側は次のTask 7で対応する。もしこの時点で無関係な失敗が出た場合のみ調査すること)

- [ ] **Step 7: コミット**

```bash
git add lambda/reference-api/index.ts test/reference-api.test.ts
git commit -m "Compute nextRightsDate from rightsMonths instead of querying JQuantsYutaiRightsDate"
```

---

### Task 6: `gyakuhibu-history-batch`を`rightsMonths`ベースの権利日列挙に切り替え

**Files:**
- Modify: `lambda/gyakuhibu-history-batch/index.ts`
- Modify: `test/gyakuhibu-history-batch.test.ts`

**Interfaces:**
- Consumes: `getLocalTradingCalendar`(既存)・`rightsDateForMonth`(Task 1)

- [ ] **Step 1: 現状のテストが通ることを確認する(ベースライン)**

Run: `npx jest test/gyakuhibu-history-batch.test.ts`
Expected: PASS(現状の全テスト)

- [ ] **Step 2: 本体コードを置き換える**

`lambda/gyakuhibu-history-batch/index.ts`の`YUTAI_RIGHTS_DATE_TABLE_NAME`・`listPastRightsDates`・`isWithinPublishedRange`・`getUnitShares`を削除し、以下に置き換える(ファイル全体):

```typescript
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { fetchTaisyakuCsv, parseTaisyakuCsv } from './taisyaku-client';
import { getLocalTradingCalendar, rightsDateForMonth } from '../shared/trading-calendar';

const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
const GYAKUHIBU_ACTUAL_TABLE_NAME = process.env.GYAKUHIBU_ACTUAL_TABLE_NAME!;
// taisyaku.jpが公開しているのは直近3年分のみ(それより古いデータは非公開)。
const MAX_HISTORY_YEARS = 3;
// 1,000銘柄規模になると初回は候補件数が膨大になり、Lambdaの実行時間内に収まらない。
// 実際にtaisyaku.jpへ取得しに行く件数だけを上限で区切り、残りは翌日以降に自然と持ち越す
// (alreadyFetchedが常にfalseのままなので取りこぼしにはならない)。
const MAX_FETCHES_PER_RUN = Number(process.env.MAX_GYAKUHIBU_FETCHES_PER_RUN ?? '200');

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

interface MasterRow {
  ticker: string;
  unitShares: number;
  rightsMonths: number[];
}

interface RightsDateCandidate {
  ticker: string;
  rightsDate: string;
  unitShares: number;
}

async function scanYutaiMaster(): Promise<MasterRow[]> {
  const rows: MasterRow[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await ddbDocClient.send(
      new ScanCommand({ TableName: YUTAI_MASTER_TABLE_NAME, ExclusiveStartKey: exclusiveStartKey }),
    );
    for (const item of result.Items ?? []) {
      if (typeof item.ticker === 'string' && typeof item.unitShares === 'number' && Array.isArray(item.rightsMonths)) {
        rows.push({ ticker: item.ticker, unitShares: item.unitShares, rightsMonths: item.rightsMonths });
      }
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return rows;
}

// 各銘柄のrightsMonthsについて、taisyaku.jpの公開範囲(直近MAX_HISTORY_YEARS年)分の
// 権利付き最終日を計算し、今日より過去の日付だけを候補として返す(旧JQuantsYutaiRightsDate
// テーブルスキャンの代替)。
function pastRightsDateCandidates(rows: MasterRow[]): RightsDateCandidate[] {
  const today = new Date().toISOString().slice(0, 10);
  const thisYear = Number(today.slice(0, 4));
  const fromYear = thisYear - MAX_HISTORY_YEARS;
  const calendar = getLocalTradingCalendar(`${fromYear}-01-01`, `${thisYear}-12-31`);

  const candidates: RightsDateCandidate[] = [];
  for (const row of rows) {
    for (let year = fromYear; year <= thisYear; year++) {
      for (const month of row.rightsMonths) {
        const rightsDate = rightsDateForMonth(calendar, year, month);
        if (rightsDate && rightsDate < today) {
          candidates.push({ ticker: row.ticker, rightsDate, unitShares: row.unitShares });
        }
      }
    }
  }
  return candidates;
}

async function alreadyFetched(ticker: string, rightsDate: string): Promise<boolean> {
  const result = await ddbDocClient.send(
    new GetCommand({ TableName: GYAKUHIBU_ACTUAL_TABLE_NAME, Key: { ticker, rightsDate } }),
  );
  return result.Item !== undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// taisyaku.jpへの連続リクエストの間隔。公開されたレート制限は無いが、個人利用の
// バッチとして無配慮に連打しないための最低限の間隔(数百ms〜数秒程度あれば十分)。
const BETWEEN_REQUESTS_DELAY_MS = Number(process.env.TAISYAKU_REQUEST_INTERVAL_MS ?? '1000');

export const handler = async (): Promise<void> => {
  const rows = await scanYutaiMaster();
  const candidates = pastRightsDateCandidates(rows);

  let fetchCount = 0;
  for (const { ticker, rightsDate, unitShares } of candidates) {
    if (fetchCount >= MAX_FETCHES_PER_RUN) break;

    // taisyaku.jpへの実リクエストを行った場合だけループ末尾で待機する
    // (alreadyFetchedでスキップした行まで待つのは無駄なため)。
    let attemptedFetch = false;
    try {
      if (await alreadyFetched(ticker, rightsDate)) continue;

      attemptedFetch = true;
      fetchCount++;
      const csv = await fetchTaisyakuCsv(ticker, rightsDate, rightsDate);
      const point = parseTaisyakuCsv(csv, rightsDate, unitShares, ticker);
      if (!point) {
        // 品貸料が発生しなかった(または対象日がCSVに含まれていなかった)場合でも、
        // 「確認済みで実績なし」の行を書いておかないとalreadyFetchedが常にfalseになり、
        // 毎日この権利日を再スクレイピングし続けてしまう(Fix 2)。
        console.log(`${ticker}: no lending fee on ${rightsDate} (not a margin-shortage event); recording as checked`);
        await ddbDocClient.send(
          new PutCommand({
            TableName: GYAKUHIBU_ACTUAL_TABLE_NAME,
            Item: { ticker, rightsDate, totalAmount: 0, days: 0, avgRate: 0, noGyakuhibu: true },
          }),
        );
        continue;
      }

      await ddbDocClient.send(
        new PutCommand({
          TableName: GYAKUHIBU_ACTUAL_TABLE_NAME,
          Item: { ticker, rightsDate: point.rightsDate, totalAmount: point.totalAmount, days: point.days, avgRate: point.avgRate },
        }),
      );
      console.log(`${ticker}: upserted actual gyakuhibu for ${rightsDate}`);
    } catch (error) {
      console.error(`${ticker}: failed to fetch/upsert actual gyakuhibu for ${rightsDate}`, error);
    } finally {
      if (attemptedFetch) await sleep(BETWEEN_REQUESTS_DELAY_MS);
    }
  }
};
```

- [ ] **Step 3: `test/gyakuhibu-history-batch.test.ts`を書き換える**

モックの第一段(旧: `JQuantsYutaiRightsDate`のScanCommandが`{ ticker, rightsDate }`を直接返す)は、新実装では`JQuantsYutaiMaster`のScanCommandが`{ ticker, unitShares, rightsMonths }`を返す形に変わる。`rightsDate`は`rightsMonths`から計算されるため、テスト内で固定文字列を使う代わりに、テストファイル冒頭で`../lambda/shared/trading-calendar`から`getLocalTradingCalendar`・`rightsDateForMonth`をimportし、「確実に過去日になる年月」から実際の期待値を計算するヘルパーを用意する:

```typescript
import { getLocalTradingCalendar, rightsDateForMonth } from '../lambda/shared/trading-calendar';

// テスト実行時点で確実に「過去」になる年月(去年の3月)から、実カレンダーで計算した
// 権利付き最終日を返す。ハードコードされた日付文字列に依存せず、実行時点によらず
// 安定して過去日になる。
function knownPastRightsDate(): string {
  const lastYear = new Date().getFullYear() - 1;
  const calendar = getLocalTradingCalendar(`${lastYear}-01-01`, `${lastYear}-12-31`);
  const date = rightsDateForMonth(calendar, lastYear, 3);
  if (!date) throw new Error('test setup: could not compute a known past rights date');
  return date;
}
```

`MAX_HISTORY_YEARS=3`かつ`rightsMonths: [3]`を使うと、去年だけでなく「今年もし3月が過ぎていれば今年の3月」「一昨年」「3年前」も候補に入ってしまい、テストの`mockResolvedValueOnce`が1件分しか用意されていないと2件目以降で失敗する。**この曖昧さを避けるため、テストでは`rightsMonths: [3]`ではなく、`pastRightsDateCandidates`が生成する候補が1件だけになるよう、`process.env.MAX_GYAKUHIBU_FETCHES_PER_RUN`はテストに影響しないので、代わりに`alreadyFetched`のモックを`mockResolvedValue`(`Once`を付けない)にして「2件目以降も全て未取得」として扱い、`fetchTaisyakuCsv`/`parseTaisyakuCsv`も`mockResolvedValue`/`mockReturnValue`(`Once`を付けない)で複数回呼ばれても同じ値を返すようにし、アサーション側は`putCalls`の中に期待する1件が**含まれる**ことを確認する(`toHaveLength(1)`のような完全一致ではなく、`expect(putCalls.some(...)).toBe(true)`や`expect(putCalls.length).toBeGreaterThanOrEqual(1)`)方式に変更する。**

以下のように書き換える(3つのテスト全て):

```typescript
test('fetches and upserts actual gyakuhibu only for past rights dates not yet in JQuantsGyakuhibuActual', async () => {
  const rightsDate = knownPastRightsDate();
  mockSend.mockResolvedValueOnce({ Items: [{ ticker: '7203', unitShares: 100, rightsMonths: [3] }] }); // yutai master scan
  mockSend.mockResolvedValue({ Item: undefined }); // alreadyFetched: 常に未取得として扱う(候補が複数年分生成されるため)
  taisyakuClient.fetchTaisyakuCsv.mockResolvedValue('csv-body');
  taisyakuClient.parseTaisyakuCsv.mockImplementation((_csv, targetRightsDate) =>
    targetRightsDate === rightsDate ? { rightsDate, totalAmount: 680, days: 2, avgRate: 0.4 } : undefined,
  );

  await handler();

  const putCalls = mockSend.mock.calls.filter(
    ([cmd]) => 'Item' in (cmd as Record<string, unknown>) && (cmd as { TableName?: string }).TableName === 'JQuantsGyakuhibuActual',
  );
  expect(putCalls.some((call) => (call[0] as { Item: { rightsDate: string } }).Item.rightsDate === rightsDate)).toBe(true);
  const matchingCall = putCalls.find((call) => (call[0] as { Item: { rightsDate: string } }).Item.rightsDate === rightsDate);
  expect(matchingCall![0]).toMatchObject({
    Item: { ticker: '7203', rightsDate, totalAmount: 680, days: 2, avgRate: 0.4 },
  });
});

test('writes a noGyakuhibu marker row (instead of nothing) when parseTaisyakuCsv finds no lending fee, so the date is not re-scraped forever', async () => {
  mockSend.mockResolvedValueOnce({ Items: [{ ticker: '7203', unitShares: 100, rightsMonths: [3] }] }); // yutai master scan
  mockSend.mockResolvedValue({ Item: undefined }); // alreadyFetched: 常に未取得
  taisyakuClient.fetchTaisyakuCsv.mockResolvedValue('csv-body');
  taisyakuClient.parseTaisyakuCsv.mockReturnValue(undefined); // どの候補日も品薄なし

  await handler();

  const putCalls = mockSend.mock.calls.filter(
    ([cmd]) => 'Item' in (cmd as Record<string, unknown>) && (cmd as { TableName?: string }).TableName === 'JQuantsGyakuhibuActual',
  );
  expect(putCalls.length).toBeGreaterThan(0);
  expect(putCalls.every((call) => (call[0] as { Item: { noGyakuhibu?: boolean } }).Item.noGyakuhibu === true)).toBe(true);
});

test('caps the number of real taisyaku.jp fetches per run at MAX_GYAKUHIBU_FETCHES_PER_RUN, leaving the rest for next time', async () => {
  const previousEnv = process.env.MAX_GYAKUHIBU_FETCHES_PER_RUN;
  process.env.MAX_GYAKUHIBU_FETCHES_PER_RUN = '1';
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { handler: cappedHandler } = require('../lambda/gyakuhibu-history-batch/index') as { handler: () => Promise<void> };

  try {
    // rightsMonths: [1, 2, 3]の3ヶ月分あれば、直近数年でほぼ確実に2件以上の過去候補が生じる。
    mockSend.mockResolvedValueOnce({ Items: [{ ticker: '7203', unitShares: 100, rightsMonths: [1, 2, 3] }] });
    mockSend.mockResolvedValue({ Item: undefined });
    taisyakuClient.fetchTaisyakuCsv.mockResolvedValue('csv-body');
    taisyakuClient.parseTaisyakuCsv.mockReturnValue(undefined);

    await cappedHandler();

    expect(taisyakuClient.fetchTaisyakuCsv).toHaveBeenCalledTimes(1);
  } finally {
    if (previousEnv === undefined) delete process.env.MAX_GYAKUHIBU_FETCHES_PER_RUN;
    else process.env.MAX_GYAKUHIBU_FETCHES_PER_RUN = previousEnv;
  }
});
```

「skips rights dates older than 3 years」テストは、新実装では`pastRightsDateCandidates`自体が`fromYear = thisYear - MAX_HISTORY_YEARS`より前を生成しないため、同じ意図を確認するには`rightsMonths`に存在しない/計算不能な状況を作るより、**このテストは削除してよい**(3年より古い候補がそもそも生成されないことは`pastRightsDateCandidates`の実装自体で保証されており、個別のテストは冗長になる)。

冒頭の`process.env.YUTAI_RIGHTS_DATE_TABLE_NAME = 'JQuantsYutaiRightsDate';`の行は削除し、代わりに`process.env.YUTAI_MASTER_TABLE_NAME = 'JQuantsYutaiMaster';`が既にあることを確認する(既存のまま残っているはず)。

- [ ] **Step 4: テストを実行して成功することを確認する**

Run: `npx jest test/gyakuhibu-history-batch.test.ts`
Expected: PASS(3 tests: 上記の書き換え後2件+上限テスト1件)

- [ ] **Step 5: コミット**

```bash
git add lambda/gyakuhibu-history-batch/index.ts test/gyakuhibu-history-batch.test.ts
git commit -m "Enumerate past rights dates from rightsMonths with a per-run fetch cap"
```

---

### Task 7: CDKスタックの更新

**Files:**
- Modify: `lib/j-quants-stack.ts`
- Modify: `test/j-quants.test.ts`

**Interfaces:**
- Consumes: `lambda/yutai-master-sync-batch/index.ts`(Task 3)、`lambda/yutai-tdnet-watch-batch/index.ts`(Task 4)

- [ ] **Step 1: `JQuantsYutaiRightsDateTable`の定義を削除する**

`lib/j-quants-stack.ts`のクラスプロパティ宣言から以下の1行を削除する(22行目付近):

```typescript
  public readonly yutaiRightsDateTable: dynamodb.Table;
```

テーブル定義ブロック(76-86行目付近)を丸ごと削除する:

```typescript
    // 銘柄ごとの権利日。年複数回のケースに対応するため1行1権利日で
    // 過去分・将来分を問わずアプリ外から個別投入する。
    this.yutaiRightsDateTable = new dynamodb.Table(this, 'JQuantsYutaiRightsDateTable', {
      tableName: 'JQuantsYutaiRightsDate',
      partitionKey: { name: 'ticker', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'rightsDate', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

```

- [ ] **Step 2: `gyakuhibuHistoryBatchFn`から`YUTAI_RIGHTS_DATE_TABLE_NAME`を外す**

環境変数から以下の1行を削除:

```typescript
        YUTAI_RIGHTS_DATE_TABLE_NAME: this.yutaiRightsDateTable.tableName,
```

grant文から以下の1行を削除:

```typescript
    this.yutaiRightsDateTable.grantReadData(gyakuhibuHistoryBatchFn);
```

- [ ] **Step 3: `referenceApiFn`から`YUTAI_RIGHTS_DATE_TABLE_NAME`を外す**

環境変数から以下の1行を削除:

```typescript
        YUTAI_RIGHTS_DATE_TABLE_NAME: this.yutaiRightsDateTable.tableName,
```

grant文から以下の1行を削除:

```typescript
    this.yutaiRightsDateTable.grantReadData(referenceApiFn);
```

- [ ] **Step 4: `yutai-master-sync-batch`と`yutai-tdnet-watch-batch`の2つのLambdaを追加する**

`GyakuhibuHistoryBatchSchedule`のRule定義の直後、`referenceApiFn`の定義の直前(254-256行目付近)に、以下を挿入する:

```typescript

    const yutaiMasterSyncBatchFn = new nodejs.NodejsFunction(this, 'YutaiMasterSyncBatchFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'yutai-master-sync-batch', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      // kabuyutai.comの月別一覧ページ(12ヶ月×数ページ)を礼儀正しい間隔で走査するため長め。
      // EventBridgeスケジュールは持たず、初回構築時・取りこぼし確認時に手動invokeする運用。
      timeout: cdk.Duration.minutes(14),
      memorySize: 256,
      bundling: { externalModules: ['@aws-sdk/*'] },
      environment: {
        YUTAI_MASTER_TABLE_NAME: this.yutaiMasterTable.tableName,
      },
    });

    this.yutaiMasterTable.grantWriteData(yutaiMasterSyncBatchFn);

    const yutaiTdnetWatchBatchFn = new nodejs.NodejsFunction(this, 'YutaiTdnetWatchBatchFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'yutai-tdnet-watch-batch', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(14),
      memorySize: 256,
      bundling: { externalModules: ['@aws-sdk/*'] },
      environment: {
        YUTAI_MASTER_TABLE_NAME: this.yutaiMasterTable.tableName,
      },
    });

    this.yutaiMasterTable.grantWriteData(yutaiTdnetWatchBatchFn);

    // TDnetの直近開示から株主優待関連の新設・変更・廃止を検知する。既存の週次バッチ
    // (FinancialSummaryBatchSchedule: 月11:00 UTC、MarginBalanceBatchSchedule: 月9:30 UTC)
    // と重ならない時間帯。JST 月曜21:00 = UTC 月曜12:00。
    new events.Rule(this, 'YutaiTdnetWatchBatchSchedule', {
      schedule: events.Schedule.cron({ minute: '0', hour: '12', weekDay: 'MON' }),
      targets: [new targets.LambdaFunction(yutaiTdnetWatchBatchFn)],
    });
```

- [ ] **Step 5: 合成(synth)して構文・スケジュールを確認する**

Run: `APP_PASSWORD=dummy-for-synth npx cdk synth JQuantsStack > /dev/null && echo SYNTH_OK`
Expected: `SYNTH_OK`

Run: `MSYS_NO_PATHCONV=1 APP_PASSWORD=dummy-for-synth npx cdk synth JQuantsStack 2>/dev/null | grep -B5 "ScheduleExpression"`
Expected: `YutaiTdnetWatchBatchSchedule`が`cron(0 12 ? * MON *)`で存在し、`JQuantsYutaiRightsDateTable`関連のリソースが出力に含まれないことを確認する

- [ ] **Step 6: `test/j-quants.test.ts`を更新する**

`JQuantsYutaiRightsDate`テーブルの存在を検証しているテスト(`TableName: 'JQuantsYutaiRightsDate'`を含むテスト)を、`grep -n "YutaiRightsDate" test/j-quants.test.ts`で探して削除する。

`gyakuhibuHistoryBatchFn`・`referenceApiFn`のLambda環境変数を検証しているテストで`YUTAI_RIGHTS_DATE_TABLE_NAME`をアサートしている箇所があれば、その行を削除する(`grep -n "YUTAI_RIGHTS_DATE_TABLE_NAME" test/j-quants.test.ts`で探す)。

新規に以下のテストを追記する(既存のテストの末尾、または関連するテーブル/Lambdaのテストの近くに配置):

```typescript
test('does not create a JQuantsYutaiRightsDate table (removed in favor of computed rights dates)', () => {
  const template = synth();

  const resources = template.findResources('AWS::DynamoDB::Table');
  const tableNames = Object.values(resources).map((r) => (r as { Properties: { TableName: string } }).Properties.TableName);
  expect(tableNames).not.toContain('JQuantsYutaiRightsDate');
});

test('creates the yutai-master-sync-batch Lambda with write access to the yutai master table and no schedule', () => {
  const template = synth();

  template.hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'index.handler',
    Environment: {
      Variables: Match.objectLike({ YUTAI_MASTER_TABLE_NAME: Match.anyValue() }),
    },
  });

  const rules = template.findResources('AWS::Events::Rule');
  const scheduleExpressions = Object.values(rules).map(
    (r) => (r as { Properties?: { ScheduleExpression?: string } }).Properties?.ScheduleExpression,
  );
  // yutai-master-sync-batch自体のスケジュールは存在しない。他バッチの4つのスケジュール
  // (price/financial-summary/margin-balance/gyakuhibu-history)+tdnet-watchの5つのみ。
  expect(scheduleExpressions.filter(Boolean)).toHaveLength(5);
});

test('creates the yutai-tdnet-watch-batch Lambda on a weekly Monday schedule', () => {
  const template = synth();

  template.hasResourceProperties('AWS::Events::Rule', {
    ScheduleExpression: 'cron(0 12 ? * MON *)',
    State: 'ENABLED',
  });
});
```

- [ ] **Step 7: テストスイート全体を実行する**

Run: `npx jest`
Expected: PASS(全テストスイート)

- [ ] **Step 8: コミット**

```bash
git add lib/j-quants-stack.ts test/j-quants.test.ts
git commit -m "Remove JQuantsYutaiRightsDate table, add yutai-master-sync/tdnet-watch Lambdas"
```

---

### Task 8: README更新

**Files:**
- Modify: `README.md`

- [ ] **Step 1: テーブル一覧を更新する**

`JQuantsYutaiRightsDate`の行を削除し、`JQuantsYutaiMaster`の説明を「書き込みはアプリ外」から「`yutai-master-sync-batch`(初回・手動)と`yutai-tdnet-watch-batch`(週次)が自動投入する。`rightsMonths`(権利確定月の配列)を持つ」という趣旨に更新する。

- [ ] **Step 2: Lambda一覧に2つを追加する**

`GyakuhibuHistoryBatchFunction`の行の後に、`YutaiMasterSyncBatchFunction`(トリガー: なし・手動invokeのみ、役割: kabuyutai.comの月別一覧ページから優待実施銘柄を一括取得し`JQuantsYutaiMaster`へupsert)・`YutaiTdnetWatchBatchFunction`(トリガー: `cron(0 12 ? * MON *)` = 毎週月曜JST21:00、役割: TDnetの直近開示から優待関連の新設・変更・廃止を検知し、該当銘柄をkabuyutai.comで再取得して`JQuantsYutaiMaster`へupsert)を追加する。

- [ ] **Step 3: アーキテクチャ図に2つのフローを追加する**

冒頭のアーキテクチャ図(EventBridge〜Lambda〜DynamoDBの矢印表記)に、`yutai-master-sync-batch`(スケジュールなし)・`yutai-tdnet-watch-batch`(週次)のブロックを既存の書式(`EventBridge(...)  → XxxFunction(Lambda)  - 処理内容  → テーブル に upsert`)に合わせて追加する。`yutai-master-sync-batch`はEventBridgeが無いので「(手動invokeのみ)」といった注記にする。

- [ ] **Step 4: 優待クロス機能の説明に、権利日の扱いの変更を追記する**

「優待クロス逆日歩リスク可視化」節に、権利日が`JQuantsYutaiRightsDate`(廃止)への個別投入から`rightsMonths`(権利確定月)+取引カレンダー計算に変わったこと、優待マスタ自体の投入もkabuyutai.com一覧ページからの自動取得(`yutai-master-sync-batch`)とTDnet監視(`yutai-tdnet-watch-batch`)に切り替わったことを追記する。単元株数は一律100株固定である旨も明記する。

- [ ] **Step 5: テストスイート全体を実行する(コード変更はないが安全確認)**

Run: `npx jest`
Expected: PASS(全テストスイート)

- [ ] **Step 6: コミット**

```bash
git add README.md
git commit -m "Document the automated yutai master population (kabuyutai.com sync + TDnet watch)"
```
