# 逆日歩予測 精度検証 実装計画(Task 1-3: 緊急分)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **日付固定の締切があります。** Task 1は2026-09-25 12:00 JSTまでにデプロイ完了、Task 1-3全てが2026-09-25 20:00 JSTのスナップショットA自動実行までにデプロイ完了している必要があります。Task 4(実績取得Lambda)・Task 5(評価スクリプト)・Task 6(合格基準凍結)は別途この計画の続きとして扱う(締切は9/28〜10/2でこちらより余裕がある)。

**Goal:** 逆日歩予測の精度を、2026-09-28権利付き最終日の実績と突き合わせて検証するため、予測を改ざん不能な形で凍結するS3バケットと、それを自動実行するLambda・スケジュールを用意する。

**Architecture:** 新規S3バケット(Object Lock)に、既存の逆日歩予測の純粋関数(`lambda/shared/gyakuhibu-forecast.ts`)をそのまま呼び出して銘柄ごとの予測を書き込む新規Lambdaを用意し、EventBridge Scheduler(1回限りのスケジュール、`aws-cdk-lib/aws-scheduler`)で決まった日時に自動実行する。既存の`gyakuhibu-forecast-batch`(本番の日次予測バッチ)には一切手を入れない — 別系統の新規Lambdaとして完全に独立させることで、検証機能の実装が本番の予測パイプラインに影響しないようにする。

**Tech Stack:** AWS CDK(TypeScript)、Lambda(Node.js 22)、S3(Object Lock)、EventBridge Scheduler、DynamoDB。

## 設計書・事前確認との対応

- 設計書: `docs/superpowers/specs/2026-09-24-gyakuhibu-forecast-validation-design.md`
- Task 0事前確認結果: `docs/superpowers/notes/2026-09-25-validation-preflight.md`
  - 対象銘柄数: **303件**(`rightsMonths`に9を含み、かつJ-Quants `/equities/master`の`MrgnNm`が`貸借`)
  - 取得所要時間: 約6.1分/303銘柄。**単一Lambda呼び出しで完結**(Step Functions分割は不要)
  - 一括取得: 不可。既存の`fetchTaisyakuCsv`(銘柄単位)をそのまま使う
  - 速報(`prelim`)データが実在するか未確認。**コードは`final`/`prelim`両対応で書くが、`prelim`が常に`fetchStatus: "no_row"`相当になっても正常動作すること**(9/25リハーサルで実地確認する)

## Global Constraints

- 新規Lambda・新規S3バケットは既存の予測パイプライン(`gyakuhibu-forecast-batch`等)に一切変更を加えない。完全に独立した新規リソースとして追加する。
- S3キーのプレフィックスは全て設計書の指定通り: `forecast-snapshots/rightsDate=2026-09-28/asof={asofLabel}/run={runId}/`。
- 取得に失敗した銘柄は`fetchStatus: "fetch_error"`として記録し、**古いデータへの暗黙のフォールバックをしない**(前回成功時の値を使い回さない)。
- manifest.jsonが最後に書かれることを「run完了」の合図とする(部分書き込み中に見えないようにする)。
- 既存のtaisyaku.jpクライアント(`lambda/gyakuhibu-history-batch/taisyaku-client.ts`の`fetchTaisyakuCsv`・`parseTaisyakuCsv`)と、既存の逆日歩予測純粋関数(`lambda/shared/gyakuhibu-forecast.ts`の`toSample`・`buildPool`・`chooseScenario`・`forecast`・`excessRatio`・`binFor`)をそのまま再利用する。**これらのファイルは変更しない**(シグネチャ変更や挙動変更は本番の日次予測バッチに影響するため)。

---

### Task 1: 凍結用S3バケット(CDK)

**Files:**
- Modify: `lib/j-quants-stack.ts`
- Test: `test/j-quants.test.ts`

**Interfaces:**
- Produces(Task 2, 3が使う): `this.gyakuhibuValidationBucket`(バケット名はCfnOutputで確認できるようにする)、新規Lambdaへの`s3:PutObject`/`s3:GetObject`/`s3:ListBucket`権限

- [ ] **Step 1: 失敗するテストを書く**

