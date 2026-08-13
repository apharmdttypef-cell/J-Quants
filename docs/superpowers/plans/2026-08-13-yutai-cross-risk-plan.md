# 株主優待クロス 逆日歩リスク可視化 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/yutai` と `/yutai/:ticker` の2画面を追加し、優待クロスの逆日歩リスク(次回権利日の上限見積り+過去の実績)を可視化する。フェーズ1では信用残データだけダミー実装にし、AWSに実デプロイして画面を検証できる状態にする。

**Architecture:** 既存の単一`JQuantsStack`にDynamoDBテーブル4つ・Lambda2本(新規)・既存Lambda2本の拡張・APIルート3本・フロント2画面を追加する。逆日歩の「次回予測」は日証金公開の最高料率早見表(株価×単元株数で決まる決定的な式)を使い、「過去の実績」はtaisyaku.jp(日本証券金融公式サイト)の確報データを使う。両者は別の計算経路。

**Tech Stack:** CDK(TypeScript)、Lambda(Node.js 22、`aws-cdk-lib/aws-lambda-nodejs`)、DynamoDB、API Gateway HTTP API、React + Vite + TypeScript、recharts、Jest。

## Global Constraints

- 個人用アプリ、YAGNIで進める(設計書 `docs/superpowers/specs/2026-08-13-yutai-cross-risk-design.md` 参照)。
- `/yutai`系は読み取り専用。登録・編集・削除のAPI/UIは作らない。
- 信用残データ(`mkt-margin-int`/`mkt-margin-alert`)はフェーズ1ではダミー実装。taisyaku.jp・取引カレンダーは無料でJ-Quants Standardプランと無関係なため、フェーズ1から本番の取得処理を使う。
- 逆日歩の「次回予測」は最高料率(株価×単元株数で決定的に算出)を使う。信用残(貸株超過株数)は計算に使わない(トレンドグラフ表示と貸借銘柄判定にのみ使う)。
- 新規DynamoDBテーブルは既存3テーブルと同様 `RemovalPolicy.RETAIN` + PITR + `PAY_PER_REQUEST`。
- フロントに自動テストは無い(既存4画面も同様)。フロントの各タスクは実装後に `npm run dev` で手動確認する。
- バックエンドは既存同様Jestでテストを書く(`jest.mock('@aws-sdk/...')` パターンを踏襲)。

---

## 実装前の注意(要手動検証)

**Task 8(GyakuhibuHistoryBatchFunction)は、taisyaku.jpのCSV取得の実際のリクエスト形式が未確認のまま着手することになる。** 調査の結果、銘柄詳細ページ(`https://www.taisyaku.jp/app/stock/detail/{code}-01`)に「CSV」リンクがあり相対パス `{code}/csv` を指しているが、`GET /app/stock/{code}/csv` を直接叩くと404になることを確認済み(日付範囲などのクエリパラメータ、あるいはPOSTフォーム送信が必要と推測される)。Task 8のStep 1で実際のブラウザのDevTools(Networkタブ)を使い、検索フォームから日付範囲を指定してCSVを取得した際の実際のリクエスト(URL・メソッド・パラメータ)を確認してから実装する。

---

## Task 1: 逆日歩計算ロジックと取引カレンダーの純粋関数

**Files:**
- Create: `lambda/shared/gyakuhibu-calc.ts`
- Create: `lambda/shared/trading-calendar.ts`
- Test: `test/gyakuhibu-calc.test.ts`
- Test: `test/trading-calendar.test.ts`

**Interfaces:**
- Produces:
  - `calcMaxRate(closePrice: number, tradingUnit: number): number` — 1株・1日あたりの最高料率(円)
  - `calcMaxGyakuhibu(closePrice: number, tradingUnit: number, days: number): number` — 最大逆日歩(円)
  - `interface CalendarDay { date: string; holDiv: string }`
  - `isTradingDay(day: CalendarDay): boolean`
  - `fetchTradingCalendar(apiBaseUrl: string, apiKey: string, from: string, to: string): Promise<CalendarDay[]>`
  - `settlementDate(calendar: CalendarDay[], tradeDate: string): string` — tradeDateのT+2営業日
  - `calendarDaysBetween(from: string, to: string): number`

- [ ] **Step 1: 最高料率計算の失敗するテストを書く**

`test/gyakuhibu-calc.test.ts`:

```typescript
import { calcMaxRate, calcMaxGyakuhibu } from '../lambda/shared/gyakuhibu-calc';

// 日証金公開PDF「株式 最高料率早見表」の実際の値と一致することを確認する
// https://www.taisyaku.jp/media/about-hayamihyo.pdf
test('calcMaxRate matches the published table at investment unit boundaries', () => {
  expect(calcMaxRate(500, 100)).toBeCloseTo(1.0); // 投資単位5万円ちょうど → 上限100円 → 100/100=1.0円
  expect(calcMaxRate(600, 100)).toBeCloseTo(1.2); // 投資単位6万円 → 上限120円 → 120/100=1.2円
  expect(calcMaxRate(5000, 100)).toBeCloseTo(10.0); // 投資単位50万円 → 上限1000円 → 1000/100=10.0円
  expect(calcMaxRate(50, 1000)).toBeCloseTo(1.0); // 投資単位5万円、単元1000株 → 100/1000=0.1円 → 1円以下なので1円に切り上げ
});

test('calcMaxRate rounds up to the nearest 10 sen above 1 yen', () => {
  // 投資単位55,500円(50,000円超) → 上限 = 100 + ceil(5500/10000)*20 = 100+20=120円
  // 単元株数100 → 120/100=1.2円(既に10銭単位なのでそのまま)
  expect(calcMaxRate(555, 100)).toBeCloseTo(1.2);
  // 単元株数97 → 120/97=1.237...円 → 10銭単位で切り上げ→1.3円
  expect(calcMaxRate(572.16, 97)).toBeCloseTo(1.3);
});

test('calcMaxGyakuhibu multiplies the per-share rate by trading unit and days', () => {
  expect(calcMaxGyakuhibu(500, 100, 3)).toBeCloseTo(1.0 * 100 * 3);
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx jest test/gyakuhibu-calc.test.ts`
Expected: FAIL (`Cannot find module '../lambda/shared/gyakuhibu-calc'`)

- [ ] **Step 3: 最小実装を書く**

`lambda/shared/gyakuhibu-calc.ts`:

```typescript
// 逆日歩(品貸料率)は毎日の品貸入札で決まる変動相場であり、貸株超過株数から
// 一意に決まる固定表は存在しない。ここで計算するのは入札の上限である「最高料率」
// (投資単位=貸借値段×売買単位から一意に決まる)で、これを使って
// 「最大逆日歩(=最高料率で決着した場合の上限額)」というリスクの上限を算出する。
// 出典: 日証金公開PDF「株式 最高料率早見表」 https://www.taisyaku.jp/media/about-hayamihyo.pdf
// 参考:「貸借取引貸株超過銘柄等に対する取扱い」
//   投資単位が5万円以下: 品貸料の上限は100円
//   投資単位が5万円超: 100円に、5万円を超えた分を1万円単位で切り上げた口数×20円を加算
//   最高料率(1株あたり) = 品貸料の上限 ÷ 売買単位。1円以下なら1円、1円超は10銭単位で切り上げ
export function calcMaxRate(closePrice: number, tradingUnit: number): number {
  const investmentUnit = closePrice * tradingUnit;
  const cap = investmentUnit <= 50_000 ? 100 : 100 + Math.ceil((investmentUnit - 50_000) / 10_000) * 20;
  const rawRate = cap / tradingUnit;
  if (rawRate <= 1) return 1;
  return Math.ceil(rawRate * 10) / 10;
}

// 最大逆日歩(円) = 最高料率 × 保有株数(単元株数) × 品貸日数
export function calcMaxGyakuhibu(closePrice: number, tradingUnit: number, days: number): number {
  return calcMaxRate(closePrice, tradingUnit) * tradingUnit * days;
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx jest test/gyakuhibu-calc.test.ts`
Expected: PASS

- [ ] **Step 5: 取引カレンダーの失敗するテストを書く**

`test/trading-calendar.test.ts`:

```typescript
import { isTradingDay, settlementDate, calendarDaysBetween, fetchTradingCalendar, type CalendarDay } from '../lambda/shared/trading-calendar';

const mockFetch = jest.fn();
beforeEach(() => {
  mockFetch.mockReset();
  (global as unknown as { fetch: typeof mockFetch }).fetch = mockFetch;
});

test('isTradingDay treats HolDiv 1 (business day) and 2 (half day) as trading days', () => {
  expect(isTradingDay({ date: '2026-08-17', holDiv: '1' })).toBe(true);
  expect(isTradingDay({ date: '2026-08-17', holDiv: '2' })).toBe(true);
  expect(isTradingDay({ date: '2026-08-17', holDiv: '0' })).toBe(false);
  expect(isTradingDay({ date: '2026-08-17', holDiv: '3' })).toBe(false);
});

test('settlementDate returns the 2nd trading day after tradeDate (T+2)', () => {
  const calendar: CalendarDay[] = [
    { date: '2026-08-14', holDiv: '1' }, // 金(基準日)
    { date: '2026-08-15', holDiv: '0' }, // 土
    { date: '2026-08-16', holDiv: '0' }, // 日
    { date: '2026-08-17', holDiv: '1' }, // 月(T+1)
    { date: '2026-08-18', holDiv: '1' }, // 火(T+2)
  ];
  expect(settlementDate(calendar, '2026-08-14')).toBe('2026-08-18');
});

test('calendarDaysBetween counts calendar days including weekends', () => {
  expect(calendarDaysBetween('2026-08-14', '2026-08-18')).toBe(4);
});

test('fetchTradingCalendar calls /markets/calendar with from/to and returns the data array', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ data: [{ Date: '2026-08-14', HolDiv: '1' }] }),
  });

  const result = await fetchTradingCalendar('https://api.jquants.com/v2', 'test-api-key', '2026-08-01', '2026-08-31');

  expect(mockFetch).toHaveBeenCalledWith(
    'https://api.jquants.com/v2/markets/calendar?from=2026-08-01&to=2026-08-31',
    { headers: { 'x-api-key': 'test-api-key' } },
  );
  expect(result).toEqual([{ date: '2026-08-14', holDiv: '1' }]);
});
```

- [ ] **Step 6: テストが失敗することを確認**

Run: `npx jest test/trading-calendar.test.ts`
Expected: FAIL (`Cannot find module '../lambda/shared/trading-calendar'`)

- [ ] **Step 7: 最小実装を書く**

`lambda/shared/trading-calendar.ts`:

```typescript
// J-Quants取引カレンダー(/markets/calendar、Freeプランで利用可)。
// HolDiv: 0=非営業日, 1=営業日, 2=東証半日立会日(受渡計算上は営業日扱い), 3=非営業日(祝日取引あり)
export interface CalendarDay {
  date: string;
  holDiv: string;
}

interface RawCalendarDay {
  Date: string;
  HolDiv: string;
}

interface CalendarResponse {
  data: RawCalendarDay[];
}

export function isTradingDay(day: CalendarDay): boolean {
  return day.holDiv === '1' || day.holDiv === '2';
}

export async function fetchTradingCalendar(
  apiBaseUrl: string,
  apiKey: string,
  from: string,
  to: string,
): Promise<CalendarDay[]> {
  const params = new URLSearchParams({ from, to });
  const response = await fetch(`${apiBaseUrl}/markets/calendar?${params}`, { headers: { 'x-api-key': apiKey } });
  if (!response.ok) {
    throw new Error(`J-Quants API error ${response.status}: ${await response.text()}`);
  }
  const body = (await response.json()) as CalendarResponse;
  return body.data.map((d) => ({ date: d.Date, holDiv: d.HolDiv }));
}

// tradeDateのT+2営業日(受渡日)を返す。calendarにはtradeDateより後の日を
// 十分な件数(最低2営業日分)含めておくこと。
export function settlementDate(calendar: CalendarDay[], tradeDate: string): string {
  const upcoming = calendar
    .filter((d) => d.date > tradeDate && isTradingDay(d))
    .sort((a, b) => a.date.localeCompare(b.date));

  if (upcoming.length < 2) {
    throw new Error(`Not enough trading calendar data after ${tradeDate} to compute T+2 settlement`);
  }
  return upcoming[1].date;
}

export function calendarDaysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}
```

- [ ] **Step 8: テストが通ることを確認**

Run: `npx jest test/trading-calendar.test.ts`
Expected: PASS

