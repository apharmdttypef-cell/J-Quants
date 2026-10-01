import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as stepfunctions_tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpLambdaAuthorizer, HttpLambdaResponseType } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import { Construct } from 'constructs';

export class JQuantsStack extends cdk.Stack {
  public readonly stockPricesTable: dynamodb.Table;
  public readonly financialSummaryTable: dynamodb.Table;
  public readonly yutaiMasterTable: dynamodb.Table;
  public readonly marginBalanceTable: dynamodb.Table;
  public readonly gyakuhibuActualTable: dynamodb.Table;
  public readonly gyakuhibuForecastTable: dynamodb.Table;
  public readonly yutaiTdnetEventTable: dynamodb.Table;
  public readonly apiKeySecret: secretsmanager.Secret;
  public readonly api: apigwv2.HttpApi;
  public readonly frontendBucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // スタンダードプラン依存機能(東証信用残の取得・現在需給ベース予測・信用残トレンド)の
    // 有効/無効。ライトプランへ落とす際は `cdk deploy -c tseMarginFeatures=false` の1回で、
    // 信用残バッチのスケジュール削除・APIのnull応答・画面非表示までまとめて切り替わる
    // (docs/superpowers/specs/2026-09-09-tse-margin-forecast-design.md)。CLIの-cは文字列で渡る。
    const tseMarginFeaturesContext = this.node.tryGetContext('tseMarginFeatures');
    const tseMarginFeatures = tseMarginFeaturesContext !== false && tseMarginFeaturesContext !== 'false';