`test/j-quants.test.ts`のファイル末尾に追加する:

```ts
test('creates the gyakuhibu validation bucket with Object Lock (Governance, retain until 2026-12-31), versioning, and RETAIN policy', () => {
  const template = synth();

  template.hasResourceProperties('AWS::S3::Bucket', {
    ObjectLockEnabled: true,
    ObjectLockConfiguration: Match.objectLike({
      ObjectLockEnabled: 'Enabled',
      Rule: Match.objectLike({
        DefaultRetention: Match.objectLike({
          Mode: 'GOVERNANCE',
        }),
      }),
    }),
    VersioningConfiguration: Match.objectLike({ Status: 'Enabled' }),
    PublicAccessBlockConfiguration: Match.objectLike({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    }),
    BucketEncryption: Match.objectLike({
      ServerSideEncryptionConfiguration: Match.arrayWith([
        Match.objectLike({ ServerSideEncryptionByDefault: Match.objectLike({ SSEAlgorithm: 'AES256' }) }),
      ]),
    }),
  });
  template.hasResource('AWS::S3::Bucket', {
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx jest test/j-quants.test.ts -t "gyakuhibu validation bucket"`
Expected: FAIL(バケットが存在しない)

- [ ] **Step 3: 実装する**

`lib/j-quants-stack.ts`:

(a) クラスフィールド宣言に追加する(`public readonly yutaiTdnetEventTable: dynamodb.Table;`の直後):

```ts
  public readonly gyakuhibuValidationBucket: s3.Bucket;
```

(b) `this.apiKeySecret = new secretsmanager.Secret(...)`ブロックの直前に追加する:

```ts
    // 逆日歩予測の精度検証(2026-09-28権利付き最終日)用。予測を凍結後に書き換えられない
    // ことを保証するためObject Lock(Governanceモード)を使う。保持期限は検証プロジェクトの
    // 区切りとして2026-12-31固定(docs/superpowers/specs/2026-09-24-gyakuhibu-forecast-validation-design.md)。
    // Lambdaロールには s3:BypassGovernanceRetention を付与しない(誤って上書き・削除できないように)。
    this.gyakuhibuValidationBucket = new s3.Bucket(this, 'GyakuhibuValidationBucket', {
      objectLockEnabled: true,
      objectLockDefaultRetention: s3.ObjectLockRetention.governance(cdk.Duration.days(
        Math.ceil((new Date('2026-12-31T23:59:59+09:00').getTime() - Date.now()) / (24 * 60 * 60 * 1000)),
      )),
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
```

**注意:** `objectLockDefaultRetention`はCDKでは「期間(日数)」でしか指定できず、固定の「この日まで」というAPIは無い。上記は`synth()`実行時点から2026-12-31までの残り日数を動的に計算する実装。CDKの`ObjectLockRetention.governance(Duration)`が実際にどう振る舞うか(型・必須引数)は`node_modules/aws-cdk-lib/aws-s3`の型定義を実装前に確認し、上記コードが実際にコンパイルできることを確認してから進めること。コンパイルが通らない場合は、L1(`CfnBucket`)の`ObjectLockConfiguration`プロパティで直接`DefaultRetention.Days`を計算値で渡す形に切り替える。

(c) `referenceApiFn`の定義ブロックより後、`this.api = new apigwv2.HttpApi(...)`より前の適切な位置に、新規Lambda用の権限を追加する準備として以下のコメントを残す(実際のLambda定義とgrantはTask 2で追加するため、ここではTask 1の時点ではバケットの作成のみでよい):

```ts
    // 検証用Lambda(ForecastSnapshotFunction)へのgrantはTask 2で追加する。
```

(d) `new cdk.CfnOutput(this, 'FrontendBucketName', ...)`の直後に追加する:

```ts
    new cdk.CfnOutput(this, 'GyakuhibuValidationBucketName', { value: this.gyakuhibuValidationBucket.bucketName });
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `npx jest test/j-quants.test.ts`
Expected: PASS(全件)

- [ ] **Step 5: コミット**

```bash
git add lib/j-quants-stack.ts test/j-quants.test.ts
git commit -m "Add an Object Lock S3 bucket for freezing gyakuhibu forecast validation snapshots"
```

- [ ] **Step 6: デプロイして手動確認(締切: 2026-09-25 12:00 JST)**

```bash
APP_PASSWORD=xxxxx npx cdk deploy JQuantsStack --require-approval
```

デプロイ後、`GyakuhibuValidationBucketName`の出力値を使って、テストオブジェクトの上書き・削除が拒否されることを手動確認する:

```bash
BUCKET=<GyakuhibuValidationBucketNameの値>
echo "test" > /tmp/lock-test.txt
aws s3 cp /tmp/lock-test.txt s3://$BUCKET/lock-test.txt
aws s3 cp /tmp/lock-test.txt s3://$BUCKET/lock-test.txt  # 上書き試行(バージョニングありなので新バージョンとしては成功するはずだが、旧バージョンの削除は拒否されることを次のコマンドで確認)
aws s3api list-object-versions --bucket $BUCKET --prefix lock-test.txt --query "Versions[0].VersionId" --output text
# 上記で取得したVersionIdを使って削除を試み、AccessDeniedになることを確認する
aws s3api delete-object --bucket $BUCKET --key lock-test.txt --version-id <取得したVersionId>
```

最後のコマンドが`AccessDenied`(Object Lockによる拒否)になることを確認したら、`aws s3 rm s3://$BUCKET/lock-test.txt`相当のクリーンアップは**行わない**(テストオブジェクト自体もロックされ削除できないのが正しい状態のため、そのまま放置してよい)。

---

### Task 2: スナップショットLambda `ForecastSnapshotFunction`

**Files:**
- Create: `lambda/gyakuhibu-forecast-validation/index.ts`(ハンドラ本体)
- Create: `lambda/gyakuhibu-forecast-validation/target-tickers.ts`(対象銘柄303件の決定)
- Create: `lambda/gyakuhibu-forecast-validation/snapshot-input.ts`(銘柄1件分の入力データ取得: taisyaku.jp・株価・優待マスタ)
- Test: `test/gyakuhibu-forecast-validation.test.ts`

**Interfaces:**
- Consumes: Task 1の`this.gyakuhibuValidationBucket`、既存の`lambda/gyakuhibu-history-batch/taisyaku-client.ts`(`fetchTaisyakuCsv`・`parseTaisyakuCsv`、変更しない)、既存の`lambda/shared/gyakuhibu-forecast.ts`(`toSample`・`buildPool`・`chooseScenario`・`forecast`・`excessRatio`、変更しない)
- Produces(Task 3が呼ぶ): `handler(event: { rightsDate: string; asofLabel: string; runId: string; prefix?: string; variant: 'final' | 'prelim'; asofDate: string }): Promise<void>`。`asofDate`はtaisyaku.jpから取得する対象の「申込日」(例: `final`なら`2026-09-24`、`prelim`なら`2026-09-25`)。

**この計画で規定しきれない設計判断がいくつかある。実装者は以下の方針で進め、実装後にレポートへ「何を独自判断したか」を明記すること(この計画の他タスクと違い、ここは厳密な逐語実装ではなく契約の実装)。**

- [ ] **Step 1: 対象銘柄の決定ロジックを実装する**

`lambda/gyakuhibu-forecast-validation/target-tickers.ts`:

```ts
export interface TargetTicker {
  ticker: string;
  companyName: string;
  value: number | null;
  unitShares: number;
  maxGyakuhibu: number | null;
  rightsMonths: number[];
}

export async function resolveTargetTickers(rightsMonth: number): Promise<TargetTicker[]>
```

実装方針:
1. `JQuantsYutaiMaster`を全件スキャンし、`rightsMonths`に`rightsMonth`(=9)を含む行を集める。
2. J-Quants API `${API_BASE_URL}/equities/master`(日付指定なしまたは当日日付)を1回呼び出し、`MrgnNm === '貸借'`の銘柄コード(4桁、`Code`の先頭4桁)の集合を作る。
3. 1と2の積集合を対象銘柄とする。
4. J-Quants APIキーの取得は`lambda/shared/jquants-batch-client.ts`の`getApiKey`をそのまま使う(新規実装しない)。

