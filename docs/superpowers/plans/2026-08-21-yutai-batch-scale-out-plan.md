# 優待クロス機能スケール対応(サブプロジェクトC) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `GET /yutai`一覧APIが1,000銘柄規模でタイムアウトする問題を、新規バッチによるリスク計算の事前計算方式に切り替えて解消する。あわせて`reference-api`内の重複クエリ(以前のサブプロジェクトBレビューでParkされていたMinor指摘)も解消する。

**Architecture:** 新規`yutai-risk-precompute-batch`(日次、`PriceBatchFunction`の後)が`JQuantsYutaiMaster`を全件スキャンし、銘柄ごとにリスク計算(信用残の有無・前日終値ベース)を行って結果を同テーブルへ書き戻す。`reference-api`の`listYutai`・`getYutaiDetail`は事前計算済みの値を読むだけになり、銘柄ごとの逐次DynamoDBクエリが無くなる。

**Tech Stack:** TypeScript, AWS CDK (aws-cdk-lib), Lambda (Node.js 22, aws-lambda-nodejs), DynamoDB, Jest

## Global Constraints

- `price-batch`/`financial-summary-batch`のカーソルベース分割処理は実装しない(J-Quants Standardプラン移行で解決する方針。本プランのスコープ外)
- 新規バッチが書き込むフィールド: `riskStatus`(`'safe' | 'danger' | 'na'`)・`maxGyakuhibu`(`number | null`)・`maxRate`(`number | null`)・`days`(`number | null`)。既存の`companyName`/`content`/`value`/`unitShares`/`rightsMonths`は上書きしない(`UpdateCommand`で対象フィールドのみ更新)
- `rightsDate`自体はDB非依存の軽量なローカル計算のため、引き続き`reference-api`側でリクエスト時に計算する(事前計算の対象外)
- 詳細設計は`docs/superpowers/specs/2026-08-21-yutai-batch-scale-out-design.md`を参照

---

### Task 1: `nextRightsDate`を`trading-calendar.ts`へ移動

**Files:**
- Modify: `lambda/shared/trading-calendar.ts`
- Modify: `lambda/reference-api/index.ts`
- Modify: `test/trading-calendar.test.ts`
- Modify: `test/reference-api.test.ts`

**Interfaces:**
- Produces: `nextRightsDate(rightsMonths: number[]): string | undefined`(`lambda/shared/trading-calendar.ts`からexport。キャッシュ引数は廃止し、内部で直接`getLocalTradingCalendar`を呼ぶ自己完結の関数にする)

- [ ] **Step 1: `trading-calendar.ts`にテストを追記する**

`test/trading-calendar.test.ts`の末尾に追記:

```typescript
describe('nextRightsDate', () => {
  test('returns undefined when rightsMonths is empty', () => {
    expect(nextRightsDate([])).toBeUndefined();
  });

  test('returns a date matching the YYYY-MM-DD format for a non-empty rightsMonths', () => {
    const result = nextRightsDate([8]);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('the returned date is always today or later', () => {
    const today = new Date().toISOString().slice(0, 10);
    const result = nextRightsDate([1, 4, 7, 10]);
    expect(result).toBeDefined();
    expect(result! >= today).toBe(true);
  });
});
```

