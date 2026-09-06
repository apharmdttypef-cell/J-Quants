# 優待価値nullable化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** kabuyutai.comから優待価値(円換算)を抽出できない銘柄(例: 東武鉄道9001「優待乗車証(回数券:2枚〜)」)も、非表示にせず「対象外」として一覧・詳細に表示できるようにする。

**Architecture:** `value: number` を `value: number | null` として書き込み元(yutai-master-sync-batch)から表示(フロントエンド)まで一貫して広げる。既存の`maxGyakuhibu: number | null`と同じ「無ければnull、呼び出し側でnullガード、既存の`na`(対象外)ステータスに倒す」パターンをそのまま踏襲する。新しいステータス値・新しいCSSクラスは追加しない(`risk-badge--na`は既存)。

**Tech Stack:** TypeScript / AWS Lambda / DynamoDB / React / Vite / Jest。

## Global Constraints

- `value`はDynamoDBに書き込む際、`undefined`ではなく明示的に`null`にする(`entry.value ?? null`。`minInvestment`の既存パターンと同じ)。DynamoDBは`undefined`を含む属性を許容しない場合がある一方、`null`は正規のNULL型として書き込める。
- 優待価値に依存しない計算(`maxGyakuhibu`・`maxRate`・`days`・逆日歩予測の`forecastP50`/`forecastP90`/`fillMean`/`pOccur`)は、`value`の有無に関わらず今まで通り計算する。優待価値との比較が必要な項目(`riskStatus`のsafe/danger、`expectedNet`、`forecastStatus`のsafe/caution/danger)だけを`value === null`のとき既存の`na`にする。
- `rightsMonths`が解析できないケースのスキップ挙動(`yutai-master-sync-batch`)は変更しない(実データでは発生実績が無く、対応不要と判断済み)。
- 表示側のnullガードは、既存の`maxGyakuhibu`列で使われているパターン(`x !== null ? formatFinancialYen(String(x)) : '—'`、`sortingFn`でnullを最後尾に)をそのまま踏襲し、新しい表示規約を作らない。
- 設計の背景・詳細根拠は `docs/superpowers/specs/2026-09-06-yutai-value-nullable-design.md` を参照。

---

### Task 1: yutai-master-sync-batch — 優待価値が無い銘柄もnullで書き込む

**Files:**
- Modify: `lambda/yutai-master-sync-batch/index.ts`
- Test: `test/yutai-master-sync-batch.test.ts`

**Interfaces:**
- 変更なし(この関数自体はexportされた`handler`のみ)。

- [ ] **Step 1: 既存の失敗するテストを先に直す**

`test/yutai-master-sync-batch.test.ts`の以下のテスト(66〜80行目)を、「valueが無くてもvalue: nullでupsertされる」ことを検証する内容に書き換える:

```ts
test('upserts an entry with no extractable value as value: null instead of skipping it', async () => {
  mockFetchAllListings.mockResolvedValueOnce([
    { ticker: '9001', companyName: '東武鉄道', content: '優待乗車証（回数券：2枚～）など', rightsMonths: [3], value: undefined, minInvestment: undefined },
  ]);
  mockSend.mockResolvedValue({});

  await handler();

  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockSend.mock.calls[0][0]).toMatchObject({
    TableName: 'JQuantsYutaiMaster',
    Key: { ticker: '9001' },
    ExpressionAttributeValues: expect.objectContaining({ ':value': null }),
  });
});
```

これは既存の「skips an entry with no extractable value, logging a warning」テストを置き換える(この後のStepでスキップ挙動自体を削除するため、置き換えないと矛盾するテストが残る)。

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx jest test/yutai-master-sync-batch.test.ts -t "upserts an entry with no extractable value"`
Expected: FAIL(現状の実装は`value`が無いとupsertせずスキップするため、`mockSend`が呼ばれない)

- [ ] **Step 3: 実装を変更する**

`lambda/yutai-master-sync-batch/index.ts`の以下のブロックを削除する:

```ts
    if (entry.value === undefined) {
      console.warn(`${entry.ticker}: could not extract value from content "${entry.content}"; skipping`);
      skipped++;
      continue;
    }