- [ ] **Step 9: コミット**

```bash
git add lambda/shared/gyakuhibu-calc.ts lambda/shared/trading-calendar.ts test/gyakuhibu-calc.test.ts test/trading-calendar.test.ts
git commit -m "Add gyakuhibu max-rate calc and trading-calendar helpers"
```

---

## Task 2: DynamoDBテーブル4つをCDKスタックに追加

**Files:**
- Modify: `lib/j-quants-stack.ts`
- Test: `test/j-quants.test.ts`

**Interfaces:**
- Produces: `this.yutaiMasterTable`, `this.yutaiRightsDateTable`, `this.marginBalanceTable`, `this.gyakuhibuActualTable` (`dynamodb.Table`、`JQuantsStack`の public readonly プロパティ)

- [ ] **Step 1: 失敗するスタックテストを書く**

`test/j-quants.test.ts` に追記(既存の`synth()`ヘルパーとimportをそのまま使う):

```typescript
test('creates the JQuantsYutaiMaster table with ticker key and RETAIN policy', () => {
  const template = synth();

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    TableName: 'JQuantsYutaiMaster',
    KeySchema: [{ AttributeName: 'ticker', KeyType: 'HASH' }],
    BillingMode: 'PAY_PER_REQUEST',
  });
});

test('creates the JQuantsYutaiRightsDate table with ticker/rightsDate key', () => {
  const template = synth();

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    TableName: 'JQuantsYutaiRightsDate',
    KeySchema: [
      { AttributeName: 'ticker', KeyType: 'HASH' },
      { AttributeName: 'rightsDate', KeyType: 'RANGE' },
    ],
  });
});

test('creates the JQuantsMarginBalance table with ticker/date key', () => {
  const template = synth();

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    TableName: 'JQuantsMarginBalance',
    KeySchema: [
      { AttributeName: 'ticker', KeyType: 'HASH' },
      { AttributeName: 'date', KeyType: 'RANGE' },
    ],
  });
});

test('creates the JQuantsGyakuhibuActual table with ticker/rightsDate key', () => {
  const template = synth();

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    TableName: 'JQuantsGyakuhibuActual',
    KeySchema: [
      { AttributeName: 'ticker', KeyType: 'HASH' },
      { AttributeName: 'rightsDate', KeyType: 'RANGE' },
    ],
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx jest test/j-quants.test.ts`
Expected: FAIL (4件、該当テーブルが存在しない)

- [ ] **Step 3: テーブルを追加**

`lib/j-quants-stack.ts` のクラスプロパティ宣言に追記(`watchlistTable`宣言の直後):

```typescript
  public readonly yutaiMasterTable: dynamodb.Table;
  public readonly yutaiRightsDateTable: dynamodb.Table;
  public readonly marginBalanceTable: dynamodb.Table;
  public readonly gyakuhibuActualTable: dynamodb.Table;
```

`this.watchlistTable = new dynamodb.Table(...)` の直後(APIキーSecret定義の前)に追記:

```typescript
    // 優待マスタ本体(権利日以外)。書き込みはアプリ外(別途スクリプト等でDynamoDB
    // へ直接投入)で行う前提。アプリのUIからは読み取り専用。
    this.yutaiMasterTable = new dynamodb.Table(this, 'JQuantsYutaiMasterTable', {
      tableName: 'JQuantsYutaiMaster',
      partitionKey: { name: 'ticker', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

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

    // 信用残(融資残・貸株残)の時系列。トレンドグラフ表示と貸借銘柄判定に使う
    // (逆日歩の見積り計算そのものには使わない。最高料率は株価×単元株数で決まるため)。
    this.marginBalanceTable = new dynamodb.Table(this, 'JQuantsMarginBalanceTable', {
      tableName: 'JQuantsMarginBalance',
      partitionKey: { name: 'ticker', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'date', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // taisyaku.jp(日本証券金融公式サイト)から取得した、過去の権利日ごとの
    // 実績逆日歩。直近3年分のみ存在しうる(それより古いデータはtaisyaku.jp非公開)。
    this.gyakuhibuActualTable = new dynamodb.Table(this, 'JQuantsGyakuhibuActualTable', {
      tableName: 'JQuantsGyakuhibuActual',
      partitionKey: { name: 'ticker', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'rightsDate', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx jest test/j-quants.test.ts`
Expected: PASS(全件)

- [ ] **Step 5: コミット**

```bash
git add lib/j-quants-stack.ts test/j-quants.test.ts
git commit -m "Add DynamoDB tables for the yutai cross-risk feature"
```

---

## Task 3: 既存BatchFetchFunctionの対象銘柄を優待マスタにも拡張

**Files:**
- Modify: `lambda/batch-fetch/index.ts`
- Modify: `lib/j-quants-stack.ts`
- Test: `test/batch-fetch.test.ts`

**Interfaces:**
- Consumes: `JQuantsYutaiMaster`テーブル(Task 2で作成、`ticker`のみ読む)
- Produces: `getTargetTickers(): Promise<string[]>`(`getWatchlistTickers`を置き換え、ウォッチリスト∪優待マスタの重複排除済み一覧)

- [ ] **Step 1: 失敗するテストを書く**

`test/batch-fetch.test.ts` の先頭の`process.env`設定に追記:

```typescript
process.env.YUTAI_MASTER_TABLE_NAME = 'JQuantsYutaiMaster';
```

同ファイルに追記:

```typescript
test('fetches for the union of watchlist and yutai-master tickers, deduped', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '7203' }] }) // watchlist scan
    .mockResolvedValueOnce({ Items: [{ ticker: '7203' }, { ticker: '9999' }] }); // yutai master scan
  mockSecretsSend.mockResolvedValueOnce({ SecretString: 'test-api-key' });
  mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
  mockSend.mockResolvedValue({});

  await handler();

  // 7203は重複排除で1回だけ、9999も含めて2銘柄分(各銘柄バー+サマリで2回ずつ)fetchされる
  const barUrls = mockFetch.mock.calls.map(([url]) => url as string).filter((u) => u.includes('/equities/bars/daily'));
  expect(barUrls).toHaveLength(2);
  expect(barUrls.some((u) => u.includes('code=7203'))).toBe(true);
  expect(barUrls.some((u) => u.includes('code=9999'))).toBe(true);
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx jest test/batch-fetch.test.ts -t "union of watchlist"`
Expected: FAIL(現状は1回目のScan結果=ウォッチリストのみしか見ないため、9999が呼ばれない)

- [ ] **Step 3: 実装を変更**

`lambda/batch-fetch/index.ts` の環境変数定義に追記:

```typescript
const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
```

`getWatchlistTickers`関数を以下に置き換え:

```typescript
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

// ウォッチリスト管理画面での追加/削除、優待マスタへの投入(アプリ外)を次回実行
// から反映するため、対象銘柄は(env var固定ではなく)実行のたびにDynamoDBから読む。
// 優待クロス対象銘柄は必ずしも個人のウォッチリストに入っているとは限らないため、
// 両テーブルの和集合(重複排除)を対象にする。
async function getTargetTickers(): Promise<string[]> {
  const [watchlistTickers, yutaiTickers] = await Promise.all([
    scanTickerColumn(WATCHLIST_TABLE_NAME),
    scanTickerColumn(YUTAI_MASTER_TABLE_NAME),
  ]);
  return [...new Set([...watchlistTickers, ...yutaiTickers])];
}
```

`handler`内の`const tickers = await getWatchlistTickers();`を次のように変更:

```typescript
  const tickers = await getTargetTickers();
  if (tickers.length === 0) {
    console.warn('No target tickers (watchlist and yutai master are both empty); nothing to fetch');
    return;
  }
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx jest test/batch-fetch.test.ts`
Expected: PASS(全件。既存の「空なら何もしない」テストは`mockSend`を2回分`Items: []`にする必要があるため、そのテストも修正する)

`test/batch-fetch.test.ts` の `'does nothing when the watchlist is empty'` テストを次のように修正(2回のScanどちらも空にする):

```typescript
test('does nothing when both watchlist and yutai master are empty', async () => {
  mockSend.mockResolvedValueOnce({ Items: [] }).mockResolvedValueOnce({ Items: [] });

  await handler();

  expect(mockSecretsSend).not.toHaveBeenCalled();
  expect(mockFetch).not.toHaveBeenCalled();
});
```

Run: `npx jest test/batch-fetch.test.ts`
Expected: PASS(全件)

- [ ] **Step 5: CDKスタックの環境変数とIAM権限を追加**

`lib/j-quants-stack.ts` の `batchFetchFn` 定義(Task 2までの変更で`yutaiMasterTable`が既に存在する状態)で、`environment`に追記:

```typescript
        YUTAI_MASTER_TABLE_NAME: this.yutaiMasterTable.tableName,
```

`this.watchlistTable.grantReadData(batchFetchFn);` の直後に追記:

```typescript
    this.yutaiMasterTable.grantReadData(batchFetchFn);
```

- [ ] **Step 6: スタックテストを更新して確認**

`test/j-quants.test.ts` の `'creates the batch fetch Lambda...'` テストの `Environment.Variables` に追記:

```typescript
        YUTAI_MASTER_TABLE_NAME: Match.anyValue(),
```

Run: `npx jest test/j-quants.test.ts test/batch-fetch.test.ts`
Expected: PASS(全件)

- [ ] **Step 7: コミット**

```bash
git add lambda/batch-fetch/index.ts lib/j-quants-stack.ts test/batch-fetch.test.ts test/j-quants.test.ts
git commit -m "Extend BatchFetchFunction to also cover yutai-master tickers"
```

---

## Task 4: MarginBalanceBatchFunction(ダミーdata-source)

**Files:**
- Create: `lambda/margin-balance-batch/data-source.ts`
- Create: `lambda/margin-balance-batch/index.ts`
- Modify: `lib/j-quants-stack.ts`
- Test: `test/margin-balance-batch-data-source.test.ts`
- Test: `test/margin-balance-batch.test.ts`
- Test: `test/j-quants.test.ts`

**Interfaces:**
- Consumes: `JQuantsYutaiMaster`(ticker一覧)、`JQuantsMarginBalance`(既存データの有無でバックフィル/差分を判定)
- Produces:
  - `interface MarginBalancePoint { date: string; financingBalance: number; lendingBalance: number; source: 'weekly' | 'daily-alert' }`
  - `fetchWeeklyBalances(ticker: string, from: string, to: string): Promise<MarginBalancePoint[]>`
  - `fetchDailyAlertBalances(tickers: string[], date: string): Promise<MarginBalancePoint[]>`

- [ ] **Step 1: data-sourceの失敗するテストを書く**

`test/margin-balance-batch-data-source.test.ts`:

```typescript
import { fetchWeeklyBalances } from '../lambda/margin-balance-batch/data-source';

test('fetchWeeklyBalances returns one point per week in range, deterministic for the same ticker+date', async () => {
  const a = await fetchWeeklyBalances('7203', '2026-01-05', '2026-01-19');
  const b = await fetchWeeklyBalances('7203', '2026-01-05', '2026-01-19');

  expect(a).toEqual(b); // 同じ入力なら同じ値(バッチを毎日回してもグラフがジャンプしないため)
  expect(a.length).toBeGreaterThan(0);
  for (const point of a) {
    expect(point.source).toBe('weekly');
    expect(point.financingBalance).toBeGreaterThanOrEqual(0);
    expect(point.lendingBalance).toBeGreaterThanOrEqual(0);
  }
});

test('fetchWeeklyBalances differs across tickers (not the same seed for every ticker)', async () => {
  const a = await fetchWeeklyBalances('7203', '2026-01-05', '2026-01-05');
  const b = await fetchWeeklyBalances('9999', '2026-01-05', '2026-01-05');

  expect(a[0].lendingBalance).not.toBe(b[0].lendingBalance);
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx jest test/margin-balance-batch-data-source.test.ts`
Expected: FAIL(モジュールが存在しない)

- [ ] **Step 3: 最小実装を書く**

`lambda/margin-balance-batch/data-source.ts`:

```typescript
// フェーズ1: J-Quants Standardプラン(mkt-margin-int / mkt-margin-alert)へのアップグレードを
// 遅らせるため、信用残データはダミー生成する。ticker+dateから決定的な擬似乱数を作り、
// 同じ入力には常に同じ値を返す(実行のたびに値が変わるとトレンドグラフが毎日ジャンプするため)。
// フェーズ2ではこのファイルの中身だけをmkt-margin-int/mkt-margin-alert呼び出しに差し替える
// (呼び出し元はこの関数がダミーか本番かを意識しない)。
export interface MarginBalancePoint {
  date: string;
  financingBalance: number;
  lendingBalance: number;
  source: 'weekly' | 'daily-alert';
}

function seedFrom(...parts: string[]): number {
  let hash = 0;
  const input = parts.join('|');
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function pseudoRandom(seed: number): number {
  // 単純な線形合同法。暗号強度は不要(表示用ダミーデータのため)。
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function listMondays(from: string, to: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  // 直近の月曜まで戻す
  const day = cursor.getUTCDay();
  cursor.setUTCDate(cursor.getUTCDate() - ((day + 6) % 7));

  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return dates;
}

export async function fetchWeeklyBalances(ticker: string, from: string, to: string): Promise<MarginBalancePoint[]> {
  return listMondays(from, to).map((date) => {
    const seed = seedFrom(ticker, date);
    const base = 10_000 + Math.floor(pseudoRandom(seed) * 90_000);
    const lendingBalance = base + Math.floor(pseudoRandom(seed + 1) * 20_000);
    const financingBalance = base;
    return { date, financingBalance, lendingBalance, source: 'weekly' as const };
  });
}

export async function fetchDailyAlertBalances(tickers: string[], date: string): Promise<MarginBalancePoint[]> {
  return tickers.map((ticker) => {
    const seed = seedFrom(ticker, date, 'daily-alert');
    const base = 10_000 + Math.floor(pseudoRandom(seed) * 90_000);
    const lendingBalance = base + Math.floor(pseudoRandom(seed + 1) * 30_000);
    return { date, financingBalance: base, lendingBalance, source: 'daily-alert' as const };
  });
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx jest test/margin-balance-batch-data-source.test.ts`
Expected: PASS

- [ ] **Step 5: Lambdaハンドラの失敗するテストを書く**

`test/margin-balance-batch.test.ts`:

```typescript
const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  PutCommand: jest.fn((input: unknown) => input),
  QueryCommand: jest.fn((input: unknown) => input),
  ScanCommand: jest.fn((input: unknown) => input),
}));

jest.mock('../lambda/margin-balance-batch/data-source', () => ({
  fetchWeeklyBalances: jest.fn(),
  fetchDailyAlertBalances: jest.fn(),
}));

process.env.YUTAI_MASTER_TABLE_NAME = 'JQuantsYutaiMaster';
process.env.MARGIN_BALANCE_TABLE_NAME = 'JQuantsMarginBalance';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/margin-balance-batch/index') as { handler: () => Promise<void> };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const dataSource = require('../lambda/margin-balance-batch/data-source') as {
  fetchWeeklyBalances: jest.Mock;
  fetchDailyAlertBalances: jest.Mock;
};

beforeEach(() => {
  mockSend.mockReset();
  dataSource.fetchWeeklyBalances.mockReset();
  dataSource.fetchDailyAlertBalances.mockReset();
});

test('backfills 1-2 years for a ticker with no existing margin balance rows', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '7203' }] }) // yutai master scan
    .mockResolvedValueOnce({ Items: [] }); // margin balance query for 7203: empty → backfill
  dataSource.fetchWeeklyBalances.mockResolvedValueOnce([
    { date: '2025-01-06', financingBalance: 100, lendingBalance: 200, source: 'weekly' },
  ]);
  dataSource.fetchDailyAlertBalances.mockResolvedValueOnce([]);
  mockSend.mockResolvedValue({});

  await handler();

  expect(dataSource.fetchWeeklyBalances).toHaveBeenCalledTimes(1);
  const [, from, to] = dataSource.fetchWeeklyBalances.mock.calls[0];
  const spanDays = (new Date(to).getTime() - new Date(from).getTime()) / (24 * 60 * 60 * 1000);
  expect(spanDays).toBeGreaterThan(300); // 1年以上のバックフィル期間

  const putCalls = mockSend.mock.calls.filter(([cmd]) => 'Item' in (cmd as Record<string, unknown>));
  expect(putCalls[0][0]).toMatchObject({
    TableName: 'JQuantsMarginBalance',
    Item: { ticker: '7203', date: '2025-01-06', financingBalance: 100, lendingBalance: 200, source: 'weekly' },
  });
});

test('fetches only the recent diff for a ticker that already has margin balance rows', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '7203' }] })
    .mockResolvedValueOnce({ Items: [{ date: '2026-08-03' }] }); // already has data → not a backfill
  dataSource.fetchWeeklyBalances.mockResolvedValueOnce([]);
  dataSource.fetchDailyAlertBalances.mockResolvedValueOnce([]);

  await handler();

  const [, from, to] = dataSource.fetchWeeklyBalances.mock.calls[0];
  const spanDays = (new Date(to).getTime() - new Date(from).getTime()) / (24 * 60 * 60 * 1000);
  expect(spanDays).toBeLessThan(30); // 通常の日次差分取得(短い範囲)
});
```

- [ ] **Step 6: テストが失敗することを確認**

Run: `npx jest test/margin-balance-batch.test.ts`
Expected: FAIL(モジュールが存在しない)

- [ ] **Step 7: 最小実装を書く**

`lambda/margin-balance-batch/index.ts`:

```typescript
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { fetchWeeklyBalances, fetchDailyAlertBalances, type MarginBalancePoint } from './data-source';

const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
const MARGIN_BALANCE_TABLE_NAME = process.env.MARGIN_BALANCE_TABLE_NAME!;
const BACKFILL_DAYS = Number(process.env.BACKFILL_DAYS ?? String(2 * 365));
const DIFF_LOOKBACK_DAYS = Number(process.env.DIFF_LOOKBACK_DAYS ?? '14');

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function formatDate(date: Date): string {
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

// 銘柄に信用残データが1件も無ければバックフィル対象とみなす。
// 優待マスタへの新規追加はアプリ外で行われるため、このバッチが毎回自動検知する。
async function hasExistingBalance(ticker: string): Promise<boolean> {
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

async function upsertPoints(ticker: string, points: MarginBalancePoint[]): Promise<void> {
  for (const point of points) {
    await ddbDocClient.send(
      new PutCommand({
        TableName: MARGIN_BALANCE_TABLE_NAME,
        Item: {
          ticker,
          date: point.date,
          financingBalance: point.financingBalance,
          lendingBalance: point.lendingBalance,
          source: point.source,
        },
      }),
    );
  }
}

export const handler = async (): Promise<void> => {
  const tickers = await getYutaiTickers();
  if (tickers.length === 0) {
    console.warn('Yutai master is empty; nothing to fetch');
    return;
  }

  const today = formatDate(new Date());

  for (const ticker of tickers) {
    try {
      const isBackfill = !(await hasExistingBalance(ticker));
      const lookbackDays = isBackfill ? BACKFILL_DAYS : DIFF_LOOKBACK_DAYS;
      const from = formatDate(new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000));

      const weekly = await fetchWeeklyBalances(ticker, from, today);
      await upsertPoints(ticker, weekly);

      const dailyAlert = await fetchDailyAlertBalances([ticker], today);
      await upsertPoints(ticker, dailyAlert);

      console.log(`${ticker}: upserted ${weekly.length} weekly + ${dailyAlert.length} daily-alert points (backfill=${isBackfill})`);
    } catch (error) {
      console.error(`${ticker}: failed to fetch/upsert margin balance`, error);
    }
  }
};
```

- [ ] **Step 8: テストが通ることを確認**

Run: `npx jest test/margin-balance-batch.test.ts`
Expected: PASS

- [ ] **Step 9: CDKスタックにLambdaとスケジュールを追加**

`lib/j-quants-stack.ts` の `referenceApiFn` 定義の前に追記:

```typescript
    const marginBalanceBatchFn = new nodejs.NodejsFunction(this, 'MarginBalanceBatchFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'margin-balance-batch', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(14),
      memorySize: 256,
      bundling: { externalModules: ['@aws-sdk/*'] },
      environment: {
        YUTAI_MASTER_TABLE_NAME: this.yutaiMasterTable.tableName,
        MARGIN_BALANCE_TABLE_NAME: this.marginBalanceTable.tableName,
      },
    });

    this.yutaiMasterTable.grantReadData(marginBalanceBatchFn);
    this.marginBalanceTable.grantReadWriteData(marginBalanceBatchFn);

    new events.Rule(this, 'MarginBalanceBatchSchedule', {
      schedule: events.Schedule.cron({ minute: '30', hour: '9' }),
      targets: [new targets.LambdaFunction(marginBalanceBatchFn)],
    });
```

- [ ] **Step 10: スタックテストを追加して確認**

`test/j-quants.test.ts` に追記:

```typescript
test('creates the margin balance batch Lambda wired to the yutai and margin tables, on a daily schedule', () => {
  const template = synth();

  template.hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'index.handler',
    Environment: {
      Variables: Match.objectLike({
        YUTAI_MASTER_TABLE_NAME: Match.anyValue(),
        MARGIN_BALANCE_TABLE_NAME: Match.anyValue(),
      }),
    },
  });
  template.hasResourceProperties('AWS::Events::Rule', {
    ScheduleExpression: 'cron(30 9 * * ? *)',
    State: 'ENABLED',
  });
});
```

Run: `npx jest test/j-quants.test.ts`
Expected: PASS(全件)

- [ ] **Step 11: コミット**

```bash
git add lambda/margin-balance-batch lib/j-quants-stack.ts test/margin-balance-batch-data-source.test.ts test/margin-balance-batch.test.ts test/j-quants.test.ts
git commit -m "Add MarginBalanceBatchFunction with a dummy phase-1 data source"
```

---

## Task 5: taisyaku.jpの実際のCSV取得方式を手動調査(実装前の準備)

**Files:**
- Create: `docs/superpowers/notes/2026-08-13-taisyaku-csv-format.md`

このタスクはコードを書かない調査タスク。ブラウザで実際に操作して、Task 6で使う実際のリクエスト形式を確定させる。

- [ ] **Step 1: ブラウザでtaisyaku.jpの銘柄検索を開く**

`https://www.taisyaku.jp/app/stock` を開き、既知の貸借銘柄(例: 7203 トヨタ自動車)を検索する。

- [ ] **Step 2: 日付範囲を8営業日以上に指定してCSV出力を実行**

抽出条件で日付範囲を8営業日以上(例: 直近1ヶ月)に指定し、「CSV」リンク/ボタンをクリックする。

- [ ] **Step 3: DevToolsのNetworkタブで実際のリクエストを確認**

ブラウザのDevTools(F12)→Networkタブを開いた状態でStep 2を実行し、発生したリクエストの以下を記録する:
- リクエストURL(クエリパラメータ含む)
- HTTPメソッド(GET/POST)
- POSTの場合はリクエストボディの形式(form-urlencoded/JSON等)とパラメータ名
- レスポンスのCSVの実際のヘッダー行(列名)と数行のサンプルデータ
- Cookie/セッションが必須かどうか(Cookie無しでcurl等から直接叩けるか)

- [ ] **Step 4: 調査結果をファイルに記録**

`docs/superpowers/notes/2026-08-13-taisyaku-csv-format.md` に、Step 3で確認した内容をそのまま書き出す。最低限、以下を埋める:

```markdown
# taisyaku.jp CSV取得方式の調査結果

## リクエスト
- URL: (実際のURL)
- メソッド: (GET/POST)
- パラメータ: (実際のパラメータ名と値の例)
- Cookie必須か: (yes/no)

## レスポンス(CSV)のヘッダー行
(実際のヘッダー行をそのまま貼る)

## サンプルデータ行
(実際の数行をそのまま貼る)
```

- [ ] **Step 5: コミット**

```bash
git add docs/superpowers/notes/2026-08-13-taisyaku-csv-format.md
git commit -m "Record taisyaku.jp CSV request format from manual investigation"
```

**Note:** Task 6のStep 1・Step 3は、このファイルに記録された実際のURL・パラメータ・CSV列名を使って書く。このファイルの内容がTask 6実装時点でまだ無い場合は、Task 6に進む前に本タスクを先に終わらせること。

---

## Task 6: GyakuhibuHistoryBatchFunction(taisyaku.jp実績逆日歩取得)

**Files:**
- Create: `lambda/gyakuhibu-history-batch/taisyaku-client.ts`
- Create: `lambda/gyakuhibu-history-batch/index.ts`
- Modify: `lib/j-quants-stack.ts`
- Test: `test/taisyaku-client.test.ts`
- Test: `test/gyakuhibu-history-batch.test.ts`
- Test: `test/j-quants.test.ts`

