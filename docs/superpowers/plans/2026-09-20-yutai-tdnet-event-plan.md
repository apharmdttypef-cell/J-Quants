# 優待開始・廃止イベント一覧 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TDnet監視バッチ(`yutai-tdnet-watch-batch`)が検知する優待関連イベント(開始/変更/廃止)を`JQuantsYutaiTdnetEvent`テーブルへ永続化し、`GET /yutai/tdnet-events`と新規画面`/yutai/tdnet-events`で確認できるようにする。

**Architecture:** 既存のバッチ→DynamoDB→reference-api→フロントという各機能と同じ3層構成。新規テーブルは固定PK(`"ALL"`)+ソートキー(`eventId`、先頭に開示日を埋め込み)でGSI無しに日付降順一覧を実現する。バッチの`matchedTickers`を`Map<ticker, boolean>`から`Map<ticker, Disclosure[]>`に変更し、開示ごとに1イベント行を書く。

**Tech Stack:** AWS CDK(TypeScript)、Lambda(Node.js 22)、DynamoDB、API Gateway HTTP API、React + TypeScript(Vite)。

## Global Constraints

- 新規テーブル名: `JQuantsYutaiTdnetEvent`。PK: `pk`(string、固定値`"ALL"`)、SK: `eventId`(string、形式`{disclosedAt}#{ticker}#{titleのsha256hex先頭8文字}`)。billingMode: `PAY_PER_REQUEST`、`pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true }`、`removalPolicy: cdk.RemovalPolicy.RETAIN`(既存テーブル群と同じ運用)。
- 新規環境変数名: `YUTAI_TDNET_EVENT_TABLE_NAME`(バッチ・APIの両Lambdaで共通)。
- `eventType`は`'start' | 'update' | 'abolition'`の3値。判定は「マスタから削除(廃止シグナル)→`abolition`」「`JQuantsYutaiMaster`に事前存在→`update`」「事前存在なし→`start`」。kabuyutai.comに見つからず廃止シグナルも無い場合、または見つかったが`rightsMonths`が空の場合は、マスタが実際には変わっていないためイベントを記録しない(現状通り`console.warn`のみ)。
- イベント粒度: 同一tickerに複数の優待関連開示がマッチした場合、開示ごとに1件のイベント行を書く(`eventType`はそのtickerの処理結果を全開示に共通適用)。
- `companyName`はTDnet開示側(`Disclosure.companyName`)の表記を保存する(kabuyutai.com側ではない。廃止で削除された銘柄はkabuyutai.com側にもう存在しないため)。
- 新規APIルート: `GET /yutai/tdnet-events`(認証は既存のLambdaオーソライザーが自動適用、追加設定不要)。
- フロント新規パス: `/yutai/tdnet-events`。ナビゲーション(`Layout.tsx`の`NAV_ITEMS`)に「逆日歩予測」の直後として追加する。ラベルは「優待変更履歴」。
- 種別バッジの配色は新規CSS変数を追加せず既存トークンを再利用: `start`→`--accent`、`update`→`--text-muted`、`abolition`→`--up`。
- `test/j-quants.test.ts`はCDK synth(esbuildバンドル)を伴うため1ファイル実行でも約9分かかる。各タスクでは対象ファイルのみ実行し、このファイルへの変更を含むタスク(Task 1)以外では実行しない。

---

### Task 1: CDKに新規テーブル・IAM grant・APIルートを追加する

**Files:**
- Modify: `lib/j-quants-stack.ts`
- Test: `test/j-quants.test.ts`

**Interfaces:**
- Produces(Task 2, 3が使う): 環境変数`YUTAI_TDNET_EVENT_TABLE_NAME`が`yutaiTdnetWatchBatchFn`(書き込み用)と`referenceApiFn`(読み取り用)の両方に設定される。テーブル`JQuantsYutaiTdnetEvent`(PK: `pk`, SK: `eventId`)。ルート`GET /yutai/tdnet-events`。

- [ ] **Step 1: 失敗するテストを書く**

`test/j-quants.test.ts`のルート一覧配列(132行目付近)に追加する:

```ts
  const routeKeys = [
    'GET /tickers',
    'POST /tickers',
    'DELETE /tickers/{ticker}',
    'GET /tickers/{ticker}/prices',
    'GET /tickers/{ticker}/summary',
    'GET /yutai',
    'GET /yutai/{ticker}',
    'GET /yutai/{ticker}/margin-trend',
    'GET /yutai/forecast',
    'GET /yutai/{ticker}/forecast',
    'GET /yutai/tdnet-events',
  ];
```

ファイル末尾(既存の`describe`/`test`が終わった後)に追加する:

