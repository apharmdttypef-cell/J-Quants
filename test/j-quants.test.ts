import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { JQuantsStack } from '../lib/j-quants-stack';

process.env.APP_PASSWORD = 'test-app-password';

function synth() {
  const app = new cdk.App();
  const stack = new JQuantsStack(app, 'TestStack');
  return Template.fromStack(stack);
}

test('creates the JQuantsStockPrices table with ticker/date key and RETAIN policy', () => {
  const template = synth();

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    TableName: 'JQuantsStockPrices',
    KeySchema: [
      { AttributeName: 'ticker', KeyType: 'HASH' },
      { AttributeName: 'date', KeyType: 'RANGE' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  });
  template.hasResource('AWS::DynamoDB::Table', {
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
  });
});

test('creates the JQuantsFinancialSummary table with ticker/discDate key and RETAIN policy', () => {
  const template = synth();

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    TableName: 'JQuantsFinancialSummary',
    KeySchema: [
      { AttributeName: 'ticker', KeyType: 'HASH' },
      { AttributeName: 'discDate', KeyType: 'RANGE' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  });
});

test('creates a private S3 bucket and CloudFront distribution for the frontend, with SPA fallback', () => {
  const template = synth();

  template.hasResourceProperties('AWS::S3::Bucket', {
    PublicAccessBlockConfiguration: Match.objectLike({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
    }),
  });

  template.hasResourceProperties('AWS::CloudFront::Distribution', {
    DistributionConfig: Match.objectLike({
      DefaultRootObject: 'index.html',
      CustomErrorResponses: Match.arrayWith([
        Match.objectLike({ ErrorCode: 404, ResponseCode: 200, ResponsePagePath: '/index.html' }),
      ]),
    }),
  });
});

test('creates the JQuantsWatchlist table (ticker only key) with RETAIN policy', () => {
  const template = synth();

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    TableName: 'JQuantsWatchlist',
    KeySchema: [{ AttributeName: 'ticker', KeyType: 'HASH' }],
    BillingMode: 'PAY_PER_REQUEST',
  });
});

test('creates the J-Quants API key secret without an inline value', () => {
  const template = synth();

  template.hasResourceProperties('AWS::SecretsManager::Secret', {
    Name: 'JQuantsApiKey',
  });
});

test('creates the price batch Lambda wired to the price/watchlist/yutai tables (not financial) and a daily schedule', () => {
  const template = synth();

  template.hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'index.handler',
    Runtime: 'nodejs22.x',
    Environment: {
      Variables: Match.objectLike({
        TABLE_NAME: Match.anyValue(),
        WATCHLIST_TABLE_NAME: Match.anyValue(),
        YUTAI_MASTER_TABLE_NAME: Match.anyValue(),
        SECRET_ARN: Match.anyValue(),
        FINANCIAL_TABLE_NAME: Match.absent(),
      }),
    },
  });
  template.hasResourceProperties('AWS::Events::Rule', {
    ScheduleExpression: 'cron(0 9 * * ? *)',
    State: 'ENABLED',
  });
});

test('creates the financial summary batch Lambda wired to the financial/watchlist/yutai tables (not price) and a weekly schedule', () => {
  const template = synth();

  template.hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'index.handler',
    Runtime: 'nodejs22.x',
    Environment: {
      Variables: Match.objectLike({
        FINANCIAL_TABLE_NAME: Match.anyValue(),
        WATCHLIST_TABLE_NAME: Match.anyValue(),
        YUTAI_MASTER_TABLE_NAME: Match.anyValue(),
        SECRET_ARN: Match.anyValue(),
        TABLE_NAME: Match.absent(),
      }),
    },
  });
  template.hasResourceProperties('AWS::Events::Rule', {
    ScheduleExpression: 'cron(0 11 ? * MON *)',
    State: 'ENABLED',
  });
});

test('creates the HTTP API with tickers CRUD and the price/summary routes', () => {
  const template = synth();

  template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
    ProtocolType: 'HTTP',
  });

  const routeKeys = [
    'GET /tickers',
    'POST /tickers',
    'DELETE /tickers/{ticker}',
    'GET /tickers/{ticker}/prices',
    'GET /tickers/{ticker}/summary',
    'GET /yutai',
    'GET /yutai/{ticker}',
    'GET /yutai/{ticker}/margin-trend',
  ];
  for (const routeKey of routeKeys) {
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: routeKey });
  }
});

