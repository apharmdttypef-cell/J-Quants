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
import { WATCHLIST_TICKERS } from './watchlist-tickers';

export class JQuantsStack extends cdk.Stack {
  public readonly stockPricesTable: dynamodb.Table;
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
      // 銘柄数×13秒間隔(5req/分制限)のポーリングを直列で行うため長めに確保
      timeout: cdk.Duration.minutes(10),
      memorySize: 256,
      // AWS SDK v3はNode.js 20系ランタイムに同梱されているためバンドルしない
      bundling: { externalModules: ['@aws-sdk/*'] },
      environment: {
        TABLE_NAME: this.stockPricesTable.tableName,
        SECRET_ARN: this.apiKeySecret.secretArn,
        TICKERS: WATCHLIST_TICKERS.join(','),
      },
    });

    this.stockPricesTable.grantWriteData(batchFetchFn);
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
        TICKERS: WATCHLIST_TICKERS.join(','),
      },
    });

    this.stockPricesTable.grantReadData(referenceApiFn);

    const referenceApiIntegration = new HttpLambdaIntegration('ReferenceApiIntegration', referenceApiFn);

    // フロント(S3+CloudFront)からのブラウザアクセスを許可。オリジンはフロント実装時に絞り込む。
    this.api = new apigwv2.HttpApi(this, 'JQuantsApi', {
      apiName: 'JQuants Reference API',
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigwv2.CorsHttpMethod.GET],
      },
    });

    this.api.addRoutes({
      path: '/tickers',
      methods: [apigwv2.HttpMethod.GET],
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