このロジックはTask 0の事前確認(`docs/superpowers/notes/2026-09-25-validation-preflight.md`)で303件になることを実地確認済み。テストでは実際の303という数字ではなく、モックデータでロジックの積集合計算が正しいことを検証すればよい。

- [ ] **Step 2: 銘柄1件分の入力取得ロジックを実装する**

`lambda/gyakuhibu-forecast-validation/snapshot-input.ts`:

```ts
export interface TickerSnapshotInput {
  ticker: string;
  variant: 'final' | 'prelim';
  dataStatus: 'final' | 'prelim' | 'no_row' | 'fetch_error';
  financingBalance: number | null;
  lendingBalance: number | null;
  fetchStatus: 'ok' | 'fetch_error';
}

export async function fetchTickerSnapshotInput(
  ticker: string,
  asofDate: string, // "2026-09-24" 形式
): Promise<TickerSnapshotInput>
```

実装方針:
1. `fetchTaisyakuCsv(ticker, <asofDateの30日前>, asofDate)`(既存関数、変更しない)を呼ぶ。日付フォーマットは`fetchTaisyakuCsv`の期待する`"YYYY/MM/DD"`形式に変換すること(`gyakuhibu-history-batch/index.ts`の既存の日付変換ロジックを参考にする)。
2. 例外が飛んだら`fetchStatus: "fetch_error"`、`dataStatus: "fetch_error"`として返す(**古いデータへのフォールバックをしない**)。
3. 成功したら`parseTaisyakuCsv(csv, asofDate, unitShares, ticker)`(既存関数、変更しない)を呼ぶ。戻り値が`undefined`なら`dataStatus: "no_row"`。
4. 戻り値がある場合、`financingBalance`/`lendingBalance`はそのまま採用。`occurred`(実績が確定しているか)を見て`dataStatus`を`final`か`prelim`かに振り分けるロジックは、**この時点では単純に呼び出し元が渡した`variant`引数をそのまま`dataStatus`として使ってよい**(速報/確報の判定を自動で行う手段が無いことがTask 0で判明しているため。9/25リハーサルで`variant: 'prelim'`が常に`no_row`になることを実地確認した上で、必要ならこの関数を後日修正する)。

- [ ] **Step 3: ハンドラ本体を実装する**

`lambda/gyakuhibu-forecast-validation/index.ts`:

```ts
export const handler = async (event: {
  rightsDate: string;
  asofLabel: string;
  runId: string;
  prefix?: string;
  variant: 'final' | 'prelim';
  asofDate: string;
}): Promise<void>
```

実装方針:
1. `resolveTargetTickers(9)`で対象銘柄を確定する。
2. 銘柄ごとに`fetchTickerSnapshotInput`を呼び、`excessRatio(financingBalance, lendingBalance)`(既存の純粋関数)で超過率を求める。
3. 予測に必要な`tickerSamples`・`poolSamples`は、`JQuantsGyakuhibuActual`と`JQuantsYutaiMaster`を全件スキャンし、`toSample`(既存の純粋関数、`lambda/shared/gyakuhibu-forecast.ts`)で`ForecastSample[]`に変換して作る。**この部分のスキャン・変換ロジックは`lambda/gyakuhibu-forecast-batch/index.ts`の`scanYutaiMaster`/`scanGyakuhibuActual`/`groupByTicker`と同等の処理になるが、本番バッチのファイルは一切変更しないこと。このLambda専用に同等のロジックを独自に実装してよい(重複コードになるが、本番パイプラインへの影響を避けるためあえて共有しない)。**
4. `chooseScenario(tickerSamples, nextRightsMonth=9, null)`(既存関数、`current-tse`フォールバックは使わない — 2026-09-09の設計変更に合わせる)と`forecast({...})`(既存関数)を呼び、`fillRatioP50`/`fillRatioP90`/`costP50`/`costP90`等を算出する。`status`判定は既存の`forecastStatus`関数を使う。
5. `requiredShares`は`unitShares`をそのまま使う(優待の必要株数とunitSharesが食い違う既知のケースがあるが、この検証では単純化してunitSharesで統一してよい。レポートに前提として明記する)。
6. 設計書のJSON形式(`forecast.json`の1レコード)に従ってS3へ書き込む。S3キーは`{prefix ?? ''}forecast-snapshots/rightsDate={rightsDate}/asof={asofLabel}/run={runId}/`配下。
7. `inputs/`配下に生CSVをそのまま保存する(銘柄ごとに1ファイル、ファイル名は`{ticker}.csv`)。
8. 全銘柄処理後、`manifest.json`を最後に書き込む(`startedAt`, `completedAt`, `gitCommit`(環境変数`GIT_COMMIT`があれば使う、無ければ`"unknown"`), モデルパラメータ(`SHRINKAGE_K`定数の値、`BIN_EDGES`の境界値 — いずれも`lambda/shared/gyakuhibu-forecast.ts`からimportする)、`primaryVariant: "final"`, 銘柄数の内訳、各ファイルのsha256(Node標準の`crypto.createHash('sha256')`))。