    // J-Quants Freeプランは過去2年分を12週間遅延で配信する(直近12週間分は取得不可)。
    // 蓄積データはスタック destroy 時も残す(RETAIN + PITR)。
    this.stockPricesTable = new dynamodb.Table(this, 'JQuantsStockPricesTable', {
      tableName: 'JQuantsStockPrices',
      partitionKey: { name: 'ticker', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'date', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // 開示は四半期ごとで頻度は低いが、価格データと同じ理由(Freeプランは
    // 直近12週間分は取得できない)でRETAIN + PITRにする。
    this.financialSummaryTable = new dynamodb.Table(this, 'JQuantsFinancialSummaryTable', {
      tableName: 'JQuantsFinancialSummary',
      partitionKey: { name: 'ticker', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'discDate', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // 優待マスタ本体(権利日以外)。書き込みはアプリ外(別途スクリプト等でDynamoDB
    // へ直接投入)で行う前提。アプリのUIからは読み取り専用。
    this.yutaiMasterTable = new dynamodb.Table(this, 'JQuantsYutaiMasterTable', {
      tableName: 'JQuantsYutaiMaster',
      partitionKey: { name: 'ticker', type: dynamodb.AttributeType.STRING },
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

    // 逆日歩予測(gyakuhibu-forecast-batch)の日次事前計算結果。銘柄行 + 全銘柄横断の
    // プール曲線行(ticker='_POOL_')。毎日全件再計算される派生データでRETAIN必須ではないが、
    // 他テーブルと運用を揃える。
    this.gyakuhibuForecastTable = new dynamodb.Table(this, 'JQuantsGyakuhibuForecastTable', {
      tableName: 'JQuantsGyakuhibuForecast',
      partitionKey: { name: 'ticker', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

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

    // APIキーの値自体はCDKに含めず、deploy後に
    // `aws secretsmanager put-secret-value` で投入する想定。
    this.apiKeySecret = new secretsmanager.Secret(this, 'JQuantsApiKeySecret', {
      secretName: 'JQuantsApiKey',
      description: 'J-Quants API key (V2)',
    });

    // フロント/APIを未認証で公開しないための共有パスワード。CDKデプロイ時に
    // 環境変数で必須入力させ、Secrets Managerとフロント配信の両方に同じ値を反映する。
    const appPassword = process.env.APP_PASSWORD;
    if (!appPassword) {
      throw new Error(
        'APP_PASSWORD environment variable is required (protects the frontend/API from being publicly open). ' +
          'Example: APP_PASSWORD=xxxxx npx cdk deploy',
      );
    }

    const appPasswordSecret = new secretsmanager.Secret(this, 'JQuantsAppPasswordSecret', {
      secretName: 'JQuantsAppPassword',
      description: 'Shared password protecting the frontend/API (checked by the Lambda authorizer)',
      secretStringValue: cdk.SecretValue.unsafePlainText(appPassword),
    });

    const authorizerFn = new nodejs.NodejsFunction(this, 'AuthorizerFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'authorizer', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(5),
      memorySize: 128,
      bundling: { externalModules: ['@aws-sdk/*'] },
      environment: { SECRET_ARN: appPasswordSecret.secretArn },
    });
    appPasswordSecret.grantRead(authorizerFn);

    const apiAuthorizer = new HttpLambdaAuthorizer('ApiAuthorizer', authorizerFn, {
      responseTypes: [HttpLambdaResponseType.SIMPLE],
      identitySource: ['$request.header.x-app-password'],
      resultsCacheTtl: cdk.Duration.minutes(5),
    });

    const priceBatchFn = new nodejs.NodejsFunction(this, 'PriceBatchFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'price-batch', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      // 日付ごとに東証全銘柄分を1リクエストで取得する方式(LOOKBACK_DAYS+1回)に切り替え済み。
      // 13秒間隔(5req/分制限)は日付単位のリクエストにのみかかるため、対象銘柄数が増えても
      // API呼び出し回数は変わらない。ただし対象銘柄が増えるとDynamoDBへのupsert件数が
      // 増えるため、その分の余裕は引き続き必要。
      timeout: cdk.Duration.minutes(14),
      memorySize: 256,
      // AWS SDK v3はNode.js 20系ランタイムに同梱されているためバンドルしない
      bundling: { externalModules: ['@aws-sdk/*'] },
      environment: {
        TABLE_NAME: this.stockPricesTable.tableName,
        YUTAI_MASTER_TABLE_NAME: this.yutaiMasterTable.tableName,
        SECRET_ARN: this.apiKeySecret.secretArn,
      },
    });

    this.stockPricesTable.grantWriteData(priceBatchFn);
    this.yutaiMasterTable.grantReadData(priceBatchFn);
    this.apiKeySecret.grantRead(priceBatchFn);

    // 株価四本値は当日16:30頃に配信される(https://jpx-jquants.com/ja/spec/data-update)。
    // Standardプラン移行によりFreeプランの12週間遅延制約は解消済みのため、それ以降の時刻に
    // 実行する必要がある。JST 18:00 = UTC 09:00 に毎日実行(16:30より十分後)。
    new events.Rule(this, 'PriceBatchSchedule', {
      schedule: events.Schedule.cron({ minute: '0', hour: '9' }),
      targets: [new targets.LambdaFunction(priceBatchFn)],
    });

    const financialSummaryBatchFn = new nodejs.NodejsFunction(this, 'FinancialSummaryBatchFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'financial-summary-batch', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      // 新規銘柄の初回バックフィル(銘柄ごと直列)+直近日付の一括チェックの合計時間を
      // 見込んで長めに確保(lambda/financial-summary-batch/index.tsのMAX_BACKFILL_TICKERS_PER_RUN
      // 参照)。
      timeout: cdk.Duration.minutes(14),
      memorySize: 256,
      bundling: { externalModules: ['@aws-sdk/*'] },
      environment: {
        FINANCIAL_TABLE_NAME: this.financialSummaryTable.tableName,
        YUTAI_MASTER_TABLE_NAME: this.yutaiMasterTable.tableName,
        SECRET_ARN: this.apiKeySecret.secretArn,
      },
    });

    this.financialSummaryTable.grantWriteData(financialSummaryBatchFn);
    this.financialSummaryTable.grantReadData(financialSummaryBatchFn);
    this.yutaiMasterTable.grantReadData(financialSummaryBatchFn);
    this.apiKeySecret.grantRead(financialSummaryBatchFn);

    // 決算サマリは四半期ごとしか更新されないため週次で十分。
    // JST 月曜20:00 = UTC 月曜11:00。
    new events.Rule(this, 'FinancialSummaryBatchSchedule', {
      schedule: events.Schedule.cron({ minute: '0', hour: '11', weekDay: 'MON' }),
      targets: [new targets.LambdaFunction(financialSummaryBatchFn)],
    });

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
        SECRET_ARN: this.apiKeySecret.secretArn,
      },
    });

    this.yutaiMasterTable.grantReadData(marginBalanceBatchFn);
    this.marginBalanceTable.grantReadWriteData(marginBalanceBatchFn);
    this.apiKeySecret.grantRead(marginBalanceBatchFn);

    // 信用残はJ-Quants側で毎営業日16:30頃に更新される(margin-alertは以前から日次、
    // margin-interestは2026-09-28から日次)。JST平日17:30 = UTC 08:30。
    // スタンダードプラン依存のため、tseMarginFeaturesが無効ならスケジュール自体を作らない
    // (Lambdaは残すので手動実行は可能)。
    if (tseMarginFeatures) {
      new events.Rule(this, 'MarginBalanceBatchSchedule', {
        schedule: events.Schedule.cron({ minute: '30', hour: '8', weekDay: 'MON-FRI' }),
        targets: [new targets.LambdaFunction(marginBalanceBatchFn)],
      });
    }

    const gyakuhibuHistoryBatchFn = new nodejs.NodejsFunction(this, 'GyakuhibuHistoryBatchFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'gyakuhibu-history-batch', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(14),
      memorySize: 256,
      bundling: { externalModules: ['@aws-sdk/*'] },
      environment: {
        YUTAI_MASTER_TABLE_NAME: this.yutaiMasterTable.tableName,
        GYAKUHIBU_ACTUAL_TABLE_NAME: this.gyakuhibuActualTable.tableName,
      },
    });

    this.yutaiMasterTable.grantReadData(gyakuhibuHistoryBatchFn);
    this.gyakuhibuActualTable.grantReadWriteData(gyakuhibuHistoryBatchFn);

    new events.Rule(this, 'GyakuhibuHistoryBatchSchedule', {
      schedule: events.Schedule.cron({ minute: '0', hour: '10' }),
      targets: [new targets.LambdaFunction(gyakuhibuHistoryBatchFn)],
    });

    const yutaiMasterSyncBatchFn = new nodejs.NodejsFunction(this, 'YutaiMasterSyncBatchFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'yutai-master-sync-batch', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      // kabuyutai.comの月別一覧ページ(12ヶ月×数ページ)を礼儀正しい間隔で走査するため長め。
      // EventBridgeスケジュールは持たず、初回構築時・取りこぼし確認時に手動invokeする運用。
      timeout: cdk.Duration.minutes(14),
      memorySize: 256,
      bundling: { externalModules: ['@aws-sdk/*'] },
      environment: {
        YUTAI_MASTER_TABLE_NAME: this.yutaiMasterTable.tableName,
      },
    });

    this.yutaiMasterTable.grantWriteData(yutaiMasterSyncBatchFn);

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

    // TDnetの直近開示から株主優待関連の新設・変更・廃止を検知する。既存の週次バッチ
    // (FinancialSummaryBatchSchedule: 月11:00 UTC、MarginBalanceBatchSchedule: 月9:30 UTC)
    // と重ならない時間帯。JST 月曜21:00 = UTC 月曜12:00。
    new events.Rule(this, 'YutaiTdnetWatchBatchSchedule', {
      schedule: events.Schedule.cron({ minute: '0', hour: '12', weekDay: 'MON' }),
      targets: [new targets.LambdaFunction(yutaiTdnetWatchBatchFn)],
    });

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
        GYAKUHIBU_ACTUAL_TABLE_NAME: this.gyakuhibuActualTable.tableName,
      },
    });