**Interfaces:**
- Consumes: `docs/superpowers/notes/2026-08-13-taisyaku-csv-format.md`(実ブラウザのHARキャプチャ2回分で確認済みの実際のリクエスト形式)
- Produces:
  - `interface GyakuhibuActualPoint { rightsDate: string; totalAmount: number; days: number; avgRate: number }`
  - `extractCsrfToken(html: string): string`(詳細ページHTMLから`csrf_test_name`の値を取り出す。無ければ例外)
  - `parseTaisyakuCsv(csvText: string, rightsDate: string, unitShares: number): GyakuhibuActualPoint | undefined`(該当日の品貸料率が空/`-`(実際の品薄が発生しなかった日)なら`undefined`)
  - `fetchTaisyakuCsv(ticker: string, from: string, to: string): Promise<string>`(CSRFトークン取得→期間検索→CSV取得の3ステップを内部で行う)

**実装メモ(`docs/superpowers/notes/2026-08-13-taisyaku-csv-format.md`より)**: taisyaku.jpはCSRFトークン+セッションCookieが必須で、単純な1回のGETでは取得できない。`fetchTaisyakuCsv`は (1) `GET /app/stock/detail/{ticker}-01` でセッションCookieとCSRFトークン(HTML内`<input type="hidden" name="csrf_test_name" value="...">`)を取得 → (2) `POST /app/stock/detail/{ticker}/search` に`csrf_test_name`・`orgMgrCd`・`mkYmdFrom`/`mkYmdTo`(`"YYYY / MM / DD"`形式)・`trjoKbn=01`(東証)等を送信して期間を指定 → (3) `GET /app/stock/detail/{ticker}/csv` を同じCookieでリクエスト、の順で行う。品貸料率・最高料率は実データで検証済みの通り**1株あたり・品貸日数分**の金額なので、`unitShares`を掛けるだけでよい(1,000株換算の割り戻しは不要)。

- [ ] **Step 1: CSRFトークン抽出・CSVパースの失敗するテストを書く**

`test/taisyaku-client.test.ts`:

```typescript
import { extractCsrfToken, parseTaisyakuCsv } from '../lambda/gyakuhibu-history-batch/taisyaku-client';

test('extractCsrfToken reads the csrf_test_name hidden input value', () => {
  const html = '<input type="hidden" name="csrf_test_name" value="abc123def456">';
  expect(extractCsrfToken(html)).toBe('abc123def456');
});

test('extractCsrfToken throws when the token is missing', () => {
  expect(() => extractCsrfToken('<html></html>')).toThrow();
});

// CSVは日付ごとに1行、taisyaku.jpの画面表示テーブルと同じ列名(申込日/品貸料率(品貸日数分/円)/品貸日数)を持つ想定。
// 実際にダウンロードしたCSVの列名・行列の向きが異なると判明した場合は、このテストと
// parseTaisyakuCsvの実装を実物に合わせて書き換えること(docs/superpowers/notes/2026-08-13-taisyaku-csv-format.md 参照)。
test('parseTaisyakuCsv scales the per-share lending fee to unitShares for the matching rights date', () => {
  const csv = [
    '申込日,品貸料率(品貸日数分/円),品貸日数',
    '2026-08-25,6.00,1',
    '2026-08-26,18.00,3',
  ].join('\n');

  const result = parseTaisyakuCsv(csv, '2026-08-26', 100);

  expect(result).toEqual({
    rightsDate: '2026-08-26',
    totalAmount: 18.0 * 100,
    days: 3,
    avgRate: 18.0 / 3,
  });
});

test('parseTaisyakuCsv returns undefined when the matching date has no lending fee (a dash, meaning no shortage occurred)', () => {
  const csv = ['申込日,品貸料率(品貸日数分/円),品貸日数', '2026-08-26,-,1'].join('\n');
  expect(parseTaisyakuCsv(csv, '2026-08-26', 100)).toBeUndefined();
});

test('parseTaisyakuCsv returns undefined when the rights date is not in the CSV at all', () => {
  const csv = ['申込日,品貸料率(品貸日数分/円),品貸日数', '2026-08-20,6.00,1'].join('\n');
  expect(parseTaisyakuCsv(csv, '2026-08-26', 100)).toBeUndefined();
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx jest test/taisyaku-client.test.ts`
Expected: FAIL(モジュールが存在しない)

- [ ] **Step 3: `extractCsrfToken` と `parseTaisyakuCsv` を実装**

`lambda/gyakuhibu-history-batch/taisyaku-client.ts`(この時点では`fetchTaisyakuCsv`は未実装、Step 7で追加する):

```typescript
export interface GyakuhibuActualPoint {
  rightsDate: string;
  totalAmount: number;
  days: number;
  avgRate: number;
}

export function extractCsrfToken(html: string): string {
  const match = html.match(/<input[^>]*name="csrf_test_name"[^>]*value="([^"]+)"/);
  if (!match) {
    throw new Error('csrf_test_name not found in taisyaku.jp page HTML (page structure may have changed)');
  }
  return match[1];
}

// CSVは「申込日」列で対象権利日の行を探し、「品貸料率(品貸日数分/円)」列がハイフン(実際の
// 品薄が発生しなかった日)や空でなければ、その値と「品貸日数」列から実績を組み立てる。
// taisyaku.jpの品貸料率・最高料率は実データで検証済みの通り1株あたり・品貸日数分の金額
// なので、unitShares(単元株数)を掛けるだけでよい(1,000株換算は不要)。
export function parseTaisyakuCsv(csvText: string, rightsDate: string, unitShares: number): GyakuhibuActualPoint | undefined {
  const lines = csvText.trim().split('\n');
  const header = lines[0].split(',').map((h) => h.trim());
  const dateIdx = header.findIndex((h) => h.includes('申込日'));
  const rateIdx = header.findIndex((h) => h.includes('品貸料率'));
  const daysIdx = header.findIndex((h) => h.includes('品貸日数'));
  if (dateIdx === -1 || rateIdx === -1 || daysIdx === -1) {
    throw new Error('Unexpected taisyaku.jp CSV header shape (expected 申込日/品貸料率/品貸日数 columns)');
  }

  for (const line of lines.slice(1)) {
    const cols = line.split(',').map((c) => c.trim());
    if (cols[dateIdx] !== rightsDate) continue;

    const rateRaw = cols[rateIdx];
    if (!rateRaw || rateRaw === '-') return undefined; // その日は実際の品薄(逆日歩)が発生しなかった

    const perShareRate = Number(rateRaw);
    const days = Number(cols[daysIdx]);
    if (Number.isNaN(perShareRate) || Number.isNaN(days) || days <= 0) return undefined;

    return { rightsDate, totalAmount: perShareRate * unitShares, days, avgRate: perShareRate / days };
  }

  return undefined; // 対象の申込日がCSVに含まれていない
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx jest test/taisyaku-client.test.ts`
Expected: PASS

- [ ] **Step 5: `fetchTaisyakuCsv`(CSRF取得→検索→CSV取得)の失敗するテストを書く**

`test/taisyaku-client.test.ts` に追記:

```typescript
import { fetchTaisyakuCsv } from '../lambda/gyakuhibu-history-batch/taisyaku-client';

describe('fetchTaisyakuCsv', () => {
  const mockFetch = jest.fn();
  beforeEach(() => {
    mockFetch.mockReset();
    (global as unknown as { fetch: typeof mockFetch }).fetch = mockFetch;
  });

  test('fetches the CSRF token from the detail page, POSTs the date-range search, then GETs the CSV with the same session cookie', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        headers: { getSetCookie: () => ['ci_session=abc123; Path=/'] },
        text: async () => '<input type="hidden" name="csrf_test_name" value="tok-1">',
      })
      .mockResolvedValueOnce({ ok: true, headers: { getSetCookie: () => [] }, text: async () => '<html>search result</html>' })
      .mockResolvedValueOnce({ ok: true, headers: { getSetCookie: () => [] }, text: async () => 'csv-body' });

    const result = await fetchTaisyakuCsv('7203', '2026-08-05', '2026-08-14');

    expect(result).toBe('csv-body');
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[0][0]).toBe('https://www.taisyaku.jp/app/stock/detail/7203-01');

    const [searchUrl, searchInit] = mockFetch.mock.calls[1];
    expect(searchUrl).toBe('https://www.taisyaku.jp/app/stock/detail/7203/search');
    expect(searchInit.method).toBe('POST');
    expect(searchInit.headers.Cookie).toBe('ci_session=abc123');
    const body = new URLSearchParams(searchInit.body as string);
    expect(body.get('csrf_test_name')).toBe('tok-1');
    expect(body.get('orgMgrCd')).toBe('7203');
    expect(body.get('mkYmdFrom')).toBe('2026 / 08 / 05');
    expect(body.get('mkYmdTo')).toBe('2026 / 08 / 14');
    expect(body.get('trjoKbn')).toBe('01');

    const [csvUrl, csvInit] = mockFetch.mock.calls[2];
    expect(csvUrl).toBe('https://www.taisyaku.jp/app/stock/detail/7203/csv');
    expect(csvInit.headers.Cookie).toBe('ci_session=abc123');
  });

  test('throws when the detail page request fails', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'server error' });
    await expect(fetchTaisyakuCsv('7203', '2026-08-05', '2026-08-14')).rejects.toThrow('taisyaku.jp');
  });
});
```

- [ ] **Step 6: テストが失敗することを確認**

Run: `npx jest test/taisyaku-client.test.ts`
Expected: FAIL(`fetchTaisyakuCsv`が存在しない)

- [ ] **Step 7: `fetchTaisyakuCsv` を実装**

`lambda/gyakuhibu-history-batch/taisyaku-client.ts` に追記:

```typescript
const TAISYAKU_BASE_URL = 'https://www.taisyaku.jp';

// "YYYY-MM-DD" → "YYYY / MM / DD"(taisyaku.jpのフォーム入力形式)
function toSlashDate(isoDate: string): string {
  return isoDate.replaceAll('-', ' / ');
}

function cookieHeaderFrom(setCookies: string[]): string {
  return setCookies.map((c) => c.split(';')[0]).join('; ');
}

// 銘柄詳細ページ(GET)→期間検索(POST)→CSV取得(GET)の3ステップ。
// taisyaku.jpはCSRFトークン+セッションCookie必須のため、無状態の1回のリクエストでは
// 取得できない(docs/superpowers/notes/2026-08-13-taisyaku-csv-format.md 参照)。
export async function fetchTaisyakuCsv(ticker: string, from: string, to: string): Promise<string> {
  const detailUrl = `${TAISYAKU_BASE_URL}/app/stock/detail/${ticker}-01`;
  const pageResponse = await fetch(detailUrl);
  if (!pageResponse.ok) {
    throw new Error(`taisyaku.jp error ${pageResponse.status} fetching ${detailUrl}`);
  }
  const cookie = cookieHeaderFrom(pageResponse.headers.getSetCookie());
  const csrfToken = extractCsrfToken(await pageResponse.text());

  const searchUrl = `${TAISYAKU_BASE_URL}/app/stock/detail/${ticker}/search`;
  const searchBody = new URLSearchParams({
    csrf_test_name: csrfToken,
    orgMgrCd: ticker,
    orgMgrMei: '',
    sort: '',
    page: '',
    fsort: '',
    fpage: '',
    mkYmdFrom: toSlashDate(from),
    mkYmdTo: toSlashDate(to),
    kjnYmdDays: '',
    trjoKbn: '01',
  });
  const searchResponse = await fetch(searchUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: searchBody.toString(),
  });
  if (!searchResponse.ok) {
    throw new Error(`taisyaku.jp error ${searchResponse.status} posting to ${searchUrl}`);
  }
  await searchResponse.text();

  const csvUrl = `${TAISYAKU_BASE_URL}/app/stock/detail/${ticker}/csv`;
  const csvResponse = await fetch(csvUrl, { headers: { Cookie: cookie } });
  if (!csvResponse.ok) {
    throw new Error(`taisyaku.jp error ${csvResponse.status} fetching ${csvUrl}`);
  }
  return csvResponse.text();
}
```

- [ ] **Step 8: テストが通ることを確認**

Run: `npx jest test/taisyaku-client.test.ts`
Expected: PASS(全件)

- [ ] **Step 9: バッチハンドラの失敗するテストを書く**

`test/gyakuhibu-history-batch.test.ts`:

```typescript
const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  PutCommand: jest.fn((input: unknown) => input),
  QueryCommand: jest.fn((input: unknown) => input),
  ScanCommand: jest.fn((input: unknown) => input),
}));
jest.mock('../lambda/gyakuhibu-history-batch/taisyaku-client', () => ({
  fetchTaisyakuCsv: jest.fn(),
  parseTaisyakuCsv: jest.fn(),
}));

process.env.YUTAI_RIGHTS_DATE_TABLE_NAME = 'JQuantsYutaiRightsDate';
process.env.YUTAI_MASTER_TABLE_NAME = 'JQuantsYutaiMaster';
process.env.GYAKUHIBU_ACTUAL_TABLE_NAME = 'JQuantsGyakuhibuActual';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/gyakuhibu-history-batch/index') as { handler: () => Promise<void> };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const taisyakuClient = require('../lambda/gyakuhibu-history-batch/taisyaku-client') as {
  fetchTaisyakuCsv: jest.Mock;
  parseTaisyakuCsv: jest.Mock;
};

beforeEach(() => {
  mockSend.mockReset();
  taisyakuClient.fetchTaisyakuCsv.mockReset();
  taisyakuClient.parseTaisyakuCsv.mockReset();
});

test('fetches and upserts actual gyakuhibu only for past rights dates not yet in JQuantsGyakuhibuActual', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '7203', rightsDate: '2026-03-30' }] }) // rights-date scan (past)
    .mockResolvedValueOnce({ Item: undefined }) // not yet in gyakuhibu-actual
    .mockResolvedValueOnce({ Item: { ticker: '7203', unitShares: 100 } }); // yutai master lookup
  taisyakuClient.fetchTaisyakuCsv.mockResolvedValueOnce('csv-body');
  taisyakuClient.parseTaisyakuCsv.mockReturnValueOnce({
    rightsDate: '2026-03-30',
    totalAmount: 680,
    days: 2,
    avgRate: 0.4,
  });
  mockSend.mockResolvedValue({});

  await handler();

  const putCalls = mockSend.mock.calls.filter(([cmd]) => 'Item' in (cmd as Record<string, unknown>) && (cmd as { TableName?: string }).TableName === 'JQuantsGyakuhibuActual');
  expect(putCalls).toHaveLength(1);
  expect(putCalls[0][0]).toMatchObject({
    Item: { ticker: '7203', rightsDate: '2026-03-30', totalAmount: 680, days: 2, avgRate: 0.4 },
  });
});

test('skips rights dates older than 3 years', async () => {
  const fourYearsAgo = new Date();
  fourYearsAgo.setFullYear(fourYearsAgo.getFullYear() - 4);
  mockSend.mockResolvedValueOnce({
    Items: [{ ticker: '7203', rightsDate: fourYearsAgo.toISOString().slice(0, 10) }],
  });

  await handler();

  expect(taisyakuClient.fetchTaisyakuCsv).not.toHaveBeenCalled();
});
```

- [ ] **Step 10: テストが失敗することを確認**

Run: `npx jest test/gyakuhibu-history-batch.test.ts`
Expected: FAIL(モジュールが存在しない)

- [ ] **Step 11: 実装を書く**

`lambda/gyakuhibu-history-batch/index.ts`:

```typescript
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { fetchTaisyakuCsv, parseTaisyakuCsv } from './taisyaku-client';

const YUTAI_RIGHTS_DATE_TABLE_NAME = process.env.YUTAI_RIGHTS_DATE_TABLE_NAME!;
const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
const GYAKUHIBU_ACTUAL_TABLE_NAME = process.env.GYAKUHIBU_ACTUAL_TABLE_NAME!;
// taisyaku.jpが公開しているのは直近3年分のみ(それより古いデータは非公開)。
const MAX_HISTORY_YEARS = 3;

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

interface RightsDateRow {
  ticker: string;
  rightsDate: string;
}

async function listPastRightsDates(): Promise<RightsDateRow[]> {
  const rows: RightsDateRow[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  const today = new Date().toISOString().slice(0, 10);

  do {
    const result = await ddbDocClient.send(
      new ScanCommand({ TableName: YUTAI_RIGHTS_DATE_TABLE_NAME, ExclusiveStartKey: exclusiveStartKey }),
    );
    for (const item of result.Items ?? []) {
      if (typeof item.ticker === 'string' && typeof item.rightsDate === 'string' && item.rightsDate < today) {
        rows.push({ ticker: item.ticker, rightsDate: item.rightsDate });
      }
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return rows;
}

function isWithinPublishedRange(rightsDate: string): boolean {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - MAX_HISTORY_YEARS);
  return rightsDate >= cutoff.toISOString().slice(0, 10);
}

async function alreadyFetched(ticker: string, rightsDate: string): Promise<boolean> {
  const result = await ddbDocClient.send(
    new GetCommand({ TableName: GYAKUHIBU_ACTUAL_TABLE_NAME, Key: { ticker, rightsDate } }),
  );
  return result.Item !== undefined;
}

async function getUnitShares(ticker: string): Promise<number | undefined> {
  const result = await ddbDocClient.send(new GetCommand({ TableName: YUTAI_MASTER_TABLE_NAME, Key: { ticker } }));
  return typeof result.Item?.unitShares === 'number' ? result.Item.unitShares : undefined;
}

export const handler = async (): Promise<void> => {
  const rows = await listPastRightsDates();

  for (const { ticker, rightsDate } of rows) {
    if (!isWithinPublishedRange(rightsDate)) continue;

    try {
      if (await alreadyFetched(ticker, rightsDate)) continue;

      const unitShares = await getUnitShares(ticker);
      if (unitShares === undefined) {
        console.warn(`${ticker}: no unitShares in yutai master, skipping ${rightsDate}`);
        continue;
      }

      const csv = await fetchTaisyakuCsv(ticker, rightsDate, rightsDate);
      const point = parseTaisyakuCsv(csv, rightsDate, unitShares);
      if (!point) {
        console.log(`${ticker}: no lending fee on ${rightsDate} (not a margin-shortage event)`);
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
    }
  }
};
```

- [ ] **Step 12: テストが通ることを確認**

Run: `npx jest test/gyakuhibu-history-batch.test.ts`
Expected: PASS

- [ ] **Step 13: CDKスタックにLambdaとスケジュールを追加**

`lib/j-quants-stack.ts` の `marginBalanceBatchFn` 定義の直後に追記:

```typescript
    const gyakuhibuHistoryBatchFn = new nodejs.NodejsFunction(this, 'GyakuhibuHistoryBatchFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'gyakuhibu-history-batch', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(14),
      memorySize: 256,
      bundling: { externalModules: ['@aws-sdk/*'] },
      environment: {
        YUTAI_RIGHTS_DATE_TABLE_NAME: this.yutaiRightsDateTable.tableName,
        YUTAI_MASTER_TABLE_NAME: this.yutaiMasterTable.tableName,
        GYAKUHIBU_ACTUAL_TABLE_NAME: this.gyakuhibuActualTable.tableName,
      },
    });

    this.yutaiRightsDateTable.grantReadData(gyakuhibuHistoryBatchFn);
    this.yutaiMasterTable.grantReadData(gyakuhibuHistoryBatchFn);
    this.gyakuhibuActualTable.grantReadWriteData(gyakuhibuHistoryBatchFn);

    new events.Rule(this, 'GyakuhibuHistoryBatchSchedule', {
      schedule: events.Schedule.cron({ minute: '0', hour: '10' }),
      targets: [new targets.LambdaFunction(gyakuhibuHistoryBatchFn)],
    });
```

- [ ] **Step 14: スタックテストを追加して確認**

`test/j-quants.test.ts` に追記:

```typescript
test('creates the gyakuhibu history batch Lambda wired to the rights-date/master/actual tables, on a daily schedule', () => {
  const template = synth();

  template.hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'index.handler',
    Environment: {
      Variables: Match.objectLike({
        YUTAI_RIGHTS_DATE_TABLE_NAME: Match.anyValue(),
        GYAKUHIBU_ACTUAL_TABLE_NAME: Match.anyValue(),
      }),
    },
  });
  template.hasResourceProperties('AWS::Events::Rule', {
    ScheduleExpression: 'cron(0 10 * * ? *)',
    State: 'ENABLED',
  });
});
```

Run: `npx jest test/j-quants.test.ts`
Expected: PASS(全件)

- [ ] **Step 15: コミット**

```bash
git add lambda/gyakuhibu-history-batch lib/j-quants-stack.ts test/taisyaku-client.test.ts test/gyakuhibu-history-batch.test.ts test/j-quants.test.ts
git commit -m "Add GyakuhibuHistoryBatchFunction fetching actual rates from taisyaku.jp"
```

---

## Task 7: GET /yutai (検索・一覧・当月権利付き最終日バナー)

**Files:**
- Modify: `lambda/reference-api/index.ts`
- Modify: `lib/j-quants-stack.ts`
- Test: `test/reference-api.test.ts`
- Test: `test/j-quants.test.ts`

**Interfaces:**
- Consumes: Task 1の`calcMaxRate`・取引カレンダー関数、Task 2〜6のテーブル
- Produces: `GET /yutai?rightsDateFrom=&rightsDateTo=&keyword=&riskStatus=` → `{ tickers: YutaiListItem[], currentMonthLastTradableDate: string }`
  - `interface YutaiListItem { ticker: string; companyName?: string; content: string; value: number; rightsDate: string; riskStatus: 'safe' | 'danger' | 'na' }`

- [ ] **Step 1: 失敗するテストを書く**

`test/reference-api.test.ts` の先頭の`process.env`に追記:

```typescript
process.env.YUTAI_MASTER_TABLE_NAME = 'JQuantsYutaiMaster';
process.env.YUTAI_RIGHTS_DATE_TABLE_NAME = 'JQuantsYutaiRightsDate';
process.env.MARGIN_BALANCE_TABLE_NAME = 'JQuantsMarginBalance';
process.env.GYAKUHIBU_ACTUAL_TABLE_NAME = 'JQuantsGyakuhibuActual';
```

同ファイルに追記:

```typescript
test('GET /yutai returns each ticker with its next rights date and a safe/danger/na risk badge', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', companyName: '○○HD', content: 'QUOカード', value: 1000, unitShares: 100 }] }) // yutai master scan
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', rightsDate: '2026-08-20' }] }) // rights-date query for 1234
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', date: '2026-08-10', financingBalance: 100, lendingBalance: 200 }] }) // margin balance presence check
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', date: '2026-08-12', close: 500 }] }) // latest close price
    .mockResolvedValueOnce({ data: [{ Date: '2026-08-21', HolDiv: '1' }, { Date: '2026-08-24', HolDiv: '1' }] }); // trading calendar (fetch mock)

  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ data: [{ Date: '2026-08-21', HolDiv: '1' }, { Date: '2026-08-24', HolDiv: '1' }] }),
  });

  const result = await handler(makeEvent('GET /yutai', { queryStringParameters: {} }));

  expect((result as { statusCode: number }).statusCode).toBe(200);
  const parsed = body(result) as { tickers: Array<{ ticker: string; riskStatus: string }>; currentMonthLastTradableDate: string };
  expect(parsed.tickers[0]).toMatchObject({ ticker: '1234' });
  expect(['safe', 'danger', 'na']).toContain(parsed.tickers[0].riskStatus);
  expect(parsed.currentMonthLastTradableDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test('GET /yutai filters by keyword against company name and content', async () => {
  mockSend
    .mockResolvedValueOnce({
      Items: [
        { ticker: '1234', companyName: '○○ホールディングス', content: 'QUOカード', value: 1000, unitShares: 100 },
        { ticker: '5678', companyName: '△△工業', content: '自社製品', value: 3000, unitShares: 100 },
      ],
    })
    .mockResolvedValue({ Items: [] }); // rights-date/margin-balance queries: no data → treated as 対象外
  mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });

  const result = await handler(makeEvent('GET /yutai', { queryStringParameters: { keyword: 'QUO' } }));

  const parsed = body(result) as { tickers: Array<{ ticker: string }> };
  expect(parsed.tickers.map((t) => t.ticker)).toEqual(['1234']);
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx jest test/reference-api.test.ts -t "GET /yutai"`
Expected: FAIL(ルート未実装で404)

- [ ] **Step 3: 実装を書く**

`lambda/reference-api/index.ts` の先頭の環境変数定義に追記:

```typescript
import { calcMaxRate, calcMaxGyakuhibu } from '../shared/gyakuhibu-calc';
import { fetchTradingCalendar, isTradingDay, settlementDate, calendarDaysBetween } from '../shared/trading-calendar';

const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
const YUTAI_RIGHTS_DATE_TABLE_NAME = process.env.YUTAI_RIGHTS_DATE_TABLE_NAME!;
const MARGIN_BALANCE_TABLE_NAME = process.env.MARGIN_BALANCE_TABLE_NAME!;
```

