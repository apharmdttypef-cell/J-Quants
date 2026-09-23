# 銘柄一覧・スクリーニング・ウォッチリスト管理 廃止 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ユーザーが使っていない3画面(銘柄一覧`/`・スクリーニング`/screening`・ウォッチリスト管理`/watchlist`)を、フロントエンド・バックエンドAPI・CDKリソースまで含めて廃止する。

**Architecture:** `個別銘柄詳細`(`/tickers/:ticker`)は優待の詳細画面から相互リンクされているため存置する。この画面は現在`GET /tickers`(ウォッチリスト一覧)を呼んで会社名表示に使っているため、依存を解消する(ティッカーコードをそのまま見出しにする)。`PriceBatchFunction`/`FinancialSummaryBatchFunction`は現在`JQuantsWatchlist ∪ JQuantsYutaiMaster`の和集合で対象銘柄を決めているが、ウォッチリスト廃止後は`JQuantsYutaiMaster`単独に切り替える。`JQuantsWatchlist`テーブルはCDK定義から削除する(既存データは`RemovalPolicy.RETAIN`により実データは消えず、CDK管理外になるだけ)。

**Tech Stack:** AWS CDK(TypeScript)、Lambda(Node.js 22)、DynamoDB、API Gateway HTTP API、React + TypeScript(Vite)。

## Global Constraints

- 削除対象の3画面(`TickerListPage`・`ScreeningPage`・`WatchlistPage`)と、それらが独占的に使うバックエンドリソース(`JQuantsWatchlist`テーブル、`GET/POST /tickers`、`DELETE /tickers/{ticker}`)を全て削除する。
- `TickerDetailPage`(`/tickers/:ticker`)・`GET /tickers/{ticker}/prices`・`GET /tickers/{ticker}/summary`は存置する(優待詳細画面からの相互リンク先のため)。
- `TickerDetailPage`の会社名表示は`GET /tickers`(ウォッチリスト一覧)への依存をやめ、ティッカーコードをそのまま見出しにする。
- `PriceBatchFunction`・`FinancialSummaryBatchFunction`は対象銘柄の取得元を`JQuantsYutaiMaster`単独に切り替える(`lambda/shared/jquants-batch-client.ts`の`getTargetTickers`を廃止し、既存の内部関数`scanTickerColumn`をexportして両バッチから直接呼ぶ)。
- `GET /tickers/{ticker}/prices`・`GET /tickers/{ticker}/summary`の対象銘柄チェックは、ウォッチリストではなく`JQuantsYutaiMaster`の存在確認に切り替える(`isWatchedTicker`→`isKnownTicker`にリネーム、対象テーブルを`WATCHLIST_TABLE_NAME`から`YUTAI_MASTER_TABLE_NAME`に変更)。
- トップページ(`/`)は`/yutai/forecast`へのリダイレクトにする(`react-router-dom`の`Navigate`コンポーネントを使う)。
- `JQuantsWatchlist`テーブルはCDK定義・IAM grant・環境変数から完全に削除する(`RemovalPolicy.RETAIN`だったため`cdk deploy`実行時も実データは消えない)。
- `ReferenceApiFunction`の`SECRET_ARN`・`apiKeySecret`への依存(J-Quants `/equities/master`への会社名問い合わせ、ウォッチリスト追加専用)も、それを使っていた`addTicker`もろとも削除する。他のLambda(`PriceBatchFunction`等)の`SECRET_ARN`はJ-Quants本体APIへの認証に必要なため触らない。
- CORSの`allowMethods`から`POST`・`DELETE`を削除する(このAPIでPOST/DELETEを使うのは廃止するウォッチリストCRUDのみだったため、削除後は`GET`のみになる)。

---

### Task 1: CDKからJQuantsWatchlistテーブル・関連ルート・grantを削除する

**Files:**
- Modify: `lib/j-quants-stack.ts`
- Test: `test/j-quants.test.ts`