```ts
test('creates the JQuantsYutaiTdnetEvent table with pk/eventId key and RETAIN policy', () => {
  const template = synth();

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    TableName: 'JQuantsYutaiTdnetEvent',
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'eventId', KeyType: 'RANGE' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  });
});

test('yutai-tdnet-watch-batch has read access to the yutai master table and write access to the tdnet event table', () => {
  const template = synth();

  template.hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'index.handler',
    Environment: {
      Variables: Match.objectLike({
        YUTAI_MASTER_TABLE_NAME: Match.anyValue(),
        YUTAI_TDNET_EVENT_TABLE_NAME: Match.anyValue(),
      }),
    },
  });

  const policies = template.findResources('AWS::IAM::Policy');
  const policyEntries = Object.entries(policies);

  const hasMasterReadAccess = policyEntries.some(([name, p]) => {
    if (!name.includes('YutaiTdnetWatchBatch')) return false;
    const statements =
      (p as { Properties?: { PolicyDocument?: { Statement?: Array<{ Action?: string[] | string; Resource?: any }> } } })
        .Properties?.PolicyDocument?.Statement || [];
    return statements.some((stmt) => {
      const actions = Array.isArray(stmt.Action) ? stmt.Action : stmt.Action ? [stmt.Action] : [];
      const hasReadActions = actions.some((action) => action && (action.includes('GetItem') || action.includes('Query')));
      const hasMasterResource = JSON.stringify(stmt.Resource || '').includes('YutaiMaster');
      return hasReadActions && hasMasterResource;
    });
  });
  expect(hasMasterReadAccess).toBe(true);

  const hasEventWriteAccess = policyEntries.some(([name, p]) => {
    if (!name.includes('YutaiTdnetWatchBatch')) return false;
    const statements =
      (p as { Properties?: { PolicyDocument?: { Statement?: Array<{ Action?: string[] | string; Resource?: any }> } } })
        .Properties?.PolicyDocument?.Statement || [];
    return statements.some((stmt) => {
      const actions = Array.isArray(stmt.Action) ? stmt.Action : stmt.Action ? [stmt.Action] : [];
      const hasWriteActions = actions.some((action) => action && action.includes('PutItem'));
      const hasEventResource = JSON.stringify(stmt.Resource || '').includes('YutaiTdnetEvent');
      return hasWriteActions && hasEventResource;
    });
  });
  expect(hasEventWriteAccess).toBe(true);
});

test('reference-api has read access to the tdnet event table', () => {
  const template = synth();

  template.hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'index.handler',
    Environment: {
      Variables: Match.objectLike({
        YUTAI_TDNET_EVENT_TABLE_NAME: Match.anyValue(),
        WATCHLIST_TABLE_NAME: Match.anyValue(),
      }),
    },
  });

  const policies = template.findResources('AWS::IAM::Policy');
  const hasEventReadAccess = Object.entries(policies).some(([name, p]) => {
    if (!name.includes('ReferenceApi')) return false;
    const statements =
      (p as { Properties?: { PolicyDocument?: { Statement?: Array<{ Action?: string[] | string; Resource?: any }> } } })
        .Properties?.PolicyDocument?.Statement || [];
    return statements.some((stmt) => {
      const actions = Array.isArray(stmt.Action) ? stmt.Action : stmt.Action ? [stmt.Action] : [];
      const hasReadActions = actions.some((action) => action && (action.includes('GetItem') || action.includes('Query')));
      const hasEventResource = JSON.stringify(stmt.Resource || '').includes('YutaiTdnetEvent');
      return hasReadActions && hasEventResource;
    });
  });
  expect(hasEventReadAccess).toBe(true);
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx jest test/j-quants.test.ts -t "YutaiTdnetEvent|tdnet-events|tdnet event table"`
Expected: FAIL(テーブル・ルート・env var・grantのいずれも未実装)

- [ ] **Step 3: 実装する**

`lib/j-quants-stack.ts`:

(a) クラスフィールド宣言(`public readonly gyakuhibuForecastTable: dynamodb.Table;`の直後)に追加する:

```ts
  public readonly yutaiTdnetEventTable: dynamodb.Table;
```

(b) `this.gyakuhibuForecastTable = new dynamodb.Table(...)`ブロックの直後(`this.apiKeySecret = ...`の前)に追加する:

```ts
    // TDnet監視バッチ(yutai-tdnet-watch-batch)が検知した優待関連イベント(開始/変更/廃止)の記録。
    // 全件を1パーティションにまとめ(pk固定値'ALL')、eventId(ソートキー)の先頭に開示日を
    // 埋め込むことで、Query+ScanIndexForward:falseだけで日付降順の一覧が取れるようにする
    // (docs/superpowers/specs/2026-09-20-yutai-tdnet-event-design.md)。
    this.yutaiTdnetEventTable = new dynamodb.Table(this, 'JQuantsYutaiTdnetEventTable', {
      tableName: 'JQuantsYutaiTdnetEvent',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'eventId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
```

(c) `yutaiTdnetWatchBatchFn`の`environment`に1行追加し、`this.yutaiMasterTable.grantWriteData(yutaiTdnetWatchBatchFn);`の直後に2行追加する:

```ts
    const yutaiTdnetWatchBatchFn = new nodejs.NodejsFunction(this, 'YutaiTdnetWatchBatchFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'yutai-tdnet-watch-batch', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(14),
      memorySize: 256,
      bundling: { externalModules: ['@aws-sdk/*'] },
      environment: {
        YUTAI_MASTER_TABLE_NAME: this.yutaiMasterTable.tableName,
        YUTAI_TDNET_EVENT_TABLE_NAME: this.yutaiTdnetEventTable.tableName,
      },
    });

    this.yutaiMasterTable.grantWriteData(yutaiTdnetWatchBatchFn);
    // 新規登録(start) vs 既存更新(update)の判定にJQuantsYutaiMasterの既存有無を読むため、
    // write専用だったこのLambdaにread権限も追加する。
    this.yutaiMasterTable.grantReadData(yutaiTdnetWatchBatchFn);
    this.yutaiTdnetEventTable.grantWriteData(yutaiTdnetWatchBatchFn);
```

(d) `referenceApiFn`の`environment`に1行追加し、`this.gyakuhibuForecastTable.grantReadData(referenceApiFn);`の直後に1行追加する:

```ts
      environment: {
        TABLE_NAME: this.stockPricesTable.tableName,
        FINANCIAL_TABLE_NAME: this.financialSummaryTable.tableName,
        WATCHLIST_TABLE_NAME: this.watchlistTable.tableName,
        SECRET_ARN: this.apiKeySecret.secretArn,
        YUTAI_MASTER_TABLE_NAME: this.yutaiMasterTable.tableName,
        MARGIN_BALANCE_TABLE_NAME: this.marginBalanceTable.tableName,
        GYAKUHIBU_ACTUAL_TABLE_NAME: this.gyakuhibuActualTable.tableName,
        GYAKUHIBU_FORECAST_TABLE_NAME: this.gyakuhibuForecastTable.tableName,
        TSE_MARGIN_FEATURES_ENABLED: String(tseMarginFeatures),
        YUTAI_TDNET_EVENT_TABLE_NAME: this.yutaiTdnetEventTable.tableName,
      },
    });

    this.stockPricesTable.grantReadData(referenceApiFn);
    this.financialSummaryTable.grantReadData(referenceApiFn);
    this.watchlistTable.grantReadWriteData(referenceApiFn);
    this.apiKeySecret.grantRead(referenceApiFn);
    this.yutaiMasterTable.grantReadData(referenceApiFn);
    this.marginBalanceTable.grantReadData(referenceApiFn);
    this.gyakuhibuActualTable.grantReadData(referenceApiFn);
    this.gyakuhibuForecastTable.grantReadData(referenceApiFn);
    this.yutaiTdnetEventTable.grantReadData(referenceApiFn);
```

(e) `this.api.addRoutes({ path: '/yutai/forecast', ...})`ブロックの直前に追加する(既存の`/yutai`系ルートのまとまりを崩さないよう`/yutai`の直後に置く):

```ts
    this.api.addRoutes({
      path: '/yutai/tdnet-events',
      methods: [apigwv2.HttpMethod.GET],
      integration: referenceApiIntegration,
    });
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `npx jest test/j-quants.test.ts`
Expected: PASS(全件、既存テストへの影響なし)

- [ ] **Step 5: コミット**

```bash
git add lib/j-quants-stack.ts test/j-quants.test.ts
git commit -m "Add the JQuantsYutaiTdnetEvent table, grants, and GET /yutai/tdnet-events route"
```

---

### Task 2: yutai-tdnet-watch-batchでイベントを記録する

**Files:**
- Modify: `lambda/yutai-tdnet-watch-batch/index.ts`
- Test: `test/yutai-tdnet-watch-batch.test.ts`

**Interfaces:**
- Consumes: Task 1の環境変数`YUTAI_TDNET_EVENT_TABLE_NAME`
- Produces(Task 3が読む): `JQuantsYutaiTdnetEvent`の行`{ pk: 'ALL', eventId, ticker, companyName, eventType, disclosureTitle, disclosedAt, recordedAt }`

- [ ] **Step 1: テストを更新・追加する**

`test/yutai-tdnet-watch-batch.test.ts`の`jest.mock('@aws-sdk/lib-dynamodb', ...)`を以下に置き換える:

```ts
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  GetCommand: jest.fn((input: unknown) => input),
  PutCommand: jest.fn((input: unknown) => input),
  UpdateCommand: jest.fn((input: unknown) => input),
  DeleteCommand: jest.fn((input: unknown) => input),
}));
```

`process.env.YUTAI_MASTER_TABLE_NAME = 'JQuantsYutaiMaster';`の直後に追加する:

```ts
process.env.YUTAI_TDNET_EVENT_TABLE_NAME = 'JQuantsYutaiTdnetEvent';
```

既存の6つのテストを以下の内容に置き換える(`mockSend.mockResolvedValue({})`だと新規追加した`GetCommand`(既存有無チェック)も`{}`つまり「未登録」を返すため、置き換え後のテストは特に指定が無い限り全て`eventType: 'start'`になる):

```ts
test('matches a yutai-related disclosure, looks it up via a single fetchAllListings scan, and upserts it', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    text: async () =>
      dayListHtml([{ code: '21570', name: 'コシダカホールディングス', title: '株主優待制度の一部変更に関するお知らせ' }]),
  });
  mockFetchAllListings.mockResolvedValueOnce([
    {
      ticker: '2157',
      companyName: 'コシダカホールディングス',
      content: '割引券（3,000円相当～）',
      rightsMonths: [2, 8],
      value: 3000,
      minInvestment: 150000,
    },
  ]);
  mockSend.mockResolvedValue({});

  await handler();

  expect(mockFetchAllListings).toHaveBeenCalledTimes(1);
  // Get(既存有無チェック) + Update(マスタupsert) + Put(イベント記録) = 3件。
  expect(mockSend).toHaveBeenCalledTimes(3);
  expect(mockSend.mock.calls[0][0]).toMatchObject({ TableName: 'JQuantsYutaiMaster', Key: { ticker: '2157' } });
  expect(mockSend.mock.calls[1][0]).toMatchObject({
    TableName: 'JQuantsYutaiMaster',
    Key: { ticker: '2157' },
    ExpressionAttributeValues: { ':value': 3000, ':unitShares': 100, ':minInvestment': 150000, ':rightsMonths': [2, 8] },
  });
  expect(mockSend.mock.calls[2][0]).toMatchObject({
    TableName: 'JQuantsYutaiTdnetEvent',
    Item: expect.objectContaining({
      pk: 'ALL',
      ticker: '2157',
      companyName: 'コシダカホールディングス',
      eventType: 'start',
      disclosureTitle: '株主優待制度の一部変更に関するお知らせ',
    }),
  });
});

