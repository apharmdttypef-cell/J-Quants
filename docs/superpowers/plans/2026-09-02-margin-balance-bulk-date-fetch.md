# margin-balance-batch Bulk-Date-Fetch Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace margin-balance-batch's per-ticker J-Quants calls with the same date-only bulk-fetch pattern price-batch already uses, and switch DynamoDB writes to batched (25-item) writes, so the batch's runtime stops scaling with the number of tickers that already have data.

**Architecture:** `data-source.ts` gets two new functions that fetch ALL listed stocks' margin data for a single date (no `code` param). `index.ts` drops its per-ticker loop entirely in favor of looping over a small, fixed set of dates (every Friday in the lookback window, plus today for the daily-alert endpoint), filtering each date's response down to the yutai-tracked tickers, and writing matches via batched `BatchWriteCommand` calls with retry-on-`UnprocessedItems`.

**Tech Stack:** TypeScript, AWS Lambda, DynamoDB (`@aws-sdk/lib-dynamodb`), Jest/ts-jest.

## Global Constraints

- Design spec: `docs/superpowers/specs/2026-09-02-margin-balance-bulk-date-fetch-design.md` — read it for full background/rationale before starting.
- Friday enumeration is simple day-of-week arithmetic (`getUTCDay() === 5`); weeks where J-Quants has no data (e.g. holiday weeks) just return an empty array — no special-casing.
- `hasExistingBalance`, `MAX_BACKFILL_TICKERS_PER_RUN`, `BACKFILL_DAYS`, `DIFF_LOOKBACK_DAYS` are deleted entirely. Replaced by a single `LOOKBACK_DAYS` env var (default 730 = 2 years) used to generate the Friday list on every run, unconditionally.
- `fetchAllDailyAlertBalancesForDate` is only ever called for `today` — no historical backfill for the daily-alert endpoint (matches current behavior).
- No CDK changes needed: `lib/j-quants-stack.ts`'s `MarginBalanceBatchFunction` does not set any of the env vars being removed (confirmed by grep — only code-level defaults were in play).
- `BatchWriteCommand` retry-on-`UnprocessedItems` is required in the production code (not just scripts) — DynamoDB can return partial success silently, and skipping the retry means dropped writes with no error.
- Ticker matching (5-digit `code` from the API vs 4-or-5-digit `ticker` in our tables) reuses price-batch's exact logic: `lambda/price-batch/index.ts`'s `resolveTargetBars` (4-digit prefix match preferring the `'0'`-suffixed common-stock record, plus 5-digit exact match).

---

### Task 1: Switch margin-balance-batch to bulk date-fetch with batched writes

**Files:**
- Modify: `lambda/margin-balance-batch/data-source.ts` (full rewrite)
- Modify: `lambda/margin-balance-batch/index.ts` (full rewrite)
- Modify: `test/margin-balance-batch-data-source.test.ts` (full rewrite)
- Modify: `test/margin-balance-batch.test.ts` (full rewrite)

**Interfaces:**
- Produces: `fetchAllWeeklyBalancesForDate(date: string, apiKey: string): Promise<MarginBalancePoint[]>` and `fetchAllDailyAlertBalancesForDate(date: string, apiKey: string): Promise<MarginBalancePoint[]>` from `data-source.ts`, where `MarginBalancePoint` now includes a `code: string` field (the raw J-Quants code, e.g. `'72030'`) alongside the existing `date`/`financingBalance`/`lendingBalance`/`source`.
- Consumes: `fetchWithRetry`, `normalizeDate` from `../shared/jquants-batch-client` (data-source.ts); `getApiKey` from the same module (index.ts only — data-source.ts no longer manages the API key itself, since `index.ts` now fetches it once and passes it into every call).

- [ ] **Step 1: Write the failing data-source.ts tests**

Replace the full contents of `test/margin-balance-batch-data-source.test.ts` with:

```ts
const mockFetchWithRetry = jest.fn();

jest.mock('../lambda/shared/jquants-batch-client', () => ({
  fetchWithRetry: (...args: unknown[]) => mockFetchWithRetry(...args),
  normalizeDate: (raw: string) => (raw.includes('-') ? raw : `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fetchAllWeeklyBalancesForDate, fetchAllDailyAlertBalancesForDate } = require('../lambda/margin-balance-batch/data-source') as {
  fetchAllWeeklyBalancesForDate: (date: string, apiKey: string) => Promise<unknown[]>;
  fetchAllDailyAlertBalancesForDate: (date: string, apiKey: string) => Promise<unknown[]>;
};