**Interfaces:**
- Produces(Task 2, 3が使う): `PriceBatchFunction`・`FinancialSummaryBatchFunction`の環境変数から`WATCHLIST_TABLE_NAME`が消える。`ReferenceApiFunction`の環境変数から`WATCHLIST_TABLE_NAME`・`SECRET_ARN`が消える。

- [ ] **Step 1: 失敗するテストを書く**

`test/j-quants.test.ts`の63-71行目(`'creates the JQuantsWatchlist table (ticker only key) with RETAIN policy'`)を以下に置き換える:

```ts
test('does not create a JQuantsWatchlist table (watchlist feature removed)', () => {
  const template = synth();

  const resources = template.findResources('AWS::DynamoDB::Table');
  const tableNames = Object.values(resources).map((r) => (r as { Properties: { TableName: string } }).Properties.TableName);
  expect(tableNames).not.toContain('JQuantsWatchlist');
});
```

81-101行目(`'creates the price batch Lambda wired to the price/watchlist/yutai tables (not financial) and a daily schedule'`)を以下に置き換える(タイトルからwatchlist記述を削り、`WATCHLIST_TABLE_NAME`の行を削除):

```ts
test('creates the price batch Lambda wired to the price/yutai tables (not financial) and a daily schedule', () => {
  const template = synth();

  template.hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'index.handler',
    Runtime: 'nodejs22.x',
    Environment: {
      Variables: Match.objectLike({
        TABLE_NAME: Match.anyValue(),
        YUTAI_MASTER_TABLE_NAME: Match.anyValue(),
        SECRET_ARN: Match.anyValue(),
        FINANCIAL_TABLE_NAME: Match.absent(),
        WATCHLIST_TABLE_NAME: Match.absent(),
      }),
    },
  });
  template.hasResourceProperties('AWS::Events::Rule', {
    ScheduleExpression: 'cron(0 9 * * ? *)',
    State: 'ENABLED',
  });
});
```

103-123行目(`'creates the financial summary batch Lambda wired to the financial/watchlist/yutai tables (not price) and a weekly schedule'`)を同様に置き換える:

```ts
test('creates the financial summary batch Lambda wired to the financial/yutai tables (not price) and a weekly schedule', () => {
  const template = synth();

  template.hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'index.handler',
    Runtime: 'nodejs22.x',
    Environment: {
      Variables: Match.objectLike({
        FINANCIAL_TABLE_NAME: Match.anyValue(),
        YUTAI_MASTER_TABLE_NAME: Match.anyValue(),
        SECRET_ARN: Match.anyValue(),
        TABLE_NAME: Match.absent(),
        WATCHLIST_TABLE_NAME: Match.absent(),
      }),
    },
  });
  template.hasResourceProperties('AWS::Events::Rule', {
    ScheduleExpression: 'cron(0 11 ? * MON *)',
    State: 'ENABLED',
  });
});
```

125-148行目(`'creates the HTTP API with tickers CRUD and the price/summary routes'`)を以下に置き換える(`routeKeys`配列から`GET /tickers`・`POST /tickers`・`DELETE /tickers/{ticker}`を削除し、タイトルからCRUD記述を削る):

```ts
test('creates the HTTP API with the price/summary and yutai routes', () => {
  const template = synth();

  template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
    ProtocolType: 'HTTP',
  });

  const routeKeys = [
    'GET /tickers/{ticker}/prices',
    'GET /tickers/{ticker}/summary',
    'GET /yutai',
    'GET /yutai/{ticker}',
    'GET /yutai/{ticker}/margin-trend',
    'GET /yutai/forecast',
    'GET /yutai/{ticker}/forecast',
    'GET /yutai/tdnet-events',
  ];
  for (const routeKey of routeKeys) {
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: routeKey });
  }

  const routes = template.findResources('AWS::ApiGatewayV2::Route');
  const actualRouteKeys = Object.values(routes).map((r) => (r as { Properties: { RouteKey: string } }).Properties.RouteKey);
  expect(actualRouteKeys).not.toContain('GET /tickers');
  expect(actualRouteKeys).not.toContain('POST /tickers');
  expect(actualRouteKeys).not.toContain('DELETE /tickers/{ticker}');
});
```

