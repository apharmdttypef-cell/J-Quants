# margin-balance-batch 実API化(フェーズ2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `lambda/margin-balance-batch/data-source.ts`のダミー信用残高生成を、J-Quants Standardプランの`mkt-margin-int`/`mkt-margin-alert`エンドポイントへの実呼び出しに差し替える。

**Architecture:** `lambda/shared/jquants-batch-client.ts`の`getApiKey`/`fetchWithRetry`を再利用し、他のJ-Quants呼び出しバッチ(price-batch等)と同じdo-whileページングパターンで`/markets/margin-interest`(週末残高)・`/markets/margin-alert`(日々公表銘柄の残高)を呼ぶ。制度信用のみのフィールド(`*StdVol`/`*StdOut`)を使う。呼び出し元(`margin-balance-batch/index.ts`)のシグネチャ・ループ構造は変更しない。

**Tech Stack:** TypeScript / Node.js Lambda / jest(ts-jest) / AWS CDK。

## Global Constraints

- `MarginBalancePoint`インターフェース(`date`/`financingBalance`/`lendingBalance`/`source`)は変更しない(spec: 2026-09-02-margin-balance-real-api-design.md)
- `financingBalance`/`lendingBalance`には制度信用のみのフィールド(`LongStdVol`/`ShrtStdVol`、`LongStdOut`/`ShrtStdOut`)を使う。一般信用込みの合計(`LongVol`/`ShrtVol`、`LongOut`/`ShrtOut`)は使わない
- `margin-balance-batch/index.ts`の銘柄ごと直列ループ・backfill/diff判定ロジックは変更しない(スコープ外、Standardプラン移行後の実際の挙動を見てから別途判断)
- `mkt-margin-int`の2026-09-28仕様変更への特別対応は不要(株数系フィールド名は新旧で同じ)

---

### Task 1: data-source.tsを実API呼び出しに差し替え、CDKに認証情報を追加

**Files:**
- Modify: `lambda/margin-balance-batch/data-source.ts`(全面書き換え)
- Modify: `test/margin-balance-batch-data-source.test.ts`(全面書き換え)
- Modify: `lib/j-quants-stack.ts:206-213`(環境変数・権限追加)

**Interfaces:**
- Consumes: `lambda/shared/jquants-batch-client.ts`の`getApiKey(secretArn: string): Promise<string>`・`fetchWithRetry(url: string, apiKey: string, intervalMs: number, maxRetries: number): Promise<Response>`。いずれも変更しない
- Produces: `fetchWeeklyBalances(ticker: string, from: string, to: string): Promise<MarginBalancePoint[]>`・`fetchDailyAlertBalances(tickers: string[], date: string): Promise<MarginBalancePoint[]>`(シグネチャは変更なし)。`margin-balance-batch/index.ts`はこの2関数と`MarginBalancePoint`型をそのまま使い続ける(変更不要)

- [ ] **Step 1: `test/margin-balance-batch-data-source.test.ts`を以下の内容に全面置き換える(RED)**

既存テストはダミー生成の決定性(同じ入力→同じ値)を検証しているが、新実装では実際のURL・パラメータ・フィールドマッピング・ページング・空データの扱いを検証する。