```

同ファイルの`UpdateExpression`の`ExpressionAttributeValues`内、`':value': entry.value,`を以下に変更する(既存の`minInvestment`と同じ`?? null`パターン):

```ts
      ':value': entry.value ?? null,
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `npx jest test/yutai-master-sync-batch.test.ts`
Expected: PASS(全テスト)

- [ ] **Step 5: コミット**

```bash
git add lambda/yutai-master-sync-batch/index.ts test/yutai-master-sync-batch.test.ts
git commit -m "Write yutai master rows with value: null instead of skipping unparseable value"
```

---

### Task 2: yutai-risk-precompute-batch — valueが無くてもmaxGyakuhibu等は計算し、riskStatusだけnaにする

**Files:**
- Modify: `lambda/yutai-risk-precompute-batch/index.ts`
- Test: `test/yutai-risk-precompute-batch.test.ts`

**Interfaces:**
- Modify: `MasterRow.value: number` → `value: number | null`(`lambda/yutai-risk-precompute-batch/index.ts`内のローカル型。他タスクの型とは独立)。

- [ ] **Step 1: 既存テストのタイトルを修正する**

`test/yutai-risk-precompute-batch.test.ts`の168〜175行目のテストタイトルを、実際の検証内容(`unitShares`欠落時のスキップ。`value`欠落単体では今後スキップしなくなるため)に合わせて修正する:

```ts
test('skips a row missing unitShares without crashing', async () => {
  mockSend.mockResolvedValueOnce({
    Items: [{ ticker: '9999', rightsMonths: [8] }], // valueもunitSharesも欠落
  });

  await expect(handler()).resolves.not.toThrow();
  expect(updateCalls()).toHaveLength(0);
});
```

(このテスト自体のモックデータ・アサーションは変更不要。`unitShares`が引き続き欠落しているため、Step 3の変更後もこのテストは0件のまま通る。タイトルのみ実態に合わせて修正する。)

- [ ] **Step 2: 新しい失敗するテストを追加する**

同ファイルに、「valueが無くてもmaxGyakuhibu等は計算され、riskStatusだけnaになる」ことを検証する新しいテストを追加する(73行目の「computes safe/danger...」テストの直後に挿入):

```ts
test('computes maxGyakuhibu/maxRate/days but writes riskStatus na when value is null (優待価値が抽出できない銘柄)', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '9001', unitShares: 100, rightsMonths: [8] }] }) // yutai master scan (valueフィールド無し = 東武鉄道のような銘柄)
    .mockResolvedValueOnce({ Items: [{ ticker: '9001', date: '2026-08-10' }] }) // margin balance presence: yes
    .mockResolvedValueOnce({ Items: [{ ticker: '9001', date: '2026-08-12', close: 500 }] }); // latest close

  await handler();

  const calls = updateCalls();
  expect(calls).toHaveLength(1);
  const values = (calls[0][0] as { ExpressionAttributeValues: Record<string, unknown> }).ExpressionAttributeValues;
  expect(values[':riskStatus']).toBe('na'); // valueが無いので比較できずna
  expect(typeof values[':maxGyakuhibu']).toBe('number'); // valueの有無に関わらず計算される
  expect(typeof values[':maxRate']).toBe('number');
  expect(typeof values[':days']).toBe('number');
});
```

- [ ] **Step 3: テストを実行して新規テストが失敗することを確認する**

Run: `npx jest test/yutai-risk-precompute-batch.test.ts -t "writes riskStatus na when value is null"`
Expected: FAIL(現状の`scanYutaiMaster`は`typeof item.value === 'number'`でない行を除外するため、`calls`が0件になる)

- [ ] **Step 4: 実装を変更する**

`lambda/yutai-risk-precompute-batch/index.ts`のインターフェース定義を変更する:

```ts
interface MasterRow {
  ticker: string;
  value: number | null;
  unitShares: number;
  minInvestment: number | null;
  rightsMonths: number[];
}
```

`scanYutaiMaster()`内のフィルタ条件を変更する:

```ts
    for (const item of result.Items ?? []) {
      if (typeof item.ticker === 'string' && typeof item.unitShares === 'number') {
        rows.push({
          ticker: item.ticker,
          value: typeof item.value === 'number' ? item.value : null,
          unitShares: item.unitShares,
          minInvestment: typeof item.minInvestment === 'number' ? item.minInvestment : null,
          rightsMonths: item.rightsMonths ?? [],
        });
      }
    }
```

`calcRisk()`の引数の型を`MasterRow`の変更に合わせ(`row: { ticker: string; value: number | null; unitShares: number; minInvestment: number | null }`)、以下の行:

```ts
  const riskStatus: RiskStatus = row.value > maxGyakuhibu ? 'safe' : 'danger';
```

を次のように変更する:

```ts
  const riskStatus: RiskStatus = row.value === null ? 'na' : row.value > maxGyakuhibu ? 'safe' : 'danger';
```

- [ ] **Step 5: テストを実行して全て成功することを確認する**

Run: `npx jest test/yutai-risk-precompute-batch.test.ts`
Expected: PASS(全テスト)

- [ ] **Step 6: コミット**

```bash
git add lambda/yutai-risk-precompute-batch/index.ts test/yutai-risk-precompute-batch.test.ts
git commit -m "Compute maxGyakuhibu regardless of yutai value; riskStatus is na only when value is null"
```

---

### Task 3: lambda/shared/gyakuhibu-forecast.ts — forecast()がvalue: number | nullを受け付けるようにする

**Files:**
- Modify: `lambda/shared/gyakuhibu-forecast.ts`
- Test: `test/gyakuhibu-forecast.test.ts`

**Interfaces:**
- Modify: `forecast(args: { ...; value: number })` → `forecast(args: { ...; value: number | null })`(`lambda/shared/gyakuhibu-forecast.ts`のexport関数。Task 4の`gyakuhibu-forecast-batch`がこの関数を呼び出す)。

- [ ] **Step 1: 失敗するテストを書く**

`test/gyakuhibu-forecast.test.ts`の138行目付近(「forecast returns na when maxGyakuhibu is null...」テスト)の直後に、以下のテストを追加する:

```ts
test('forecast computes forecastP50/forecastP90 but forecastStatus na and expectedNet null when value is null (優待価値不明)', () => {
  // poolSamplesのfill=[0, 0.5, 1.0] (既存の「forecast with no ticker samples」テストと同じ入力)。
  const poolSamples = [0, 0.5, 1.0].map((f) => sample(f));
  const result = forecast({
    tickerSamples: [], poolSamples, scenario: 'last-rights', excessRatio: 1.5, maxGyakuhibu: 1000, value: null,
  });
  // maxGyakuhibuがあるので分布そのもの(fillP50/fillP90/forecastP50/forecastP90)は計算される。
  expect(result.fillP50).toBeCloseTo(0.5);
  expect(result.forecastP50).toBeCloseTo(500); // 0.5 * 1000
  expect(result.forecastP90).toBeCloseTo(1000); // 1.0 * 1000
  // valueが無いので優待価値との比較は不能。
  expect(result.expectedNet).toBeNull();
  expect(result.forecastStatus).toBe('na');
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx jest test/gyakuhibu-forecast.test.ts -t "value is null"`
Expected: 型エラーでコンパイル失敗、または`value: null`を`number`型に渡せずTypeScriptのビルドが失敗する(`forecast()`の引数型が`value: number`のため)

- [ ] **Step 3: 実装を変更する**

`lambda/shared/gyakuhibu-forecast.ts`の`forecast()`の引数型を変更する:

```ts
export function forecast(args: {
  tickerSamples: ForecastSample[];
  /** 全銘柄横断のプールサンプル全体。ビンで絞り込まずに渡すこと(上記コメント参照)。 */
  poolSamples: ForecastSample[];
  scenario: Scenario;
  excessRatio: number | null;
  maxGyakuhibu: number | null;
  value: number | null;
}): ForecastResult {
```

判定ブロックを以下のように変更する(`forecastP50`/`forecastP90`/`forecastMean`は`maxGyakuhibu`があれば計算を続け、`expectedNet`/`status`だけ`value`の有無で分岐する):

```ts
  if (maxGyakuhibu !== null) {
    forecastP50 = fillP50 * maxGyakuhibu;
    forecastP90 = fillP90 * maxGyakuhibu;
    forecastMean = fillMean * maxGyakuhibu;
    if (value !== null) {
      expectedNet = value - forecastMean;
      status = forecastStatus(value, forecastP50, forecastP90);
    }
  }
```

- [ ] **Step 4: テストを実行して全て成功することを確認する**

Run: `npx jest test/gyakuhibu-forecast.test.ts`
Expected: PASS(全テスト。既存のP50/P90ロジックへの回帰が無いことも確認)

- [ ] **Step 5: コミット**

```bash
git add lambda/shared/gyakuhibu-forecast.ts test/gyakuhibu-forecast.test.ts
git commit -m "Allow forecast() to accept a null yutai value, keeping the distribution computed"
```

---

### Task 4: gyakuhibu-forecast-batch — valueが無い銘柄もforecast行を書き込む

**Files:**
- Modify: `lambda/gyakuhibu-forecast-batch/index.ts`
- Test: `test/gyakuhibu-forecast-batch.test.ts`

**Interfaces:**
- Consumes: `forecast()`(`lambda/shared/gyakuhibu-forecast.ts`、Task 3で`value: number | null`を受け付けるよう変更済み)。
- Modify: `MasterRow.value: number` → `value: number | null`(`lambda/gyakuhibu-forecast-batch/index.ts`内のローカル型)。

- [ ] **Step 1: 失敗するテストを書く**

`test/gyakuhibu-forecast-batch.test.ts`に、以下のテストを追加する(既存の「computes a forecast per ticker...」テストの直後):

```ts
test('writes a forecast row (with forecastStatus na) for a ticker whose yutai value is unknown', async () => {
  await withFixedNow(async () => {
    mockSend
      .mockResolvedValueOnce({ Items: [{ ticker: '9001', unitShares: 100, rightsMonths: [8], maxGyakuhibu: 5000 }] }) // yutai master scan (valueフィールド無し)
      .mockResolvedValueOnce({
        Items: [
          {
            ticker: '9001', rightsDate: '2025-08-27', financingBalance: 100, lendingBalance: 250,
            avgRate: 10, days: 1, maxRateActual: 10, restriction: null, emergencyMeasure: null, enriched: true,
          },
        ],
      }) // gyakuhibu actual scan
      .mockResolvedValueOnce({}) // _POOL_ put
      .mockResolvedValueOnce({ Items: [] }) // margin balance query
      .mockResolvedValueOnce({}); // 9001のforecast put

    await handler();

    const puts = putCalls();
    expect(puts).toHaveLength(2);
    const item = (puts[1][0] as { Item: Record<string, unknown> }).Item;
    expect(item.ticker).toBe('9001');
    expect(item.forecastStatus).toBe('na'); // valueが無いので判定不能
    expect(typeof item.forecastP50).toBe('number'); // 分布自体は計算される
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx jest test/gyakuhibu-forecast-batch.test.ts -t "yutai value is unknown"`
Expected: FAIL(現状の`scanYutaiMaster`は`typeof item.value === 'number'`でない行を除外するため、`puts`が1件(`_POOL_`のみ)になる)

- [ ] **Step 3: 実装を変更する**

`lambda/gyakuhibu-forecast-batch/index.ts`の`MasterRow`インターフェースを変更する:

```ts
interface MasterRow {
  ticker: string;
  value: number | null;
  unitShares: number;
  rightsMonths: number[];
  maxGyakuhibu: number | null;
}
```

`scanYutaiMaster()`内のフィルタ条件を変更する:

```ts
    for (const item of result.Items ?? []) {
      if (typeof item.ticker === 'string' && typeof item.unitShares === 'number') {
        rows.push({
          ticker: item.ticker,
          value: typeof item.value === 'number' ? item.value : null,
          unitShares: item.unitShares,
          rightsMonths: Array.isArray(item.rightsMonths) ? item.rightsMonths : [],
          maxGyakuhibu: typeof item.maxGyakuhibu === 'number' ? item.maxGyakuhibu : null,
        });
      }
    }
```

`forecast()`への呼び出し(`value: row.value`)はそのまま変更不要(Task 3で`number | null`を受け付けるようになっている)。

- [ ] **Step 4: テストを実行して全て成功することを確認する**

Run: `npx jest test/gyakuhibu-forecast-batch.test.ts`
Expected: PASS(全テスト)

- [ ] **Step 5: コミット**

```bash
git add lambda/gyakuhibu-forecast-batch/index.ts test/gyakuhibu-forecast-batch.test.ts
git commit -m "Write a forecast row for tickers whose yutai value is unknown"
```

---

### Task 5: reference-api — value: number | nullをAPI応答に通す

**Files:**
- Modify: `lambda/reference-api/index.ts`
- Test: `test/reference-api.test.ts`

**Interfaces:**
- Modify: `YutaiMasterRow.value: number` → `value: number | null`(`lambda/reference-api/index.ts`内のローカル型。`scanYutaiMaster()`・`getYutaiMaster()`両方の戻り値型であり、`/yutai`・`/yutai/forecast`の一覧・詳細すべてがこの型を経由する)。

- [ ] **Step 1: 失敗するテストを書く**

`test/reference-api.test.ts`に、`/yutai`一覧が`value: null`の行をエラー無く返すことを検証するテストを追加する(既存の257〜258行目付近のテストと同じ形式に倣う):

```ts
test('GET /yutai includes a ticker whose value is null instead of dropping it', async () => {
  mockSend.mockResolvedValueOnce({
    Items: [
      { ticker: '9001', companyName: '東武鉄道', content: '優待乗車証（回数券：2枚～）など', value: null, unitShares: 100, rightsMonths: [8], riskStatus: 'na', maxGyakuhibu: 12400, maxRate: 124, days: 1 },
    ],
  });

  const result = await handler(makeEvent('GET /yutai', { queryStringParameters: {} }));

  const parsed = body(result) as { tickers: Array<Record<string, unknown>> };
  expect(parsed.tickers).toHaveLength(1);
  expect(parsed.tickers[0]).toMatchObject({ ticker: '9001', value: null, riskStatus: 'na', maxGyakuhibu: 12400 });
});
```

同様に、`GET /yutai/{ticker}`が`value: null`をそのまま返すことを検証するテストも追加する(モックの呼び出し順は既存の「GET /yutai/{ticker} returns basic info...」テストと同じ: yutai master get → latest price → financial summary → gyakuhibu actual history の4回):

```ts
test('GET /yutai/{ticker} returns value: null when the yutai value is unknown', async () => {
  mockSend
    .mockResolvedValueOnce({
      Item: { ticker: '9001', companyName: '東武鉄道', content: '優待乗車証（回数券：2枚～）など', value: null, unitShares: 100, rightsMonths: [8], riskStatus: 'na', maxGyakuhibu: 12400, maxRate: 124, days: 1 },
    }) // yutai master get
    .mockResolvedValueOnce({ Items: [] }) // latest price
    .mockResolvedValueOnce({ Items: [] }) // financial summary
    .mockResolvedValueOnce({ Items: [] }); // gyakuhibu actual history

  const result = await handler(makeEvent('GET /yutai/{ticker}', { pathParameters: { ticker: '9001' } }));

  const parsed = body(result) as { value: number | null };
  expect(parsed.value).toBeNull();
});
```