438-451行目(`'passes TSE_MARGIN_FEATURES_ENABLED=true to the reference API by default'`)の`WATCHLIST_TABLE_NAME: Match.anyValue()`を`YUTAI_TDNET_EVENT_TABLE_NAME: Match.anyValue()`に置き換える(`gyakuhibuForecastBatchFn`と区別するための判別子。`gyakuhibuForecastBatchFn`は`YUTAI_TDNET_EVENT_TABLE_NAME`を持たないため引き続き一意に判別できる):

```ts
test('passes TSE_MARGIN_FEATURES_ENABLED=true to the reference API by default', () => {
  const template = synth();

  template.hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'index.handler',
    Environment: {
      Variables: Match.objectLike({
        GYAKUHIBU_FORECAST_TABLE_NAME: Match.anyValue(),
        YUTAI_TDNET_EVENT_TABLE_NAME: Match.anyValue(),
        TSE_MARGIN_FEATURES_ENABLED: 'true',
      }),
    },
  });
});
```

554-565行目(`'reference-api has read access to the tdnet event table'`)の`WATCHLIST_TABLE_NAME: Match.anyValue()`を`TABLE_NAME: Match.anyValue()`に置き換える(`yutaiTdnetWatchBatchFn`と区別するための判別子。`yutaiTdnetWatchBatchFn`は`TABLE_NAME`〔stockPricesTable〕を持たないため引き続き一意に判別できる):

```ts
  template.hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'index.handler',
    Environment: {
      Variables: Match.objectLike({
        YUTAI_TDNET_EVENT_TABLE_NAME: Match.anyValue(),
        TABLE_NAME: Match.anyValue(),
      }),
    },
  });
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx jest test/j-quants.test.ts -t "Watchlist|tickers CRUD|price and yutai|financial and yutai|TSE_MARGIN_FEATURES_ENABLED=true to the reference API|tdnet event table"`
Expected: FAIL(現状は`JQuantsWatchlist`テーブル・ルート・grantが存在するため)

- [ ] **Step 3: 実装する**

`lib/j-quants-stack.ts`:

(a) クラスフィールド宣言から`public readonly watchlistTable: dynamodb.Table;`を削除する。

(b) `JQuantsWatchlistTable`のテーブル定義ブロック(63-72行目)を丸ごと削除する。

(c) `gyakuhibuForecastTable`定義直前のコメント(108行目付近)を、`JQuantsWatchlistTable`への言及を削って以下に変える:

```ts
    // 逆日歩予測(gyakuhibu-forecast-batch)の日次事前計算結果。銘柄行 + 全銘柄横断の
    // プール曲線行(ticker='_POOL_')。毎日全件再計算される派生データでRETAIN必須ではないが、
    // 他テーブルと運用を揃える。
```

(d) `priceBatchFn`定義: 直前のコメント(175-177行目付近)から「ウォッチリストが大幅に増える場合は要見直し」を削って以下に変える:

```ts
      // 13秒間隔(5req/分制限)は日付単位のリクエストにのみかかるため、対象銘柄数が増えても
      // API呼び出し回数は変わらない。ただし対象銘柄が増えるとDynamoDBへのupsert件数が
      // 増えるため、その分の余裕は引き続き必要。
```

`environment`から`WATCHLIST_TABLE_NAME: this.watchlistTable.tableName,`の行を削除し、直後の`this.watchlistTable.grantReadData(priceBatchFn);`の行を削除する。

(e) `financialSummaryBatchFn`定義: `environment`から`WATCHLIST_TABLE_NAME: this.watchlistTable.tableName,`の行を削除し、`this.watchlistTable.grantReadData(financialSummaryBatchFn);`の行を削除する。