- [ ] **Step 4: テストを書く**

`test/gyakuhibu-forecast-validation.test.ts`(taisyaku-client・DynamoDB・S3・J-Quants APIはモック):

- `resolveTargetTickers`: yutai masterとequities/masterの積集合が正しく計算されること
- `fetchTickerSnapshotInput`: 取得失敗時に`fetch_error`になり、フォールバックしないこと
- ハンドラ: manifest.jsonが最後に書かれること、sha256が計算されること、`fetchStatus`の内訳がmanifestに正しく反映されること

Run: `npx jest test/gyakuhibu-forecast-validation.test.ts`
Expected: PASS

- [ ] **Step 5: CDKに追加する**

`lib/j-quants-stack.ts`のTask 1で追加した`// 検証用Lambda...`コメントの位置に、実際のLambda定義を追加する:

```ts
    const gyakuhibuForecastSnapshotFn = new nodejs.NodejsFunction(this, 'ForecastSnapshotFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'gyakuhibu-forecast-validation', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(14),
      memorySize: 512,
      bundling: { externalModules: ['@aws-sdk/*'] },
      environment: {
        YUTAI_MASTER_TABLE_NAME: this.yutaiMasterTable.tableName,
        GYAKUHIBU_ACTUAL_TABLE_NAME: this.gyakuhibuActualTable.tableName,
        STOCK_PRICES_TABLE_NAME: this.stockPricesTable.tableName,
        VALIDATION_BUCKET_NAME: this.gyakuhibuValidationBucket.bucketName,
        SECRET_ARN: this.apiKeySecret.secretArn,
      },
    });

    this.yutaiMasterTable.grantReadData(gyakuhibuForecastSnapshotFn);
    this.gyakuhibuActualTable.grantReadData(gyakuhibuForecastSnapshotFn);
    this.stockPricesTable.grantReadData(gyakuhibuForecastSnapshotFn);
    this.apiKeySecret.grantRead(gyakuhibuForecastSnapshotFn);
    this.gyakuhibuValidationBucket.grantPut(gyakuhibuForecastSnapshotFn);
    this.gyakuhibuValidationBucket.grantRead(gyakuhibuForecastSnapshotFn);
```

CDKテスト(`test/j-quants.test.ts`)に、このLambdaが存在し上記のgrantを持つことを検証するテストを1つ追加する(既存の他Lambdaのテストパターンに倣う)。

- [ ] **Step 6: テストを実行して確認、コミット**

Run: `npx jest test/gyakuhibu-forecast-validation.test.ts test/j-quants.test.ts && npx tsc --noEmit`

```bash
git add lambda/gyakuhibu-forecast-validation/ test/gyakuhibu-forecast-validation.test.ts lib/j-quants-stack.ts test/j-quants.test.ts
git commit -m "Add the gyakuhibu forecast validation snapshot Lambda"
```

---

### Task 3: EventBridge Schedulerでの1回限りスケジュール

**Files:**
- Modify: `lib/j-quants-stack.ts`

**Interfaces:**
- Consumes: Task 2の`gyakuhibuForecastSnapshotFn`

- [ ] **Step 1: 実装する**

`lib/j-quants-stack.ts`の先頭付近に追加:

```ts
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as scheduler_targets from 'aws-cdk-lib/aws-scheduler-targets';
```