test('upserts a matched ticker with value: null when kabuyutai.com has no extractable value, as long as rightsMonths is present', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    text: async () =>
      dayListHtml([{ code: '21570', name: 'コシダカホールディングス', title: '株主優待制度の一部変更に関するお知らせ' }]),
  });
  mockFetchAllListings.mockResolvedValueOnce([
    {
      ticker: '2157',
      companyName: 'コシダカホールディングス',
      content: '割引券（金額不明）',
      rightsMonths: [2, 8],
      value: undefined,
      minInvestment: 150000,
    },
  ]);
  mockSend.mockResolvedValue({});

  await handler();

  expect(mockFetchAllListings).toHaveBeenCalledTimes(1);
  expect(mockSend).toHaveBeenCalledTimes(3);
  expect(mockSend.mock.calls[1][0]).toMatchObject({
    TableName: 'JQuantsYutaiMaster',
    Key: { ticker: '2157' },
    ExpressionAttributeValues: { ':value': null, ':unitShares': 100, ':minInvestment': 150000, ':rightsMonths': [2, 8] },
  });
});

test('ignores disclosures whose title has no yutai-related keyword', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    text: async () => dayListHtml([{ code: '72030', name: 'トヨタ自動車', title: '自己株式取得に関するお知らせ' }]),
  });

  await handler();

  expect(mockFetchAllListings).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
});

test('warns without deleting or recording an event when a matched ticker is not found on kabuyutai.com but the disclosure has no abolition keyword', async () => {
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        dayListHtml([{ code: '99990', name: '謎企業', title: '株主優待制度の一部変更に関するお知らせ' }]),
    });
    mockFetchAllListings.mockResolvedValueOnce([]); // not found, but no abolition signal -> likely transient

    await handler();

    expect(mockSend).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('9999'));
  } finally {
    warnSpy.mockRestore();
  }
});

test('deletes the yutai master row and records an abolition event when a matched ticker is not found on kabuyutai.com AND the matching disclosure contains an abolition keyword', async () => {
  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        dayListHtml([{ code: '99990', name: '廃止企業', title: '株主優待制度の廃止に関するお知らせ' }]),
    });
    mockFetchAllListings.mockResolvedValueOnce([]); // もうkabuyutai.comの一覧に存在しない
    mockSend.mockResolvedValue({});

    await handler();

    // Delete(マスタ削除) + Put(イベント記録) = 2件。廃止はGetCommand(既存有無チェック)不要
    // (eventTypeが'abolition'に確定しているため)。
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend.mock.calls[0][0]).toMatchObject({ TableName: 'JQuantsYutaiMaster', Key: { ticker: '9999' } });
    expect(mockSend.mock.calls[1][0]).toMatchObject({
      TableName: 'JQuantsYutaiTdnetEvent',
      Item: expect.objectContaining({ ticker: '9999', eventType: 'abolition', companyName: '廃止企業' }),
    });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('9999'));
  } finally {
    logSpy.mockRestore();
  }
});

test('deduplicates multiple matching disclosures across tickers into a single fetchAllListings scan, and records one event per disclosure', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    text: async () =>
      dayListHtml([
        { code: '21570', name: 'コシダカホールディングス', title: '株主優待制度の一部変更に関するお知らせ' },
        { code: '21570', name: 'コシダカホールディングス', title: '株主優待制度の一部変更に関するお知らせ（訂正）' },
        { code: '30030', name: '別企業', title: '株主優待制度の新設に関するお知らせ' },
      ]),
  });
  mockFetchAllListings.mockResolvedValueOnce([
    {
      ticker: '2157',
      companyName: 'コシダカホールディングス',
      content: '割引券（3,000円相当～）',
      rightsMonths: [2, 8],
      value: 3000,
    },
    { ticker: '3003', companyName: '別企業', content: 'QUOカード（500円相当～）', rightsMonths: [3], value: 500 },
  ]);
  mockSend.mockResolvedValue({});

  await handler();

  // 銘柄数(2件)に関わらず、実行全体を通してサイト走査は1回だけ。
  expect(mockFetchAllListings).toHaveBeenCalledTimes(1);

  // 2157: Get+Update+Put×2件(開示ごと)、3003: Get+Update+Put×1件 = 7件。
  expect(mockSend).toHaveBeenCalledTimes(7);
  const eventPuts = mockSend.mock.calls
    .map((c) => c[0] as { TableName?: string; Item?: { ticker: string; disclosureTitle: string } })
    .filter((c) => c.TableName === 'JQuantsYutaiTdnetEvent');
  expect(eventPuts).toHaveLength(3);
  expect(eventPuts.filter((c) => c.Item!.ticker === '2157')).toHaveLength(2);
  expect(eventPuts.map((c) => c.Item!.disclosureTitle)).toEqual(
    expect.arrayContaining([
      '株主優待制度の一部変更に関するお知らせ',
      '株主優待制度の一部変更に関するお知らせ（訂正）',
      '株主優待制度の新設に関するお知らせ',
    ]),
  );
});

test('treats a 404 day page as "no disclosures that day" rather than failing the run', async () => {
  mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

  await expect(handler()).resolves.not.toThrow();
  expect(mockFetchAllListings).not.toHaveBeenCalled();
});

test('throws when every day in the lookback window fails to fetch from TDnet', async () => {
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    mockFetch.mockResolvedValue({ ok: false, status: 500 }); // every day errors (not a 404 "no disclosures")

    await expect(handler()).rejects.toThrow(/All \d+ days failed to fetch from TDnet/);
    expect(mockFetchAllListings).not.toHaveBeenCalled();
  } finally {
    errorSpy.mockRestore();
  }
});