同ファイルに以下のヘルパーとハンドラを追加(既存の`getSummary`関数の後、`export const handler`の前):

```typescript
interface YutaiMasterRow {
  ticker: string;
  companyName?: string;
  content: string;
  value: number;
  unitShares: number;
}

async function scanYutaiMaster(): Promise<YutaiMasterRow[]> {
  const rows: YutaiMasterRow[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await ddbDocClient.send(
      new ScanCommand({ TableName: YUTAI_MASTER_TABLE_NAME, ExclusiveStartKey: exclusiveStartKey }),
    );
    for (const item of result.Items ?? []) {
      rows.push({
        ticker: item.ticker,
        companyName: item.companyName,
        content: item.content,
        value: item.value,
        unitShares: item.unitShares,
      });
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return rows;
}

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

async function calcRiskStatus(
  row: YutaiMasterRow,
  rightsDate: string | undefined,
  apiBaseUrl: string,
  apiKey: string,
): Promise<RiskStatus> {
  if (!rightsDate) return 'na';
  if (!(await hasMarginBalance(row.ticker))) return 'na';

  const closePrice = await latestClose(row.ticker);
  if (closePrice === undefined) return 'na';

  const calendarTo = new Date(rightsDate);
  calendarTo.setDate(calendarTo.getDate() + 14);
  const calendar = await fetchTradingCalendar(
    apiBaseUrl,
    apiKey,
    rightsDate,
    calendarTo.toISOString().slice(0, 10),
  );
  const settlement = settlementDate(calendar, rightsDate);
  const days = calendarDaysBetween(rightsDate, settlement);

  const maxGyakuhibu = calcMaxGyakuhibu(closePrice, row.unitShares, days);
  return row.value > maxGyakuhibu ? 'safe' : 'danger';
}

// 当月末の最終営業日から2営業日前(受渡T+2)を「権利付き最終日」の目安として返す。
// 月末が権利確定日の銘柄が多いため、このバナー1つを一覧全体で使い回す(銘柄ごとには計算しない)。
function currentMonthLastTradableDate(calendar: { date: string; holDiv: string }[]): string {
  const businessDays = calendar.filter(isTradingDay).map((d) => d.date).sort();
  const cutoffIndex = Math.max(businessDays.length - 3, 0);
  return businessDays[cutoffIndex];
}

async function listYutai(query: Record<string, string | undefined>): Promise<APIGatewayProxyResultV2> {
  const rightsDateFrom = query.rightsDateFrom;
  const rightsDateTo = query.rightsDateTo;
  const keyword = query.keyword?.toLowerCase();
  const riskStatusFilter = query.riskStatus && query.riskStatus !== 'all' ? query.riskStatus : undefined;

  const apiKey = await getApiKey();
  const rows = await scanYutaiMaster();

  const items = [];
  for (const row of rows) {
    if (keyword) {
      const haystack = `${row.companyName ?? ''} ${row.content}`.toLowerCase();
      if (!haystack.includes(keyword)) continue;
    }

    const rightsDate = await nextRightsDate(row.ticker);
    if (rightsDateFrom && (!rightsDate || rightsDate < rightsDateFrom)) continue;
    if (rightsDateTo && (!rightsDate || rightsDate > rightsDateTo)) continue;

    const riskStatus = await calcRiskStatus(row, rightsDate, API_BASE_URL, apiKey);
    if (riskStatusFilter && riskStatus !== riskStatusFilter) continue;

    items.push({
      ticker: row.ticker,
      companyName: row.companyName,
      content: row.content,
      value: row.value,
      rightsDate,
      riskStatus,
    });
  }

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  const monthCalendar = await fetchTradingCalendar(API_BASE_URL, apiKey, monthStart, monthEnd);

  return jsonResponse(200, {
    tickers: items,
    currentMonthLastTradableDate: currentMonthLastTradableDate(monthCalendar),
  });
}
```

`export const handler`のswitch文に追記:

```typescript
    case 'GET /yutai':
      return listYutai(event.queryStringParameters ?? {});
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx jest test/reference-api.test.ts`
Expected: PASS(全件。モックの並び順は実装のDB呼び出し順に合わせて調整する)

- [ ] **Step 5: CDKにルートと権限を追加**

`lib/j-quants-stack.ts` の`referenceApiFn`の`environment`に追記:

```typescript
        YUTAI_MASTER_TABLE_NAME: this.yutaiMasterTable.tableName,
        YUTAI_RIGHTS_DATE_TABLE_NAME: this.yutaiRightsDateTable.tableName,
        MARGIN_BALANCE_TABLE_NAME: this.marginBalanceTable.tableName,
        GYAKUHIBU_ACTUAL_TABLE_NAME: this.gyakuhibuActualTable.tableName,
```

`this.watchlistTable.grantReadWriteData(referenceApiFn);` の直後に追記:

```typescript
    this.yutaiMasterTable.grantReadData(referenceApiFn);
    this.yutaiRightsDateTable.grantReadData(referenceApiFn);
    this.marginBalanceTable.grantReadData(referenceApiFn);
    this.gyakuhibuActualTable.grantReadData(referenceApiFn);
```

`this.api.addRoutes({ path: '/tickers/{ticker}/summary', ...})` の直後に追記:

```typescript
    this.api.addRoutes({
      path: '/yutai',
      methods: [apigwv2.HttpMethod.GET],
      integration: referenceApiIntegration,
    });
```

- [ ] **Step 6: スタックテストを更新して確認**

`test/j-quants.test.ts` の `'creates the HTTP API with tickers CRUD...'` テストの`routeKeys`配列に `'GET /yutai'` を追記。

Run: `npx jest test/j-quants.test.ts`
Expected: PASS

- [ ] **Step 7: コミット**

```bash
git add lambda/reference-api/index.ts lib/j-quants-stack.ts test/reference-api.test.ts test/j-quants.test.ts
git commit -m "Add GET /yutai: filterable list with risk badges and monthly cutoff banner"
```

---

## Task 8: GET /yutai/{ticker} (詳細・銘柄基本情報・逆日歩計算・実績履歴)

**Files:**
- Modify: `lambda/reference-api/index.ts`
- Modify: `lib/j-quants-stack.ts`
- Test: `test/reference-api.test.ts`
- Test: `test/j-quants.test.ts`

**Interfaces:**
- Consumes: Task 7のヘルパー(`latestClose`等)、Task 6の`JQuantsGyakuhibuActual`
- Produces: `GET /yutai/{ticker}` → `{ ticker, companyName, content, value, unitShares, basicInfo: {...}, risk: {...}, rightsHistory: [...] }`

- [ ] **Step 1: 失敗するテストを書く**

`test/reference-api.test.ts` に追記:

```typescript
test('GET /yutai/{ticker} returns basic info, risk calc, and rights history', async () => {
  mockSend
    .mockResolvedValueOnce({ Item: { ticker: '1234', companyName: '○○HD', content: 'QUOカード', value: 1000, unitShares: 100 } }) // yutai master get
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', date: '2026-08-12', close: 500, volume: 10000 }] }) // latest price
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', discDate: '2026-05-08', eps: '10.0', sales: '100', operatingProfit: '10', netProfit: '5' }] }) // financial summary
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', rightsDate: '2026-08-20' }] }) // next rights date
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', date: '2026-08-10' }] }) // margin balance presence
    .mockResolvedValueOnce({
      Items: [{ ticker: '1234', rightsDate: '2026-03-30', totalAmount: 680, days: 2, avgRate: 0.4 }],
    }); // gyakuhibu actual history
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ data: [{ Date: '2026-08-21', HolDiv: '1' }, { Date: '2026-08-24', HolDiv: '1' }] }),
  });

  const result = await handler(makeEvent('GET /yutai/{ticker}', { pathParameters: { ticker: '1234' } }));

  expect((result as { statusCode: number }).statusCode).toBe(200);
  const parsed = body(result) as {
    basicInfo: { closePrice: number; per: number | null };
    risk: { maxGyakuhibu: number };
    rightsHistory: Array<{ rightsDate: string; totalAmount: number }>;
  };
  expect(parsed.basicInfo.closePrice).toBe(500);
  expect(parsed.risk.maxGyakuhibu).toBeGreaterThan(0);
  expect(parsed.rightsHistory).toEqual([{ rightsDate: '2026-03-30', totalAmount: 680, days: 2, avgRate: 0.4 }]);
});

test('GET /yutai/{ticker} returns 404 for a ticker not in the yutai master', async () => {
  mockSend.mockResolvedValueOnce({ Item: undefined });

  const result = await handler(makeEvent('GET /yutai/{ticker}', { pathParameters: { ticker: '9999' } }));

  expect((result as { statusCode: number }).statusCode).toBe(404);
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx jest test/reference-api.test.ts -t "GET /yutai/{ticker}"`
Expected: FAIL(ルート未実装で404 or ルーティングマッチしない)

- [ ] **Step 3: 実装を書く**

`lambda/reference-api/index.ts` に追記(`listYutai`関数の後):

```typescript
async function getYutaiMaster(ticker: string): Promise<YutaiMasterRow | undefined> {
  const result = await ddbDocClient.send(new GetCommand({ TableName: YUTAI_MASTER_TABLE_NAME, Key: { ticker } }));
  if (!result.Item) return undefined;
  return {
    ticker: result.Item.ticker,
    companyName: result.Item.companyName,
    content: result.Item.content,
    value: result.Item.value,
    unitShares: result.Item.unitShares,
  };
}

async function latestPricePoint(ticker: string): Promise<{ close: number; volume: number | null } | undefined> {
  const result = await ddbDocClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'ticker = :ticker',
      ExpressionAttributeValues: { ':ticker': ticker },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );
  const latest = result.Items?.[0];
  if (!latest || typeof latest.close !== 'number') return undefined;
  return { close: latest.close, volume: latest.volume ?? null };
}

async function latestFinancialSummary(ticker: string) {
  const result = await ddbDocClient.send(
    new QueryCommand({
      TableName: FINANCIAL_TABLE_NAME,
      KeyConditionExpression: 'ticker = :ticker',
      ExpressionAttributeValues: { ':ticker': ticker },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );
  return result.Items?.[0];
}

async function gyakuhibuHistory(ticker: string) {
  const result = await ddbDocClient.send(
    new QueryCommand({
      TableName: GYAKUHIBU_ACTUAL_TABLE_NAME,
      KeyConditionExpression: 'ticker = :ticker',
      ExpressionAttributeValues: { ':ticker': ticker },
      ScanIndexForward: false,
    }),
  );
  return (result.Items ?? []).map((item) => ({
    rightsDate: item.rightsDate,
    totalAmount: item.totalAmount,
    days: item.days,
    avgRate: item.avgRate,
  }));
}

async function getYutaiDetail(ticker: string): Promise<APIGatewayProxyResultV2> {
  const master = await getYutaiMaster(ticker);
  if (!master) return jsonResponse(404, { message: `Unknown yutai ticker: ${ticker}` });

  const price = await latestPricePoint(ticker);
  const summary = await latestFinancialSummary(ticker);
  const eps = summary?.eps ? Number(summary.eps) : undefined;
  const per = price && eps && eps > 0 ? price.close / eps : null;

  const rightsDate = await nextRightsDate(ticker);
  const apiKey = await getApiKey();

  let risk: { maxGyakuhibu: number | null; maxRate: number | null; days: number | null; riskStatus: RiskStatus } = {
    maxGyakuhibu: null,
    maxRate: null,
    days: null,
    riskStatus: 'na',
  };

  if (rightsDate && price && (await hasMarginBalance(ticker))) {
    const calendarTo = new Date(rightsDate);
    calendarTo.setDate(calendarTo.getDate() + 14);
    const calendar = await fetchTradingCalendar(API_BASE_URL, apiKey, rightsDate, calendarTo.toISOString().slice(0, 10));
    const settlement = settlementDate(calendar, rightsDate);
    const days = calendarDaysBetween(rightsDate, settlement);
    const maxRate = calcMaxRate(price.close, master.unitShares);
    const maxGyakuhibu = calcMaxGyakuhibu(price.close, master.unitShares, days);
    risk = { maxGyakuhibu, maxRate, days, riskStatus: master.value > maxGyakuhibu ? 'safe' : 'danger' };
  }

  const history = await gyakuhibuHistory(ticker);

  return jsonResponse(200, {
    ticker: master.ticker,
    companyName: master.companyName,
    content: master.content,
    value: master.value,
    unitShares: master.unitShares,
    rightsDate,
    basicInfo: {
      closePrice: price?.close ?? null,
      volume: price?.volume ?? null,
      per,
      sales: summary?.sales ?? null,
      operatingProfit: summary?.operatingProfit ?? null,
      netProfit: summary?.netProfit ?? null,
      eps: summary?.eps ?? null,
    },
    risk,
    rightsHistory: history,
  });
}
```

