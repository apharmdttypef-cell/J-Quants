# バッチ鮮度別分離(サブプロジェクトA) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `BatchFetchFunction`(株価+決算サマリを同一日次バッチで取得)を、株価専用の日次バッチと決算サマリ専用の週次バッチに分離し、`MarginBalanceBatchFunction`のスケジュールを週次に変更する。

**Architecture:** 両バッチが共有するJ-Quants呼び出しインフラ(APIキー取得・対象銘柄取得・レート制限付きfetch・日付正規化)を`lambda/shared/jquants-batch-client.ts`に抽出し、`lambda/price-batch/`と`lambda/financial-summary-batch/`という2つの独立したLambdaがそれぞれ利用する。

**Tech Stack:** TypeScript, AWS CDK (aws-cdk-lib), Lambda (Node.js 22, aws-lambda-nodejs), DynamoDB, Jest

## Global Constraints

- 株価・決算サマリそれぞれの取得ロジック(J-Quants呼び出しのURL構築・レスポンスのDynamoDB書き込み形状)は分割前と完全に同じ挙動を保つこと。分割自体以外のロジック変更はしない
- 既存のDynamoDBテーブル名・スキーマは変更しない
- 新規`lambda/shared/jquants-batch-client.ts`のエクスポート関数は、AWS SDKのクライアントオブジェクトを引数に取らない(呼び出し側はテーブル名・ARN・URLなどのプリミティブ値だけを渡す)
- テストファイルは`lambda/<dir>/`に対して`test/<dir>.test.ts`という既存の命名規則に従う(例: `lambda/margin-balance-batch/` → `test/margin-balance-batch.test.ts`)
- `REQUEST_INTERVAL_MS`のデフォルトは両バッチとも13000ms(同じJ-Quants APIキーのレート制限を共有するため変更しない)
- スケジュール(設計書で確定済み): `PriceBatchSchedule`は日次 `cron(0 9 * * ? *)`(変更なし)、`FinancialSummaryBatchSchedule`は週次 `cron(0 11 ? * MON *)`(新規)、`MarginBalanceBatchSchedule`は週次 `cron(30 9 ? * MON *)`(コードは変更なし、cronのみ変更)
- 詳細設計は`docs/superpowers/specs/2026-08-18-yutai-batch-freshness-split-design.md`を参照

---

### Task 1: 共有J-Quantsバッチクライアントの抽出

**Files:**
- Create: `lambda/shared/jquants-batch-client.ts`
- Test: `test/jquants-batch-client.test.ts`

**Interfaces:**
- Produces:
  - `getApiKey(secretArn: string): Promise<string>`
  - `getTargetTickers(watchlistTableName: string, yutaiMasterTableName: string): Promise<string[]>`
  - `fetchWithRetry(url: string, apiKey: string, requestIntervalMs: number, maxRetries: number, attempt?: number): Promise<Response>`
  - `formatDate(date: Date): string`
  - `normalizeDate(raw: string): string`

- [ ] **Step 1: テストファイルを書く**

`test/jquants-batch-client.test.ts`:

```typescript
const mockSecretsSend = jest.fn();
const mockDdbSend = jest.fn();
const mockFetch = jest.fn();

jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSecretsSend })),
  GetSecretValueCommand: jest.fn((input: unknown) => input),
}));

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  ScanCommand: jest.fn((input: unknown) => input),
}));

import { getApiKey, getTargetTickers, fetchWithRetry, formatDate, normalizeDate } from '../lambda/shared/jquants-batch-client';

beforeEach(() => {
  mockSecretsSend.mockReset();
  mockDdbSend.mockReset();
  mockFetch.mockReset();
  (global as unknown as { fetch: typeof mockFetch }).fetch = mockFetch;
});

// cachedApiKeyはモジュールスコープでテスト間を跨いで保持されるため、
// 「失敗」ケースを先に置く(成功キャッシュが一度できると以降secretsSendが呼ばれなくなるため)。
describe('getApiKey', () => {
  test('throws when the secret has no string value', async () => {
    mockSecretsSend.mockResolvedValueOnce({});
    await expect(getApiKey('arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:JQuantsApiKey')).rejects.toThrow(
      'no string value',
    );
  });

  test('fetches the API key from Secrets Manager and caches it for subsequent calls', async () => {
    mockSecretsSend.mockResolvedValueOnce({ SecretString: 'test-api-key' });
    const first = await getApiKey('arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:JQuantsApiKey');
    const second = await getApiKey('arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:JQuantsApiKey');
    expect(first).toBe('test-api-key');
    expect(second).toBe('test-api-key');
    expect(mockSecretsSend).toHaveBeenCalledTimes(1);
  });
});

describe('getTargetTickers', () => {
  test('returns the union of watchlist and yutai-master tickers, deduped', async () => {
    mockDdbSend
      .mockResolvedValueOnce({ Items: [{ ticker: '7203' }] })
      .mockResolvedValueOnce({ Items: [{ ticker: '7203' }, { ticker: '9999' }] });

    const tickers = await getTargetTickers('JQuantsWatchlist', 'JQuantsYutaiMaster');

    expect(tickers.sort()).toEqual(['7203', '9999']);
  });

  test('paginates through ScanCommand results using LastEvaluatedKey', async () => {
    mockDdbSend
      .mockResolvedValueOnce({ Items: [{ ticker: '1111' }], LastEvaluatedKey: { ticker: '1111' } })
      .mockResolvedValueOnce({ Items: [{ ticker: '2222' }] })
      .mockResolvedValueOnce({ Items: [] });

    const tickers = await getTargetTickers('JQuantsWatchlist', 'JQuantsYutaiMaster');

    expect(tickers.sort()).toEqual(['1111', '2222']);
  });
});

describe('fetchWithRetry', () => {
  test('returns the response when the request succeeds', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const response = await fetchWithRetry('https://api.example.com/x', 'key', 0, 5);

    expect(response.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith('https://api.example.com/x', { headers: { 'x-api-key': 'key' } });
  });

  test('retries with backoff on 429 and eventually succeeds', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429 }).mockResolvedValueOnce({ ok: true });

    const response = await fetchWithRetry('https://api.example.com/x', 'key', 0, 5);

    expect(response.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('throws when the response is not ok and not a 429', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'server error' });

    await expect(fetchWithRetry('https://api.example.com/x', 'key', 0, 5)).rejects.toThrow('J-Quants API error 500');
  });

  test('gives up after maxRetries and throws', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 429, text: async () => 'rate limited' });

    await expect(fetchWithRetry('https://api.example.com/x', 'key', 0, 1)).rejects.toThrow('J-Quants API error 429');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe('formatDate', () => {
  test('formats a Date as YYYYMMDD', () => {
    expect(formatDate(new Date('2026-08-18T00:00:00Z'))).toBe('20260818');
  });
});

describe('normalizeDate', () => {
  test('leaves an already-hyphenated date unchanged', () => {
    expect(normalizeDate('2026-08-18')).toBe('2026-08-18');
  });

  test('converts YYYYMMDD to YYYY-MM-DD', () => {
    expect(normalizeDate('20260818')).toBe('2026-08-18');
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx jest test/jquants-batch-client.test.ts`
Expected: FAIL(`lambda/shared/jquants-batch-client`が存在しない)

- [ ] **Step 3: 実装する**

`lambda/shared/jquants-batch-client.ts`:

```typescript
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';

const secretsClient = new SecretsManagerClient({});
const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

let cachedApiKey: string | undefined;

export async function getApiKey(secretArn: string): Promise<string> {
  if (cachedApiKey) return cachedApiKey;
  const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!result.SecretString) {
    throw new Error('J-Quants API key secret has no string value');
  }
  cachedApiKey = result.SecretString;
  return cachedApiKey;
}

async function scanTickerColumn(tableName: string): Promise<string[]> {
  const tickers: string[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await ddbDocClient.send(
      new ScanCommand({ TableName: tableName, ExclusiveStartKey: exclusiveStartKey }),
    );
    for (const item of result.Items ?? []) {
      if (typeof item.ticker === 'string') tickers.push(item.ticker);
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return tickers;
}

// 優待クロス対象銘柄は必ずしも個人のウォッチリストに入っているとは限らないため、
// 両テーブルの和集合(重複排除)を対象にする。
export async function getTargetTickers(watchlistTableName: string, yutaiMasterTableName: string): Promise<string[]> {
  const [watchlistTickers, yutaiTickers] = await Promise.all([
    scanTickerColumn(watchlistTableName),
    scanTickerColumn(yutaiMasterTableName),
  ]);
  return [...new Set([...watchlistTickers, ...yutaiTickers])];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 呼び出しのたびにレート制限分スリープするので、呼び出し側は間隔を意識しなくてよい。
export async function fetchWithRetry(
  url: string,
  apiKey: string,
  requestIntervalMs: number,
  maxRetries: number,
  attempt = 0,
): Promise<Response> {
  const response = await fetch(url, { headers: { 'x-api-key': apiKey } });

  if (response.status === 429 && attempt < maxRetries) {
    const backoffMs = requestIntervalMs * 2 ** attempt;
    console.warn(`Rate limited, backing off ${backoffMs}ms (attempt ${attempt + 1})`);
    await sleep(backoffMs);
    return fetchWithRetry(url, apiKey, requestIntervalMs, maxRetries, attempt + 1);
  }

  if (!response.ok) {
    throw new Error(`J-Quants API error ${response.status}: ${await response.text()}`);
  }

  await sleep(requestIntervalMs);
  return response;
}

export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

// APIのDateはドキュメント上 "20210907" / "2021-09-07" どちらの形式もあり得るため正規化する。
export function normalizeDate(raw: string): string {
  if (raw.includes('-')) return raw;
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npx jest test/jquants-batch-client.test.ts`
Expected: PASS(11 tests)

- [ ] **Step 5: コミット**

```bash
git add lambda/shared/jquants-batch-client.ts test/jquants-batch-client.test.ts
git commit -m "Extract shared J-Quants batch client (API key, target tickers, rate-limited fetch)"
```

---

### Task 2: 株価専用バッチ(`price-batch`)への分離

**Files:**
- Create: `lambda/price-batch/index.ts`
- Create: `test/price-batch.test.ts`
- Delete: `lambda/batch-fetch/index.ts`, `test/batch-fetch.test.ts`

**Interfaces:**
- Consumes: `lambda/shared/jquants-batch-client.ts`の`getApiKey`/`getTargetTickers`/`fetchWithRetry`/`normalizeDate`/`formatDate`(Task 1)

- [ ] **Step 1: テストファイルを書く**

`test/price-batch.test.ts`:

```typescript
const mockDdbSend = jest.fn();
const mockGetApiKey = jest.fn();
const mockGetTargetTickers = jest.fn();
const mockFetchWithRetry = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  PutCommand: jest.fn((input: unknown) => input),
}));

jest.mock('../lambda/shared/jquants-batch-client', () => ({
  getApiKey: (...args: unknown[]) => mockGetApiKey(...args),
  getTargetTickers: (...args: unknown[]) => mockGetTargetTickers(...args),
  fetchWithRetry: (...args: unknown[]) => mockFetchWithRetry(...args),
  normalizeDate: (raw: string) => (raw.includes('-') ? raw : `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`),
  formatDate: (date: Date) => date.toISOString().slice(0, 10).replace(/-/g, ''),
}));

process.env.TABLE_NAME = 'JQuantsStockPrices';
process.env.WATCHLIST_TABLE_NAME = 'JQuantsWatchlist';
process.env.YUTAI_MASTER_TABLE_NAME = 'JQuantsYutaiMaster';
process.env.SECRET_ARN = 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:JQuantsApiKey';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/price-batch/index') as { handler: () => Promise<void> };

beforeEach(() => {
  mockDdbSend.mockReset();
  mockGetApiKey.mockReset();
  mockGetTargetTickers.mockReset();
  mockFetchWithRetry.mockReset();
});

test('does nothing when there are no target tickers', async () => {
  mockGetTargetTickers.mockResolvedValueOnce([]);

  await handler();

  expect(mockGetApiKey).not.toHaveBeenCalled();
  expect(mockFetchWithRetry).not.toHaveBeenCalled();
});

test('fetches daily bars for each target ticker and upserts them', async () => {
  mockGetTargetTickers.mockResolvedValueOnce(['7203']);
  mockGetApiKey.mockResolvedValueOnce('test-api-key');
  mockFetchWithRetry.mockResolvedValueOnce({
    json: async () => ({ data: [{ Code: '7203', Date: '2026-08-01', O: 100, H: 110, L: 95, C: 105, Vo: 1000 }] }),
  });

  await handler();

  expect(mockFetchWithRetry).toHaveBeenCalledTimes(1);
  expect(mockFetchWithRetry.mock.calls[0][0]).toContain('/equities/bars/daily');
  expect(mockFetchWithRetry.mock.calls[0][0]).toContain('code=7203');

  const putCalls = mockDdbSend.mock.calls.filter(([cmd]) => 'Item' in (cmd as Record<string, unknown>));
  expect(putCalls).toHaveLength(1);
  expect(putCalls[0][0]).toMatchObject({ TableName: 'JQuantsStockPrices', Item: { ticker: '7203', date: '2026-08-01' } });
});

test('fetches for multiple target tickers independently', async () => {
  mockGetTargetTickers.mockResolvedValueOnce(['7203', '9999']);
  mockGetApiKey.mockResolvedValueOnce('test-api-key');
  mockFetchWithRetry.mockResolvedValue({ json: async () => ({ data: [] }) });

  await handler();

  expect(mockFetchWithRetry).toHaveBeenCalledTimes(2);
  const urls = mockFetchWithRetry.mock.calls.map(([url]) => url as string);
  expect(urls.some((u) => u.includes('code=7203'))).toBe(true);
  expect(urls.some((u) => u.includes('code=9999'))).toBe(true);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx jest test/price-batch.test.ts`