(f) `referenceApiFn`定義: `environment`から以下の2行を削除する:

```ts
        WATCHLIST_TABLE_NAME: this.watchlistTable.tableName,
        SECRET_ARN: this.apiKeySecret.secretArn,
```

`this.watchlistTable.grantReadWriteData(referenceApiFn);`と`this.apiKeySecret.grantRead(referenceApiFn);`の2行を削除する。

(g) `this.api.addRoutes({ path: '/tickers', ... })`ブロックと、直後の`this.api.addRoutes({ path: '/tickers/{ticker}', methods: [apigwv2.HttpMethod.DELETE], ... })`ブロックの2つを丸ごと削除する(`/tickers/{ticker}/prices`・`/tickers/{ticker}/summary`のルートはそのまま残す)。

(h) `this.api = new apigwv2.HttpApi(...)`の`corsPreflight.allowMethods`を以下に変更する(POST/DELETEを使うルートが無くなるため):

```ts
        allowMethods: [apigwv2.CorsHttpMethod.GET],
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `npx jest test/j-quants.test.ts`
Expected: PASS(全件)

- [ ] **Step 5: コミット**

```bash
git add lib/j-quants-stack.ts test/j-quants.test.ts
git commit -m "Remove the JQuantsWatchlist table, its routes, and its grants from the CDK stack"
```

---

### Task 2: price-batch・financial-summary-batchの対象銘柄取得をJQuantsYutaiMaster単独に切り替える

**Files:**
- Modify: `lambda/shared/jquants-batch-client.ts`
- Modify: `lambda/price-batch/index.ts`
- Modify: `lambda/financial-summary-batch/index.ts`
- Test: `test/price-batch.test.ts`
- Test: `test/financial-summary-batch.test.ts`

**Interfaces:**
- Consumes: Task 1完了後のCDK(両バッチの環境変数から`WATCHLIST_TABLE_NAME`が既に消えている)
- Produces: `lambda/shared/jquants-batch-client.ts`が`scanTickerColumn(tableName: string): Promise<string[]>`をexportする(`getTargetTickers`は削除)

- [ ] **Step 1: テストを更新する**

`test/price-batch.test.ts`と`test/financial-summary-batch.test.ts`の両方で、以下の一括置換を行う:

(a) `jest.mock('../lambda/shared/jquants-batch-client', ...)`内の`getTargetTickers: (...args: unknown[]) => mockGetTargetTickers(...args),`を`scanTickerColumn: (...args: unknown[]) => mockScanTickerColumn(...args),`に変える。

(b) ファイル先頭の`const mockGetTargetTickers = jest.fn();`を`const mockScanTickerColumn = jest.fn();`に変える。

(c) ファイル内の`mockGetTargetTickers`という識別子を全て`mockScanTickerColumn`に置換する(`.mockResolvedValueOnce(...)`の呼び出し箇所全て。呼び出し引数は元のテストのまま変更不要、モックの返り値`string[]`を差し替えているだけなので、リネームのみで動作は変わらない)。

(d) `process.env.WATCHLIST_TABLE_NAME = 'JQuantsWatchlist';`の行を削除する。

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx jest test/price-batch.test.ts test/financial-summary-batch.test.ts`
Expected: FAIL(モック名`mockScanTickerColumn`をexportされていない`scanTickerColumn`に紐付けようとして失敗、または本体側が`getTargetTickers`をまだ呼んでいて未定義エラー)

- [ ] **Step 3: 実装する**

`lambda/shared/jquants-batch-client.ts`:

(a) `scanTickerColumn`関数の`async function`を`export async function`に変える(シグネチャ・実装は変更しない)。

(b) `getTargetTickers`関数(その直前のコメント「優待クロス対象銘柄は必ずしも...」を含む)を丸ごと削除する。

`lambda/price-batch/index.ts`:

(c) importを`import { getApiKey, scanTickerColumn, fetchWithRetry, normalizeDate, formatDate } from '../shared/jquants-batch-client';`に変える。