beforeEach(() => {
  mockFetchWithRetry.mockReset();
});

describe('fetchAllWeeklyBalancesForDate', () => {
  test('calls /markets/margin-interest with date only (no code) and maps system-margin fields for every ticker in the response', async () => {
    mockFetchWithRetry.mockResolvedValueOnce({
      json: async () => ({
        data: [
          { Date: '2026-08-28', Code: '72030', LongVol: 225000, ShrtVol: 257400, LongStdVol: 143100, ShrtStdVol: 14600 },
          { Date: '2026-08-28', Code: '13010', LongVol: 5000, ShrtVol: 6000, LongStdVol: 4000, ShrtStdVol: 500 },
        ],
      }),
    });

    const result = await fetchAllWeeklyBalancesForDate('2026-08-28', 'test-api-key');

    expect(mockFetchWithRetry).toHaveBeenCalledTimes(1);
    expect(mockFetchWithRetry).toHaveBeenCalledWith(
      expect.stringContaining('/markets/margin-interest'),
      'test-api-key',
      500,
      5,
    );
    const url = mockFetchWithRetry.mock.calls[0][0] as string;
    expect(url).toContain('date=2026-08-28');
    expect(url).not.toContain('code=');

    expect(result).toEqual([
      { code: '72030', date: '2026-08-28', financingBalance: 143100, lendingBalance: 14600, source: 'weekly' },
      { code: '13010', date: '2026-08-28', financingBalance: 4000, lendingBalance: 500, source: 'weekly' },
    ]);
  });

  test('follows pagination_key across multiple pages', async () => {
    mockFetchWithRetry
      .mockResolvedValueOnce({
        json: async () => ({
          data: [{ Date: '2026-08-28', Code: '72030', LongStdVol: 100, ShrtStdVol: 50 }],
          pagination_key: 'page2',
        }),
      })
      .mockResolvedValueOnce({
        json: async () => ({ data: [{ Date: '2026-08-28', Code: '13010', LongStdVol: 200, ShrtStdVol: 60 }] }),
      });

    const result = await fetchAllWeeklyBalancesForDate('2026-08-28', 'test-api-key');

    expect(mockFetchWithRetry).toHaveBeenCalledTimes(2);
    expect(mockFetchWithRetry.mock.calls[1][0]).toContain('pagination_key=page2');
    expect(result).toHaveLength(2);
  });

  test('normalizes a non-dashed Date field', async () => {
    mockFetchWithRetry.mockResolvedValueOnce({
      json: async () => ({ data: [{ Date: '20260828', Code: '72030', LongStdVol: 100, ShrtStdVol: 50 }] }),
    });

    const result = await fetchAllWeeklyBalancesForDate('2026-08-28', 'test-api-key');

    expect(result[0]).toMatchObject({ date: '2026-08-28' });
  });

  test('returns an empty array when the date has no data', async () => {
    mockFetchWithRetry.mockResolvedValueOnce({ json: async () => ({ data: [] }) });

    const result = await fetchAllWeeklyBalancesForDate('2026-08-28', 'test-api-key');

    expect(result).toEqual([]);
  });

  test('does not throw when the response omits the data field', async () => {
    mockFetchWithRetry.mockResolvedValueOnce({ json: async () => ({}) });

    const result = await fetchAllWeeklyBalancesForDate('2026-08-28', 'test-api-key');

    expect(result).toEqual([]);
  });
});