Expected: FAIL(`lambda/price-batch/index`が存在しない)

- [ ] **Step 3: 実装する**

`lambda/price-batch/index.ts`:

```typescript
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { getApiKey, getTargetTickers, fetchWithRetry, normalizeDate, formatDate } from '../shared/jquants-batch-client';

const TABLE_NAME = process.env.TABLE_NAME!;
const WATCHLIST_TABLE_NAME = process.env.WATCHLIST_TABLE_NAME!;
const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
const SECRET_ARN = process.env.SECRET_ARN!;
const API_BASE_URL = process.env.API_BASE_URL ?? 'https://api.jquants.com/v2';
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? '7');
// Freeプランは配信12週間遅延(=84日)。この境界を過ぎた日付を要求すると
// 「Your subscription covers the following dates: ...」400エラーになるため、
// "今日" を基準にせず配信済みの範囲まで遡る。日付境界のズレを避け+1日のバッファを持たせる。
const DELIVERY_DELAY_DAYS = Number(process.env.DELIVERY_DELAY_DAYS ?? String(12 * 7 + 1));
const REQUEST_INTERVAL_MS = Number(process.env.REQUEST_INTERVAL_MS ?? '13000');
const MAX_RETRIES = 5;

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

interface DailyBar {
  Code: string;
  Date: string;
  O: number | null;
  H: number | null;
  L: number | null;
  C: number | null;
  Vo: number | null;
}

interface DailyBarsResponse {
  data: DailyBar[];
  pagination_key?: string;
}

async function fetchDailyBars(ticker: string, apiKey: string, from: string, to: string): Promise<DailyBar[]> {
  const bars: DailyBar[] = [];
  let paginationKey: string | undefined;

  do {
    const params = new URLSearchParams({ code: ticker, from, to });
    if (paginationKey) params.set('pagination_key', paginationKey);

    const response = await fetchWithRetry(
      `${API_BASE_URL}/equities/bars/daily?${params}`,
      apiKey,
      REQUEST_INTERVAL_MS,
      MAX_RETRIES,
    );
    const body = (await response.json()) as DailyBarsResponse;
    bars.push(...body.data);
    paginationKey = body.pagination_key;
  } while (paginationKey);

  return bars;
}

async function upsertBars(ticker: string, bars: DailyBar[]): Promise<void> {
  const updatedAt = new Date().toISOString();

  for (const bar of bars) {
    await ddbDocClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          ticker,
          date: normalizeDate(bar.Date),
          open: bar.O,
          high: bar.H,
          low: bar.L,
          close: bar.C,
          volume: bar.Vo,
          updated_at: updatedAt,
        },
      }),
    );
  }
}

export const handler = async (): Promise<void> => {
  const tickers = await getTargetTickers(WATCHLIST_TABLE_NAME, YUTAI_MASTER_TABLE_NAME);
  if (tickers.length === 0) {
    console.warn('No target tickers (watchlist and yutai master are both empty); nothing to fetch');
    return;
  }

  const apiKey = await getApiKey(SECRET_ARN);
  const to = formatDate(new Date(Date.now() - DELIVERY_DELAY_DAYS * 24 * 60 * 60 * 1000));
  const from = formatDate(new Date(Date.now() - (DELIVERY_DELAY_DAYS + LOOKBACK_DAYS) * 24 * 60 * 60 * 1000));

  for (const ticker of tickers) {
    try {
      const bars = await fetchDailyBars(ticker, apiKey, from, to);
      await upsertBars(ticker, bars);
      console.log(`${ticker}: upserted ${bars.length} bars`);
    } catch (error) {
      console.error(`${ticker}: failed to fetch/upsert daily bars`, error);
    }
  }
};
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npx jest test/price-batch.test.ts`
Expected: PASS(3 tests)

