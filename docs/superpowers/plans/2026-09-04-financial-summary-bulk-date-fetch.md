# financial-summary-batch Bulk-Date-Fetch Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix financial-summary-batch's confirmed production timeout (GitHub Issue #2) by splitting it into new-ticker backfill (unchanged, capped per run) and existing-ticker updates (switched to date-only bulk fetch), and extract the batch-write-with-retry helper margin-balance-batch already has so it isn't reimplemented a second time.

**Architecture:** A new `lambda/shared/dynamodb-batch.ts` holds the `batchUpsert` helper (moved from margin-balance-batch, unchanged behavior). `financial-summary-batch/index.ts` classifies each target ticker as new (no existing `JQuantsFinancialSummary` row) or existing, backfills new tickers via the existing `code`-only full-history call (capped per run), and checks the last `LOOKBACK_DAYS` calendar days via `date`-only bulk fetch (all listed companies in one call per date) for every target ticker regardless of backfill status.

**Tech Stack:** TypeScript, AWS Lambda, DynamoDB (`@aws-sdk/lib-dynamodb`), Jest/ts-jest.

## Global Constraints

- Design spec: `docs/superpowers/specs/2026-09-04-financial-summary-bulk-date-fetch-design.md` — read it for full background/rationale before starting.
- `/fins/summary` has no `from`/`to` range parameter. `date`-only bulk mode returns only records disclosed on that exact day — it cannot backfill historical quarters. Full-history backfill must stay `code`-only, per-ticker.
- `MAX_BACKFILL_TICKERS_PER_RUN` default 150 (same value as margin-balance-batch's now-removed constant of the same name — chosen for consistency, not because the two batches' per-ticker cost is identical).
- `LOOKBACK_DAYS` default 14 (double the weekly 7-day run interval, to tolerate a missed run or a holiday).
- `REQUEST_INTERVAL_MS` default changes from `13000` to `1000` (Standard plan's financial-statement-specific rate limit is 60 req/min = 1000ms; the old default assumed Free plan's 5 req/min).
- Date-only bulk fetch checks every calendar day in the lookback window (no trading-day filtering) — a weekend/holiday with no disclosures just returns an empty array, which is harmless.
- Existing (already-backfilled) tickers are still checked in the date-bulk loop every run — there is no "steady-state" tier that skips them, since the date-bulk cost doesn't scale with ticker count.
- Ticker matching (5-digit API `Code` vs 4-or-5-digit `ticker`) reuses `lambda/price-batch/index.ts`'s `resolveTargetBars` logic (4-digit prefix match preferring the `'0'`-suffixed common-stock record, plus 5-digit exact match) — duplicated into this file, matching this project's established convention (the same logic is already independently duplicated in `price-batch` and `margin-balance-batch`).
- No CDK schedule/timeout changes: weekly cadence and 14-minute timeout stay as-is. Only add `financialSummaryTable.grantReadData(financialSummaryBatchFn)` (needed for the new per-ticker existence check; currently only `grantWriteData` is granted).

---

### Task 1: Extract `batchUpsert` into `lambda/shared/dynamodb-batch.ts`

**Files:**
- Create: `lambda/shared/dynamodb-batch.ts`
- Create: `test/dynamodb-batch.test.ts`
- Modify: `lambda/margin-balance-batch/index.ts`

**Interfaces:**
- Produces: `batchUpsert(ddbDocClient: DynamoDBDocumentClient, tableName: string, items: Record<string, unknown>[]): Promise<void>` — exported from `lambda/shared/dynamodb-batch.ts`. Task 2's `financial-summary-batch/index.ts` will import this same function.

- [ ] **Step 1: Write the failing test for the extracted helper**

Create `test/dynamodb-batch.test.ts` with this exact content:

```ts
const mockSend = jest.fn();

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  BatchWriteCommand: jest.fn((input: unknown) => ({ ...(input as object), __type: 'BatchWrite' })),
}));
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { batchUpsert } = require('../lambda/shared/dynamodb-batch') as {
  batchUpsert: (ddbDocClient: unknown, tableName: string, items: Record<string, unknown>[]) => Promise<void>;
};

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

beforeEach(() => {
  mockSend.mockReset();
});

test('writes items in batches of 25', async () => {
  mockSend.mockResolvedValue({});
  const items = Array.from({ length: 30 }, (_, i) => ({ id: i }));

  await batchUpsert(ddbDocClient, 'MyTable', items);

  expect(mockSend).toHaveBeenCalledTimes(2);
  const firstBatch = mockSend.mock.calls[0][0] as { RequestItems: Record<string, unknown[]> };
  expect(firstBatch.RequestItems.MyTable).toHaveLength(25);
  const secondBatch = mockSend.mock.calls[1][0] as { RequestItems: Record<string, unknown[]> };
  expect(secondBatch.RequestItems.MyTable).toHaveLength(5);
});

test('does nothing (no send calls) when items is empty', async () => {
  await batchUpsert(ddbDocClient, 'MyTable', []);
  expect(mockSend).not.toHaveBeenCalled();
});

test('retries when UnprocessedItems is returned, until it succeeds', async () => {
  let callCount = 0;
  mockSend.mockImplementation((cmd: { RequestItems: Record<string, unknown[]> }) => {
    callCount++;
    if (callCount === 1) {
      const firstItem = cmd.RequestItems.MyTable[0];
      return Promise.resolve({ UnprocessedItems: { MyTable: [firstItem] } });
    }
    return Promise.resolve({});
  });

  await batchUpsert(ddbDocClient, 'MyTable', [{ id: 1 }]);

  expect(callCount).toBeGreaterThanOrEqual(2);
});

test('throws after more than 10 retries', async () => {
  jest.useFakeTimers();
  try {
    mockSend.mockImplementation((cmd: { RequestItems: Record<string, unknown[]> }) => {
      const item = cmd.RequestItems.MyTable[0];
      return Promise.resolve({ UnprocessedItems: { MyTable: [item] } });
    });

    const promise = batchUpsert(ddbDocClient, 'MyTable', [{ id: 1 }]);
    // rejects.toThrow()を先に呼んでpromiseにハンドラを同期的に付けてから
    // runAllTimersAsync()でリトライを進める。逆順だとfake timersが
    // マイクロタスクをフラッシュしてpromiseが先に(未ハンドラのまま)rejectし、
    // Jestがテスト失敗として扱うPromiseRejectionHandledWarningが出る。
    const assertion = expect(promise).rejects.toThrow('too many retries');
    await jest.runAllTimersAsync();
    await assertion;
  } finally {
    jest.useRealTimers();
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest dynamodb-batch.test.ts`
Expected: FAIL — `Cannot find module '../lambda/shared/dynamodb-batch'`.

- [ ] **Step 3: Create `lambda/shared/dynamodb-batch.ts`**

```ts
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// DynamoDBのBatchWriteItemは25件までしか受け付けず、スロットリング時はUnprocessedItemsに
// 未処理分を積んで200番台で返す(エラーにはならない)。ここでリトライしないと、書き込みが
// エラーなく黙って欠落する(margin-balance-batchのテーブル一括パージ作業で実際に踏んだ不具合と同じ)。
export async function batchUpsert(
  ddbDocClient: DynamoDBDocumentClient,
  tableName: string,
  items: Record<string, unknown>[],
): Promise<void> {
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
```

- [ ] **Step 4: Run to verify the new test passes**

Run: `npx jest dynamodb-batch.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Update `lambda/margin-balance-batch/index.ts` to use the extracted helper**

Replace the full contents of `lambda/margin-balance-batch/index.ts` with:

```ts
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { getApiKey } from '../shared/jquants-batch-client';
import { batchUpsert } from '../shared/dynamodb-batch';
import { fetchAllWeeklyBalancesForDate, fetchAllDailyAlertBalancesForDate, type MarginBalancePoint } from './data-source';

const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
const MARGIN_BALANCE_TABLE_NAME = process.env.MARGIN_BALANCE_TABLE_NAME!;
const SECRET_ARN = process.env.SECRET_ARN!;
// 週次データを何日分遡って取得するか。デフォルト2年分。price-batchのLOOKBACK_DAYSとは
// 無関係の別Lambda環境変数(このLambda専用)。
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? String(2 * 365));
if (!Number.isFinite(LOOKBACK_DAYS) || LOOKBACK_DAYS < 0) {
  throw new Error(`margin-balance-batch: invalid LOOKBACK_DAYS env var: ${process.env.LOOKBACK_DAYS}`);
}

// DynamoDBのデフォルト設定はundefinedなプロパティを持つアイテムの書き込みで例外を投げる。
// 全上場銘柄が対象の一括取得では値欠損レコードが混ざりうるため(data-source.tsでnullに
// 変換済みだが念のための防御)、undefinedのプロパティは書き込み時に自動的に取り除く。
const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
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