```tsx
const mockGetApiKey = jest.fn();
const mockFetchWithRetry = jest.fn();

jest.mock('../lambda/shared/jquants-batch-client', () => ({
  getApiKey: (...args: unknown[]) => mockGetApiKey(...args),
  fetchWithRetry: (...args: unknown[]) => mockFetchWithRetry(...args),
}));

process.env.SECRET_ARN = 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:JQuantsApiKey';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fetchWeeklyBalances, fetchDailyAlertBalances } = require('../lambda/margin-balance-batch/data-source') as {
  fetchWeeklyBalances: (ticker: string, from: string, to: string) => Promise<unknown[]>;
  fetchDailyAlertBalances: (tickers: string[], date: string) => Promise<unknown[]>;
};

beforeEach(() => {
  mockGetApiKey.mockReset();
  mockFetchWithRetry.mockReset();
});

describe('fetchWeeklyBalances', () => {
  test('calls /markets/margin-interest with code/from/to and maps system-margin fields only', async () => {
    mockGetApiKey.mockResolvedValueOnce('test-api-key');
    mockFetchWithRetry.mockResolvedValueOnce({
      json: async () => ({
        data: [
          {
            Date: '2026-08-28',
            Code: '72030',
            LongVol: 225000,
            ShrtVol: 257400,
            LongStdVol: 143100,
            ShrtStdVol: 14600,
          },
        ],
      }),
    });

    const result = await fetchWeeklyBalances('7203', '2026-08-01', '2026-08-31');

    expect(mockFetchWithRetry).toHaveBeenCalledTimes(1);
    const url = mockFetchWithRetry.mock.calls[0][0] as string;
    expect(url).toContain('/markets/margin-interest');
    expect(url).toContain('code=7203');
    expect(url).toContain('from=2026-08-01');
    expect(url).toContain('to=2026-08-31');

    // 一般信用込みの合計(LongVol/ShrtVol)ではなく制度信用のみ(*StdVol)を使うこと
    expect(result).toEqual([{ date: '2026-08-28', financingBalance: 143100, lendingBalance: 14600, source: 'weekly' }]);
  });

  test('follows pagination_key across multiple pages', async () => {
    mockGetApiKey.mockResolvedValueOnce('test-api-key');
    mockFetchWithRetry
      .mockResolvedValueOnce({
        json: async () => ({
          data: [{ Date: '2026-08-21', Code: '72030', LongStdVol: 100, ShrtStdVol: 50 }],
          pagination_key: 'page2',
        }),
      })
      .mockResolvedValueOnce({
        json: async () => ({ data: [{ Date: '2026-08-28', Code: '72030', LongStdVol: 200, ShrtStdVol: 60 }] }),
      });

    const result = await fetchWeeklyBalances('7203', '2026-08-01', '2026-08-31');

    expect(mockFetchWithRetry).toHaveBeenCalledTimes(2);
    expect(mockFetchWithRetry.mock.calls[1][0]).toContain('pagination_key=page2');
    expect(result).toHaveLength(2);
  });

  test('returns an empty array when the ticker has no margin balance history', async () => {
    mockGetApiKey.mockResolvedValueOnce('test-api-key');
    mockFetchWithRetry.mockResolvedValueOnce({ json: async () => ({ data: [] }) });

    const result = await fetchWeeklyBalances('7203', '2026-08-01', '2026-08-31');

    expect(result).toEqual([]);
  });
});

describe('fetchDailyAlertBalances', () => {
  test('calls /markets/margin-alert once per ticker with code/date, using AppDate (not PubDate) as the point date', async () => {
    mockGetApiKey.mockResolvedValueOnce('test-api-key');
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

    const result = await fetchDailyAlertBalances(['7203'], '2026-08-27');

    expect(mockFetchWithRetry).toHaveBeenCalledTimes(1);
    const url = mockFetchWithRetry.mock.calls[0][0] as string;
    expect(url).toContain('/markets/margin-alert');
    expect(url).toContain('code=7203');
    expect(url).toContain('date=2026-08-27');

    expect(result).toEqual([{ date: '2026-08-26', financingBalance: 8410, lendingBalance: 920, source: 'daily-alert' }]);
  });

  test('calls once per ticker when given multiple tickers', async () => {
    mockGetApiKey.mockResolvedValueOnce('test-api-key');
    mockFetchWithRetry.mockResolvedValue({ json: async () => ({ data: [] }) });

    await fetchDailyAlertBalances(['7203', '9999'], '2026-08-27');

    expect(mockFetchWithRetry).toHaveBeenCalledTimes(2);
    const urls = mockFetchWithRetry.mock.calls.map(([url]) => url as string);
    expect(urls.some((u) => u.includes('code=7203'))).toBe(true);
    expect(urls.some((u) => u.includes('code=9999'))).toBe(true);
  });

  test('returns an empty array for a ticker not on the daily-alert list', async () => {
    mockGetApiKey.mockResolvedValueOnce('test-api-key');
    mockFetchWithRetry.mockResolvedValueOnce({ json: async () => ({ data: [] }) });

    const result = await fetchDailyAlertBalances(['7203'], '2026-08-27');

    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
cd /c/workspaces/J-Quants
npx jest margin-balance-batch-data-source.test.ts
```