- [ ] **Step 5: 旧ファイルを削除する**

```bash
git rm -r lambda/batch-fetch
git rm test/batch-fetch.test.ts
```

- [ ] **Step 6: コミット**

```bash
git add lambda/price-batch/index.ts test/price-batch.test.ts
git commit -m "Split price fetching out of batch-fetch into a dedicated price-batch Lambda"
```

---

### Task 3: 決算サマリ専用バッチ(`financial-summary-batch`)の新規追加

**Files:**
- Create: `lambda/financial-summary-batch/index.ts`
- Create: `test/financial-summary-batch.test.ts`

**Interfaces:**
- Consumes: `lambda/shared/jquants-batch-client.ts`の`getApiKey`/`getTargetTickers`/`fetchWithRetry`/`normalizeDate`(Task 1)

- [ ] **Step 1: テストファイルを書く**

`test/financial-summary-batch.test.ts`:

```typescript
const mockDdbSend = jest.fn();
const mockGetApiKey = jest.fn();
const mockGetTargetTickers = jest.fn();
const mockFetchWithRetry = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  PutCommand: jest.fn((input: unknown) => input),
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/financial-summary-batch/index') as { handler: () => Promise<void> };

beforeEach(() => {
  mockDdbSend.mockReset();
  mockGetApiKey.mockReset();
  mockGetTargetTickers.mockReset();
  mockFetchWithRetry.mockReset();
});

test('does nothing when there are no target tickers', async () => {
  mockGetTargetTickers.mockResolvedValueOnce([]);

  await handler();

  expect(mockGetApiKey).not.toHaveBeenCalled();
  expect(mockFetchWithRetry).not.toHaveBeenCalled();
});

test('fetches financial summaries for each target ticker and upserts them', async () => {
  mockGetTargetTickers.mockResolvedValueOnce(['7203']);
  mockGetApiKey.mockResolvedValueOnce('test-api-key');
  mockFetchWithRetry.mockResolvedValueOnce({
    json: async () => ({
      data: [
        {
          Code: '7203',
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

  await handler();

  expect(mockFetchWithRetry).toHaveBeenCalledTimes(1);
  expect(mockFetchWithRetry.mock.calls[0][0]).toContain('/fins/summary');
  expect(mockFetchWithRetry.mock.calls[0][0]).toContain('code=7203');

  const putCalls = mockDdbSend.mock.calls.filter(([cmd]) => 'Item' in (cmd as Record<string, unknown>));
  expect(putCalls).toHaveLength(1);
  expect(putCalls[0][0]).toMatchObject({
    TableName: 'JQuantsFinancialSummary',
    Item: { ticker: '7203', discDate: '2026-05-08', sales: '45095325000000' },
  });
});

test('fetches for multiple target tickers independently', async () => {
  mockGetTargetTickers.mockResolvedValueOnce(['7203', '9999']);
  mockGetApiKey.mockResolvedValueOnce('test-api-key');
  mockFetchWithRetry.mockResolvedValue({ json: async () => ({ data: [] }) });

  await handler();

  expect(mockFetchWithRetry).toHaveBeenCalledTimes(2);
  const urls = mockFetchWithRetry.mock.calls.map(([url]) => url as string);
  expect(urls.some((u) => u.includes('code=7203'))).toBe(true);
  expect(urls.some((u) => u.includes('code=9999'))).toBe(true);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx jest test/financial-summary-batch.test.ts`