describe('pagination within a single day', () => {
  test('follows pagination when the count banner reports more than 100 disclosures, and picks up a ticker that only appears on page 2', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          dayListHtml(
            [{ code: '10010', name: 'ページ1企業', title: '株主優待制度の新設に関するお知らせ' }],
            149, // 「1～100件/全149件」 -> 100件/ページなので2ページ目が存在する
          ),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          dayListHtml([{ code: '20020', name: 'ページ2企業', title: '株主優待制度の新設に関するお知らせ' }], 149),
      });
    mockFetchAllListings.mockResolvedValueOnce([
      { ticker: '1001', companyName: 'ページ1企業', content: 'QUOカード（500円相当～）', rightsMonths: [3], value: 500 },
      { ticker: '2002', companyName: 'ページ2企業', content: '商品券（1,000円相当～）', rightsMonths: [9], value: 1000 },
    ]);
    mockSend.mockResolvedValue({});

    await handler();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(String(mockFetch.mock.calls[0][0])).toContain('I_list_001_');
    expect(String(mockFetch.mock.calls[1][0])).toContain('I_list_002_');

    const upsertedTickers = mockSend.mock.calls.map((call) => (call[0] as { Key?: { ticker?: string } }).Key?.ticker);
    expect(upsertedTickers).toContain('2002');
  });
});
```

ファイル末尾(`describe('pagination within a single day', ...)`の後)に、新規テストを2件追加する:

```ts
test('records eventType "update" (not "start") when the ticker already exists in JQuantsYutaiMaster', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    text: async () =>
      dayListHtml([{ code: '21570', name: 'コシダカホールディングス', title: '株主優待制度の一部変更に関するお知らせ' }]),
  });
  mockFetchAllListings.mockResolvedValueOnce([
    { ticker: '2157', companyName: 'コシダカホールディングス', content: '割引券（3,000円相当～）', rightsMonths: [2, 8], value: 3000 },
  ]);
  mockSend.mockImplementation((command: unknown) => {
    const c = command as { TableName?: string; UpdateExpression?: string };
    if (c.TableName === 'JQuantsYutaiMaster' && !c.UpdateExpression) {
      // GetCommand(既存有無チェック)。UpdateCommandは同じTableNameだがUpdateExpressionを持つので区別できる。
      return Promise.resolve({ Item: { ticker: '2157' } });
    }
    return Promise.resolve({});
  });

  await handler();

  const eventPut = mockSend.mock.calls
    .map((c) => c[0] as { TableName?: string; Item?: Record<string, unknown> })
    .find((c) => c.TableName === 'JQuantsYutaiTdnetEvent');
  expect(eventPut?.Item).toMatchObject({ ticker: '2157', eventType: 'update' });
});

test('computes a deterministic eventId so re-processing the same disclosure overwrites rather than duplicates', async () => {
  const runOnce = async (): Promise<string> => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        dayListHtml([{ code: '21570', name: 'コシダカホールディングス', title: '株主優待制度の一部変更に関するお知らせ' }]),
    });
    mockFetchAllListings.mockResolvedValueOnce([
      { ticker: '2157', companyName: 'コシダカホールディングス', content: '割引券（3,000円相当～）', rightsMonths: [2, 8], value: 3000 },
    ]);
    mockSend.mockReset();
    mockSend.mockResolvedValue({});

    await handler();

    const eventPut = mockSend.mock.calls
      .map((c) => c[0] as { TableName?: string; Item?: { eventId: string } })
      .find((c) => c.TableName === 'JQuantsYutaiTdnetEvent');
    return eventPut!.Item!.eventId;
  };

  const firstEventId = await runOnce();
  const secondEventId = await runOnce();
  expect(firstEventId).toBe(secondEventId);
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx jest test/yutai-tdnet-watch-batch.test.ts`
Expected: FAIL(現状は`GetCommand`/`PutCommand`を発行しないため呼び出し回数・内容が一致しない)

- [ ] **Step 3: 実装する**

`lambda/yutai-tdnet-watch-batch/index.ts`:

(a) importを以下に置き換える:

```ts
import { createHash } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { fetchAllListings, KabuyutaiEntry } from '../shared/kabuyutai-client';
```

(b) `const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;`の直後に追加する:

```ts
const YUTAI_TDNET_EVENT_TABLE_NAME = process.env.YUTAI_TDNET_EVENT_TABLE_NAME!;
```

(c) `Disclosure`インターフェースに`disclosedAt`を追加する:

```ts
interface Disclosure {
  code: string;
  companyName: string;
  title: string;
  disclosedAt: string;
}
```

(d) `formatDate`の直後に追加する:

```ts
// "YYYYMMDD" -> "YYYY-MM-DD"(イベントのdisclosedAt・eventId生成用)。
function toIsoDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}
```

(e) `parseDayPage`を以下に置き換える(`disclosedAt`を受け取って各行に埋め込む):

```ts
function parseDayPage(html: string, disclosedAt: string): Disclosure[] {
  const disclosures: Disclosure[] = [];
  for (const rowMatch of html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const row = rowMatch[1];
    const codeMatch = row.match(/class="[^"]*kjCode[^"]*"[^>]*>(\d+)</);
    const nameMatch = row.match(/class="[^"]*kjName[^"]*"[^>]*>([^<]+)</);
    const titleMatch = row.match(/class="[^"]*kjTitle[^"]*"[^>]*><a[^>]*>([^<]+)</);
    if (!codeMatch || !nameMatch || !titleMatch) continue;

    disclosures.push({ code: codeMatch[1], companyName: nameMatch[1].trim(), title: titleMatch[1].trim(), disclosedAt });
  }
  return disclosures;
}
```

(f) `fetchDayDisclosures`内の`parseDayPage(firstHtml)`と`parseDayPage(await response.text())`の2箇所を、それぞれ`parseDayPage(firstHtml, toIsoDate(dateStr))`・`parseDayPage(await response.text(), toIsoDate(dateStr))`に変更する。

(g) `export const handler`内、開示収集ループを以下に置き換える(`matchedTickers`の型が`Map<string, boolean>`から`Map<string, Disclosure[]>`に変わる):

```ts
  // ticker -> その銘柄にマッチした開示の配列(1つの開示につき1イベントとして記録するため、
  // 集約時点でtitle/日付を捨てずに保持する)。
  const matchedTickers = new Map<string, Disclosure[]>();
  let failedDays = 0;

  for (let daysAgo = 0; daysAgo < LOOKBACK_DAYS; daysAgo++) {
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    const dateStr = formatDate(date);

    try {
      const disclosures = await fetchDayDisclosures(dateStr);
      for (const disclosure of disclosures) {
        if (isYutaiRelated(disclosure.title)) {
          const ticker = toTicker(disclosure.code);
          const existing = matchedTickers.get(ticker) ?? [];
          existing.push(disclosure);
          matchedTickers.set(ticker, existing);
        }
      }
    } catch (error) {
      failedDays++;
      console.error(`Failed to fetch TDnet disclosures for ${dateStr}`, error);
    }

    await sleep(REQUEST_INTERVAL_MS);
  }
