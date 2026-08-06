import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Construct } from 'constructs';

export class JQuantsStack extends cdk.Stack {
  public readonly stockPricesTable: dynamodb.Table;
  public readonly financialSummaryTable: dynamodb.Table;
  public readonly watchlistTable: dynamodb.Table;
  public readonly apiKeySecret: secretsmanager.Secret;
  public readonly api: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // J-Quants Freeプランは直近12週間分しか再取得できないため、
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
    // 直近12週間しか再取得できない)でRETAIN + PITRにする。
    this.financialSummaryTable = new dynamodb.Table(this, 'JQuantsFinancialSummaryTable', {
      tableName: 'JQuantsFinancialSummary',
      partitionKey: { name: 'ticker', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'discDate', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ウォッチリスト管理画面から追加/削除される、取得対象銘柄の正本。
    // 消えても銘柄コードを打ち直せば復旧できるためRETAINは必須ではないが、
    // 他テーブルと運用を揃えるため同じ方針にする。
    this.watchlistTable = new dynamodb.Table(this, 'JQuantsWatchlistTable', {
      tableName: 'JQuantsWatchlist',
      partitionKey: { name: 'ticker', type: dynamodb.AttributeType.STRING },
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
        SECRET_ARN: this.apiKeySecret.secretArn,
      },
    });

    this.stockPricesTable.grantWriteData(batchFetchFn);
    this.financialSummaryTable.grantWriteData(batchFetchFn);
    this.watchlistTable.grantReadData(batchFetchFn);
    this.apiKeySecret.grantRead(batchFetchFn);

    // J-Quants Freeプランは配信12週間遅延のため取得時刻はシビアでなくてよい。
    // JST 18:00 = UTC 09:00 に毎日実行。
    new events.Rule(this, 'BatchFetchSchedule', {
      schedule: events.Schedule.cron({ minute: '0', hour: '9' }),
      targets: [new targets.LambdaFunction(batchFetchFn)],
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
        WATCHLIST_TABLE_NAME: this.watchlistTable.tableName,
        SECRET_ARN: this.apiKeySecret.secretArn,
      },
    });

    this.stockPricesTable.grantReadData(referenceApiFn);
    this.financialSummaryTable.grantReadData(referenceApiFn);
    this.watchlistTable.grantReadWriteData(referenceApiFn);
    this.apiKeySecret.grantRead(referenceApiFn);

    const referenceApiIntegration = new HttpLambdaIntegration('ReferenceApiIntegration', referenceApiFn);

    // フロント(S3+CloudFront)からのブラウザアクセスを許可。オリジンはフロント実装時に絞り込む。
    this.api = new apigwv2.HttpApi(this, 'JQuantsApi', {
      apiName: 'JQuants Reference API',
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.DELETE],
        allowHeaders: ['Content-Type'],
      },
    });

    this.api.addRoutes({
      path: '/tickers',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: referenceApiIntegration,
    });
    this.api.addRoutes({
      path: '/tickers/{ticker}',
      methods: [apigwv2.HttpMethod.DELETE],
      integration: referenceApiIntegration,
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

    new cdk.CfnOutput(this, 'ApiEndpoint', { value: this.api.apiEndpoint });
  }
}