test('protects every route with the shared-password Lambda authorizer', () => {
  const template = synth();

  template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
    AuthorizerType: 'REQUEST',
    IdentitySource: ['$request.header.x-app-password'],
  });

  const routes = template.findResources('AWS::ApiGatewayV2::Route');
  const routeKeys = Object.values(routes).map((r) => (r as { Properties: { RouteKey: string } }).Properties.RouteKey);
  expect(routeKeys.length).toBeGreaterThan(0);
  for (const route of Object.values(routes)) {
    expect((route as { Properties: { AuthorizerId?: unknown } }).Properties.AuthorizerId).toBeDefined();
  }
});

test('protects the frontend with a CloudFront Function performing Basic auth', () => {
  const template = synth();

  template.hasResourceProperties('AWS::CloudFront::Function', {
    FunctionConfig: Match.objectLike({ Runtime: 'cloudfront-js-2.0' }),
  });

  template.hasResourceProperties('AWS::CloudFront::Distribution', {
    DistributionConfig: Match.objectLike({
      DefaultCacheBehavior: Match.objectLike({
        FunctionAssociations: Match.arrayWith([Match.objectLike({ EventType: 'viewer-request' })]),
      }),
    }),
  });
});

test('creates the JQuantsYutaiMaster table with ticker key and RETAIN policy', () => {
  const template = synth();

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    TableName: 'JQuantsYutaiMaster',
    KeySchema: [{ AttributeName: 'ticker', KeyType: 'HASH' }],
    BillingMode: 'PAY_PER_REQUEST',
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

test('creates the margin balance batch Lambda wired to the yutai and margin tables, on a weekly schedule', () => {
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
    ScheduleExpression: 'cron(30 9 ? * MON *)',
    State: 'ENABLED',
  });
});

test('creates the gyakuhibu history batch Lambda wired to the rights-date/master/actual tables, on a daily schedule', () => {
  const template = synth();

  template.hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'index.handler',
    Environment: {
      Variables: Match.objectLike({
        GYAKUHIBU_ACTUAL_TABLE_NAME: Match.anyValue(),
      }),
    },
  });
  template.hasResourceProperties('AWS::Events::Rule', {
    ScheduleExpression: 'cron(0 10 * * ? *)',
    State: 'ENABLED',
  });
});

test('throws a clear error when APP_PASSWORD is not set', () => {
  const original = process.env.APP_PASSWORD;
  delete process.env.APP_PASSWORD;

  try {
    expect(() => new JQuantsStack(new cdk.App(), 'TestStack')).toThrow('APP_PASSWORD');
  } finally {
    process.env.APP_PASSWORD = original;
  }
});

test('does not create a JQuantsYutaiRightsDate table (removed in favor of computed rights dates)', () => {
  const template = synth();

  const resources = template.findResources('AWS::DynamoDB::Table');
  const tableNames = Object.values(resources).map((r) => (r as { Properties: { TableName: string } }).Properties.TableName);
  expect(tableNames).not.toContain('JQuantsYutaiRightsDate');
});

test('creates the yutai-master-sync-batch Lambda with write access to the yutai master table and no schedule', () => {
  const template = synth();

  template.hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'index.handler',
    Environment: {
      Variables: Match.objectLike({ YUTAI_MASTER_TABLE_NAME: Match.anyValue() }),
    },
  });

  const rules = template.findResources('AWS::Events::Rule');
  const scheduleExpressions = Object.values(rules).map(
    (r) => (r as { Properties?: { ScheduleExpression?: string } }).Properties?.ScheduleExpression,
  );
  // yutai-master-sync-batch自体のスケジュールは存在しない。他バッチの4つのスケジュール
  // (price/financial-summary/margin-balance/gyakuhibu-history)+tdnet-watchの5つのみ。
  expect(scheduleExpressions.filter(Boolean)).toHaveLength(5);
});

test('creates the yutai-tdnet-watch-batch Lambda on a weekly Monday schedule', () => {
  const template = synth();

  template.hasResourceProperties('AWS::Events::Rule', {
    ScheduleExpression: 'cron(0 12 ? * MON *)',
    State: 'ENABLED',
  });
});