Expected: FAIL(`lambda/financial-summary-batch/index`が存在しない)

- [ ] **Step 3: 実装する**

`lambda/financial-summary-batch/index.ts`:

```typescript
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { getApiKey, getTargetTickers, fetchWithRetry, normalizeDate } from '../shared/jquants-batch-client';

const FINANCIAL_TABLE_NAME = process.env.FINANCIAL_TABLE_NAME!;
const WATCHLIST_TABLE_NAME = process.env.WATCHLIST_TABLE_NAME!;
const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
const SECRET_ARN = process.env.SECRET_ARN!;
const API_BASE_URL = process.env.API_BASE_URL ?? 'https://api.jquants.com/v2';
const REQUEST_INTERVAL_MS = Number(process.env.REQUEST_INTERVAL_MS ?? '13000');
const MAX_RETRIES = 5;

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

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
  data: FinancialSummary[];
  pagination_key?: string;
}

// code のみ指定(from/to なし)。/fins/summary は日付範囲パラメータを持たず、
// Freeプランの配信遅延(直近12週間分は非公開)制約はAPI側で自動的にかかる。
async function fetchFinancialSummaries(ticker: string, apiKey: string): Promise<FinancialSummary[]> {
  const summaries: FinancialSummary[] = [];
  let paginationKey: string | undefined;

  do {
    const params = new URLSearchParams({ code: ticker });
    if (paginationKey) params.set('pagination_key', paginationKey);

    const response = await fetchWithRetry(`${API_BASE_URL}/fins/summary?${params}`, apiKey, REQUEST_INTERVAL_MS, MAX_RETRIES);
    const body = (await response.json()) as FinancialSummaryResponse;
    summaries.push(...body.data);
    paginationKey = body.pagination_key;
  } while (paginationKey);

  return summaries;
}

async function upsertFinancialSummaries(ticker: string, summaries: FinancialSummary[]): Promise<void> {
  const updatedAt = new Date().toISOString();

  for (const summary of summaries) {
    await ddbDocClient.send(
      new PutCommand({
        TableName: FINANCIAL_TABLE_NAME,
        Item: {
          ticker,
          discDate: normalizeDate(summary.DiscDate),
          docType: summary.DocType,
          curPerType: summary.CurPerType,
          // 桁数が大きく精度が必要なためAPIが返す文字列のまま保持する。
          sales: summary.Sales,
          operatingProfit: summary.OP,
          ordinaryProfit: summary.OdP,
          netProfit: summary.NP,
          eps: summary.EPS,
          updated_at: updatedAt,
        },
      }),
    );
  }
}

export const handler = async (): Promise<void> => {
  const tickers = await getTargetTickers(WATCHLIST_TABLE_NAME, YUTAI_MASTER_TABLE_NAME);
  if (tickers.length === 0) {
    console.warn('No target tickers (watchlist and yutai master are both empty); nothing to fetch');
    return;
  }

  const apiKey = await getApiKey(SECRET_ARN);

  for (const ticker of tickers) {
    try {
      const summaries = await fetchFinancialSummaries(ticker, apiKey);
      await upsertFinancialSummaries(ticker, summaries);
      console.log(`${ticker}: upserted ${summaries.length} financial summaries`);
    } catch (error) {
      console.error(`${ticker}: failed to fetch/upsert financial summaries`, error);
    }
  }
};
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npx jest test/financial-summary-batch.test.ts`
Expected: PASS(3 tests)

- [ ] **Step 5: コミット**

```bash
git add lambda/financial-summary-batch/index.ts test/financial-summary-batch.test.ts
git commit -m "Add dedicated financial-summary-batch Lambda"
```

---

### Task 4: CDKスタックの更新(Lambdaリネーム・新規追加・スケジュール変更)

**Files:**
- Modify: `lib/j-quants-stack.ts:149-200`