Expected: FAIL(既存実装はAPIを一切呼ばずダミー値を生成するため、`mockFetchWithRetry`が呼ばれず全テストが失敗する)

- [ ] **Step 3: `lambda/margin-balance-batch/data-source.ts`を以下の内容に全面置き換える**

```tsx
import { getApiKey, fetchWithRetry } from '../shared/jquants-batch-client';

const SECRET_ARN = process.env.SECRET_ARN!;
const API_BASE_URL = process.env.API_BASE_URL ?? 'https://api.jquants.com/v2';
// mkt-margin-int/mkt-margin-alertはStandardプラン専用のエンドポイントのため、
// Freeプラン向けの13秒デフォルトは不要。Standardプランの120req/分を想定した値。
const REQUEST_INTERVAL_MS = Number(process.env.REQUEST_INTERVAL_MS ?? '500');
const MAX_RETRIES = 5;

export interface MarginBalancePoint {
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
  data: MarginIntRecord[];
  pagination_key?: string;
}

interface MarginAlertRecord {
  AppDate: string;
  Code: string;
  LongStdOut: number;
  ShrtStdOut: number;
}

interface MarginAlertResponse {
  data: MarginAlertRecord[];
  pagination_key?: string;
}

async function fetchMarginIntPage(params: Record<string, string>, apiKey: string): Promise<MarginIntRecord[]> {
  const records: MarginIntRecord[] = [];
  let paginationKey: string | undefined;

  do {
    const search = new URLSearchParams(params);
    if (paginationKey) search.set('pagination_key', paginationKey);

    const response = await fetchWithRetry(
      `${API_BASE_URL}/markets/margin-interest?${search}`,
      apiKey,
      REQUEST_INTERVAL_MS,
      MAX_RETRIES,
    );
    const body = (await response.json()) as MarginIntResponse;
    records.push(...body.data);
    paginationKey = body.pagination_key;
  } while (paginationKey);

  return records;
}

async function fetchMarginAlertPage(params: Record<string, string>, apiKey: string): Promise<MarginAlertRecord[]> {
  const records: MarginAlertRecord[] = [];
  let paginationKey: string | undefined;

  do {
    const search = new URLSearchParams(params);
    if (paginationKey) search.set('pagination_key', paginationKey);

    const response = await fetchWithRetry(
      `${API_BASE_URL}/markets/margin-alert?${search}`,
      apiKey,
      REQUEST_INTERVAL_MS,
      MAX_RETRIES,
    );
    const body = (await response.json()) as MarginAlertResponse;
    records.push(...body.data);
    paginationKey = body.pagination_key;
  } while (paginationKey);

  return records;
}

// 信用取引週末残高(/markets/margin-interest)から制度信用分のみを取得する。逆日歩は
// 制度信用固有の仕組みのため、一般信用込みの合計(ShrtVol/LongVol)ではなく制度信用のみ
// (ShrtStdVol/LongStdVol)を使う。2026-09-28に日次配信へ仕様変更予定だが、株数系
// フィールド名は新旧で同じなので、この変更を跨いでもコード変更は不要な想定。
export async function fetchWeeklyBalances(ticker: string, from: string, to: string): Promise<MarginBalancePoint[]> {
  const apiKey = await getApiKey(SECRET_ARN);
  const records = await fetchMarginIntPage({ code: ticker, from, to }, apiKey);

  return records.map((record) => ({
    date: record.Date,
    financingBalance: record.LongStdVol,
    lendingBalance: record.ShrtStdVol,
    source: 'weekly' as const,
  }));
}

// 日々公表信用取引残高(/markets/margin-alert)。「日々公表銘柄」に指定された銘柄のみが
// 対象で、mkt-margin-intとは別のデータソース。対象外の銘柄・日付は空配列が返る
// (エラーにはならない)。dateパラメータは公表日ベースだが、レスポンスのAppDate(申込日、
// 残高が示す基準日)をMarginBalancePoint.dateとして使い、fetchWeeklyBalancesのDateと
// 意味を揃える。
export async function fetchDailyAlertBalances(tickers: string[], date: string): Promise<MarginBalancePoint[]> {
  const apiKey = await getApiKey(SECRET_ARN);
  const points: MarginBalancePoint[] = [];

  for (const ticker of tickers) {
    const records = await fetchMarginAlertPage({ code: ticker, date }, apiKey);
    for (const record of records) {
      points.push({
        date: record.AppDate,
        financingBalance: record.LongStdOut,
        lendingBalance: record.ShrtStdOut,
        source: 'daily-alert' as const,
      });
    }
  }

  return points;
}
```