- [ ] **Step 2: テストを実行する(この2件は変更前から既に通るはず)**

Run: `npx jest test/reference-api.test.ts -t "value is null"`
Expected: PASS。`scanYutaiMaster()`/`getYutaiMaster()`はDynamoDBから読んだ`value`をそのまま(型チェック無しで)代入しているだけなので、`YutaiMasterRow.value`の型注釈を直す前でもランタイムの挙動としては既に`null`を素通りできている。この2件のテストはランタイムのバグ修正ではなく、Step 3の型注釈の変更が正しいことを確認する「characterization test」であり、Step 3の前後どちらでもPASSする。

- [ ] **Step 3: 実装を変更する**

`lambda/reference-api/index.ts`の`YutaiMasterRow`インターフェースの`value: number`を`value: number | null`に変更する。これ一箇所の変更で、`scanYutaiMaster()`(`/yutai`・`/yutai/forecast`一覧)と`getYutaiMaster()`(`/yutai/:ticker`・`/yutai/:ticker/forecast`詳細)の両方に自動的に反映される(他の代入箇所は`item.value`/`master.value`をそのまま渡しているだけで変更不要)。

- [ ] **Step 4: テストを実行して全て成功することを確認する**

Run: `npx jest test/reference-api.test.ts`
Expected: PASS(全テスト)

- [ ] **Step 5: コミット**

```bash
git add lambda/reference-api/index.ts test/reference-api.test.ts
git commit -m "Widen YutaiMasterRow.value to number | null in the reference API"
```

---

### Task 6: フロントエンド(優待クロス側) — value: number | nullの型・表示対応

**Files:**
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/pages/YutaiListPage.tsx`
- Modify: `frontend/src/pages/YutaiDetailPage.tsx`

**Interfaces:**
- Modify: `YutaiListItem.value: number` → `value: number | null`(`frontend/src/api/types.ts`)。
- Modify: `YutaiDetail.value: number` → `value: number | null`(`frontend/src/api/types.ts`)。

- [ ] **Step 1: 型を変更する**

`frontend/src/api/types.ts`の`YutaiListItem`と`YutaiDetail`インターフェースの`value: number`を、それぞれ`value: number | null`に変更する。

- [ ] **Step 2: 型チェックを実行し、エラー箇所を確認する**

Run: `cd frontend && npx tsc --noEmit -p tsconfig.json`
Expected: `YutaiListPage.tsx`と`YutaiDetailPage.tsx`の`value`を直接`formatFinancialYen(String(...))`に渡している箇所でエラーは出ない(TypeScriptは`String(number | null)`を許容し`"null"`という文字列になってしまう。**型エラーにはならないが表示が壊れるため、Step 3で明示的に直す**)。

- [ ] **Step 3: 表示箇所を直す**

`frontend/src/pages/YutaiListPage.tsx`の`columns`定義内、`value`列の`cell`を、既存の`maxGyakuhibu`列と同じnullガードパターンに変更する:

現在:
```ts
  {
    accessorKey: 'value',
    header: '優待価値',
    sortDescFirst: false,
    cell: ({ row }) => formatFinancialYen(String(row.original.value)),
  },
```

変更後(`maxGyakuhibu`列と同じ`sortingFn`でnullを最後尾に):
```ts
  {
    accessorKey: 'value',
    header: '優待価値',
    sortDescFirst: false,
    sortingFn: (rowA, rowB) => {
      const a = rowA.original.value;
      const b = rowB.original.value;
      if (a === null && b === null) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      return a - b;
    },
    cell: ({ row }) => (row.original.value !== null ? formatFinancialYen(String(row.original.value)) : '—'),
  },
```

`frontend/src/pages/YutaiDetailPage.tsx`の74行目:
```tsx
            <div className="summary-item__value">{formatFinancialYen(String(data.value))}</div>