(d) `const WATCHLIST_TABLE_NAME = process.env.WATCHLIST_TABLE_NAME!;`の行を削除する。

(e) `export const handler`内の以下2行:

```ts
  const tickers = await getTargetTickers(WATCHLIST_TABLE_NAME, YUTAI_MASTER_TABLE_NAME);
  if (tickers.length === 0) {
    console.warn('No target tickers (watchlist and yutai master are both empty); nothing to fetch');
    return;
  }
```

を以下に置き換える:

```ts
  const tickers = await scanTickerColumn(YUTAI_MASTER_TABLE_NAME);
  if (tickers.length === 0) {
    console.warn('No target tickers (yutai master is empty); nothing to fetch');
    return;
  }
```

`lambda/financial-summary-batch/index.ts`:

(f) importを`import { getApiKey, scanTickerColumn, fetchWithRetry, normalizeDate } from '../shared/jquants-batch-client';`に変える。

(g) `const WATCHLIST_TABLE_NAME = process.env.WATCHLIST_TABLE_NAME!;`の行を削除する。

(h) `export const handler`内の以下2行:

```ts
  const tickers = await getTargetTickers(WATCHLIST_TABLE_NAME, YUTAI_MASTER_TABLE_NAME);
  if (tickers.length === 0) {
    console.warn('No target tickers (watchlist and yutai master are both empty); nothing to fetch');
    return;
  }
```

を以下に置き換える:

```ts
  const tickers = await scanTickerColumn(YUTAI_MASTER_TABLE_NAME);
  if (tickers.length === 0) {
    console.warn('No target tickers (yutai master is empty); nothing to fetch');
    return;
  }
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `npx jest test/price-batch.test.ts test/financial-summary-batch.test.ts && npx tsc --noEmit`
Expected: PASS(全件)、型チェックも通過(未使用importが残っていないこと)

- [ ] **Step 5: コミット**

```bash
git add lambda/shared/jquants-batch-client.ts lambda/price-batch/index.ts lambda/financial-summary-batch/index.ts test/price-batch.test.ts test/financial-summary-batch.test.ts
git commit -m "Source price/financial-summary batch tickers from JQuantsYutaiMaster alone"
```

---

### Task 3: reference-apiからウォッチリストCRUDを削除し、価格/決算エンドポイントの対象チェックをJQuantsYutaiMasterに切り替える

**Files:**
- Modify: `lambda/reference-api/index.ts`
- Test: `test/reference-api.test.ts`

**Interfaces:**
- Consumes: Task 1完了後のCDK(環境変数から`WATCHLIST_TABLE_NAME`・`SECRET_ARN`が既に消えている)
- Produces(Task 4が使う): `GET /tickers`・`POST /tickers`・`DELETE /tickers/{ticker}`は404になる。`GET /tickers/{ticker}/prices`・`GET /tickers/{ticker}/summary`は`JQuantsYutaiMaster`に存在するティッカーでのみ200を返す

- [ ] **Step 1: テストを更新する**

`test/reference-api.test.ts`から以下を削除する:

(a) ファイル先頭のモック関連コード: `const mockSecretsSend = jest.fn();`の行、`jest.mock('@aws-sdk/client-secrets-manager', () => ({...}));`ブロック全体、`process.env.SECRET_ARN = ...;`の行、`process.env.WATCHLIST_TABLE_NAME = 'JQuantsWatchlist';`の行、`beforeEach`内の`mockSecretsSend.mockReset();`の行。

(b) 以下5つのテストを丸ごと削除する: `'GET /tickers scans the watchlist table and returns it sorted'`、`'POST /tickers rejects a malformed ticker without calling J-Quants'`、`'POST /tickers looks up the company name and upserts the watchlist'`、`'POST /tickers returns 400 when J-Quants has no data for the code'`、`'DELETE /tickers/{ticker} removes the item and returns 204'`。

(c) `'GET /tickers/{ticker}/prices returns 404 for an unwatched ticker'`のタイトルを`'GET /tickers/{ticker}/prices returns 404 for a ticker not in JQuantsYutaiMaster'`に変え、テスト本体でモックしているDynamoDBテーブル名の期待値を`WATCHLIST_TABLE_NAME`(`'JQuantsWatchlist'`)から`YUTAI_MASTER_TABLE_NAME`(`'JQuantsYutaiMaster'`)に変える(モック自体は`mockSend.mockResolvedValueOnce({})`のように`Item`無しを返すだけなので、テーブル名を検証している箇所があれば変更、無ければテスト内容はそのまま)。

(d) `'GET /tickers/{ticker}/summary returns 404 for an unwatched ticker'`も同様に`'GET /tickers/{ticker}/summary returns 404 for a ticker not in JQuantsYutaiMaster'`に変える。

(e) 残る2つのテスト(`'GET /tickers/{ticker}/prices queries the most recent stored rows regardless of "today"'`・`'GET /tickers/{ticker}/summary returns the latest disclosure'`)は、対象ティッカーが存在する前提の`mockSend`シーケンスの最初に`isKnownTicker`用の`GetCommand`が来る点は変わらない(元々`isWatchedTicker`用のGetCommandが最初に来ていたのと同じ位置関係)ため、モックの並び自体は変更不要。ただし対象テーブル名の期待値がある場合は`JQuantsYutaiMaster`に変える。

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx jest test/reference-api.test.ts`
Expected: FAIL(削除したテストの分は当然消えるが、残りは現状の`isWatchedTicker`実装のままなのでテーブル名不一致等で失敗するものがある)