```

(h) ティッカー処理ループを以下に置き換える:

```ts
  for (const [ticker, disclosures] of matchedTickers) {
    const sawAbolitionKeyword = disclosures.some((d) => isAbolitionRelated(d.title));
    try {
      const entry = listingsByTicker.get(ticker);
      if (!entry) {
        if (sawAbolitionKeyword) {
          await ddbDocClient.send(new DeleteCommand({ TableName: YUTAI_MASTER_TABLE_NAME, Key: { ticker } }));
          console.log(`${ticker}: yutai program appears discontinued (abolition disclosure + not found on kabuyutai.com); deleted from master`);
          await recordEvents(ticker, disclosures, 'abolition');
        } else {
          console.warn(`${ticker}: matched a yutai-related TDnet disclosure but not found on kabuyutai.com; skipping`);
        }
        continue;
      }
      if (entry.rightsMonths.length === 0) {
        console.warn(`${ticker}: found on kabuyutai.com but rightsMonths incomplete; skipping`);
        continue;
      }

      // 新規登録(start)か既存更新(update)かはJQuantsYutaiMaster(自テーブル)側の既存有無で
      // 判定する(kabuyutai.com側の存在有無=entryとは別物)。
      const existing = await ddbDocClient.send(new GetCommand({ TableName: YUTAI_MASTER_TABLE_NAME, Key: { ticker } }));
      const eventType: 'start' | 'update' = existing.Item ? 'update' : 'start';

      await ddbDocClient.send(
        new UpdateCommand({
          TableName: YUTAI_MASTER_TABLE_NAME,
          Key: { ticker: entry.ticker },
          UpdateExpression:
            'SET companyName = :companyName, #content = :content, #value = :value, unitShares = :unitShares, minInvestment = :minInvestment, rightsMonths = :rightsMonths',
          ExpressionAttributeNames: { '#content': 'content', '#value': 'value' },
          ExpressionAttributeValues: {
            ':companyName': entry.companyName,
            ':content': entry.content,
            ':value': entry.value ?? null,
            ':unitShares': UNIT_SHARES,
            ':minInvestment': entry.minInvestment ?? null,
            ':rightsMonths': entry.rightsMonths,
          },
        }),
      );
      console.log(`${ticker}: upserted yutai master from TDnet-triggered re-sync`);
      await recordEvents(ticker, disclosures, eventType);
    } catch (error) {
      console.error(`${ticker}: failed to re-sync from TDnet match`, error);
    }
  }
};

// tickerにマッチした開示それぞれについて、1件ずつイベント行を書く(開示ごとに1イベント)。
// eventIdは{disclosedAt}#{ticker}#{titleのsha256hex先頭8文字}なので、同一開示の再処理
// (LOOKBACK_DAYSによる重複走査)では同じ行を上書きするだけで重複しない。1件の書き込み失敗が
// 他の開示の記録を妨げないよう、開示ごとに個別にtry/catchする。
async function recordEvents(
  ticker: string,
  disclosures: Disclosure[],
  eventType: 'start' | 'update' | 'abolition',
): Promise<void> {
  const recordedAt = new Date().toISOString();
  for (const disclosure of disclosures) {
    try {
      const hash = createHash('sha256').update(disclosure.title).digest('hex').slice(0, 8);
      const eventId = `${disclosure.disclosedAt}#${ticker}#${hash}`;
      await ddbDocClient.send(
        new PutCommand({
          TableName: YUTAI_TDNET_EVENT_TABLE_NAME,
          Item: {
            pk: 'ALL',
            eventId,
            ticker,
            companyName: disclosure.companyName,
            eventType,
            disclosureTitle: disclosure.title,
            disclosedAt: disclosure.disclosedAt,
            recordedAt,
          },
        }),
      );
    } catch (error) {
      console.error(`${ticker}: failed to record tdnet event`, error);
    }
  }
}
```

上記(h)は`export const handler = async (): Promise<void> => { ... };`の末尾(元の閉じ`};`)を含めて置き換えるため、`recordEvents`関数はハンドラーの外(ファイル末尾)に定義される形になる。

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `npx jest test/yutai-tdnet-watch-batch.test.ts && npx tsc --noEmit`
Expected: PASS(全件)、型チェックも通過

- [ ] **Step 5: コミット**

```bash
git add lambda/yutai-tdnet-watch-batch/index.ts test/yutai-tdnet-watch-batch.test.ts
git commit -m "Record start/update/abolition events per disclosure in yutai-tdnet-watch-batch"
```

---

### Task 3: API `GET /yutai/tdnet-events` を追加する

**Files:**
- Modify: `lambda/reference-api/index.ts`
- Test: `test/reference-api.test.ts`

**Interfaces:**
- Consumes: Task 1の環境変数`YUTAI_TDNET_EVENT_TABLE_NAME`、Task 2が書く`JQuantsYutaiTdnetEvent`の行
- Produces(Task 4が使う): `GET /yutai/tdnet-events`のレスポンス`{ events: [{ ticker, companyName, eventType, disclosureTitle, disclosedAt, recordedAt }] }`(`disclosedAt`降順)

- [ ] **Step 1: 失敗するテストを書く**

`test/reference-api.test.ts`の`process.env.GYAKUHIBU_FORECAST_TABLE_NAME = ...;`の直後に追加する:

```ts
process.env.YUTAI_TDNET_EVENT_TABLE_NAME = 'JQuantsYutaiTdnetEvent';
```

ファイル末尾に追加する:

```ts
test('GET /yutai/tdnet-events queries the event table by fixed pk and returns items newest-first', async () => {
  mockSend.mockResolvedValueOnce({
    Items: [
      {
        pk: 'ALL',
        eventId: '2026-09-08#2157#abcdef12',
        ticker: '2157',
        companyName: 'コシダカホールディングス',
        eventType: 'update',
        disclosureTitle: '株主優待制度の一部変更に関するお知らせ',
        disclosedAt: '2026-09-08',
        recordedAt: '2026-09-08T21:03:00.000Z',
      },
    ],
  });

  const result = await handler(makeEvent('GET /yutai/tdnet-events'));

  expect(mockSend.mock.calls[0][0]).toMatchObject({
    TableName: 'JQuantsYutaiTdnetEvent',
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': 'ALL' },
    ScanIndexForward: false,
  });
  const parsed = body(result) as { events: Array<Record<string, unknown>> };
  expect(parsed.events).toEqual([
    {
      ticker: '2157',
      companyName: 'コシダカホールディングス',
      eventType: 'update',
      disclosureTitle: '株主優待制度の一部変更に関するお知らせ',
      disclosedAt: '2026-09-08',
      recordedAt: '2026-09-08T21:03:00.000Z',
    },
  ]);
});