describe('fetchAllDailyAlertBalancesForDate', () => {
  test('calls /markets/margin-alert with date only (no code) and uses AppDate (not PubDate) as the point date', async () => {
    mockFetchWithRetry.mockResolvedValueOnce({
      json: async () => ({
        data: [
          {
            PubDate: '2026-08-27',
            Code: '72030',
            AppDate: '2026-08-26',
            LongOut: 9000,
            ShrtOut: 1000,
            LongStdOut: 8410,
            ShrtStdOut: 920,
          },
        ],
      }),
    });

    const result = await fetchAllDailyAlertBalancesForDate('2026-08-27', 'test-api-key');

    expect(mockFetchWithRetry).toHaveBeenCalledTimes(1);
    expect(mockFetchWithRetry).toHaveBeenCalledWith(
      expect.stringContaining('/markets/margin-alert'),
      'test-api-key',
      500,
      5,
    );
    const url = mockFetchWithRetry.mock.calls[0][0] as string;
    expect(url).toContain('date=2026-08-27');
    expect(url).not.toContain('code=');

    expect(result).toEqual([
      { code: '72030', date: '2026-08-26', financingBalance: 8410, lendingBalance: 920, source: 'daily-alert' },
    ]);
  });

  test('returns an empty array when no daily-alert data exists for the date', async () => {
    mockFetchWithRetry.mockResolvedValueOnce({ json: async () => ({ data: [] }) });

    const result = await fetchAllDailyAlertBalancesForDate('2026-08-27', 'test-api-key');

    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest margin-balance-batch-data-source.test.ts`
Expected: FAIL — `fetchAllWeeklyBalancesForDate is not a function` (or similar), since `data-source.ts` doesn't export it yet.

- [ ] **Step 3: Implement data-source.ts**

Replace the full contents of `lambda/margin-balance-batch/data-source.ts` with:

```ts
import { fetchWithRetry, normalizeDate } from '../shared/jquants-batch-client';

const API_BASE_URL = process.env.API_BASE_URL ?? 'https://api.jquants.com/v2';
// mkt-margin-int/mkt-margin-alertはStandardプラン専用のエンドポイントのため、
// Freeプラン向けの13秒デフォルトは不要。Standardプランの120req/分を想定した値。
const REQUEST_INTERVAL_MS = Number(process.env.REQUEST_INTERVAL_MS ?? '500');
const MAX_RETRIES = 5;

export interface MarginBalancePoint {
  code: string;
  date: string;
  financingBalance: number;
  lendingBalance: number;
  source: 'weekly' | 'daily-alert';
}

interface MarginIntRecord {
  Date: string;
  Code: string;
  LongStdVol: number;
  ShrtStdVol: number;
}

interface MarginIntResponse {
  data?: MarginIntRecord[];
  pagination_key?: string;
}

interface MarginAlertRecord {
  AppDate: string;
  Code: string;
  LongStdOut: number;
  ShrtStdOut: number;
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
        financingBalance: record.LongStdVol,
        lendingBalance: record.ShrtStdVol,
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
        financingBalance: record.LongStdOut,
        lendingBalance: record.ShrtStdOut,
        source: 'daily-alert',
      });
    }
    paginationKey = body.pagination_key;
  } while (paginationKey);

  return points;
}
```

- [ ] **Step 4: Run data-source.ts tests to verify they pass**

Run: `npx jest margin-balance-batch-data-source.test.ts`
Expected: PASS (7 tests: 5 under `fetchAllWeeklyBalancesForDate`, 2 under `fetchAllDailyAlertBalancesForDate`)

- [ ] **Step 5: Write the failing index.ts tests**

Replace the full contents of `test/margin-balance-batch.test.ts` with:

```ts
const mockSend = jest.fn();
const mockGetApiKey = jest.fn();
const mockFetchAllWeekly = jest.fn();
const mockFetchAllDailyAlert = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  ScanCommand: jest.fn((input: unknown) => ({ ...(input as object), __type: 'Scan' })),
  BatchWriteCommand: jest.fn((input: unknown) => ({ ...(input as object), __type: 'BatchWrite' })),
}));

jest.mock('../lambda/shared/jquants-batch-client', () => ({
  getApiKey: (...args: unknown[]) => mockGetApiKey(...args),
}));

jest.mock('../lambda/margin-balance-batch/data-source', () => ({
  fetchAllWeeklyBalancesForDate: (...args: unknown[]) => mockFetchAllWeekly(...args),
  fetchAllDailyAlertBalancesForDate: (...args: unknown[]) => mockFetchAllDailyAlert(...args),
}));

process.env.YUTAI_MASTER_TABLE_NAME = 'JQuantsYutaiMaster';
process.env.MARGIN_BALANCE_TABLE_NAME = 'JQuantsMarginBalance';
process.env.SECRET_ARN = 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:JQuantsApiKey';
process.env.LOOKBACK_DAYS = '14';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/margin-balance-batch/index') as { handler: () => Promise<void> };