- [ ] **Step 3: 実装する**

`lambda/reference-api/index.ts`:

(a) import行を以下に変える(`SecretsManagerClient`・`GetSecretValueCommand`・`DeleteCommand`を外す):

```ts
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getLocalTradingCalendar, isTradingDay, nextRightsDate } from '../shared/trading-calendar';
import { excessRatio, fillRatio } from '../shared/gyakuhibu-forecast';
```

(b) 定数宣言ブロックを以下に変える(`WATCHLIST_TABLE_NAME`・`SECRET_ARN`・`API_BASE_URL`を削除):

```ts
const TABLE_NAME = process.env.TABLE_NAME!;
const FINANCIAL_TABLE_NAME = process.env.FINANCIAL_TABLE_NAME!;
const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
const MARGIN_BALANCE_TABLE_NAME = process.env.MARGIN_BALANCE_TABLE_NAME!;
const GYAKUHIBU_ACTUAL_TABLE_NAME = process.env.GYAKUHIBU_ACTUAL_TABLE_NAME!;
const GYAKUHIBU_FORECAST_TABLE_NAME = process.env.GYAKUHIBU_FORECAST_TABLE_NAME!;
const YUTAI_TDNET_EVENT_TABLE_NAME = process.env.YUTAI_TDNET_EVENT_TABLE_NAME!;
// 日付範囲(from/to)ではなく「保存済みの最新N件」で返す方式(12週間分の営業日 ≈ 60件)。
// 日付境界で絞るより単純で、取得が数営業日遅れても直近チャートの見た目は変わらない。
const PRICE_RANGE_TRADING_DAYS = 60;

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
```

(`TICKER_CODE_PATTERN`定数と`secretsClient`の行も削除する。`TICKER_CODE_PATTERN`は`addTicker`専用だったため。)

(c) `isWatchedTicker`関数を以下に置き換える(関数名変更・対象テーブル変更):

```ts
async function isKnownTicker(ticker: string): Promise<boolean> {
  const result = await ddbDocClient.send(
    new GetCommand({ TableName: YUTAI_MASTER_TABLE_NAME, Key: { ticker } }),
  );
  return result.Item !== undefined;
}
```