function listFridays(lookbackDays: number, now: number): string[] {
  const fridays: string[] = [];
  for (let offset = 0; offset <= lookbackDays; offset++) {
    const d = new Date(now - offset * 24 * 60 * 60 * 1000);
    if (d.getUTCDay() === 5) fridays.push(formatIsoDate(d));
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
  const now = Date.now();
  const today = formatIsoDate(new Date(now));
  const fridays = listFridays(LOOKBACK_DAYS, now);

  // 直近のデータ(daily-alert)ほど鮮度の価値が高いため、実行が遅延・打ち切りに
  // なった場合でも最優先で確保されるよう、過去分の週次ループより先に処理する。
  let dailyAlertUpserted = 0;
  let dailyAlertFailed = false;
  try {
    const alertPoints = await fetchAllDailyAlertBalancesForDate(today, apiKey);
    const matchedAlerts = resolveTargetPoints(alertPoints, targetTickers);
    await batchUpsert(ddbDocClient, MARGIN_BALANCE_TABLE_NAME, toItems(matchedAlerts));
    dailyAlertUpserted = matchedAlerts.size;
    console.log(`${today}: matched ${matchedAlerts.size} of ${targetTickers.size} target tickers (daily-alert)`);
  } catch (error) {
    dailyAlertFailed = true;
    console.error(`${today}: failed to fetch/upsert daily-alert margin balances`, error);
  }

  let weeklyUpserted = 0;
  let weeklyFailed = 0;
  for (const date of fridays) {
    try {
      const points = await fetchAllWeeklyBalancesForDate(date, apiKey);
      const matched = resolveTargetPoints(points, targetTickers);
      await batchUpsert(ddbDocClient, MARGIN_BALANCE_TABLE_NAME, toItems(matched));
      weeklyUpserted += matched.size;
      console.log(`${date}: matched ${matched.size} of ${targetTickers.size} target tickers (weekly)`);
    } catch (error) {
      weeklyFailed += 1;
      console.error(`${date}: failed to fetch/upsert weekly margin balances`, error);
    }
  }

  console.log(
    `margin-balance-batch: ${fridays.length} weekly dates processed, ${weeklyUpserted} weekly points upserted, ${dailyAlertUpserted} daily-alert points upserted (of ${targetTickers.size} target tickers)`,
  );

  // 全呼び出しが失敗、または失敗ゼロなのに1件もマッチしなかった場合は、日付パラメータの
  // 意味やAPIキーなど構造的な問題を疑い、例外を投げてCloudWatch/EventBridgeにエラーとして
  // 見えるようにする(handlerが常にresolveすると、全滅していても実行は"成功"に見えてしまう)。
  const totalAttempted = fridays.length + 1;
  const totalFailed = weeklyFailed + (dailyAlertFailed ? 1 : 0);
  if (totalFailed === totalAttempted) {
    throw new Error(`margin-balance-batch: all ${totalAttempted} fetch/upsert calls failed`);
  }
  if (weeklyUpserted === 0 && dailyAlertUpserted === 0 && totalFailed === 0) {
    throw new Error(
      `margin-balance-batch: 0 points matched across ${fridays.length} weekly dates + daily-alert despite no fetch failures (of ${targetTickers.size} target tickers)`,
    );
  }
};
```

The only changes from the current file: `BatchWriteCommand` import removed from `@aws-sdk/lib-dynamodb`; added `import { batchUpsert } from '../shared/dynamodb-batch';`; removed the local `sleep` function (no longer used in this file); removed the local `batchUpsert` function; both call sites now pass `ddbDocClient` as the first argument.

- [ ] **Step 6: Verify `test/margin-balance-batch.test.ts` still passes unmodified**

This test file mocks the whole `@aws-sdk/lib-dynamodb` module (including `BatchWriteCommand`), and that mock applies module-wide regardless of which file (`index.ts` or the new `dynamodb-batch.ts`) does the importing — so no changes to this test file should be needed.

Run: `npx jest margin-balance-batch.test.ts`
Expected: PASS (all existing tests, unchanged)

- [ ] **Step 7: Run the full test suite and build**

Run: `npx jest`
Expected: PASS, all suites (the known Windows esbuild-worker-teardown flake — a suite-level warning with 0 failed individual tests — is expected and not a real failure)

Run: `npm run build`
Expected: clean, no errors

- [ ] **Step 8: Commit**

```bash
git add lambda/shared/dynamodb-batch.ts lambda/margin-balance-batch/index.ts test/dynamodb-batch.test.ts
git commit -m "Extract batchUpsert into lambda/shared/dynamodb-batch.ts

margin-balance-batch's BatchWriteCommand-with-UnprocessedItems-retry
helper is about to be needed by financial-summary-batch too. Extract
it to a shared module now rather than reimplementing the same subtle
retry logic a second time -- unlike most small per-file duplication
in this codebase, getting retry-on-UnprocessedItems wrong silently
drops writes with no error, so this one is worth sharing.

No behavior change: margin-balance-batch now imports batchUpsert
instead of defining it locally, passing its own ddbDocClient in.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Split financial-summary-batch into backfill + bulk-date-fetch modes

**Files:**
- Modify: `lambda/financial-summary-batch/index.ts` (full rewrite)
- Modify: `test/financial-summary-batch.test.ts` (full rewrite)
- Modify: `lib/j-quants-stack.ts` (add one `grantReadData` line)

**Interfaces:**
- Consumes: `batchUpsert(ddbDocClient, tableName, items)` from `../shared/dynamodb-batch` (produced by Task 1 — Task 1 must be complete and committed before starting this task).
- Consumes: `getApiKey`, `getTargetTickers`, `fetchWithRetry`, `normalizeDate` from `../shared/jquants-batch-client` (unchanged from current file).

- [ ] **Step 1: Write the failing tests**

Replace the full contents of `test/financial-summary-batch.test.ts` with:

```ts
const mockDdbSend = jest.fn();
const mockGetApiKey = jest.fn();
const mockGetTargetTickers = jest.fn();
const mockFetchWithRetry = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  QueryCommand: jest.fn((input: unknown) => ({ ...(input as object), __type: 'Query' })),
  BatchWriteCommand: jest.fn((input: unknown) => ({ ...(input as object), __type: 'BatchWrite' })),
}));

jest.mock('../lambda/shared/jquants-batch-client', () => ({
  getApiKey: (...args: unknown[]) => mockGetApiKey(...args),
  getTargetTickers: (...args: unknown[]) => mockGetTargetTickers(...args),
  fetchWithRetry: (...args: unknown[]) => mockFetchWithRetry(...args),
  normalizeDate: (raw: string) => (raw.includes('-') ? raw : `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`),
}));

process.env.FINANCIAL_TABLE_NAME = 'JQuantsFinancialSummary';
process.env.WATCHLIST_TABLE_NAME = 'JQuantsWatchlist';
process.env.YUTAI_MASTER_TABLE_NAME = 'JQuantsYutaiMaster';
process.env.SECRET_ARN = 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:JQuantsApiKey';
process.env.LOOKBACK_DAYS = '3';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/financial-summary-batch/index') as { handler: () => Promise<void> };

function putItems(): Record<string, unknown>[] {
  return mockDdbSend.mock.calls
    .map(([cmd]) => cmd as Record<string, unknown>)
    .filter((cmd) => cmd.__type === 'BatchWrite')
    .flatMap((cmd) => {
      const requestItems = cmd.RequestItems as Record<string, { PutRequest: { Item: Record<string, unknown> } }[]>;
      return requestItems['JQuantsFinancialSummary'].map((r) => r.PutRequest.Item);
    });
}

beforeEach(() => {
  mockDdbSend.mockReset();
  mockGetApiKey.mockReset();
  mockGetTargetTickers.mockReset();
  mockFetchWithRetry.mockReset();

  mockDdbSend.mockResolvedValue({}); // default: Query -> no existing item, BatchWrite -> success
  mockGetApiKey.mockResolvedValue('test-api-key');
  mockFetchWithRetry.mockResolvedValue({ json: async () => ({ data: [] }) });
});

test('does nothing when there are no target tickers', async () => {
  mockGetTargetTickers.mockResolvedValueOnce([]);

  await handler();

  expect(mockGetApiKey).not.toHaveBeenCalled();
  expect(mockFetchWithRetry).not.toHaveBeenCalled();
});

test('backfills a new ticker (no existing summary) using a code-only full-history fetch', async () => {
  mockGetTargetTickers.mockResolvedValueOnce(['7203']);
  mockDdbSend.mockImplementation((cmd: Record<string, unknown>) => {
    if (cmd.__type === 'Query') return Promise.resolve({ Items: [] }); // no existing summary -> new ticker
    return Promise.resolve({});
  });
  mockFetchWithRetry.mockImplementation((url: string) => {
    if (url.includes('code=7203')) {
      return Promise.resolve({
        json: async () => ({
          data: [
            {
              Code: '72030',
              DiscDate: '2026-05-08',
              DocType: 'FYFinancialStatements_Consolidated_IFRS',
              CurPerType: 'FY',
              Sales: '45095325000000',
              OP: '4795586000000',
              OdP: '',
              NP: '4765002000000',
              EPS: '345.42',
            },
          ],
        }),
      });
    }
    return Promise.resolve({ json: async () => ({ data: [] }) });
  });

  await handler();

  const backfillCall = mockFetchWithRetry.mock.calls.find(([url]) => (url as string).includes('code=7203'));
  expect(backfillCall).toBeDefined();
  expect(putItems()).toContainEqual(
    expect.objectContaining({ ticker: '7203', discDate: '2026-05-08', sales: '45095325000000' }),
  );
});

test('does not backfill an existing ticker (already has a summary)', async () => {
  mockGetTargetTickers.mockResolvedValueOnce(['7203']);
  mockDdbSend.mockImplementation((cmd: Record<string, unknown>) => {
    if (cmd.__type === 'Query') return Promise.resolve({ Items: [{ ticker: '7203', discDate: '2026-02-01' }] });
    return Promise.resolve({});
  });

  await handler();

  const backfillCall = mockFetchWithRetry.mock.calls.find(([url]) => (url as string).includes('code=7203'));
  expect(backfillCall).toBeUndefined();
});

test('checks LOOKBACK_DAYS+1 recent dates with date-only bulk fetch (no code param)', async () => {
  mockGetTargetTickers.mockResolvedValueOnce(['7203']);

  await handler();

  const dateCalls = mockFetchWithRetry.mock.calls.filter(([url]) => (url as string).includes('date='));
  expect(dateCalls).toHaveLength(4); // LOOKBACK_DAYS=3 -> offsets 0..3
  for (const [url] of dateCalls) {
    expect(url as string).not.toContain('code=');
  }
});

test('writes only target tickers from a date-bulk response, matching a 4-digit ticker to its 5-digit code', async () => {
  mockGetTargetTickers.mockResolvedValueOnce(['7203']);
  mockFetchWithRetry.mockImplementation((url: string) => {
    if (url.includes('date=')) {
      return Promise.resolve({
        json: async () => ({
          data: [
            {
              Code: '72030',
              DiscDate: '2026-08-01',
              DocType: 'FYFinancialStatements_Consolidated_IFRS',
              CurPerType: 'FY',
              Sales: '100',
              OP: '10',
              OdP: '9',
              NP: '8',
              EPS: '1.0',
            },
            {
              Code: '13010',
              DiscDate: '2026-08-01',
              DocType: 'FYFinancialStatements_Consolidated_IFRS',
              CurPerType: 'FY',
              Sales: '999',
              OP: '99',
              OdP: '98',
              NP: '97',
              EPS: '9.0',
            },
          ],
        }),
      });
    }
    return Promise.resolve({ json: async () => ({ data: [] }) });
  });

  await handler();

  const items = putItems();
  expect(items).toContainEqual(expect.objectContaining({ ticker: '7203', sales: '100' }));
  expect(items.some((item) => item.ticker === '13010')).toBe(false);
});

test('defers new-ticker backfills beyond the per-run cap, but still checks recent dates for everyone', async () => {
  const manyNewTickers = Array.from({ length: 151 }, (_, i) => `T${String(i).padStart(4, '0')}`);
  mockGetTargetTickers.mockResolvedValueOnce(manyNewTickers);
  mockDdbSend.mockImplementation((cmd: Record<string, unknown>) => {
    if (cmd.__type === 'Query') return Promise.resolve({ Items: [] }); // all are new
    return Promise.resolve({});
  });

  await handler();

  const backfillCalls = mockFetchWithRetry.mock.calls.filter(([url]) => (url as string).includes('code='));
  expect(backfillCalls).toHaveLength(150);
  const dateCalls = mockFetchWithRetry.mock.calls.filter(([url]) => (url as string).includes('date='));
  expect(dateCalls).toHaveLength(4);
});

test('continues past a single ticker backfill failure and a single date fetch failure', async () => {
  mockGetTargetTickers.mockResolvedValueOnce(['7203', '9999']);
  mockDdbSend.mockImplementation((cmd: Record<string, unknown>) => {
    if (cmd.__type === 'Query') return Promise.resolve({ Items: [] });
    return Promise.resolve({});
  });
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    let dateCallCount = 0;
    mockFetchWithRetry.mockImplementation((url: string) => {
      if (url.includes('code=7203')) return Promise.reject(new Error('boom'));
      if (url.includes('code=9999')) return Promise.resolve({ json: async () => ({ data: [] }) });
      if (url.includes('date=')) {
        dateCallCount++;
        if (dateCallCount === 1) return Promise.reject(new Error('date boom'));
        return Promise.resolve({ json: async () => ({ data: [] }) });
      }
      return Promise.resolve({ json: async () => ({ data: [] }) });
    });

    await handler();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('7203'), expect.any(Error));
  } finally {
    errorSpy.mockRestore();
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest financial-summary-batch.test.ts`
Expected: FAIL — the old handler doesn't classify new-vs-existing tickers, doesn't call `date=`-only bulk fetch, and the mocked `QueryCommand`/`BatchWriteCommand` shapes don't match what the old handler does (`PutCommand` per row).

- [ ] **Step 3: Implement `lambda/financial-summary-batch/index.ts`**

Replace the full contents with:

```ts
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { getApiKey, getTargetTickers, fetchWithRetry, normalizeDate } from '../shared/jquants-batch-client';
import { batchUpsert } from '../shared/dynamodb-batch';

const FINANCIAL_TABLE_NAME = process.env.FINANCIAL_TABLE_NAME!;
const WATCHLIST_TABLE_NAME = process.env.WATCHLIST_TABLE_NAME!;
const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
const SECRET_ARN = process.env.SECRET_ARN!;
const API_BASE_URL = process.env.API_BASE_URL ?? 'https://api.jquants.com/v2';
// Standardプランの決算系エンドポイント専用レート制限(60req/分)を想定した値
// (一般エンドポイントの120req/分とは別枠)。旧デフォルト13000msはFreeプラン5req/分の
// 想定のままだった。
const REQUEST_INTERVAL_MS = Number(process.env.REQUEST_INTERVAL_MS ?? '1000');
const MAX_RETRIES = 5;
// 新規銘柄1件の初回バックフィルは全期間分の逐次書き込みを伴うため、YutaiMasterへの
// 一括追加(kabuyutai優待抽出の改善による再取得等)直後は対象銘柄が一気に膨らみ、
// 14分のタイムアウト内に完走できなくなる。新規バックフィルの件数だけ実行あたりに
// 上限を設け、残りは次回実行に持ち越す(継続更新は一括取得で軽いので上限の対象外)。
const MAX_BACKFILL_TICKERS_PER_RUN = Number(process.env.MAX_BACKFILL_TICKERS_PER_RUN ?? '150');
// 決算発表は不定期に集中するため、週次実行(7日間隔)に対して2倍のバッファを持たせる。
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? '14');

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

interface FinancialSummary {
  Code: string;
  DiscDate: string;
  DocType: string;
  CurPerType: string;
  Sales: string;
  OP: string;
  OdP: string;
  NP: string;
  EPS: string;
}

interface FinancialSummaryResponse {
  data?: FinancialSummary[];
  pagination_key?: string;
}

function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function hasExistingSummary(ticker: string): Promise<boolean> {
  const result = await ddbDocClient.send(
    new QueryCommand({
      TableName: FINANCIAL_TABLE_NAME,
      KeyConditionExpression: 'ticker = :ticker',
      ExpressionAttributeValues: { ':ticker': ticker },
      Limit: 1,
    }),
  );
  return (result.Items ?? []).length > 0;
}

// 新規銘柄の初回バックフィル用。codeのみ指定(dateなし)で全期間分を取得する
// (/fins/summaryにfrom/toのような期間範囲パラメータは無いため、全期間分をこの形で
// 取得するのが唯一の方法)。
async function fetchAllSummariesForTicker(ticker: string, apiKey: string): Promise<FinancialSummary[]> {
  const summaries: FinancialSummary[] = [];
  let paginationKey: string | undefined;

  do {
    const params = new URLSearchParams({ code: ticker });
    if (paginationKey) params.set('pagination_key', paginationKey);

    const response = await fetchWithRetry(`${API_BASE_URL}/fins/summary?${params}`, apiKey, REQUEST_INTERVAL_MS, MAX_RETRIES);
    const body = (await response.json()) as FinancialSummaryResponse;
    summaries.push(...(body.data ?? []));
    paginationKey = body.pagination_key;
  } while (paginationKey);

  return summaries;
}

// 既存銘柄の継続更新用。codeを付けずdateのみ指定すると、その日に開示された全上場銘柄分の
// データが1回のリクエストで返る(price-batchのfetchAllBarsForDateと同じパターン)。
async function fetchAllSummariesForDate(date: string, apiKey: string): Promise<FinancialSummary[]> {
  const summaries: FinancialSummary[] = [];
  let paginationKey: string | undefined;

  do {
    const params = new URLSearchParams({ date });
    if (paginationKey) params.set('pagination_key', paginationKey);

    const response = await fetchWithRetry(`${API_BASE_URL}/fins/summary?${params}`, apiKey, REQUEST_INTERVAL_MS, MAX_RETRIES);
    const body = (await response.json()) as FinancialSummaryResponse;
    summaries.push(...(body.data ?? []));
    paginationKey = body.pagination_key;
  } while (paginationKey);

  return summaries;
}

// 一括取得したレスポンスのCodeは5桁(例: '72030')。アプリ内のtickerは通常4桁(例: '7203')だが、
// 優先株式等を指定する5桁のticker(例: '72030')もありうる。そのため5桁の完全一致と4桁prefix
// の一致の両方をチェックする(price-batchのresolveTargetBarsと同じ変換)。同じ4桁prefixに
// 複数のcodeが存在する場合(普通株式・優先株式等)は5桁目が'0'(普通株式)のレコードを優先する。
function resolveTargetSummaries(summaries: FinancialSummary[], targetTickers: Set<string>): Map<string, FinancialSummary> {
  const resolved = new Map<string, FinancialSummary>();

  for (const summary of summaries) {
    const isCommonStock = summary.Code[4] === '0';

    if (targetTickers.has(summary.Code)) {
      resolved.set(summary.Code, summary);
    }

    const prefix = summary.Code.slice(0, 4);
    if (targetTickers.has(prefix)) {
      const existing = resolved.get(prefix);
      if (!existing || isCommonStock) {
        resolved.set(prefix, summary);
      }
    }
  }

  return resolved;
}

// 桁数が大きく精度が必要なためAPIが返す文字列のまま保持する。
function toItem(ticker: string, summary: FinancialSummary, updatedAt: string): Record<string, unknown> {
  return {
    ticker,
    discDate: normalizeDate(summary.DiscDate),
    docType: summary.DocType,
    curPerType: summary.CurPerType,
    sales: summary.Sales,
    operatingProfit: summary.OP,
    ordinaryProfit: summary.OdP,
    netProfit: summary.NP,
    eps: summary.EPS,
    updated_at: updatedAt,
  };
}

function listRecentDates(lookbackDays: number, now: number): string[] {
  const dates: string[] = [];
  for (let offset = 0; offset <= lookbackDays; offset++) {
    dates.push(formatIsoDate(new Date(now - offset * 24 * 60 * 60 * 1000)));
  }
  return dates;
}

export const handler = async (): Promise<void> => {
  const tickers = await getTargetTickers(WATCHLIST_TABLE_NAME, YUTAI_MASTER_TABLE_NAME);
  if (tickers.length === 0) {
    console.warn('No target tickers (watchlist and yutai master are both empty); nothing to fetch');
    return;
  }
  const targetTickers = new Set(tickers);

  const apiKey = await getApiKey(SECRET_ARN);

  const newTickers: string[] = [];
  for (const ticker of tickers) {
    if (!(await hasExistingSummary(ticker))) newTickers.push(ticker);
  }

  let backfilled = 0;
  let deferred = 0;
  let backfillFailed = 0;
  for (const ticker of newTickers) {
    if (backfilled >= MAX_BACKFILL_TICKERS_PER_RUN) {
      deferred++;
      continue;
    }
    try {
      const summaries = await fetchAllSummariesForTicker(ticker, apiKey);
      const updatedAt = new Date().toISOString();
      await batchUpsert(ddbDocClient, FINANCIAL_TABLE_NAME, summaries.map((s) => toItem(ticker, s, updatedAt)));
      backfilled++;
      console.log(`${ticker}: backfilled ${summaries.length} financial summaries`);
    } catch (error) {
      backfillFailed++;
      console.error(`${ticker}: failed to backfill financial summaries`, error);
    }
  }

  const dates = listRecentDates(LOOKBACK_DAYS, Date.now());
  let dateUpdated = 0;
  let dateFailed = 0;
  for (const date of dates) {
    try {
      const summaries = await fetchAllSummariesForDate(date, apiKey);
      const matched = resolveTargetSummaries(summaries, targetTickers);
      const updatedAt = new Date().toISOString();
      const items = [...matched.entries()].map(([ticker, summary]) => toItem(ticker, summary, updatedAt));
      await batchUpsert(ddbDocClient, FINANCIAL_TABLE_NAME, items);
      dateUpdated += matched.size;
      console.log(`${date}: matched ${matched.size} of ${targetTickers.size} target tickers (disclosed that day)`);
    } catch (error) {
      dateFailed++;
      console.error(`${date}: failed to fetch/upsert financial summaries`, error);
    }
  }

  console.log(
    `financial-summary-batch: ${backfilled} new tickers backfilled, ${deferred} deferred (backfill cap reached), ${backfillFailed} backfill failures (of ${newTickers.length} new); ${dates.length} recent dates checked, ${dateUpdated} points updated, ${dateFailed} date fetch failures (of ${targetTickers.size} target tickers)`,
  );
};
```

- [ ] **Step 4: Run to verify the tests pass**

Run: `npx jest financial-summary-batch.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Update `lib/j-quants-stack.ts`**

Find the `FinancialSummaryBatchFunction` section (currently around line 170-198) and make two changes:

1. Add read access — after the existing `this.financialSummaryTable.grantWriteData(financialSummaryBatchFn);` line, add:
```ts
    this.financialSummaryTable.grantReadData(financialSummaryBatchFn);
```

2. Update the stale comment above the schedule rule. Replace:
```ts
    // 決算サマリは四半期ごとしか更新されないため週次で十分(株価と違い日付範囲を
    // 持たないエンドポイントなので、頻度を上げても新しい情報は増えない)。
    // JST 月曜20:00 = UTC 月曜11:00。
```
with:
```ts
    // 決算サマリは四半期ごとしか更新されないため週次で十分。
    // JST 月曜20:00 = UTC 月曜11:00。
```

(The old comment's claim that "no date-range parameter exists so higher frequency wouldn't help" is now outdated -- `/fins/summary` does support a `date`-only bulk mode, see the design spec -- but weekly remains the right cadence for quarterly-updated data regardless.)

Also update the timeout comment above `FinancialSummaryBatchFunction`'s `timeout: cdk.Duration.minutes(14)` line. Replace:
```ts
      // 銘柄あたり決算サマリー1リクエストを13秒間隔(5req/分制限)で直列に行うため長めに確保。
      // ウォッチリストが増える場合は要見直し。
```
with:
```ts
      // 新規銘柄の初回バックフィル(銘柄ごと直列)+直近日付の一括チェックの合計時間を
      // 見込んで長めに確保(lambda/financial-summary-batch/index.tsのMAX_BACKFILL_TICKERS_PER_RUN
      // 参照)。
```

- [ ] **Step 6: Run the full test suite and build**

Run: `npx jest`
Expected: PASS, all suites (the known Windows esbuild-worker-teardown flake is expected and not a real failure)

Run: `npm run build`
Expected: clean, no errors (this also confirms the CDK stack change compiles)

- [ ] **Step 7: Commit**

```bash
git add lambda/financial-summary-batch/index.ts test/financial-summary-batch.test.ts lib/j-quants-stack.ts
git commit -m "Split financial-summary-batch into backfill + bulk-date-fetch modes

Fixes #2: financial-summary-batch was confirmed timing out in
production with 1,700+ tickers (same per-ticker starvation pattern
margin-balance-batch and price-batch had -- 840s timeout, only 189 of
1,700+ tickers processed per run, likely the same ~189 every week).

/fins/summary has no from/to range parameter, so full-history backfill
still requires the existing per-ticker code-only call -- that part is
unchanged, just capped at MAX_BACKFILL_TICKERS_PER_RUN (150, deferring
the rest to next run) so a burst of newly-added tickers can't blow the
timeout. Existing tickers' continued updates now use the same
date-only bulk-fetch pattern price-batch/margin-balance-batch already
use (all listed companies' disclosures for one day, in one call),
checked over the last 14 days regardless of backfill status. Also
fixes REQUEST_INTERVAL_MS's default (13000ms, a Free-plan 5req/min
assumption) to 1000ms, matching Standard plan's actual 60req/min limit
for financial-statement endpoints specifically.

See docs/superpowers/specs/2026-09-04-financial-summary-bulk-date-fetch-design.md.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```