`export const handler`のswitch文に追記(`case 'GET /yutai':`の直後):

```typescript
    case 'GET /yutai/{ticker}':
      return ticker ? getYutaiDetail(ticker) : jsonResponse(400, { message: 'Missing ticker' });
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx jest test/reference-api.test.ts`
Expected: PASS(全件)

- [ ] **Step 5: CDKにルートを追加**

`lib/j-quants-stack.ts` の `/yutai` ルート追加の直後に追記:

```typescript
    this.api.addRoutes({
      path: '/yutai/{ticker}',
      methods: [apigwv2.HttpMethod.GET],
      integration: referenceApiIntegration,
    });
```

- [ ] **Step 6: スタックテストを更新して確認**

`test/j-quants.test.ts` の`routeKeys`配列に `'GET /yutai/{ticker}'` を追記。

Run: `npx jest test/j-quants.test.ts`
Expected: PASS

- [ ] **Step 7: コミット**

```bash
git add lambda/reference-api/index.ts lib/j-quants-stack.ts test/reference-api.test.ts test/j-quants.test.ts
git commit -m "Add GET /yutai/{ticker}: basic info, risk calc, and actual gyakuhibu history"
```

---

## Task 9: GET /yutai/{ticker}/margin-trend

**Files:**
- Modify: `lambda/reference-api/index.ts`
- Modify: `lib/j-quants-stack.ts`
- Test: `test/reference-api.test.ts`
- Test: `test/j-quants.test.ts`

**Interfaces:**
- Produces: `GET /yutai/{ticker}/margin-trend?range=1y` → `{ ticker, range: '1y', points: [{ date, financingBalance, lendingBalance }] }`

- [ ] **Step 1: 失敗するテストを書く**

`test/reference-api.test.ts` に追記:

```typescript
test('GET /yutai/{ticker}/margin-trend returns the balance time series in ascending date order', async () => {
  mockSend.mockResolvedValueOnce({
    Items: [
      { ticker: '1234', date: '2026-08-05', financingBalance: 100, lendingBalance: 200 },
      { ticker: '1234', date: '2026-08-04', financingBalance: 90, lendingBalance: 180 },
    ],
  });

  const result = await handler(
    makeEvent('GET /yutai/{ticker}/margin-trend', { pathParameters: { ticker: '1234' } }),
  );

  expect((result as { statusCode: number }).statusCode).toBe(200);
  expect(body(result)).toEqual({
    ticker: '1234',
    range: '1y',
    points: [
      { date: '2026-08-04', financingBalance: 90, lendingBalance: 180 },
      { date: '2026-08-05', financingBalance: 100, lendingBalance: 200 },
    ],
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx jest test/reference-api.test.ts -t "margin-trend"`
Expected: FAIL

- [ ] **Step 3: 実装を書く**

`lambda/reference-api/index.ts` に追記(`getYutaiDetail`関数の後):

```typescript
const MARGIN_TREND_RANGE_DAYS = 365;

async function getMarginTrend(ticker: string): Promise<APIGatewayProxyResultV2> {
  const result = await ddbDocClient.send(
    new QueryCommand({
      TableName: MARGIN_BALANCE_TABLE_NAME,
      KeyConditionExpression: 'ticker = :ticker',
      ExpressionAttributeValues: { ':ticker': ticker },
      ScanIndexForward: false,
      Limit: MARGIN_TREND_RANGE_DAYS,
    }),
  );

  const points = (result.Items ?? [])
    .map((item) => ({
      date: item.date as string,
      financingBalance: item.financingBalance,
      lendingBalance: item.lendingBalance,
    }))
    .reverse();

  return jsonResponse(200, { ticker, range: '1y', points });
}
```

`export const handler`のswitch文に追記:

```typescript
    case 'GET /yutai/{ticker}/margin-trend':
      return ticker ? getMarginTrend(ticker) : jsonResponse(400, { message: 'Missing ticker' });
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx jest test/reference-api.test.ts`
Expected: PASS(全件)

- [ ] **Step 5: CDKにルートを追加**

`lib/j-quants-stack.ts` の `/yutai/{ticker}` ルート追加の直後に追記:

```typescript
    this.api.addRoutes({
      path: '/yutai/{ticker}/margin-trend',
      methods: [apigwv2.HttpMethod.GET],
      integration: referenceApiIntegration,
    });
```

- [ ] **Step 6: スタックテストを更新して確認**

`test/j-quants.test.ts` の`routeKeys`配列に `'GET /yutai/{ticker}/margin-trend'` を追記。

Run: `npx jest test/j-quants.test.ts`
Expected: PASS

- [ ] **Step 7: コミット**

```bash
git add lambda/reference-api/index.ts lib/j-quants-stack.ts test/reference-api.test.ts test/j-quants.test.ts
git commit -m "Add GET /yutai/{ticker}/margin-trend"
```

---

## Task 10: フロントAPI型とクライアント関数

**Files:**
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/api/client.ts`

**Interfaces:**
- Produces: `fetchYutaiList(params)`, `fetchYutaiDetail(ticker)`, `fetchYutaiMarginTrend(ticker)` と対応する型

- [ ] **Step 1: 型を追加**

`frontend/src/api/types.ts` に追記:

```typescript
export type YutaiRiskStatus = 'safe' | 'danger' | 'na';

export interface YutaiListItem {
  ticker: string;
  companyName?: string;
  content: string;
  value: number;
  rightsDate?: string;
  riskStatus: YutaiRiskStatus;
}

export interface YutaiListResponse {
  tickers: YutaiListItem[];
  currentMonthLastTradableDate: string;
}

export interface YutaiRiskInfo {
  maxGyakuhibu: number | null;
  maxRate: number | null;
  days: number | null;
  riskStatus: YutaiRiskStatus;
}

export interface YutaiRightsHistoryPoint {
  rightsDate: string;
  totalAmount: number;
  days: number;
  avgRate: number;
}

export interface YutaiBasicInfo {
  closePrice: number | null;
  volume: number | null;
  per: number | null;
  sales: string | null;
  operatingProfit: string | null;
  netProfit: string | null;
  eps: string | null;
}

export interface YutaiDetail {
  ticker: string;
  companyName?: string;
  content: string;
  value: number;
  unitShares: number;
  rightsDate?: string;
  basicInfo: YutaiBasicInfo;
  risk: YutaiRiskInfo;
  rightsHistory: YutaiRightsHistoryPoint[];
}

export interface MarginTrendPoint {
  date: string;
  financingBalance: number;
  lendingBalance: number;
}

export interface MarginTrendResponse {
  ticker: string;
  range: '1y';
  points: MarginTrendPoint[];
}
```

- [ ] **Step 2: クライアント関数を追加**

`frontend/src/api/client.ts` の先頭のimportに追記:

```typescript
import type {
  FinancialSummary,
  MarginTrendResponse,
  PricesResponse,
  WatchlistTicker,
  YutaiDetail,
  YutaiListResponse,
} from './types';
```

ファイル末尾に追記:

```typescript
export interface YutaiListParams {
  rightsDateFrom?: string;
  rightsDateTo?: string;
  keyword?: string;
  riskStatus?: 'safe' | 'danger' | 'na' | 'all';
}

export function fetchYutaiList(params: YutaiListParams): Promise<YutaiListResponse> {
  const query = new URLSearchParams();
  if (params.rightsDateFrom) query.set('rightsDateFrom', params.rightsDateFrom);
  if (params.rightsDateTo) query.set('rightsDateTo', params.rightsDateTo);
  if (params.keyword) query.set('keyword', params.keyword);
  if (params.riskStatus) query.set('riskStatus', params.riskStatus);
  return request(`/yutai?${query}`);
}

export function fetchYutaiDetail(ticker: string): Promise<YutaiDetail> {
  return request(`/yutai/${ticker}`);
}

export function fetchYutaiMarginTrend(ticker: string): Promise<MarginTrendResponse> {
  return request(`/yutai/${ticker}/margin-trend`);
}
```

- [ ] **Step 3: ビルドが通ることを確認**

Run: `cd frontend && npx tsc --noEmit`
Expected: エラー無し

- [ ] **Step 4: コミット**

```bash
git add frontend/src/api/types.ts frontend/src/api/client.ts
git commit -m "Add frontend API types and client functions for /yutai endpoints"
```

---

## Task 11: /yutai 一覧画面

**Files:**
- Create: `frontend/src/pages/YutaiListPage.tsx`
- Modify: `frontend/src/main.tsx`
- Modify: `frontend/src/components/Layout.tsx`
- Modify: `frontend/src/index.css`

**Interfaces:**
- Consumes: `fetchYutaiList`(Task 10)
- Produces: ルート `/yutai`

- [ ] **Step 1: CSSにバッジ・バナー用クラスを追加**

`frontend/src/index.css` の `.filter-bar` ブロックの後に追記:

```css
.risk-badge {
  font-size: 0.8rem;
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  font-weight: 600;
  display: inline-block;
}

.risk-badge--safe {
  color: var(--down);
  background: color-mix(in srgb, var(--down) 14%, transparent);
}

.risk-badge--danger {
  color: var(--up);
  background: color-mix(in srgb, var(--up) 14%, transparent);
}

.risk-badge--na {
  color: var(--text-muted);
  background: var(--surface-alt);
}

.cutoff-banner {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
  padding: 0.7rem 1rem;
  border-radius: 10px;
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  border: 1px solid var(--accent);
  margin-bottom: 1.25rem;
  font-size: 0.88rem;
}
```

- [ ] **Step 2: 一覧ページを実装**

`frontend/src/pages/YutaiListPage.tsx`:

```typescript
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchYutaiList } from '../api/client';
import type { YutaiRiskStatus } from '../api/types';
import { StatusNote } from '../components/StatusNote';
import { formatFinancialYen } from '../lib/format';
import { useAsync } from '../lib/useAsync';