`import`宣言に`nextRightsDate`を追加すること(既存の`import { ... } from '../lambda/shared/trading-calendar'`の`{ }`内)。

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx jest test/trading-calendar.test.ts`
Expected: FAIL(`nextRightsDate`が存在しない)

- [ ] **Step 3: `trading-calendar.ts`に実装を追記する**

`lambda/shared/trading-calendar.ts`の末尾に追記する(`rightsDateForMonth`の後):

```typescript
// rightsMonthsの各月について、今年・来年の最終営業日から2営業日前(権利付き最終日T)を
// 計算し、今日以降で最も近いものを返す(JQuantsYutaiRightsDateテーブル廃止に伴う代替)。
export function nextRightsDate(rightsMonths: number[]): string | undefined {
  if (rightsMonths.length === 0) return undefined;

  const today = new Date().toISOString().slice(0, 10);
  const year = Number(today.slice(0, 4));
  const calendar = getLocalTradingCalendar(`${year}-01-01`, `${year + 1}-12-31`);

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

- [ ] **Step 4: `trading-calendar.test.ts`のテストが通ることを確認**

Run: `npx jest test/trading-calendar.test.ts`
Expected: PASS

- [ ] **Step 5: `reference-api/index.ts`から重複する定義を削除し、共有版をimportする**

`lambda/reference-api/index.ts`冒頭のimportを次のように変更する(`settlementDate`/`businessDaysAfter`/`calendarDaysBetween`/`rightsDateForMonth`/`type CalendarDay`は次のTask 3で不要になるため今回は残したままでよいが、`nextRightsDate`の重複定義だけこの時点で削除する):

`lambda/reference-api/index.ts`内の`function nextRightsDate(rightsMonths: number[], calendarCache: Map<string, CalendarDay[]>): string | undefined { ... }`(300-318行目付近、`fetchTradingCalendarCached`の直後)を丸ごと削除する。

import文の`from '../shared/trading-calendar'`に`nextRightsDate`を追加する:

```typescript
import {
  getLocalTradingCalendar,
  isTradingDay,
  settlementDate,
  businessDaysAfter,
  calendarDaysBetween,
  rightsDateForMonth,
  nextRightsDate,
  type CalendarDay,
} from '../shared/trading-calendar';
```

呼び出し箇所を更新する(シグネチャが`(rightsMonths, calendarCache)`から`(rightsMonths)`に変わったため、`calendarCache`引数を外す):

`listYutai`内(371行目付近):
```typescript
    const rightsDate = nextRightsDate(row.rightsMonths, calendarCache);
```
を
```typescript
    const rightsDate = nextRightsDate(row.rightsMonths);
```
に変更。

`getYutaiDetail`内(490行目付近):
```typescript
  const rightsDate = nextRightsDate(master.rightsMonths, calendarCache);
```
を
```typescript
  const rightsDate = nextRightsDate(master.rightsMonths);
```
に変更。

`calendarCache`変数自体(`listYutai`・`getYutaiDetail`双方)は、この時点ではまだ`calcRisk`が使っているため削除しないこと(Task 3で`calcRisk`ごと削除する際にあわせて削除する)。

- [ ] **Step 6: `test/reference-api.test.ts`を確認・実行する**

このタスクの変更は`nextRightsDate`の呼び出し方(引数を1つ減らす)だけで、テスト側のモック内容(DynamoDBクエリの回数・順序)には影響しない。既存のテストがそのまま通ることを確認する。

Run: `npx jest test/reference-api.test.ts`
Expected: PASS(既存の全テスト)

- [ ] **Step 7: `npx tsc --noEmit`で型エラーが無いことを確認**

Run: `npx tsc --noEmit -p .`
Expected: エラーなし

- [ ] **Step 8: コミット**

```bash
git add lambda/shared/trading-calendar.ts lambda/reference-api/index.ts test/trading-calendar.test.ts
git commit -m "Move nextRightsDate to trading-calendar as a self-contained, cache-free function"
```

---

### Task 2: `lambda/yutai-risk-precompute-batch/index.ts`(新規)

**Files:**
- Create: `lambda/yutai-risk-precompute-batch/index.ts`
- Test: `test/yutai-risk-precompute-batch.test.ts`

**Interfaces:**
- Consumes: `nextRightsDate`(Task 1)、`getLocalTradingCalendar`/`settlementDate`/`businessDaysAfter`/`calendarDaysBetween`(既存、`lambda/shared/trading-calendar.ts`)、`calcMaxRate`/`calcMaxGyakuhibu`(既存、`lambda/shared/gyakuhibu-calc.ts`)

- [ ] **Step 1: テストを書く**

`test/yutai-risk-precompute-batch.test.ts`:

```typescript
const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  QueryCommand: jest.fn((input: unknown) => input),
  ScanCommand: jest.fn((input: unknown) => input),
  UpdateCommand: jest.fn((input: unknown) => input),
}));

process.env.YUTAI_MASTER_TABLE_NAME = 'JQuantsYutaiMaster';
process.env.MARGIN_BALANCE_TABLE_NAME = 'JQuantsMarginBalance';
process.env.TABLE_NAME = 'JQuantsStockPrices';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/yutai-risk-precompute-batch/index') as { handler: () => Promise<void> };

beforeEach(() => {
  mockSend.mockReset();
});

function updateCalls() {
  return mockSend.mock.calls.filter(
    ([cmd]) => 'UpdateExpression' in (cmd as Record<string, unknown>),
  );
}

test('writes riskStatus na when rightsMonths is empty (no upcoming rights date)', async () => {
  mockSend.mockResolvedValueOnce({
    Items: [{ ticker: '1234', value: 1000, unitShares: 100, rightsMonths: [] }],
  }); // yutai master scan

  await handler();

  const calls = updateCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0][0]).toMatchObject({
    TableName: 'JQuantsYutaiMaster',
    Key: { ticker: '1234' },
    ExpressionAttributeValues: { ':riskStatus': 'na', ':maxGyakuhibu': null, ':maxRate': null, ':days': null },
  });
});

test('writes riskStatus na when there is no margin balance data for the ticker', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', value: 1000, unitShares: 100, rightsMonths: [8] }] }) // yutai master scan
    .mockResolvedValueOnce({ Items: [] }); // margin balance presence: none

  await handler();

  const calls = updateCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0][0]).toMatchObject({
    ExpressionAttributeValues: { ':riskStatus': 'na', ':maxGyakuhibu': null, ':maxRate': null, ':days': null },
  });
});

test('writes riskStatus na when there is no price data for the ticker', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', value: 1000, unitShares: 100, rightsMonths: [8] }] }) // yutai master scan
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', date: '2026-08-10' }] }) // margin balance presence: yes
    .mockResolvedValueOnce({ Items: [] }); // latest close: none

  await handler();

  const calls = updateCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0][0]).toMatchObject({
    ExpressionAttributeValues: { ':riskStatus': 'na', ':maxGyakuhibu': null, ':maxRate': null, ':days': null },
  });
});

test('computes safe/danger based on value vs maxGyakuhibu and writes the numeric fields', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', value: 100000, unitShares: 100, rightsMonths: [8] }] }) // yutai master scan
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', date: '2026-08-10' }] }) // margin balance presence: yes
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', date: '2026-08-12', close: 500 }] }); // latest close

  await handler();

  const calls = updateCalls();
  expect(calls).toHaveLength(1);
  const values = (calls[0][0] as { ExpressionAttributeValues: Record<string, unknown> }).ExpressionAttributeValues;
  expect(values[':riskStatus']).toBe('safe'); // value=100000は十分大きいのでmaxGyakuhibuを上回るはず
  expect(typeof values[':maxGyakuhibu']).toBe('number');
  expect(typeof values[':maxRate']).toBe('number');
  expect(typeof values[':days']).toBe('number');
});

test('continues past a single row failure and processes the remaining rows', async () => {
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    mockSend
      .mockResolvedValueOnce({
        Items: [
          { ticker: '1111', value: 1000, unitShares: 100, rightsMonths: [] },
          { ticker: '2222', value: 1000, unitShares: 100, rightsMonths: [] },
        ],
      }) // yutai master scan
      .mockRejectedValueOnce(new Error('DynamoDB error')) // 1111's UpdateCommand fails
      .mockResolvedValueOnce({}); // 2222's UpdateCommand succeeds

    await handler();

    const calls = updateCalls();
    expect(calls).toHaveLength(2);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('1111'), expect.any(Error));
  } finally {
    errorSpy.mockRestore();
  }
});

test('skips a row missing value or unitShares without crashing', async () => {
  mockSend.mockResolvedValueOnce({
    Items: [{ ticker: '9999', rightsMonths: [8] }], // valueもunitSharesも欠落
  });

  await expect(handler()).resolves.not.toThrow();
  expect(updateCalls()).toHaveLength(0);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx jest test/yutai-risk-precompute-batch.test.ts`
Expected: FAIL(`lambda/yutai-risk-precompute-batch/index`が存在しない)

- [ ] **Step 3: 実装する**

`lambda/yutai-risk-precompute-batch/index.ts`:

```typescript
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { calcMaxGyakuhibu, calcMaxRate } from '../shared/gyakuhibu-calc';
import {
  getLocalTradingCalendar,
  settlementDate,
  businessDaysAfter,
  calendarDaysBetween,
  nextRightsDate,
  type CalendarDay,
} from '../shared/trading-calendar';

const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
const MARGIN_BALANCE_TABLE_NAME = process.env.MARGIN_BALANCE_TABLE_NAME!;
const TABLE_NAME = process.env.TABLE_NAME!; // 株価(JQuantsStockPrices)

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

interface MasterRow {
  ticker: string;
  value: number;
  unitShares: number;
  rightsMonths: number[];
}

async function scanYutaiMaster(): Promise<MasterRow[]> {
  const rows: MasterRow[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await ddbDocClient.send(
      new ScanCommand({ TableName: YUTAI_MASTER_TABLE_NAME, ExclusiveStartKey: exclusiveStartKey }),
    );
    for (const item of result.Items ?? []) {
      if (typeof item.ticker === 'string' && typeof item.value === 'number' && typeof item.unitShares === 'number') {
        rows.push({
          ticker: item.ticker,
          value: item.value,
          unitShares: item.unitShares,
          rightsMonths: item.rightsMonths ?? [],
        });
      }
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return rows;
}

async function hasMarginBalance(ticker: string): Promise<boolean> {
  const result = await ddbDocClient.send(
    new QueryCommand({
      TableName: MARGIN_BALANCE_TABLE_NAME,
      KeyConditionExpression: 'ticker = :ticker',
      ExpressionAttributeValues: { ':ticker': ticker },
      Limit: 1,
    }),
  );
  return (result.Items ?? []).length > 0;
}

async function latestClose(ticker: string): Promise<number | undefined> {
  const result = await ddbDocClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'ticker = :ticker',
      ExpressionAttributeValues: { ':ticker': ticker },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );
  const close = result.Items?.[0]?.close;
  return typeof close === 'number' ? close : undefined;
}

type RiskStatus = 'safe' | 'danger' | 'na';

interface RiskResult {
  riskStatus: RiskStatus;
  maxGyakuhibu: number | null;
  maxRate: number | null;
  days: number | null;
}

const NA_RISK: RiskResult = { riskStatus: 'na', maxGyakuhibu: null, maxRate: null, days: null };

// 権利日が月末近くに集中するため、同じfrom/toのカレンダーはバッチ全体で使い回す
// (getLocalTradingCalendarはローカル計算なので実害は小さいが、無駄のないよう用意する)。
function fetchTradingCalendarCached(from: string, to: string, cache: Map<string, CalendarDay[]>): CalendarDay[] {
  const key = `${from}|${to}`;
  let cached = cache.get(key);
  if (!cached) {
    cached = getLocalTradingCalendar(from, to);
    cache.set(key, cached);
  }
  return cached;
}

async function calcRisk(
  row: { ticker: string; value: number; unitShares: number },
  rightsDate: string | undefined,
  calendarCache: Map<string, CalendarDay[]>,
): Promise<RiskResult> {
  if (!rightsDate) return NA_RISK;
  if (!(await hasMarginBalance(row.ticker))) return NA_RISK;

  const closePrice = await latestClose(row.ticker);
  if (closePrice === undefined) return NA_RISK;

  const calendarTo = new Date(rightsDate);
  calendarTo.setDate(calendarTo.getDate() + 14);
  const calendar = fetchTradingCalendarCached(rightsDate, calendarTo.toISOString().slice(0, 10), calendarCache);
  // 品貸日数(days)は日証金の用語集の定義通り「受渡日(T+2)〜その翌営業日」の暦日数
  // (taisyaku.jpの実データで検証済み。docs/superpowers/specs/2026-08-13-yutai-cross-risk-design.md参照)。
  const settlement = settlementDate(calendar, rightsDate);
  const followingTradingDay = businessDaysAfter(calendar, settlement, 1);
  const days = calendarDaysBetween(settlement, followingTradingDay);

  const maxRate = calcMaxRate(closePrice, row.unitShares);
  const maxGyakuhibu = calcMaxGyakuhibu(closePrice, row.unitShares, days);
  const riskStatus: RiskStatus = row.value > maxGyakuhibu ? 'safe' : 'danger';
  return { riskStatus, maxGyakuhibu, maxRate, days };
}

export const handler = async (): Promise<void> => {
  const rows = await scanYutaiMaster();
  const calendarCache = new Map<string, CalendarDay[]>();

  let updated = 0;
  for (const row of rows) {
    try {
      const rightsDate = nextRightsDate(row.rightsMonths);
      const risk = await calcRisk(row, rightsDate, calendarCache);

      await ddbDocClient.send(
        new UpdateCommand({
          TableName: YUTAI_MASTER_TABLE_NAME,
          Key: { ticker: row.ticker },
          UpdateExpression: 'SET riskStatus = :riskStatus, maxGyakuhibu = :maxGyakuhibu, maxRate = :maxRate, #days = :days',
          ExpressionAttributeNames: { '#days': 'days' },
          ExpressionAttributeValues: {
            ':riskStatus': risk.riskStatus,
            ':maxGyakuhibu': risk.maxGyakuhibu,
            ':maxRate': risk.maxRate,
            ':days': risk.days,
          },
        }),
      );
      updated++;
    } catch (error) {
      console.error(`${row.ticker}: failed to precompute/update risk`, error);
    }
  }

  console.log(`yutai-risk-precompute-batch: updated ${updated} of ${rows.length} rows`);
};
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npx jest test/yutai-risk-precompute-batch.test.ts`
Expected: PASS(6 tests)

- [ ] **Step 5: コミット**

```bash
git add lambda/yutai-risk-precompute-batch/index.ts test/yutai-risk-precompute-batch.test.ts
git commit -m "Add yutai-risk-precompute-batch to precompute GET /yutai risk fields"
```

---

### Task 3: `reference-api`の簡略化(事前計算済みリスクを読むだけにする)

**Files:**
- Modify: `lambda/reference-api/index.ts`
- Modify: `test/reference-api.test.ts`

**Interfaces:**
- Consumes: `JQuantsYutaiMaster`の`riskStatus`/`maxGyakuhibu`/`maxRate`/`days`フィールド(Task 2のバッチが書き込む)

- [ ] **Step 1: 現状のテストが通ることを確認する(ベースライン)**

Run: `npx jest test/reference-api.test.ts`
Expected: PASS(Task 1完了後の状態、既存の全テスト)

- [ ] **Step 2: importを整理する**

`lambda/reference-api/index.ts`冒頭のimportから、`calcMaxGyakuhibu`/`calcMaxRate`(`../shared/gyakuhibu-calc`からのimport文ごと)と、`settlementDate`/`businessDaysAfter`/`calendarDaysBetween`/`rightsDateForMonth`/`type CalendarDay`(`../shared/trading-calendar`のimportから)を削除する。残るimportは以下の形になる:

```typescript
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getLocalTradingCalendar, isTradingDay, nextRightsDate } from '../shared/trading-calendar';
```

`MARGIN_BALANCE_TABLE_NAME`・`TABLE_NAME`の定数宣言はそのまま残す(`getMarginTrend`・`getPrices`・`latestPricePoint`が引き続き使うため削除しないこと)。

- [ ] **Step 3: `calcRisk`関連の関数・型を削除する**

以下を丸ごと削除する(重複するので`grep`等で正確な範囲を確認してから削除すること): `fetchTradingCalendarCached`関数、`hasMarginBalance`関数、`latestClose`関数、`type RiskStatus`(削除後に下記Step 4で再定義するので一旦消してよい)、`interface RiskCalcResult`、`const NA_RISK`、`async function calcRisk(...)`。

- [ ] **Step 4: `YutaiMasterRow`にリスクフィールドを追加する**

```typescript
type RiskStatus = 'safe' | 'danger' | 'na';

interface YutaiMasterRow {
  ticker: string;
  companyName?: string;
  content: string;
  value: number;
  unitShares: number;
  rightsMonths: number[];
  riskStatus: RiskStatus;
  maxGyakuhibu: number | null;
  maxRate: number | null;
  days: number | null;
}
```

- [ ] **Step 5: `scanYutaiMaster`・`getYutaiMaster`にリスクフィールドを追加する**

`scanYutaiMaster`内の`rows.push({...})`に以下を追加(既存の`rightsMonths: item.rightsMonths ?? [],`の直後):

```typescript
        riskStatus: item.riskStatus ?? 'na',
        maxGyakuhibu: item.maxGyakuhibu ?? null,
        maxRate: item.maxRate ?? null,
        days: item.days ?? null,
```

`getYutaiMaster`内の`return {...}`に以下を追加(既存の`rightsMonths: result.Item.rightsMonths ?? [],`の直後):

```typescript
    riskStatus: result.Item.riskStatus ?? 'na',
    maxGyakuhibu: result.Item.maxGyakuhibu ?? null,
    maxRate: result.Item.maxRate ?? null,
    days: result.Item.days ?? null,
```

- [ ] **Step 6: `listYutai`を簡略化する**

`calendarCache`変数の宣言を削除し、リスク計算のtry/catchブロックを`row.riskStatus`を直接読む形に置き換える。関数全体を以下に置き換える:

```typescript
async function listYutai(query: Record<string, string | undefined>): Promise<APIGatewayProxyResultV2> {
  const rightsDateFrom = query.rightsDateFrom;
  const rightsDateTo = query.rightsDateTo;
  const keyword = query.keyword?.toLowerCase();
  const riskStatusFilter = query.riskStatus && query.riskStatus !== 'all' ? query.riskStatus : undefined;

  const rows = await scanYutaiMaster();

  const items = [];
  for (const row of rows) {
    if (keyword) {
      const haystack = `${row.companyName ?? ''} ${row.content}`.toLowerCase();
      if (!haystack.includes(keyword)) continue;
    }

    const rightsDate = nextRightsDate(row.rightsMonths);
    if (rightsDateFrom && (!rightsDate || rightsDate < rightsDateFrom)) continue;
    if (rightsDateTo && (!rightsDate || rightsDate > rightsDateTo)) continue;

    if (riskStatusFilter && row.riskStatus !== riskStatusFilter) continue;

    items.push({
      ticker: row.ticker,
      companyName: row.companyName,
      content: row.content,
      value: row.value,
      rightsDate: rightsDate ?? null,
      riskStatus: row.riskStatus,
    });
  }

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  const monthCalendar = getLocalTradingCalendar(monthStart, monthEnd);

  return jsonResponse(200, {
    tickers: items,
    currentMonthLastTradableDate: currentMonthLastTradableDate(monthCalendar),
  });
}
```

- [ ] **Step 7: `getYutaiDetail`を簡略化する**

`calendarCache`変数の宣言と`calcRisk`呼び出しを削除し、`master`の事前計算済みフィールドをそのまま`risk`オブジェクトとして返す形に置き換える。関数全体を以下に置き換える:

```typescript
async function getYutaiDetail(ticker: string): Promise<APIGatewayProxyResultV2> {
  const master = await getYutaiMaster(ticker);
  if (!master) return jsonResponse(404, { message: `Unknown yutai ticker: ${ticker}` });

  const price = await latestPricePoint(ticker);
  const summary = await latestFinancialSummary(ticker);
  const eps = summary?.eps ? Number(summary.eps) : undefined;
  const per = price && eps && eps > 0 ? price.close / eps : null;

  const rightsDate = nextRightsDate(master.rightsMonths);
  const history = await gyakuhibuHistory(ticker);

  return jsonResponse(200, {
    ticker: master.ticker,
    companyName: master.companyName ?? null,
    content: master.content,
    value: master.value,
    unitShares: master.unitShares,
    rightsDate: rightsDate ?? null,
    basicInfo: {
      closePrice: price?.close ?? null,
      volume: price?.volume ?? null,
      per,
      sales: summary?.sales ?? null,
      operatingProfit: summary?.operatingProfit ?? null,
      netProfit: summary?.netProfit ?? null,
      eps: summary?.eps ?? null,
    },
    risk: {
      riskStatus: master.riskStatus,
      maxGyakuhibu: master.maxGyakuhibu,
      maxRate: master.maxRate,
      days: master.days,
    },
    rightsHistory: history,
  });
}
```

- [ ] **Step 8: `npx tsc --noEmit`で型エラーが無いことを確認**

Run: `npx tsc --noEmit -p .`
Expected: エラーなし(この時点でテストはまだ更新していないため、Step 9まではテストが落ちて構わない)

- [ ] **Step 9: `test/reference-api.test.ts`を更新する**

`GET /yutai`系・`GET /yutai/{ticker}`系のテストのみ変更する(`GET /tickers`系・`GET /yutai/{ticker}/margin-trend`は無関係なので変更不要)。既存のテストを以下に置き換える(228〜413行目付近、`GET /yutai returns each ticker...`から`GET /yutai/{ticker} returns rightsDate: null and companyName: null...`まで):

```typescript
test('GET /yutai returns each ticker with its next rights date and its precomputed risk badge', async () => {
  mockSend.mockResolvedValueOnce({
    Items: [
      {
        ticker: '1234',
        companyName: '○○HD',
        content: 'QUOカード',
        value: 1000,
        unitShares: 100,
        rightsMonths: [8],
        riskStatus: 'safe',
        maxGyakuhibu: 200,
        maxRate: 2,
        days: 1,
      },
    ],
  }); // yutai master scan (precomputed risk fields already present)

  const result = await handler(makeEvent('GET /yutai', { queryStringParameters: {} }));

  expect((result as { statusCode: number }).statusCode).toBe(200);
  const parsed = body(result) as { tickers: Array<{ ticker: string; riskStatus: string }>; currentMonthLastTradableDate: string };
  expect(parsed.tickers[0]).toMatchObject({ ticker: '1234', riskStatus: 'safe' });
  expect(parsed.currentMonthLastTradableDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  // calcRiskが無くなったため、リクエスト全体でDynamoDBへのアクセスはyutai masterの
  // スキャン1回だけになる(N銘柄でも呼び出し回数が増えないことの確認、スケール対応の核心)。
  expect(mockSend).toHaveBeenCalledTimes(1);
});

test('GET /yutai filters by keyword against company name and content', async () => {
  mockSend.mockResolvedValueOnce({
    Items: [
      { ticker: '1234', companyName: '○○ホールディングス', content: 'QUOカード', value: 1000, unitShares: 100, rightsMonths: [8], riskStatus: 'safe', maxGyakuhibu: 200, maxRate: 2, days: 1 },
      { ticker: '5678', companyName: '△△工業', content: '自社製品', value: 3000, unitShares: 100, rightsMonths: [8], riskStatus: 'na', maxGyakuhibu: null, maxRate: null, days: null },
    ],
  });

  const result = await handler(makeEvent('GET /yutai', { queryStringParameters: { keyword: 'QUO' } }));

  const parsed = body(result) as { tickers: Array<{ ticker: string }> };
  expect(parsed.tickers.map((t) => t.ticker)).toEqual(['1234']);
});

test('GET /yutai returns rightsDate: null and riskStatus: na (not a missing key) when there is no upcoming rights date', async () => {
  mockSend.mockResolvedValueOnce({
    Items: [{ ticker: '9999', companyName: '□□コーチ', content: '割引券', value: 500, unitShares: 100, rightsMonths: [], riskStatus: 'na', maxGyakuhibu: null, maxRate: null, days: null }],
  });

  const result = await handler(makeEvent('GET /yutai', { queryStringParameters: {} }));

  // JSON.stringify drops keys whose value is `undefined`, so this only passes if the
  // implementation coerces a missing rights date to `null` before pushing the item.
  const rawBody = (result as { body: string }).body;
  expect(rawBody).toContain('"rightsDate":null');

  const parsed = body(result) as { tickers: Array<Record<string, unknown>> };
  expect(parsed.tickers[0]).toHaveProperty('rightsDate', null);
  expect(parsed.tickers[0].riskStatus).toBe('na');
});

test('GET /yutai/{ticker} returns basic info, precomputed risk, and rights history', async () => {
  mockSend
    .mockResolvedValueOnce({
      Item: { ticker: '1234', companyName: '○○HD', content: 'QUOカード', value: 1000, unitShares: 100, rightsMonths: [8], riskStatus: 'safe', maxGyakuhibu: 200, maxRate: 2, days: 1 },
    }) // yutai master get
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', date: '2026-08-12', close: 500, volume: 10000 }] }) // latest price (basicInfo)
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', discDate: '2026-05-08', eps: '10.0', sales: '100', operatingProfit: '10', netProfit: '5' }] }) // financial summary
    .mockResolvedValueOnce({
      Items: [{ ticker: '1234', rightsDate: '2026-03-30', totalAmount: 680, days: 2, avgRate: 0.4 }],
    }); // gyakuhibu actual history

  const result = await handler(makeEvent('GET /yutai/{ticker}', { pathParameters: { ticker: '1234' } }));

  expect((result as { statusCode: number }).statusCode).toBe(200);
  const parsed = body(result) as {
    basicInfo: { closePrice: number; per: number | null };
    risk: { maxGyakuhibu: number; riskStatus: string };
    rightsHistory: Array<{ rightsDate: string; totalAmount: number }>;
  };
  expect(parsed.basicInfo.closePrice).toBe(500);
  expect(parsed.risk).toEqual({ riskStatus: 'safe', maxGyakuhibu: 200, maxRate: 2, days: 1 });
  expect(parsed.rightsHistory).toEqual([{ rightsDate: '2026-03-30', totalAmount: 680, days: 2, avgRate: 0.4 }]);
  // calcRiskの逐次クエリ(信用残の有無・前日終値)が無くなったため、リクエストあたりの
  // DynamoDBアクセスは4回(yutai master get・latest price・financial summary・gyakuhibu history)。
  expect(mockSend).toHaveBeenCalledTimes(4);
});

test('GET /yutai/{ticker} rightsHistory excludes noGyakuhibu marker rows (checked-but-no-shortage dates from Fix 2)', async () => {
  mockSend
    .mockResolvedValueOnce({
      Item: { ticker: '1234', companyName: '○○HD', content: 'QUOカード', value: 1000, unitShares: 100, rightsMonths: [], riskStatus: 'na', maxGyakuhibu: null, maxRate: null, days: null },
    }) // yutai master get
    .mockResolvedValueOnce({ Items: [] }) // latest price
    .mockResolvedValueOnce({ Items: [] }) // financial summary
    .mockResolvedValueOnce({
      Items: [
        { ticker: '1234', rightsDate: '2026-03-30', totalAmount: 680, days: 2, avgRate: 0.4 },
        { ticker: '1234', rightsDate: '2026-02-27', totalAmount: 0, days: 0, avgRate: 0, noGyakuhibu: true },
      ],
    }); // gyakuhibu actual history: one real entry + one "checked, no shortage" marker row

  const result = await handler(makeEvent('GET /yutai/{ticker}', { pathParameters: { ticker: '1234' } }));

  const parsed = body(result) as { rightsHistory: Array<{ rightsDate: string }> };
  expect(parsed.rightsHistory).toEqual([{ rightsDate: '2026-03-30', totalAmount: 680, days: 2, avgRate: 0.4 }]);
});

test('GET /yutai/{ticker} returns the precomputed risk fields verbatim, including the danger case', async () => {
  mockSend
    .mockResolvedValueOnce({
      Item: { ticker: '1234', companyName: '○○HD', content: 'QUOカード', value: 99, unitShares: 100, rightsMonths: [8], riskStatus: 'danger', maxGyakuhibu: 100, maxRate: 1, days: 1 },
    }) // yutai master get
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', date: '2026-08-12', close: 500, volume: 10000 }] }) // latest price
    .mockResolvedValueOnce({ Items: [] }) // financial summary
    .mockResolvedValueOnce({ Items: [] }); // gyakuhibu actual history

  const result = await handler(makeEvent('GET /yutai/{ticker}', { pathParameters: { ticker: '1234' } }));

  const parsed = body(result) as { risk: { maxGyakuhibu: number; riskStatus: string } };
  expect(parsed.risk).toEqual({ riskStatus: 'danger', maxGyakuhibu: 100, maxRate: 1, days: 1 });
});

test('GET /yutai/{ticker} returns 404 for a ticker not in the yutai master', async () => {
  mockSend.mockResolvedValueOnce({ Item: undefined });

  const result = await handler(makeEvent('GET /yutai/{ticker}', { pathParameters: { ticker: '9999' } }));

  expect((result as { statusCode: number }).statusCode).toBe(404);
});

test('GET /yutai/{ticker} returns rightsDate: null and companyName: null (not missing keys) and an all-null risk object when there is no upcoming rights date and no companyName on record', async () => {
  mockSend
    .mockResolvedValueOnce({
      Item: { ticker: '1234', content: 'QUOカード', value: 1000, unitShares: 100, rightsMonths: [], riskStatus: 'na', maxGyakuhibu: null, maxRate: null, days: null },
    }) // yutai master get (no companyName)
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', date: '2026-08-12', close: 500, volume: 10000 }] }) // latest price
    .mockResolvedValueOnce({ Items: [] }) // financial summary: none yet
    .mockResolvedValueOnce({ Items: [] }); // gyakuhibu actual history: none

  const result = await handler(makeEvent('GET /yutai/{ticker}', { pathParameters: { ticker: '1234' } }));

  expect((result as { statusCode: number }).statusCode).toBe(200);
  const rawBody = (result as { body: string }).body;
  expect(rawBody).toContain('"rightsDate":null');
  expect(rawBody).toContain('"companyName":null');

  const parsed = body(result) as {
    rightsDate: string | null;
    companyName: string | null;
    risk: { maxGyakuhibu: number | null; maxRate: number | null; days: number | null; riskStatus: string };
  };
  expect(parsed.rightsDate).toBeNull();
  expect(parsed.companyName).toBeNull();
  expect(parsed.risk).toEqual({ maxGyakuhibu: null, maxRate: null, days: null, riskStatus: 'na' });
});
```

- [ ] **Step 10: テストを実行して全て成功することを確認する**

Run: `npx jest test/reference-api.test.ts`
Expected: PASS(全テスト)

- [ ] **Step 11: 全体のテストスイートを実行する**

Run: `npx jest`
Expected: PASS(この時点で`lib/j-quants-stack.ts`はまだ新バッチを配線していないが、既存のLambda・テストへの影響は無いので全体が通るはず)

- [ ] **Step 12: コミット**

```bash
git add lambda/reference-api/index.ts test/reference-api.test.ts
git commit -m "Serve GET /yutai risk fields from precomputed data instead of live per-ticker queries"
```

---

### Task 4: CDKスタックへの配線

**Files:**
- Modify: `lib/j-quants-stack.ts`
- Modify: `test/j-quants.test.ts`

**Interfaces:**
- Consumes: `lambda/yutai-risk-precompute-batch/index.ts`(Task 2)

- [ ] **Step 1: 新規Lambdaと日次スケジュールを追加する**

`lib/j-quants-stack.ts`の`YutaiTdnetWatchBatchFunction`の定義・スケジュールの直後、`referenceApiFn`の定義の直前に以下を挿入する:

```typescript

    const yutaiRiskPrecomputeBatchFn = new nodejs.NodejsFunction(this, 'YutaiRiskPrecomputeBatchFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'yutai-risk-precompute-batch', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(14),
      memorySize: 256,
      bundling: { externalModules: ['@aws-sdk/*'] },
      environment: {
        YUTAI_MASTER_TABLE_NAME: this.yutaiMasterTable.tableName,
        MARGIN_BALANCE_TABLE_NAME: this.marginBalanceTable.tableName,
        TABLE_NAME: this.stockPricesTable.tableName,
      },
    });

    this.yutaiMasterTable.grantReadWriteData(yutaiRiskPrecomputeBatchFn);
    this.marginBalanceTable.grantReadData(yutaiRiskPrecomputeBatchFn);
    this.stockPricesTable.grantReadData(yutaiRiskPrecomputeBatchFn);

    // GET /yutai一覧のリスク判定を事前計算し、reference-apiでの逐次クエリ(銘柄数に比例して
    // 増える)を無くす。PriceBatchFunction(daily 09:00 UTC)の後に実行する。JST 18:20 = UTC 09:20。
    new events.Rule(this, 'YutaiRiskPrecomputeBatchSchedule', {
      schedule: events.Schedule.cron({ minute: '20', hour: '9' }),
      targets: [new targets.LambdaFunction(yutaiRiskPrecomputeBatchFn)],
    });
```

- [ ] **Step 2: 合成(synth)して確認する**

Run: `APP_PASSWORD=dummy-for-synth npx cdk synth JQuantsStack > /dev/null && echo SYNTH_OK`
Expected: `SYNTH_OK`

Run: `MSYS_NO_PATHCONV=1 APP_PASSWORD=dummy-for-synth npx cdk synth JQuantsStack 2>/dev/null | grep -B5 "ScheduleExpression"`
Expected: `YutaiRiskPrecomputeBatchSchedule`が`cron(20 9 * * ? *)`で存在する(既存6つのスケジュール+これで7つ)

- [ ] **Step 3: `test/j-quants.test.ts`にテストを追加する**

以下を末尾に追記する:

```typescript
test('creates the yutai-risk-precompute-batch Lambda with read/write access to the yutai master table and a daily schedule after price-batch', () => {
  const template = synth();

  template.hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'index.handler',
    Environment: {
      Variables: Match.objectLike({
        YUTAI_MASTER_TABLE_NAME: Match.anyValue(),
        MARGIN_BALANCE_TABLE_NAME: Match.anyValue(),
        TABLE_NAME: Match.anyValue(),
      }),
    },
  });
  template.hasResourceProperties('AWS::Events::Rule', {
    ScheduleExpression: 'cron(20 9 * * ? *)',
    State: 'ENABLED',
  });
});
```

- [ ] **Step 4: テストスイート全体を実行する**

Run: `npx jest`
Expected: PASS(全テストスイート)

- [ ] **Step 5: コミット**

```bash
git add lib/j-quants-stack.ts test/j-quants.test.ts
git commit -m "Wire yutai-risk-precompute-batch into the CDK stack"
```

---

### Task 5: README更新

**Files:**
- Modify: `README.md`

- [ ] **Step 1: アーキテクチャ図に新規バッチを追加する**

冒頭のアーキテクチャ図(フェンスドコードブロック)の`YutaiTdnetWatchBatchFunction`のブロックの後に、既存の書式(`EventBridge(...)  → XxxFunction(Lambda)  - bullet  → テーブル に upsert`)に合わせて以下を追加する:

```
EventBridge(毎日 JST18:20)
  → YutaiRiskPrecomputeBatchFunction(Lambda)
      - JQuantsYutaiMasterを全件スキャンし、銘柄ごとに逆日歩リスク(信用残の有無・前日終値ベース)を計算
      → JQuantsYutaiMaster に riskStatus/maxGyakuhibu/maxRate/days を書き戻す
```

- [ ] **Step 2: Lambda一覧テーブルに追加する**

`YutaiTdnetWatchBatchFunction`の行の後に、`YutaiRiskPrecomputeBatchFunction`(トリガー: `cron(20 9 * * ? *)` = JST 18:20 毎日、役割: `JQuantsYutaiMaster`を全件スキャンし逆日歩リスクを事前計算・書き戻し。`GET /yutai`一覧APIが銘柄数に比例した逐次DynamoDBクエリを行わずに済むようにするため)を追加する。

- [ ] **Step 3: 優待クロス機能の説明に事前計算方式への変更を追記する**

「優待クロス逆日歩リスク可視化」節に、`GET /yutai`一覧のリスク判定は`YutaiRiskPrecomputeBatchFunction`が事前計算し`JQuantsYutaiMaster`に書き戻す方式であること、`reference-api`は事前計算済みの値を読むだけであることを追記する(1,000銘柄規模で`reference-api`の10秒タイムアウトを超えないようにするための設計であることも一言添える)。

- [ ] **Step 4: J-Quants Standardプラン移行の準備メモを追記する**

「J-Quants Freeプランの実際の挙動」節、または新設の小節として、`price-batch`/`financial-summary-batch`は`REQUEST_INTERVAL_MS`環境変数が既に設定可能であり、Standardプラン移行時はCDKの環境変数を短縮するだけで対応できること、`financial-summary-batch`は決算系エンドポイント固有の60req/分上限により1,000銘柄規模では移行後も一部銘柄が巡回しきれない可能性があるが、四半期更新データのため実害は小さいと判断し許容していることを記載する。

- [ ] **Step 5: テストスイート全体を実行する(コード変更はないが安全確認)**

Run: `npx jest`
Expected: PASS(全テストスイート)

- [ ] **Step 6: コミット**

```bash
git add README.md
git commit -m "Document the risk-precompute batch and Standard-plan migration notes"
```