**Interfaces:**
- Consumes: `lambda/price-batch/index.ts`(Task 2)、`lambda/financial-summary-batch/index.ts`(Task 3)

- [ ] **Step 1: `batchFetchFn`を`priceBatchFn`にリネームし、entryパスと環境変数を変更する**

`lib/j-quants-stack.ts`の以下の範囲(現在の149〜179行目付近)を置き換える:

```typescript
    const batchFetchFn = new nodejs.NodejsFunction(this, 'BatchFetchFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'batch-fetch', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      // 銘柄あたり四本値+財務サマリの2リクエストを13秒間隔(5req/分制限)で
      // 直列に行うため長めに確保。ウォッチリストが増える場合は要見直し。
      timeout: cdk.Duration.minutes(14),
      memorySize: 256,
      // AWS SDK v3はNode.js 20系ランタイムに同梱されているためバンドルしない
      bundling: { externalModules: ['@aws-sdk/*'] },
      environment: {
        TABLE_NAME: this.stockPricesTable.tableName,
        FINANCIAL_TABLE_NAME: this.financialSummaryTable.tableName,
        WATCHLIST_TABLE_NAME: this.watchlistTable.tableName,
        YUTAI_MASTER_TABLE_NAME: this.yutaiMasterTable.tableName,
        SECRET_ARN: this.apiKeySecret.secretArn,
      },
    });

    this.stockPricesTable.grantWriteData(batchFetchFn);
    this.financialSummaryTable.grantWriteData(batchFetchFn);
    this.watchlistTable.grantReadData(batchFetchFn);
    this.yutaiMasterTable.grantReadData(batchFetchFn);
    this.apiKeySecret.grantRead(batchFetchFn);

    // J-Quants Freeプランは配信12週間遅延のため取得時刻はシビアでなくてよい。
    // JST 18:00 = UTC 09:00 に毎日実行。
    new events.Rule(this, 'BatchFetchSchedule', {
      schedule: events.Schedule.cron({ minute: '0', hour: '9' }),
      targets: [new targets.LambdaFunction(batchFetchFn)],
    });
```

置き換え後:

```typescript
    const priceBatchFn = new nodejs.NodejsFunction(this, 'PriceBatchFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'price-batch', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      // 銘柄あたり四本値1リクエストを13秒間隔(5req/分制限)で直列に行うため長めに確保。
      // ウォッチリストが増える場合は要見直し。
      timeout: cdk.Duration.minutes(14),
      memorySize: 256,
      // AWS SDK v3はNode.js 20系ランタイムに同梱されているためバンドルしない
      bundling: { externalModules: ['@aws-sdk/*'] },
      environment: {
        TABLE_NAME: this.stockPricesTable.tableName,
        WATCHLIST_TABLE_NAME: this.watchlistTable.tableName,
        YUTAI_MASTER_TABLE_NAME: this.yutaiMasterTable.tableName,
        SECRET_ARN: this.apiKeySecret.secretArn,
      },
    });

    this.stockPricesTable.grantWriteData(priceBatchFn);
    this.watchlistTable.grantReadData(priceBatchFn);
    this.yutaiMasterTable.grantReadData(priceBatchFn);
    this.apiKeySecret.grantRead(priceBatchFn);

    // J-Quants Freeプランは配信12週間遅延のため取得時刻はシビアでなくてよい。
    // JST 18:00 = UTC 09:00 に毎日実行。
    new events.Rule(this, 'PriceBatchSchedule', {
      schedule: events.Schedule.cron({ minute: '0', hour: '9' }),
      targets: [new targets.LambdaFunction(priceBatchFn)],
    });

    const financialSummaryBatchFn = new nodejs.NodejsFunction(this, 'FinancialSummaryBatchFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'financial-summary-batch', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(14),
      memorySize: 256,
      bundling: { externalModules: ['@aws-sdk/*'] },
      environment: {
        FINANCIAL_TABLE_NAME: this.financialSummaryTable.tableName,
        WATCHLIST_TABLE_NAME: this.watchlistTable.tableName,
        YUTAI_MASTER_TABLE_NAME: this.yutaiMasterTable.tableName,
        SECRET_ARN: this.apiKeySecret.secretArn,
      },
    });

    this.financialSummaryTable.grantWriteData(financialSummaryBatchFn);
    this.watchlistTable.grantReadData(financialSummaryBatchFn);
    this.yutaiMasterTable.grantReadData(financialSummaryBatchFn);
    this.apiKeySecret.grantRead(financialSummaryBatchFn);

    // 決算サマリは四半期ごとしか更新されないため週次で十分(株価と違い日付範囲を
    // 持たないエンドポイントなので、頻度を上げても新しい情報は増えない)。
    // JST 月曜20:00 = UTC 月曜11:00。
    new events.Rule(this, 'FinancialSummaryBatchSchedule', {
      schedule: events.Schedule.cron({ minute: '0', hour: '11', weekDay: 'MON' }),
      targets: [new targets.LambdaFunction(financialSummaryBatchFn)],
    });
```