beforeEach(() => {
  mockSend.mockReset();
  mockGetApiKey.mockReset();
  mockFetchAllWeekly.mockReset();
  mockFetchAllDailyAlert.mockReset();

  mockSend.mockResolvedValue({}); // default: BatchWriteCommand succeeds with no UnprocessedItems
  mockGetApiKey.mockResolvedValue('test-api-key');
  mockFetchAllWeekly.mockResolvedValue([]);
  mockFetchAllDailyAlert.mockResolvedValue([]);

  jest.useFakeTimers({
    doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick'],
  }).setSystemTime(new Date('2026-08-28T00:00:00Z')); // a Friday
});

afterEach(() => {
  jest.useRealTimers();
});

test('queries every Friday within LOOKBACK_DAYS and fetches today once for daily-alert', async () => {
  mockSend.mockResolvedValueOnce({ Items: [{ ticker: '7203' }] }); // yutai master scan

  await handler();

  // LOOKBACK_DAYS=14, today=2026-08-28 (Fri) -> Fridays: 08-28, 08-21, 08-14
  expect(mockFetchAllWeekly).toHaveBeenCalledTimes(3);
  const dates = mockFetchAllWeekly.mock.calls.map(([date]) => date);
  expect(dates).toEqual(['2026-08-28', '2026-08-21', '2026-08-14']);
  expect(mockFetchAllWeekly).toHaveBeenCalledWith('2026-08-28', 'test-api-key');

  expect(mockFetchAllDailyAlert).toHaveBeenCalledTimes(1);
  expect(mockFetchAllDailyAlert).toHaveBeenCalledWith('2026-08-28', 'test-api-key');
});

test('writes only target tickers via BatchWriteCommand, matching a 4-digit ticker to its 5-digit code', async () => {
  mockSend.mockResolvedValueOnce({ Items: [{ ticker: '7203' }] }); // yutai master scan
  mockFetchAllWeekly.mockResolvedValue([
    { code: '72030', date: '2026-08-28', financingBalance: 100, lendingBalance: 50, source: 'weekly' },
    { code: '13010', date: '2026-08-28', financingBalance: 999, lendingBalance: 999, source: 'weekly' }, // not a target ticker
  ]);

  await handler();

  const batchWriteCalls = mockSend.mock.calls
    .map(([cmd]) => cmd as Record<string, unknown>)
    .filter((cmd) => cmd.__type === 'BatchWrite');
  expect(batchWriteCalls.length).toBeGreaterThan(0);

  const putItems = batchWriteCalls.flatMap((cmd) => {
    const requestItems = cmd.RequestItems as Record<string, { PutRequest: { Item: Record<string, unknown> } }[]>;
    return requestItems['JQuantsMarginBalance'].map((r) => r.PutRequest.Item);
  });

  expect(putItems).toContainEqual({
    ticker: '7203',
    date: '2026-08-28',
    financingBalance: 100,
    lendingBalance: 50,
    source: 'weekly',
  });
  expect(putItems.some((item) => item.ticker === '13010')).toBe(false);
});

test('retries BatchWriteCommand when UnprocessedItems is returned', async () => {
  let batchWriteCallCount = 0;
  mockSend.mockImplementation((cmd: Record<string, unknown>) => {
    if (cmd.__type === 'Scan') return Promise.resolve({ Items: [{ ticker: '7203' }] });
    if (cmd.__type === 'BatchWrite') {
      batchWriteCallCount += 1;
      if (batchWriteCallCount === 1) {
        const requestItems = cmd.RequestItems as Record<string, unknown[]>;
        const firstItem = requestItems['JQuantsMarginBalance'][0];
        return Promise.resolve({ UnprocessedItems: { JQuantsMarginBalance: [firstItem] } });
      }
      return Promise.resolve({});
    }
    return Promise.resolve({});
  });
  mockFetchAllWeekly.mockResolvedValueOnce([
    { code: '72030', date: '2026-08-28', financingBalance: 100, lendingBalance: 50, source: 'weekly' },
  ]);

  await handler();

  expect(batchWriteCallCount).toBeGreaterThanOrEqual(2);
});