(d) `listTickers`関数、`ListedInstrument`/`ListedInstrumentResponse`インターフェース、`lookupCompanyName`関数、`addTicker`関数、`removeTicker`関数を丸ごと削除する(`isKnownTicker`の直後から`getPrices`の直前までが該当)。

(e) `getPrices`・`getSummary`関数内の`isWatchedTicker(ticker)`をそれぞれ`isKnownTicker(ticker)`に変える(エラーメッセージ`Unknown ticker: ${ticker}`はそのままでよい)。

(f) `switch (event.routeKey)`から以下3つのcaseを削除する:

```ts
    case 'GET /tickers':
      return listTickers();
    case 'POST /tickers':
      return addTicker(event.body);
    case 'DELETE /tickers/{ticker}':
      return ticker ? removeTicker(ticker) : jsonResponse(400, { message: 'Missing ticker' });
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `npx jest test/reference-api.test.ts && npx tsc --noEmit`
Expected: PASS(全件)、型チェックも通過(未使用importが残っていないこと)

- [ ] **Step 5: コミット**

```bash
git add lambda/reference-api/index.ts test/reference-api.test.ts
git commit -m "Drop watchlist CRUD from reference-api; gate prices/summary on JQuantsYutaiMaster"
```

---

### Task 4: フロントエンドから3画面を削除し、トップページをリダイレクトにする

**Files:**
- Delete: `frontend/src/pages/TickerListPage.tsx`
- Delete: `frontend/src/pages/ScreeningPage.tsx`
- Delete: `frontend/src/pages/WatchlistPage.tsx`
- Modify: `frontend/src/main.tsx`
- Modify: `frontend/src/components/Layout.tsx`
- Modify: `frontend/src/pages/TickerDetailPage.tsx`
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/api/client.ts`

**Interfaces:**
- Consumes: Task 3完了後のAPI(`GET /tickers`系CRUDは404、`GET /tickers/{ticker}/prices`・`/summary`はそのまま)

- [ ] **Step 1: 3画面のファイルを削除する**

```bash
git rm frontend/src/pages/TickerListPage.tsx frontend/src/pages/ScreeningPage.tsx frontend/src/pages/WatchlistPage.tsx
```

- [ ] **Step 2: ルーティングとナビゲーションを更新する**

`frontend/src/main.tsx`を以下に変える(import文と`<Routes>`の中身を差し替え):

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './index.css';
import { Layout } from './components/Layout';
import { PasswordGate } from './components/PasswordGate';
import { TickerDetailPage } from './pages/TickerDetailPage';
import { YutaiListPage } from './pages/YutaiListPage';
import { YutaiForecastListPage } from './pages/YutaiForecastListPage';
import { YutaiDetailPage } from './pages/YutaiDetailPage';
import { YutaiForecastDetailPage } from './pages/YutaiForecastDetailPage';
import { YutaiTdnetEventsPage } from './pages/YutaiTdnetEventsPage';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PasswordGate>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Navigate to="/yutai/forecast" replace />} />
            <Route path="tickers/:ticker" element={<TickerDetailPage />} />
            <Route path="yutai" element={<YutaiListPage />} />
            <Route path="yutai/forecast" element={<YutaiForecastListPage />} />
            <Route path="yutai/tdnet-events" element={<YutaiTdnetEventsPage />} />
            <Route path="yutai/:ticker" element={<YutaiDetailPage />} />
            <Route path="yutai/:ticker/forecast" element={<YutaiForecastDetailPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </PasswordGate>
  </StrictMode>,
);
```

`frontend/src/components/Layout.tsx`の`NAV_ITEMS`配列から以下3行を削除する:

```ts
  { to: '/', label: '銘柄一覧', end: true },
  { to: '/screening', label: 'スクリーニング' },
  { to: '/watchlist', label: 'ウォッチリスト管理' },