function monthRange(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

const RISK_LABEL: Record<YutaiRiskStatus, string> = { safe: '安全', danger: '危険', na: '対象外' };

export function YutaiListPage() {
  const defaultRange = monthRange();
  const [rightsDateFrom, setRightsDateFrom] = useState(defaultRange.from);
  const [rightsDateTo, setRightsDateTo] = useState(defaultRange.to);
  const [keyword, setKeyword] = useState('');
  const [riskStatus, setRiskStatus] = useState<'all' | YutaiRiskStatus>('all');

  const listState = useAsync(
    () => fetchYutaiList({ rightsDateFrom, rightsDateTo, keyword: keyword || undefined, riskStatus }),
    [rightsDateFrom, rightsDateTo, keyword, riskStatus],
  );

  return (
    <>
      <h1 className="page-title">優待クロス スクリーニング</h1>
      <p className="page-subtitle">権利日・優待価値と最大逆日歩の見積りを比較して絞り込みます。</p>

      {listState.data && (
        <div className="cutoff-banner">
          <span>📅</span>
          <span>
            当月の権利付き最終日: <strong>{listState.data.currentMonthLastTradableDate}</strong>
          </span>
          <span style={{ color: 'var(--text-muted)' }}>(月末が権利確定日の銘柄はこの日までに買付が必要)</span>
        </div>
      )}

      <div className="filter-bar">
        <label>
          権利日(開始):{' '}
          <input type="date" className="input" value={rightsDateFrom} onChange={(e) => setRightsDateFrom(e.target.value)} />
        </label>
        <label>
          権利日(終了):{' '}
          <input type="date" className="input" value={rightsDateTo} onChange={(e) => setRightsDateTo(e.target.value)} />
        </label>
        <label>
          キーワード:{' '}
          <input
            className="input"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="会社名・優待内容"
          />
        </label>
        <label>
          リスク判定:{' '}
          <select value={riskStatus} onChange={(e) => setRiskStatus(e.target.value as typeof riskStatus)}>
            <option value="all">すべて</option>
            <option value="safe">安全</option>
            <option value="danger">危険</option>
            <option value="na">対象外</option>
          </select>
        </label>
      </div>

      {listState.loading && <StatusNote kind="loading" message="読み込み中…" />}
      {listState.error && <StatusNote kind="error" message={`取得に失敗しました: ${listState.error.message}`} />}
      {listState.data && listState.data.tickers.length === 0 && (
        <StatusNote kind="empty" message="条件に一致する優待銘柄がありません。" />
      )}

      {listState.data && listState.data.tickers.length > 0 && (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>銘柄</th>
                <th>優待内容</th>
                <th>優待価値</th>
                <th>権利日</th>
                <th>リスク</th>
              </tr>
            </thead>
            <tbody>
              {listState.data.tickers.map((item) => (
                <tr key={item.ticker}>
                  <td style={{ textAlign: 'left' }}>
                    <Link to={`/yutai/${item.ticker}`}>
                      {item.companyName ?? item.ticker} <span className="ticker-card__code">{item.ticker}</span>
                    </Link>
                  </td>
                  <td style={{ textAlign: 'left' }}>{item.content}</td>
                  <td className="num">{formatFinancialYen(String(item.value))}</td>
                  <td className="num">{item.rightsDate ?? '—'}</td>
                  <td>
                    <span className={`risk-badge risk-badge--${item.riskStatus}`}>{RISK_LABEL[item.riskStatus]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 3: ルーティングとナビに追加**

`frontend/src/main.tsx` のimportに追記:

```typescript
import { YutaiListPage } from './pages/YutaiListPage';
```

`<Route path="watchlist" element={<WatchlistPage />} />` の直後に追記:

```typescript
            <Route path="yutai" element={<YutaiListPage />} />
```

`frontend/src/components/Layout.tsx` の `NAV_ITEMS` に追記:

```typescript
  { to: '/yutai', label: '優待クロス' },
```

- [ ] **Step 4: 手動で動作確認**

Run: `cd frontend && npm run dev`

ブラウザで `/yutai` を開き、以下を確認する:
- 当月権利付き最終日バナーが表示される
- 権利日範囲がデフォルトで当月になっている
- キーワード・リスク判定で絞り込める
- 行をクリックすると `/yutai/:ticker` に遷移する(Task 12実装まではNot Foundでよい)

- [ ] **Step 5: コミット**

```bash
git add frontend/src/pages/YutaiListPage.tsx frontend/src/main.tsx frontend/src/components/Layout.tsx frontend/src/index.css
git commit -m "Add /yutai screening list page"
```

---

## Task 12: /yutai/:ticker 詳細画面(銘柄基本情報・優待内容・逆日歩リスク・ツールチップ・信用残トレンド)

**Files:**
- Create: `frontend/src/pages/YutaiDetailPage.tsx`
- Modify: `frontend/src/main.tsx`
- Modify: `frontend/src/index.css`

**Interfaces:**
- Consumes: `fetchYutaiDetail`, `fetchYutaiMarginTrend`(Task 10)
- Produces: ルート `/yutai/:ticker`

- [ ] **Step 1: CSSにツールチップ用クラスを追加**

`frontend/src/index.css` の末尾に追記:

```css
.gyakuhibu-hover {
  display: inline-block;
  border-bottom: 1px dotted var(--text-muted);
  cursor: help;
}

.gyakuhibu-tooltip {
  position: fixed;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  padding: 1rem;
  width: 320px;
  z-index: 1000;
  font-size: 0.85rem;
}
```

- [ ] **Step 2: 詳細ページを実装**

`frontend/src/pages/YutaiDetailPage.tsx`:

```typescript
import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts';
import { fetchYutaiDetail, fetchYutaiMarginTrend } from '../api/client';
import { StatusNote } from '../components/StatusNote';
import { formatFinancialYen, formatPrice, formatVolume } from '../lib/format';
import { useAsync } from '../lib/useAsync';

export function YutaiDetailPage() {
  const { ticker } = useParams<{ ticker: string }>();
  const [tooltipStyle, setTooltipStyle] = useState<{ top: number; left: number } | undefined>();

  const detailState = useAsync(async () => {
    if (!ticker) throw new Error('ticker is missing');
    return fetchYutaiDetail(ticker);
  }, [ticker]);

  const trendState = useAsync(async () => {
    if (!ticker) throw new Error('ticker is missing');
    return fetchYutaiMarginTrend(ticker);
  }, [ticker]);

  const triggerRef = useRef<HTMLDivElement>(null);

  function showTooltip() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTooltipStyle({ top: rect.bottom + 8, left: Math.min(rect.left, window.innerWidth - 340) });
  }

  if (detailState.loading) return <StatusNote kind="loading" message="読み込み中…" />;
  if (detailState.error) return <StatusNote kind="error" message={`取得に失敗しました: ${detailState.error.message}`} />;
  if (!detailState.data) return null;

  const { data } = detailState;
  const riskLabel = { safe: '安全', danger: '危険', na: '対象外' }[data.risk.riskStatus];

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1 className="page-title">
          {data.companyName ?? data.ticker} <span className="ticker-card__code">{data.ticker}</span>
        </h1>
        <Link to={`/tickers/${data.ticker}`} style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
          既存の個別銘柄画面を見る →
        </Link>
      </div>

      <div className="section-heading">銘柄基本情報</div>
      <div className="card summary-grid">
        <div className="summary-item">
          <div className="summary-item__label">前日終値</div>
          <div className="summary-item__value">{formatPrice(data.basicInfo.closePrice)}</div>
        </div>
        <div className="summary-item">
          <div className="summary-item__label">出来高</div>
          <div className="summary-item__value">{formatVolume(data.basicInfo.volume)}</div>
        </div>
        <div className="summary-item">
          <div className="summary-item__label">PER</div>
          <div className="summary-item__value">{data.basicInfo.per !== null ? `${data.basicInfo.per.toFixed(1)}倍` : '—'}</div>
        </div>
        <div className="summary-item">
          <div className="summary-item__label">決算サマリ</div>
          <div className="summary-item__value" style={{ fontSize: '0.85rem', lineHeight: 1.6 }}>
            売上 {formatFinancialYen(data.basicInfo.sales ?? undefined)}
            <br />
            営業利益 {formatFinancialYen(data.basicInfo.operatingProfit ?? undefined)}
            <br />
            純利益 {formatFinancialYen(data.basicInfo.netProfit ?? undefined)}
            <br />
            EPS {data.basicInfo.eps ?? '—'}
          </div>
        </div>
      </div>

      <div className="section-heading">優待内容</div>
      <div className="card">
        <p style={{ margin: '0 0 0.75rem' }}>{data.content}</p>
        <div className="summary-grid">
          <div className="summary-item">
            <div className="summary-item__label">優待価値</div>
            <div className="summary-item__value">{formatFinancialYen(String(data.value))}</div>
          </div>
          <div className="summary-item">
            <div className="summary-item__label">権利日</div>
            <div className="summary-item__value">{data.rightsDate ?? '—'}</div>
          </div>
        </div>
      </div>

      <div className="section-heading">逆日歩リスク計算</div>
      <div className="card">
        <div className="summary-item__label">最大逆日歩(概算・次回権利日の予測)</div>
        {data.risk.maxGyakuhibu !== null ? (
          <div
            ref={triggerRef}
            className="gyakuhibu-hover summary-item__value"
            onMouseEnter={showTooltip}
            onMouseLeave={() => setTooltipStyle(undefined)}
          >
            {formatFinancialYen(String(data.risk.maxGyakuhibu))}
          </div>
        ) : (
          <div className="summary-item__value">—</div>
        )}
        <p style={{ marginTop: '0.75rem', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
          {data.risk.maxRate !== null ? `最高料率 ${data.risk.maxRate}円 ・ ` : ''}
          {data.risk.days !== null ? `${data.risk.days}日分` : ''}
        </p>
        <span className={`risk-badge risk-badge--${data.risk.riskStatus}`}>{riskLabel}</span>

        {tooltipStyle && (
          <div className="gyakuhibu-tooltip" style={{ top: tooltipStyle.top, left: tooltipStyle.left }}>
            <div className="summary-item__label" style={{ marginBottom: '0.5rem' }}>
              過去の権利日の実績逆日歩(taisyaku.jp確報ベース、直近3年分)
            </div>
            {data.rightsHistory.length === 0 ? (
              <p style={{ color: 'var(--text-muted)' }}>データがありません</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>権利日</th>
                    <th>実績逆日歩</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rightsHistory.map((h) => (
                    <tr key={h.rightsDate}>
                      <td>{h.rightsDate}</td>
                      <td className="num">{formatFinancialYen(String(h.totalAmount))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      <div className="section-heading">信用残トレンド(過去1年)</div>
      {trendState.loading && <StatusNote kind="loading" message="読み込み中…" />}
      {trendState.data && trendState.data.points.length === 0 && (
        <StatusNote kind="empty" message="まだ信用残データがありません(取得中です)。" />
      )}
      {trendState.data && trendState.data.points.length > 0 && (
        <div className="card" style={{ height: 220 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={trendState.data.points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
              <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} width={64} />
              <ChartTooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 12 }} />
              <Line type="monotone" dataKey="lendingBalance" stroke="var(--accent)" dot={false} name="貸株残" />
              <Line type="monotone" dataKey="financingBalance" stroke="var(--text-muted)" dot={false} name="融資残" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 3: ルーティングに追加**

`frontend/src/main.tsx` のimportに追記:

```typescript
import { YutaiDetailPage } from './pages/YutaiDetailPage';
```

`<Route path="yutai" element={<YutaiListPage />} />` の直後に追記:

```typescript
            <Route path="yutai/:ticker" element={<YutaiDetailPage />} />
```

- [ ] **Step 4: 手動で動作確認**

Run: `cd frontend && npm run dev`

ブラウザで `/yutai` から銘柄行をクリックし、以下を確認する:
- 銘柄基本情報・優待内容・逆日歩リスク計算・信用残トレンドが順番に表示される
- 「最大逆日歩」にマウスを乗せるとツールチップが表示され、カードの外にはみ出ても見切れない
- 既存の個別銘柄画面へのリンクが機能する

- [ ] **Step 5: コミット**

```bash
git add frontend/src/pages/YutaiDetailPage.tsx frontend/src/main.tsx frontend/src/index.css
git commit -m "Add /yutai/:ticker detail page with hover tooltip and margin trend chart"
```

---

## Task 13: README更新

**Files:**
- Modify: `README.md`

- [ ] **Step 1: アーキテクチャ・テーブル・Lambda・API・フロント表を更新**

`README.md` の各表(テーブル一覧、Lambda一覧、API一覧、フロント画面一覧)に、本計画で追加した以下を反映する:
- テーブル: `JQuantsYutaiMaster`, `JQuantsYutaiRightsDate`, `JQuantsMarginBalance`, `JQuantsGyakuhibuActual`
- Lambda: `MarginBalanceBatchFunction`(信用残ダミー取得、フェーズ2でmkt-margin-int/mkt-margin-alertに差し替え予定)、`GyakuhibuHistoryBatchFunction`(taisyaku.jpから実績逆日歩取得)
- API: `GET /yutai`, `GET /yutai/{ticker}`, `GET /yutai/{ticker}/margin-trend`
- フロント: `/yutai`, `/yutai/:ticker`
- 逆日歩の計算式(最高料率ベース、出典PDFリンク)を「J-Quants Freeプランの実際の挙動」節と同様の「実機で判明した仕様」節として追記する

- [ ] **Step 2: コミット**

```bash
git add README.md
git commit -m "Document the yutai cross-risk feature in the README"
```

---

## Self-Review Notes

- **仕様カバレッジ**: 設計書の全セクション(フェーズ分け方針・データモデル・逆日歩計算ロジック・当月権利付き最終日・Lambda・API設計・画面構成・エラーハンドリング・テスト方針)に対応するタスクがある。ただしエラーハンドリング方針の一部(taisyaku.jp取得失敗時のログのみ処理、バックフィル失敗時の非ロールバック)は各Lambdaの`try/catch`ループ構造(既存`BatchFetchFunction`と同じパターン)で自然に満たされるため、独立したタスクは設けていない。
- **taisyaku.jpのCSV形式**: Task 5で明示的に「未確認」と記載し、手動調査を独立タスクとして挟んだ。Task 6のコード例はプレースホルダーではなく「たたき台」であり、実際の列名で置き換える前提を明記している。
- **型の一貫性**: `YutaiRiskStatus`(`'safe' | 'danger' | 'na'`)はバックエンド(`RiskStatus`型)とフロント(`YutaiRiskStatus`)で名称は違うが値は同じにし、Task 10で変換なしにそのまま使えるようにしている。
