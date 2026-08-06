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
import { HttpLambdaAuthorizer, HttpLambdaResponseType } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import { Construct } from 'constructs';

export class JQuantsStack extends cdk.Stack {
  public readonly stockPricesTable: dynamodb.Table;
  public readonly financialSummaryTable: dynamodb.Table;
  public readonly watchlistTable: dynamodb.Table;
  public readonly apiKeySecret: secretsmanager.Secret;
  public readonly api: apigwv2.HttpApi;
  public readonly frontendBucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

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
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.DELETE],
        allowHeaders: ['Content-Type', 'x-app-password'],
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
    new cdk.CfnOutput(this, 'FrontendUrl', { value: `https://${this.distribution.distributionDomainName}` });
    new cdk.CfnOutput(this, 'FrontendBucketName', { value: this.frontendBucket.bucketName });
    new cdk.CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
  }
}