```

(結果、`NAV_ITEMS`は`優待クロス`から始まる4項目になる。`優待クロス`は`end: true`のまま。)

- [ ] **Step 3: 個別銘柄詳細ページのウォッチリスト依存を外す**

`frontend/src/pages/TickerDetailPage.tsx`のimportを以下に変える(`fetchTickers`を外す):

```tsx
import { useParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ApiError, fetchPrices, fetchSummary } from '../api/client';
import { StatusNote } from '../components/StatusNote';
import { formatFinancialYen, formatPrice, formatVolume } from '../lib/format';
import { useAsync } from '../lib/useAsync';
```

`detailState`の定義を以下に変える(`fetchTickers()`の呼び出しと`meta`を削る):

```tsx
  const detailState = useAsync(async () => {
    if (!ticker) throw new Error('ticker is missing');
    return await fetchPrices(ticker);
  }, [ticker]);
```

`const { meta, prices } = detailState.data;`を`const prices = detailState.data;`に変える。

見出しのJSXを以下に変える(`meta?.companyName ?? ticker`と別途の`<span>`表示をやめ、ティッカーコードのみにする):

```tsx
      <h1 className="page-title">{ticker}</h1>
```

- [ ] **Step 4: 使われなくなった型・APIクライアント関数を削除する**

`frontend/src/api/types.ts`の`WatchlistTicker`インターフェースを削除する。

`frontend/src/api/client.ts`のimportから`WatchlistTicker`を外し、`fetchTickers`・`addTicker`・`removeTicker`の3関数を丸ごと削除する。

- [ ] **Step 5: 型チェックとビルド**

Run: `cd frontend && npx tsc --noEmit -p tsconfig.json && npm run build`
Expected: 両方エラー無し(未使用import・未使用エクスポートが残っていないこと)

- [ ] **Step 6: コミット**

```bash
git add -A frontend/src
git commit -m "Remove the ticker-list, screening, and watchlist-management pages"
```

---

### Task 5: READMEを更新する

**Files:**
- Modify: `README.md`

- [ ] **Step 1: アーキテクチャ概要とLambda表を更新する**

冒頭のアーキテクチャ概要(11行目・19行目付近)の「`JQuantsWatchlist ∪ JQuantsYutaiMaster`テーブルを読んで対象銘柄を取得」を「`JQuantsYutaiMaster`テーブルを読んで対象銘柄を取得」に変える(2箇所)。

`PriceBatchFunction`・`FinancialSummaryBatchFunction`の行(159-160行目)を以下に置き換える:

```
| `PriceBatchFunction` | EventBridge(`cron(0 9 * * ? *)` = JST 18:00 毎日) | 対象銘柄(`JQuantsYutaiMaster`)の四本値を取得し`JQuantsStockPrices`へupsert |
| `FinancialSummaryBatchFunction` | EventBridge(`cron(0 11 ? * MON *)` = 毎週月曜 JST 20:00) | 対象銘柄(`JQuantsYutaiMaster`)の決算サマリを取得し`JQuantsFinancialSummary`へupsert。四半期ごとの更新なので週次取得で十分 |
```

- [ ] **Step 2: データ表を更新する**

`JQuantsWatchlist`の行(76行目)を削除する。

- [ ] **Step 3: API表を更新する**

`GET /tickers`・`POST /tickers`・`DELETE /tickers/{ticker}`の3行(174-176行目)を削除する。`GET /tickers/{ticker}/prices`・`GET /tickers/{ticker}/summary`の行はそのまま残す。

- [ ] **Step 4: 画面表を更新する**

`/`・`/screening`・`/watchlist`の3行(216, 218, 219行目)を削除し、代わりに以下の行を追加する(元の`/`の位置に):

```
| `/` | `/yutai/forecast`へリダイレクト |
```

- [ ] **Step 5: 「スコープを絞った点」節を更新する**

「ウォッチリスト管理の「会社名検索」は...」の段落(230行目)を削除する(この機能自体が無くなったため)。

- [ ] **Step 6: コミット**

```bash
git add README.md
git commit -m "Document the removal of the ticker-list, screening, and watchlist pages"
```