Task 2で追加した`gyakuhibuForecastSnapshotFn`の定義の直後に追加する:

```ts
    // スナップショットA(本命判断ポイント、9/25 20:00 JST)。1回限りの実行。
    new scheduler.Schedule(this, 'ForecastSnapshotAScheduler', {
      schedule: scheduler.ScheduleExpression.at(
        new Date('2026-09-25T20:00:00+09:00'),
        cdk.TimeZone.ASIA_TOKYO,
      ),
      target: new scheduler_targets.LambdaInvoke(gyakuhibuForecastSnapshotFn, {
        input: scheduler.ScheduleTargetInput.fromObject({
          rightsDate: '2026-09-28',
          asofLabel: '2026-09-25T2000JST',
          runId: 'run=1',
          variant: 'final',
          asofDate: '2026-09-24',
        }),
      }),
    });

    // スナップショットB(参考、9/28 15:00 JST)。1回限りの実行。
    new scheduler.Schedule(this, 'ForecastSnapshotBScheduler', {
      schedule: scheduler.ScheduleExpression.at(
        new Date('2026-09-28T15:00:00+09:00'),
        cdk.TimeZone.ASIA_TOKYO,
      ),
      target: new scheduler_targets.LambdaInvoke(gyakuhibuForecastSnapshotFn, {
        input: scheduler.ScheduleTargetInput.fromObject({
          rightsDate: '2026-09-28',
          asofLabel: '2026-09-28T1500JST',
          runId: 'run=1',
          variant: 'prelim',
          asofDate: '2026-09-25',
        }),
      }),
    });
```

**注意:** `scheduler.ScheduleExpression.at`の第2引数(タイムゾーン)の型・要否は、実装前に`node_modules/aws-cdk-lib/aws-scheduler`の型定義を確認すること(CDKバージョン2.263.0で確認済みにこのモジュールは存在するが、正確なAPIシグネチャは未検証)。コンパイルが通らない場合は、Dateオブジェクト自体をUTCで組み立てる(`new Date('2026-09-25T11:00:00Z')`、JST 20:00 = UTC 11:00)方式に切り替え、タイムゾーン引数を省略する。

Task 3にはユニットテストは書かない(1回限りのCDK構成であり、CDK synthテストで存在確認できれば十分)。`test/j-quants.test.ts`に、この2つの`AWS::Scheduler::Schedule`リソースが正しい`ScheduleExpression`(`at(2026-09-25T20:00:00)`形式の文字列を含むこと)で存在することを確認するテストを1つ追加する。

- [ ] **Step 2: テストを実行して確認、コミット**

Run: `npx jest test/j-quants.test.ts && npx tsc --noEmit`

```bash
git add lib/j-quants-stack.ts test/j-quants.test.ts
git commit -m "Schedule the two forecast validation snapshots via EventBridge Scheduler"
```

- [ ] **Step 3: デプロイ(締切: 2026-09-25 20:00 JSTより前)**

```bash
APP_PASSWORD=xxxxx npx cdk deploy JQuantsStack --require-approval
```

デプロイ後、`aws scheduler get-schedule`でスケジュール時刻が意図通り(JST 20:00 / JST 15:00に対応するUTC時刻)になっていることを確認する。

- [ ] **Step 4: リハーサル実行(9/25日中、手動invoke)**

```bash
aws lambda invoke --function-name <ForecastSnapshotFunctionの実際の名前> \
  --payload '{"rightsDate":"2026-09-28","asofLabel":"rehearsal","runId":"run=1","prefix":"rehearsal/","variant":"final","asofDate":"2026-09-24"}' \
  --cli-binary-format raw-in-base64-out \
  /tmp/rehearsal-result.json
```

結果を確認し、`prelim`バリアント(`asofDate`を今日の日付にして再実行)で実際に`dataStatus: "no_row"`ばかりになるかを確認する。もし全銘柄が`no_row`なら、Task 0の懸念が確定したことになるので、その旨をユーザーに報告し、スナップショットBの`prelim`優先ロジック(設計書「9/25確報が15:00時点で出ていれば、無ければ速報」)は「常に確報待ち」に単純化してよいか確認する。