- [ ] **Step 4: テストを実行して成功を確認する(GREEN)**

```bash
cd /c/workspaces/J-Quants
npx jest margin-balance-batch-data-source.test.ts
```

Expected: 全テストPASS

- [ ] **Step 5: `lib/j-quants-stack.ts`にJ-Quants APIキーへのアクセス権限を追加する**

現状(206-213行目)の`MarginBalanceBatchFunction`定義:

```ts
      environment: {
        YUTAI_MASTER_TABLE_NAME: this.yutaiMasterTable.tableName,
        MARGIN_BALANCE_TABLE_NAME: this.marginBalanceTable.tableName,
      },
    });

    this.yutaiMasterTable.grantReadData(marginBalanceBatchFn);
    this.marginBalanceTable.grantReadWriteData(marginBalanceBatchFn);
```

これを以下に置き換える(`SECRET_ARN`環境変数と、`apiKeySecret`の読み取り権限を追加):

```ts
      environment: {
        YUTAI_MASTER_TABLE_NAME: this.yutaiMasterTable.tableName,
        MARGIN_BALANCE_TABLE_NAME: this.marginBalanceTable.tableName,
        SECRET_ARN: this.apiKeySecret.secretArn,
      },
    });

    this.yutaiMasterTable.grantReadData(marginBalanceBatchFn);
    this.marginBalanceTable.grantReadWriteData(marginBalanceBatchFn);
    this.apiKeySecret.grantRead(marginBalanceBatchFn);
```

`this.apiKeySecret`は同じファイル内の他のJ-Quants呼び出しバッチ(`priceBatchFn`等)で既に使われているプロパティなので、そのまま参照できる。

- [ ] **Step 6: 型チェックを実行する**

```bash
cd /c/workspaces/J-Quants
npm run build
```

Expected: エラーなしで終了

- [ ] **Step 7: バックエンド全体のテストスイートを実行し、他への影響が無いことを確認する**

```bash
cd /c/workspaces/J-Quants
npx jest
```

Expected: 全テストPASS。ただし、このリポジトリのフルスイートはCDKスタックのesbuildバンドルを含むため、Windows環境ではまれに「N failed / M passed」とテストスイートだけ失敗表示になりつつ、個々のテスト(`Tests:`行)は0 failedというesbuildワーカー終了処理の既知のflakeが起きることがある(本タスクの変更とは無関係)。その形に一致する場合は、`npx jest`をもう一度実行してから本当に問題があるか判断する。

- [ ] **Step 8: コミット**

```bash
git add lambda/margin-balance-batch/data-source.ts test/margin-balance-batch-data-source.test.ts lib/j-quants-stack.ts
git commit -m "$(cat <<'EOF'
Switch margin-balance-batch to real mkt-margin-int/mkt-margin-alert calls

Phase 1 shipped this batch with deterministic dummy data to delay the
J-Quants Standard plan upgrade. Phase 2 replaces data-source.ts's
generator with real calls to the two endpoints, mapping only the
system-margin fields (*StdVol/*StdOut) since gyakuhibu is a
system-margin-specific mechanism, not general margin. mkt-margin-int's
scheduled 2026-09-28 spec change (weekly to daily) doesn't require any
code change here since the share-count field names are unchanged.

The per-ticker loop in index.ts is untouched — real-world rate-limit
behavior needs to be observed after the plan upgrade before deciding
whether it needs the same bulk-fetch treatment price-batch got.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