- [ ] **Step 2: `MarginBalanceBatchSchedule`のcronを週次に変更する**

同ファイル内の該当箇所を置き換える:

```typescript
    new events.Rule(this, 'MarginBalanceBatchSchedule', {
      schedule: events.Schedule.cron({ minute: '30', hour: '9' }),
      targets: [new targets.LambdaFunction(marginBalanceBatchFn)],
    });
```

置き換え後(信用残は本来週次更新のデータのため、コードは変更せずスケジュールだけ週次にする):

```typescript
    // 信用残は本来週次更新のデータ(日々公表銘柄の日次例外は別途対応、
    // docs/superpowers/specs/2026-08-18-yutai-batch-freshness-split-design.mdのスコープ外)。
    // JST 月曜18:30 = UTC 月曜09:30。
    new events.Rule(this, 'MarginBalanceBatchSchedule', {
      schedule: events.Schedule.cron({ minute: '30', hour: '9', weekDay: 'MON' }),
      targets: [new targets.LambdaFunction(marginBalanceBatchFn)],
    });
```

- [ ] **Step 3: 合成(synth)して構文・スケジュールを確認する**

Run: `APP_PASSWORD=dummy-for-synth npx cdk synth JQuantsStack > /dev/null && echo SYNTH_OK`
Expected: `SYNTH_OK`が出力される(エラーなく合成できる)

Run: `MSYS_NO_PATHCONV=1 APP_PASSWORD=dummy-for-synth npx cdk synth JQuantsStack 2>/dev/null | grep -A2 "ScheduleExpression"`
Expected: `cron(0 9 * * ? *)`(PriceBatchSchedule)、`cron(0 11 ? * MON *)`(FinancialSummaryBatchSchedule)、`cron(30 9 ? * MON *)`(MarginBalanceBatchSchedule)、`cron(0 10 * * ? *)`(GyakuhibuHistoryBatchSchedule、変更なし)の4つが確認できる

- [ ] **Step 4: テストスイート全体を実行する**

Run: `npx jest`
Expected: PASS(全テストスイート)

- [ ] **Step 5: コミット**

```bash
git add lib/j-quants-stack.ts
git commit -m "Rename BatchFetchFunction to PriceBatchFunction, add FinancialSummaryBatchFunction, move margin-balance batch to weekly"
```

---

### Task 5: README更新

**Files:**
- Modify: `README.md`

- [ ] **Step 1: バッチ構成の説明を更新する**

`README.md`のバッチ処理を説明している箇所(冒頭のバッチ一覧、l.11-14付近)を、`PriceBatchFunction`(日次・株価のみ)/`FinancialSummaryBatchFunction`(週次・決算サマリのみ、新規)/`MarginBalanceBatchFunction`(週次に変更)の3つに分けて記載する。既存の`GyakuhibuHistoryBatchFunction`の説明は変更しない。データ種別ごとの更新頻度の理由(株価=日次が適切、決算サマリ=四半期更新のため週次で十分、信用残=本来週次更新)も一言添える。

- [ ] **Step 2: テストスイート全体を実行する(コード変更はないが安全確認)**

Run: `npx jest`
Expected: PASS(全テストスイート)

- [ ] **Step 3: コミット**

```bash
git add README.md
git commit -m "Document the price/financial-summary/margin-balance batch split and new schedules"
```