```
を以下に変更する:
```tsx
            <div className="summary-item__value">{data.value !== null ? formatFinancialYen(String(data.value)) : '—'}</div>
```

- [ ] **Step 4: 型チェックとビルドを実行する**

Run: `cd frontend && npx tsc --noEmit -p tsconfig.json && npm run build`
Expected: 型チェック・ビルドともにエラー無く成功する

- [ ] **Step 5: コミット**

```bash
git add frontend/src/api/types.ts frontend/src/pages/YutaiListPage.tsx frontend/src/pages/YutaiDetailPage.tsx
git commit -m "Handle a null yutai value in the screening list and detail pages"
```

---

### Task 7: フロントエンド(逆日歩予測側) — value: number | nullの型・表示対応

**Files:**
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/pages/YutaiForecastListPage.tsx`
- Modify: `frontend/src/pages/YutaiForecastDetailPage.tsx`

**Interfaces:**
- Modify: `YutaiForecastListItem.value: number` → `value: number | null`(`frontend/src/api/types.ts`)。
- Modify: `YutaiForecastDetail.value: number` → `value: number | null`(`frontend/src/api/types.ts`)。

- [ ] **Step 1: 型を変更する**

`frontend/src/api/types.ts`の`YutaiForecastListItem`と`YutaiForecastDetail`インターフェースの`value: number`を、それぞれ`value: number | null`に変更する(Task 6で変更した`YutaiListItem`/`YutaiDetail`とは別のインターフェースなので、これも個別に変更が必要)。

- [ ] **Step 2: 一覧ページの表示を直す**

`frontend/src/pages/YutaiForecastListPage.tsx`の`columns`定義内、`value`列を、Task 6のYutaiListPage.tsxと同じパターンに変更する:

現在:
```ts
  {
    accessorKey: 'value',
    header: '優待価値',
    sortDescFirst: false,
    cell: ({ row }) => formatFinancialYen(String(row.original.value)),
  },
```

変更後:
```ts
  {
    accessorKey: 'value',
    header: '優待価値',
    sortDescFirst: false,
    sortingFn: (rowA, rowB) => {
      const a = rowA.original.value;
      const b = rowB.original.value;
      if (a === null && b === null) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      return a - b;
    },
    cell: ({ row }) => (row.original.value !== null ? formatFinancialYen(String(row.original.value)) : '—'),
  },
```

`compareByDefaultOrder`(デフォルトソート)は`forecastStatus`のランク→`expectedNet`昇順で並べており、`value`を直接参照していないため変更不要。

- [ ] **Step 3: 詳細ページの表示・計算を直す**

`frontend/src/pages/YutaiForecastDetailPage.tsx`の104行目:
```tsx
  const netP90 = forecast.forecastP90 !== null ? data.value - forecast.forecastP90 : null;
```
を以下に変更する(`value`が無ければ計算せず`null`のまま。`formatSignedYen`は既に`null`を「—」として表示する):
```tsx
  const netP90 = forecast.forecastP90 !== null && data.value !== null ? data.value - forecast.forecastP90 : null;
```

同ファイルの220行目、感度表内の該当セル:
```tsx
                      <td className="num">{formatSignedYen(data.value - p90)}</td>
```
を以下に変更する:
```tsx
                      <td className="num">{data.value !== null ? formatSignedYen(data.value - p90) : '—'}</td>
```

- [ ] **Step 4: 型チェックとビルドを実行する**

Run: `cd frontend && npx tsc --noEmit -p tsconfig.json && npm run build`
Expected: 型チェック・ビルドともにエラー無く成功する

- [ ] **Step 5: コミット**

```bash
git add frontend/src/api/types.ts frontend/src/pages/YutaiForecastListPage.tsx frontend/src/pages/YutaiForecastDetailPage.tsx
git commit -m "Handle a null yutai value in the forecast list and detail pages"
```