    this.yutaiMasterTable.grantReadWriteData(yutaiRiskPrecomputeBatchFn);
    this.marginBalanceTable.grantReadData(yutaiRiskPrecomputeBatchFn);
    this.stockPricesTable.grantReadData(yutaiRiskPrecomputeBatchFn);
    this.gyakuhibuActualTable.grantReadData(yutaiRiskPrecomputeBatchFn);

    // GET /yutai一覧のリスク判定を事前計算し、reference-apiでの逐次クエリ(銘柄数に比例して
    // 増える)を無くす。PriceBatchFunction(daily 09:00 UTC)の後に実行する。JST 18:20 = UTC 09:20。
    new events.Rule(this, 'YutaiRiskPrecomputeBatchSchedule', {
      schedule: events.Schedule.cron({ minute: '20', hour: '9' }),
      targets: [new targets.LambdaFunction(yutaiRiskPrecomputeBatchFn)],
    });

    const yutaiDetailSyncBatchFn = new nodejs.NodejsFunction(this, 'YutaiDetailSyncBatchFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'yutai-detail-sync-batch', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      // 1銘柄1リクエスト/秒。最大バケット(3000台・274件)で約5.5分なので14分で足りる。
      timeout: cdk.Duration.minutes(14),
      memorySize: 256,
      bundling: { externalModules: ['@aws-sdk/*'] },
      environment: {
        YUTAI_MASTER_TABLE_NAME: this.yutaiMasterTable.tableName,
      },
    });

    this.yutaiMasterTable.grantReadWriteData(yutaiDetailSyncBatchFn);

    // 1,642銘柄を1リクエスト/秒で直列処理すると約33分かかり、Lambdaの15分制限を
    // 超える。銘柄コード先頭1桁で9バケットに分けて1つずつ回す。
    //
    // maxConcurrencyは必ず1。並列にするとkabuyutai.comへ秒9リクエストを送ることに
    // なり、各Lambda内の1リクエスト/秒ガードが無意味になる。Mapは15分制限の回避の
    // ためだけに使っており、速くするためではない。
    const detailSyncBucket = new stepfunctions_tasks.LambdaInvoke(this, 'YutaiDetailSyncBucket', {
      lambdaFunction: yutaiDetailSyncBatchFn,
      payload: stepfunctions.TaskInput.fromJsonPathAt('$'),
      // バケットの戻り値を次の状態に渡さない(Step Functionsのペイロード上限に
      // 無駄にカウントされないようにする)。
      resultPath: stepfunctions.JsonPath.DISCARD,
    });

    detailSyncBucket.addRetry({
      errors: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'States.Timeout'],
      maxAttempts: 3,
      interval: cdk.Duration.seconds(30),
      backoffRate: 2,
    });

    const detailSyncMap = new stepfunctions.Map(this, 'YutaiDetailSyncBuckets', {
      // 1000台〜9000台。再実行はconditionCheckedAtにより冪等で、成功済みの銘柄は
      // 取り直されない。
      items: stepfunctions.ProvideItems.jsonArray(
        ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((codePrefix) => ({ codePrefix })),
      ),
      maxConcurrency: 1,
    });
    detailSyncMap.itemProcessor(detailSyncBucket);

    new stepfunctions.StateMachine(this, 'YutaiDetailSyncStateMachine', {
      stateMachineName: 'JQuantsYutaiDetailSync',
      definitionBody: stepfunctions.DefinitionBody.fromChainable(detailSyncMap),
      // 9バケット直列で約33分。リトライ込みでも余裕を持たせる。
      timeout: cdk.Duration.hours(2),
    });

    const gyakuhibuForecastBatchFn = new nodejs.NodejsFunction(this, 'GyakuhibuForecastBatchFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'gyakuhibu-forecast-batch', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(14),
      memorySize: 1024,
      bundling: { externalModules: ['@aws-sdk/*'] },
      environment: {
        YUTAI_MASTER_TABLE_NAME: this.yutaiMasterTable.tableName,
        GYAKUHIBU_ACTUAL_TABLE_NAME: this.gyakuhibuActualTable.tableName,
        MARGIN_BALANCE_TABLE_NAME: this.marginBalanceTable.tableName,
        GYAKUHIBU_FORECAST_TABLE_NAME: this.gyakuhibuForecastTable.tableName,
        TSE_MARGIN_FEATURES_ENABLED: String(tseMarginFeatures),
      },
    });

    this.yutaiMasterTable.grantReadData(gyakuhibuForecastBatchFn);
    this.gyakuhibuActualTable.grantReadData(gyakuhibuForecastBatchFn);
    this.marginBalanceTable.grantReadData(gyakuhibuForecastBatchFn);
    this.gyakuhibuForecastTable.grantWriteData(gyakuhibuForecastBatchFn);

    // 逆日歩実績(GyakuhibuHistoryBatchSchedule: 毎日10:00 UTC)と信用残(MarginBalanceBatchSchedule:
    // 平日08:30 UTC)の後に実行する。JST 19:40 = UTC 10:40。
    new events.Rule(this, 'GyakuhibuForecastBatchSchedule', {
      schedule: events.Schedule.cron({ minute: '40', hour: '10' }),
      targets: [new targets.LambdaFunction(gyakuhibuForecastBatchFn)],
    });

    const referenceApiFn = new nodejs.NodejsFunction(this, 'ReferenceApiFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'reference-api', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      bundling: { externalModules: ['@aws-sdk/*'] },
      environment: {
        TABLE_NAME: this.stockPricesTable.tableName,
        FINANCIAL_TABLE_NAME: this.financialSummaryTable.tableName,
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
    this.yutaiMasterTable.grantReadData(referenceApiFn);
    this.marginBalanceTable.grantReadData(referenceApiFn);
    this.gyakuhibuActualTable.grantReadData(referenceApiFn);
    this.gyakuhibuForecastTable.grantReadData(referenceApiFn);
    this.yutaiTdnetEventTable.grantReadData(referenceApiFn);

    const referenceApiIntegration = new HttpLambdaIntegration('ReferenceApiIntegration', referenceApiFn);

    // ビルド成果物を置くだけの静的ホスティング用バケット。セーブデータ等の
    // 永続資産ではないため、他テーブルと違いdestroy時に消えて構わない。
    this.frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
    });

    // フロントも同じ共有パスワードでBasic認証をかける(CloudFront FunctionはSecrets
    // Managerを実行時に参照できないため、synth時にAPP_PASSWORDを埋め込む)。
    const basicAuthValue = Buffer.from(`jquants:${appPassword}`).toString('base64');
    const basicAuthFn = new cloudfront.Function(this, 'BasicAuthFunction', {
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var expected = "Basic ${basicAuthValue}";
  var provided = request.headers.authorization && request.headers.authorization.value;

  if (provided !== expected) {
    return {
      statusCode: 401,
      statusDescription: "Unauthorized",
      headers: { "www-authenticate": { value: 'Basic realm="J-Quants"' } },
    };
  }

  return request;
}
      `),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    });

    this.distribution = new cloudfront.Distribution(this, 'FrontendDistribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.frontendBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations: [{ function: basicAuthFn, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      // SPA(React Router)のクライアントサイドルーティングのため、
      // 存在しないパスもindex.htmlにフォールバックさせる。
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
    });

    // フロント(CloudFront配信)からのブラウザアクセスのみ許可。ローカル開発用にVite既定ポートも許可する。
    this.api = new apigwv2.HttpApi(this, 'JQuantsApi', {
      apiName: 'JQuants Reference API',
      defaultAuthorizer: apiAuthorizer,
      corsPreflight: {
        allowOrigins: [`https://${this.distribution.distributionDomainName}`, 'http://localhost:5173'],
        allowMethods: [apigwv2.CorsHttpMethod.GET],
        allowHeaders: ['Content-Type', 'x-app-password'],
      },
    });

    this.api.addRoutes({
      path: '/tickers/{ticker}/prices',
      methods: [apigwv2.HttpMethod.GET],
      integration: referenceApiIntegration,
    });
    this.api.addRoutes({
      path: '/tickers/{ticker}/summary',
      methods: [apigwv2.HttpMethod.GET],
      integration: referenceApiIntegration,
    });
    this.api.addRoutes({
      path: '/yutai',
      methods: [apigwv2.HttpMethod.GET],
      integration: referenceApiIntegration,
    });
    this.api.addRoutes({
      path: '/yutai/tdnet-events',
      methods: [apigwv2.HttpMethod.GET],
      integration: referenceApiIntegration,
    });
    this.api.addRoutes({
      path: '/yutai/{ticker}',
      methods: [apigwv2.HttpMethod.GET],
      integration: referenceApiIntegration,
    });
    this.api.addRoutes({
      path: '/yutai/{ticker}/margin-trend',
      methods: [apigwv2.HttpMethod.GET],
      integration: referenceApiIntegration,
    });
    this.api.addRoutes({
      path: '/yutai/forecast',
      methods: [apigwv2.HttpMethod.GET],
      integration: referenceApiIntegration,
    });
    this.api.addRoutes({
      path: '/yutai/{ticker}/forecast',
      methods: [apigwv2.HttpMethod.GET],
      integration: referenceApiIntegration,
    });

    new cdk.CfnOutput(this, 'ApiEndpoint', { value: this.api.apiEndpoint });
    new cdk.CfnOutput(this, 'FrontendUrl', { value: `https://${this.distribution.distributionDomainName}` });
    new cdk.CfnOutput(this, 'FrontendBucketName', { value: this.frontendBucket.bucketName });
    new cdk.CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
  }
}