test('does nothing when yutai master is empty', async () => {
  mockSend.mockResolvedValueOnce({ Items: [] });

  await handler();

  expect(mockFetchAllWeekly).not.toHaveBeenCalled();
  expect(mockFetchAllDailyAlert).not.toHaveBeenCalled();
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx jest margin-balance-batch.test.ts`
Expected: FAIL — the old `index.ts` still references `fetchWeeklyBalances`/`fetchDailyAlertBalances` (which no longer exist after Step 3) and the test's mocks (`ScanCommand`/`BatchWriteCommand` shaped, `getApiKey`) don't match the old handler's calls.

- [ ] **Step 7: Implement index.ts**

Replace the full contents of `lambda/margin-balance-batch/index.ts` with:

```ts
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchWriteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { getApiKey } from '../shared/jquants-batch-client';
import { fetchAllWeeklyBalancesForDate, fetchAllDailyAlertBalancesForDate, type MarginBalancePoint } from './data-source';

const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
const MARGIN_BALANCE_TABLE_NAME = process.env.MARGIN_BALANCE_TABLE_NAME!;
const SECRET_ARN = process.env.SECRET_ARN!;
// 週次データを何日分遡って取得するか。デフォルト2年分。price-batchのLOOKBACK_DAYSとは
// 無関係の別Lambda環境変数(このLambda専用)。
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? String(2 * 365));

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getYutaiTickers(): Promise<string[]> {
  const tickers: string[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await ddbDocClient.send(
      new ScanCommand({ TableName: YUTAI_MASTER_TABLE_NAME, ExclusiveStartKey: exclusiveStartKey }),
    );
    for (const item of result.Items ?? []) {
      if (typeof item.ticker === 'string') tickers.push(item.ticker);
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return tickers;
}

// 一括取得したレスポンスのcodeは5桁(例: '72030')。アプリ内のtickerは通常4桁(例: '7203')だが、
// 優先株式等を指定する5桁のticker(例: '72030')もありうる。そのため5桁の完全一致と4桁prefix
// の一致の両方をチェックする(price-batchのresolveTargetBarsと同じ変換)。同じ4桁prefixに
// 複数のcodeが存在する場合(普通株式・優先株式等)は5桁目が'0'(普通株式)のレコードを優先する。
function resolveTargetPoints(points: MarginBalancePoint[], targetTickers: Set<string>): Map<string, MarginBalancePoint> {
  const resolved = new Map<string, MarginBalancePoint>();

  for (const point of points) {
    const isCommonStock = point.code[4] === '0';

    if (targetTickers.has(point.code)) {
      resolved.set(point.code, point);
    }

    const prefix = point.code.slice(0, 4);
    if (targetTickers.has(prefix)) {
      const existing = resolved.get(prefix);
      if (!existing || isCommonStock) {
        resolved.set(prefix, point);
      }
    }
  }

  return resolved;
}

function toItems(matched: Map<string, MarginBalancePoint>): Record<string, unknown>[] {
  return [...matched.entries()].map(([ticker, point]) => ({
    ticker,
    date: point.date,
    financingBalance: point.financingBalance,
    lendingBalance: point.lendingBalance,
    source: point.source,
  }));
}

// DynamoDBのBatchWriteItemは25件までしか受け付けず、スロットリング時はUnprocessedItemsに
// 未処理分を積んで200番台で返す(エラーにはならない)。ここでリトライしないと、書き込みが
// エラーなく黙って欠落する(信用残高テーブルの一括パージ作業で実際に踏んだ不具合と同じ)。
async function batchUpsert(tableName: string, items: Record<string, unknown>[]): Promise<void> {
  for (let i = 0; i < items.length; i += 25) {
    let pending: { PutRequest: { Item: Record<string, unknown> } }[] = items
      .slice(i, i + 25)
      .map((Item) => ({ PutRequest: { Item } }));
    let attempt = 0;

    while (pending.length > 0) {
      const result = await ddbDocClient.send(new BatchWriteCommand({ RequestItems: { [tableName]: pending } }));
      const unprocessed = (result.UnprocessedItems?.[tableName] ?? []) as typeof pending;
      if (unprocessed.length === 0) break;

      attempt += 1;
      if (attempt > 10) {
        throw new Error(`batchUpsert: too many retries, ${unprocessed.length} items still unprocessed`);
      }
      await sleep(Math.min(2000, 100 * 2 ** attempt));
      pending = unprocessed;
    }
  }
}

function listFridays(lookbackDays: number): string[] {
  const fridays: string[] = [];
  for (let offset = 0; offset <= lookbackDays; offset++) {
    const d = new Date(Date.now() - offset * 24 * 60 * 60 * 1000);
    if (d.getUTCDay() === 5) fridays.push(formatDate(d));
  }
  return fridays;
}

export const handler = async (): Promise<void> => {
  const tickers = await getYutaiTickers();
  if (tickers.length === 0) {
    console.warn('Yutai master is empty; nothing to fetch');
    return;
  }
  const targetTickers = new Set(tickers);

  const apiKey = await getApiKey(SECRET_ARN);
  const today = formatDate(new Date());
  const fridays = listFridays(LOOKBACK_DAYS);

  let weeklyUpserted = 0;
  for (const date of fridays) {
    try {
      const points = await fetchAllWeeklyBalancesForDate(date, apiKey);
      const matched = resolveTargetPoints(points, targetTickers);
      await batchUpsert(MARGIN_BALANCE_TABLE_NAME, toItems(matched));
      weeklyUpserted += matched.size;
      console.log(`${date}: matched ${matched.size} of ${targetTickers.size} target tickers (weekly)`);
    } catch (error) {
      console.error(`${date}: failed to fetch/upsert weekly margin balances`, error);
    }
  }

  let dailyAlertUpserted = 0;
  try {
    const alertPoints = await fetchAllDailyAlertBalancesForDate(today, apiKey);
    const matchedAlerts = resolveTargetPoints(alertPoints, targetTickers);
    await batchUpsert(MARGIN_BALANCE_TABLE_NAME, toItems(matchedAlerts));
    dailyAlertUpserted = matchedAlerts.size;
    console.log(`${today}: matched ${matchedAlerts.size} of ${targetTickers.size} target tickers (daily-alert)`);
  } catch (error) {
    console.error(`${today}: failed to fetch/upsert daily-alert margin balances`, error);
  }

  console.log(
    `margin-balance-batch: ${fridays.length} weekly dates processed, ${weeklyUpserted} weekly points upserted, ${dailyAlertUpserted} daily-alert points upserted (of ${targetTickers.size} target tickers)`,
  );
};
```

- [ ] **Step 8: Run index.ts tests to verify they pass**

Run: `npx jest margin-balance-batch.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 9: Run the full test suite**

Run: `npx jest`
Expected: PASS, all suites (the known Windows esbuild-worker-teardown flake — a suite-level warning with 0 failed individual tests — is expected and not a real failure; anything else failing needs investigation before continuing)

- [ ] **Step 10: Run the type-check build**

Run: `npm run build`
Expected: clean, no errors (this also confirms nothing else in the codebase still imports the deleted `fetchWeeklyBalances`/`fetchDailyAlertBalances`/`hasExistingBalance` symbols)

- [ ] **Step 11: Commit**

```bash
git add lambda/margin-balance-batch/data-source.ts lambda/margin-balance-batch/index.ts test/margin-balance-batch-data-source.test.ts test/margin-balance-batch.test.ts
git commit -m "Switch margin-balance-batch to bulk date-fetch with batched writes

Replaces the per-ticker mkt-margin-int/mkt-margin-alert calls with the
same date-only bulk-fetch pattern price-batch uses (code omitted,
date specified -> all listed stocks in one call), and switches
DynamoDB writes to batched BatchWriteCommand calls (25/batch, with
retry on UnprocessedItems). Removes hasExistingBalance,
MAX_BACKFILL_TICKERS_PER_RUN, BACKFILL_DAYS, and DIFF_LOOKBACK_DAYS
entirely -- every run now unconditionally fetches every Friday in the
LOOKBACK_DAYS window (default 2 years) plus today's daily-alert
snapshot, so runtime no longer scales with how many tickers already
have data.

Empirically confirmed today that the old per-ticker design's runtime
grows with the number of tickers that already have real data (since
diff-updates aren't capped), and hits the 14min Lambda timeout at
scale -- permanently starving the tail of the ticker list. See
docs/superpowers/specs/2026-09-02-margin-balance-bulk-date-fetch-design.md."
```