test('GET /yutai/tdnet-events returns an empty array when there are no events yet', async () => {
  mockSend.mockResolvedValueOnce({ Items: [] });

  const result = await handler(makeEvent('GET /yutai/tdnet-events'));

  expect(body(result)).toEqual({ events: [] });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx jest test/reference-api.test.ts -t "tdnet-events"`
Expected: FAIL(ルート未実装につき404が返る)

- [ ] **Step 3: 実装する**

`lambda/reference-api/index.ts`:

(a) `const GYAKUHIBU_FORECAST_TABLE_NAME = process.env.GYAKUHIBU_FORECAST_TABLE_NAME!;`の直後に追加する:

```ts
const YUTAI_TDNET_EVENT_TABLE_NAME = process.env.YUTAI_TDNET_EVENT_TABLE_NAME!;
```

(b) `getMarginTrend`関数の直後に追加する:

```ts
async function listTdnetEvents(): Promise<APIGatewayProxyResultV2> {
  const result = await ddbDocClient.send(
    new QueryCommand({
      TableName: YUTAI_TDNET_EVENT_TABLE_NAME,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': 'ALL' },
      ScanIndexForward: false, // eventId(SK)の先頭がdisclosedAtなので、降順=新しい開示順になる
    }),
  );
  const events = (result.Items ?? []).map((item) => ({
    ticker: item.ticker,
    companyName: item.companyName,
    eventType: item.eventType,
    disclosureTitle: item.disclosureTitle,
    disclosedAt: item.disclosedAt,
    recordedAt: item.recordedAt,
  }));
  return jsonResponse(200, { events });
}
```

(c) `switch (event.routeKey)`内、`case 'GET /yutai':`の直後に追加する:

```ts
    case 'GET /yutai/tdnet-events':
      return listTdnetEvents();
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `npx jest test/reference-api.test.ts && npx tsc --noEmit`
Expected: PASS(全件)、型チェックも通過

- [ ] **Step 5: コミット**

```bash
git add lambda/reference-api/index.ts test/reference-api.test.ts
git commit -m "Add GET /yutai/tdnet-events"
```

---

### Task 4: フロントエンドに一覧画面を追加する

**Files:**
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/api/client.ts`
- Create: `frontend/src/pages/YutaiTdnetEventsPage.tsx`
- Modify: `frontend/src/main.tsx`
- Modify: `frontend/src/components/Layout.tsx`
- Modify: `frontend/src/index.css`

**Interfaces:**
- Consumes: Task 3のレスポンス形状

- [ ] **Step 1: 型とAPIクライアントを追加する**

`frontend/src/api/types.ts`のファイル末尾に追加する:

```ts

export type YutaiTdnetEventType = 'start' | 'update' | 'abolition';

export interface YutaiTdnetEvent {
  ticker: string;
  companyName: string;
  eventType: YutaiTdnetEventType;
  disclosureTitle: string;
  disclosedAt: string;
  recordedAt: string;
}

export interface YutaiTdnetEventsResponse {
  events: YutaiTdnetEvent[];
}
```

`frontend/src/api/client.ts`のimport一覧に`YutaiTdnetEventsResponse`を追加する:

```ts
import type {
  FinancialSummary,
  MarginTrendResponse,
  PricesResponse,
  WatchlistTicker,
  YutaiDetail,
  YutaiListResponse,
  YutaiForecastStatus,
  YutaiForecastListResponse,
  YutaiForecastDetail,
  YutaiTdnetEventsResponse,
} from './types';
```

`fetchYutaiMarginTrend`関数の直後に追加する:

```ts
export function fetchYutaiTdnetEvents(): Promise<YutaiTdnetEventsResponse> {
  return request('/yutai/tdnet-events');
}
```

- [ ] **Step 2: CSSにイベントバッジを追加する**

`frontend/src/index.css`の`.risk-badge--caution { ... }`ブロックの直後に追加する:

```css
.event-badge {
  font-size: 0.8rem;
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  font-weight: 600;
  display: inline-block;
}

.event-badge--start {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}

.event-badge--update {
  color: var(--text-muted);
  background: var(--surface-alt);
}

.event-badge--abolition {
  color: var(--up);
  background: color-mix(in srgb, var(--up) 14%, transparent);
}
```

- [ ] **Step 3: 一覧ページを作成する**

`frontend/src/pages/YutaiTdnetEventsPage.tsx`を新規作成する:

```tsx
import { Link } from 'react-router-dom';
import { fetchYutaiTdnetEvents } from '../api/client';
import type { YutaiTdnetEventType } from '../api/types';
import { StatusNote } from '../components/StatusNote';
import { useAsync } from '../lib/useAsync';

const EVENT_TYPE_LABEL: Record<YutaiTdnetEventType, string> = { start: '開始', update: '変更', abolition: '廃止' };
const EVENT_TYPE_CLASS: Record<YutaiTdnetEventType, string> = {
  start: 'event-badge--start',
  update: 'event-badge--update',
  abolition: 'event-badge--abolition',
};

export function YutaiTdnetEventsPage() {
  const eventsState = useAsync(() => fetchYutaiTdnetEvents(), []);

  return (
    <>
      <h1 className="page-title">優待変更履歴</h1>
      <p className="page-subtitle">TDnet開示から検知した株主優待の新設・変更・廃止(直近分)。</p>

      {eventsState.loading && <StatusNote kind="loading" message="読み込み中…" />}
      {eventsState.error && <StatusNote kind="error" message={`取得に失敗しました: ${eventsState.error.message}`} />}
      {eventsState.data && eventsState.data.events.length === 0 && (
        <StatusNote kind="empty" message="検知されたイベントはまだありません。" />
      )}

      {eventsState.data && eventsState.data.events.length > 0 && (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>開示日</th>
                <th>銘柄コード</th>
                <th>会社名</th>
                <th>種別</th>
                <th>開示タイトル</th>
              </tr>
            </thead>
            <tbody>
              {eventsState.data.events.map((event) => (
                <tr key={`${event.disclosedAt}-${event.ticker}-${event.disclosureTitle}`}>
                  <td className="num">{event.disclosedAt}</td>
                  <td style={{ textAlign: 'left' }}>
                    <Link to={`/yutai/${event.ticker}`}>{event.ticker}</Link>
                  </td>
                  <td style={{ textAlign: 'left' }}>{event.companyName}</td>
                  <td>
                    <span className={`event-badge ${EVENT_TYPE_CLASS[event.eventType]}`}>
                      {EVENT_TYPE_LABEL[event.eventType]}
                    </span>
                  </td>
                  <td className="cell-wrap" style={{ textAlign: 'left' }}>
                    {event.disclosureTitle}
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

- [ ] **Step 4: ルーティングとナビゲーションに組み込む**

`frontend/src/main.tsx`: importに`import { YutaiTdnetEventsPage } from './pages/YutaiTdnetEventsPage';`を追加し、`<Route path="yutai/forecast" element={<YutaiForecastListPage />} />`の直後に追加する:

```tsx
            <Route path="yutai/tdnet-events" element={<YutaiTdnetEventsPage />} />
```

`frontend/src/components/Layout.tsx`の`NAV_ITEMS`配列、`{ to: '/yutai/forecast', label: '逆日歩予測' }`の直後に追加する:

```ts
  { to: '/yutai/tdnet-events', label: '優待変更履歴' },
```

- [ ] **Step 5: 型チェックとビルド**

Run: `cd frontend && npx tsc --noEmit -p tsconfig.json && npm run build`
Expected: 両方エラー無し

- [ ] **Step 6: コミット**

```bash
git add frontend/src/api/types.ts frontend/src/api/client.ts frontend/src/pages/YutaiTdnetEventsPage.tsx frontend/src/main.tsx frontend/src/components/Layout.tsx frontend/src/index.css
git commit -m "Add the /yutai/tdnet-events list page"
```

---

### Task 5: READMEを更新する

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Lambda表を更新する**

`YutaiTdnetWatchBatchFunction`行を以下に置き換える:

```
| `YutaiTdnetWatchBatchFunction` | EventBridge(`cron(0 12 ? * MON *)` = 毎週月曜 JST 21:00) | TDnetの直近7日分の開示から「株主優待」関連のキーワードを含む開示(新設・変更・廃止)を検知し、該当銘柄をkabuyutai.comで再取得して`JQuantsYutaiMaster`へupsert。開示ごとに`JQuantsYutaiTdnetEvent`へイベント(`start`/`update`/`abolition`)を記録する(マスタが実際に変わらなかった場合は記録しない) |
```

- [ ] **Step 2: API表を更新する**

`GET /yutai/{ticker}/forecast`行の直後に追加する:

```
| `GET /yutai/tdnet-events` | TDnet監視で検知した優待関連イベント(開始/変更/廃止)の一覧。開示日降順、全件返却(ページネーション無し) |
```

- [ ] **Step 3: 画面表を更新する**

`/yutai/:ticker/forecast`行の直後に追加する:

```
| `/yutai/tdnet-events` | 優待変更履歴(読み取り専用)。開示日 / 銘柄コード / 会社名 / 種別バッジ(開始・変更・廃止) / 開示タイトルの一覧。ナビゲーションから直接遷移 |
```

- [ ] **Step 4: コミット**

```bash
git add README.md
git commit -m "Document the tdnet event table, API, and list page"
```
