import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { JQuantsStack } from '../lib/j-quants-stack';

process.env.APP_PASSWORD = 'test-app-password';

function synth() {
  const app = new cdk.App();
  const stack = new JQuantsStack(app, 'TestStack');
  return Template.fromStack(stack);
}

// bin/j-quants.tsは通常Secrets Managerから読んだ値をappPasswordプロパティで渡す
// (デプロイ時に毎回環境変数を打たずに済むようにするため)。環境変数は初回デプロイと
// ローテーション時のフォールバック。両方の経路が同じ場所に反映されることを検証する。
test('appPassword prop takes precedence over the APP_PASSWORD env var, and both reach the secret and the CloudFront Function', () => {
  const app = new cdk.App();
  const stack = new JQuantsStack(app, 'PropPasswordStack', { appPassword: 'from-prop' });
  const template = Template.fromStack(stack);

  // Secrets Manager側
  template.hasResourceProperties('AWS::SecretsManager::Secret', {
    Name: 'JQuantsAppPassword',
    SecretString: 'from-prop',
  });

  // CloudFront Function側(Basic認証は`jquants:<password>`のbase64を埋め込む)
  const expected = Buffer.from('jquants:from-prop').toString('base64');
  const functions = template.findResources('AWS::CloudFront::Function');
  const codes = Object.values(functions).map(
    (f) => (f as { Properties: { FunctionCode: string } }).Properties.FunctionCode,
  );
  expect(codes.some((c) => c.includes(expected))).toBe(true);
  // 環境変数の値(test-app-password)が使われていないこと
  expect(codes.some((c) => c.includes(Buffer.from('jquants:test-app-password').toString('base64')))).toBe(false);
});

test('falls back to the APP_PASSWORD env var when no appPassword prop is given', () => {
  const template = synth(); // propsなし → process.env.APP_PASSWORD = 'test-app-password'

  template.hasResourceProperties('AWS::SecretsManager::Secret', {
    Name: 'JQuantsAppPassword',
    SecretString: 'test-app-password',
  });
});

test('throws when neither the appPassword prop nor the APP_PASSWORD env var is available', () => {
  const saved = process.env.APP_PASSWORD;
  delete process.env.APP_PASSWORD;
  try {
    expect(() => new JQuantsStack(new cdk.App(), 'NoPasswordStack')).toThrow(/appPassword prop or APP_PASSWORD/);
  } finally {
    process.env.APP_PASSWORD = saved;
  }
});

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

test('does not create a JQuantsWatchlist table (watchlist feature removed)', () => {
  const template = synth();

  const resources = template.findResources('AWS::DynamoDB::Table');
  const tableNames = Object.values(resources).map((r) => (r as { Properties: { TableName: string } }).Properties.TableName);
  expect(tableNames).not.toContain('JQuantsWatchlist');
});

test('creates the J-Quants API key secret without an inline value', () => {
  const template = synth();

  template.hasResourceProperties('AWS::SecretsManager::Secret', {
    Name: 'JQuantsApiKey',
  });
});

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

test('creates the margin balance batch Lambda wired to the yutai and margin tables, on a weekday daily schedule', () => {
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
    ScheduleExpression: 'cron(30 8 ? * MON-FRI *)',
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
  // (price/financial-summary/margin-balance/gyakuhibu-history)+tdnet-watch+yutai-risk-precompute
  // +gyakuhibu-forecastの7つのみ。
  expect(scheduleExpressions.filter(Boolean)).toHaveLength(7);
});

test('creates the yutai-tdnet-watch-batch Lambda on a weekly Monday schedule', () => {
  const template = synth();

  template.hasResourceProperties('AWS::Events::Rule', {
    ScheduleExpression: 'cron(0 12 ? * MON *)',
    State: 'ENABLED',
  });
});

test('creates the yutai-risk-precompute-batch Lambda with read/write access to the yutai master table and a daily schedule after price-batch', () => {
  const template = synth();

  // Verify the Lambda function exists with exact environment variables (not a superset like ReferenceApiFunction).
  // Use Match.exact() to ensure only these four env vars are present, distinguishing it from ReferenceApiFunction
  // which has many more env vars (FINANCIAL_TABLE_NAME, GYAKUHIBU_ACTUAL_TABLE_NAME, MARGIN_BALANCE_TABLE_NAME, YUTAI_TDNET_EVENT_TABLE_NAME).
  template.hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'index.handler',
    Timeout: 840, // 14 minutes in seconds
    Environment: {
      Variables: Match.exact({
        YUTAI_MASTER_TABLE_NAME: Match.anyValue(),
        MARGIN_BALANCE_TABLE_NAME: Match.anyValue(),
        TABLE_NAME: Match.anyValue(),
        GYAKUHIBU_ACTUAL_TABLE_NAME: Match.anyValue(),
      }),
    },
  });

  // Verify the EventBridge schedule rule exists with the correct timing (09:20 UTC, 20 min after price batch at 09:00 UTC).
  template.hasResourceProperties('AWS::Events::Rule', {
    ScheduleExpression: 'cron(20 9 * * ? *)',
    State: 'ENABLED',
  });

  // Verify IAM policies exist that grant DynamoDB permissions for the tables accessed by this Lambda.
  // The grantReadWriteData() and grantReadData() methods create AWS::IAM::Policy resources with the necessary permissions.
  const policies = template.findResources('AWS::IAM::Policy');
  const policyEntries = Object.entries(policies);

  // Find policies that grant read/write access to the yutai master table (PutItem, UpdateItem, etc.)
  // and read access to margin balance and stock prices tables (GetItem, Query, etc.)
  const hasYutaiWriteAccess = policyEntries.some(([name, p]) => {
    // Policy names that include "YutaiRiskPrecompute" are specifically for this Lambda
    if (!name.includes('YutaiRiskPrecompute')) return false;

    const statements = (p as { Properties?: { PolicyDocument?: { Statement?: Array<{ Action?: string[] | string; Resource?: any }> } } }).Properties?.PolicyDocument?.Statement || [];
    return statements.some((stmt) => {
      const actions = Array.isArray(stmt.Action) ? stmt.Action : stmt.Action ? [stmt.Action] : [];
      const hasWriteActions = actions.some(
        (action) => action && (action.includes('PutItem') || action.includes('UpdateItem') || action.includes('DeleteItem')),
      );
      const hasYutaiMasterResource = JSON.stringify(stmt.Resource || '').includes('YutaiMaster');
      return hasWriteActions && hasYutaiMasterResource;
    });
  });
  expect(hasYutaiWriteAccess).toBe(true);

  const hasMarginStockReadAccess = policyEntries.some(([name, p]) => {
    // Policy names that include "YutaiRiskPrecompute" are specifically for this Lambda
    if (!name.includes('YutaiRiskPrecompute')) return false;

    const statements = (p as { Properties?: { PolicyDocument?: { Statement?: Array<{ Action?: string[] | string; Resource?: any }> } } }).Properties?.PolicyDocument?.Statement || [];
    return statements.some((stmt) => {
      const actions = Array.isArray(stmt.Action) ? stmt.Action : stmt.Action ? [stmt.Action] : [];
      const hasReadActions = actions.some(
        (action) => action && (action.includes('GetItem') || action.includes('Query') || action.includes('Scan') || action.includes('BatchGetItem')),
      );
      const resourceStr = JSON.stringify(stmt.Resource || '');
      const hasMarginOrStockResource = resourceStr.includes('MarginBalance') || resourceStr.includes('StockPrices');
      return hasReadActions && hasMarginOrStockResource;
    });
  });
  expect(hasMarginStockReadAccess).toBe(true);

  // 逆日歩実績テーブルは読み取りのみ(前回逆日歩の集計用)。書き込みは付けない。
  const actualStatements = policyEntries
    .filter(([name]) => name.includes('YutaiRiskPrecompute'))
    .flatMap(([, p]) => (p as { Properties?: { PolicyDocument?: { Statement?: Array<{ Action?: string[] | string; Resource?: unknown }> } } }).Properties?.PolicyDocument?.Statement ?? [])
    .filter((stmt) => JSON.stringify(stmt.Resource ?? '').includes('GyakuhibuActual'));
  const actualActions = actualStatements.flatMap((stmt) => (Array.isArray(stmt.Action) ? stmt.Action : stmt.Action ? [stmt.Action] : []));
  expect(actualActions.some((a) => a.includes('Query'))).toBe(true);
  expect(actualActions.some((a) => a.includes('PutItem') || a.includes('UpdateItem') || a.includes('DeleteItem'))).toBe(false);
});

test('creates the JQuantsGyakuhibuForecast table (ticker only key) with RETAIN policy', () => {
  const template = synth();

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    TableName: 'JQuantsGyakuhibuForecast',
    KeySchema: [{ AttributeName: 'ticker', KeyType: 'HASH' }],
    BillingMode: 'PAY_PER_REQUEST',
  });
  template.hasResource('AWS::DynamoDB::Table', {
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
  });
});

test('creates the gyakuhibu-forecast-batch Lambda wired to master/actual/margin/forecast tables, on a daily schedule after gyakuhibu-history-batch', () => {
  const template = synth();

  template.hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'index.handler',
    Runtime: 'nodejs22.x',
    Timeout: 840, // 14 minutes in seconds
    Environment: {
      Variables: Match.exact({
        YUTAI_MASTER_TABLE_NAME: Match.anyValue(),
        GYAKUHIBU_ACTUAL_TABLE_NAME: Match.anyValue(),
        MARGIN_BALANCE_TABLE_NAME: Match.anyValue(),
        GYAKUHIBU_FORECAST_TABLE_NAME: Match.anyValue(),
        TSE_MARGIN_FEATURES_ENABLED: 'true',
      }),
    },
  });

  // GyakuhibuHistoryBatchSchedule(daily 10:00 UTC)の後、JST 19:40 = UTC 10:40。
  template.hasResourceProperties('AWS::Events::Rule', {
    ScheduleExpression: 'cron(40 10 * * ? *)',
    State: 'ENABLED',
  });

  const policies = template.findResources('AWS::IAM::Policy');
  const policyEntries = Object.entries(policies);

  const hasForecastWriteAccess = policyEntries.some(([name, p]) => {
    if (!name.includes('GyakuhibuForecastBatch')) return false;

    const statements = (p as { Properties?: { PolicyDocument?: { Statement?: Array<{ Action?: string[] | string; Resource?: any }> } } }).Properties?.PolicyDocument?.Statement || [];
    return statements.some((stmt) => {
      const actions = Array.isArray(stmt.Action) ? stmt.Action : stmt.Action ? [stmt.Action] : [];
      const hasWriteActions = actions.some(
        (action) => action && (action.includes('PutItem') || action.includes('UpdateItem') || action.includes('DeleteItem')),
      );
      const hasForecastResource = JSON.stringify(stmt.Resource || '').includes('GyakuhibuForecast');
      return hasWriteActions && hasForecastResource;
    });
  });
  expect(hasForecastWriteAccess).toBe(true);

  const hasReadAccessToInputs = policyEntries.some(([name, p]) => {
    if (!name.includes('GyakuhibuForecastBatch')) return false;

    const statements = (p as { Properties?: { PolicyDocument?: { Statement?: Array<{ Action?: string[] | string; Resource?: any }> } } }).Properties?.PolicyDocument?.Statement || [];
    return statements.some((stmt) => {
      const actions = Array.isArray(stmt.Action) ? stmt.Action : stmt.Action ? [stmt.Action] : [];
      const hasReadActions = actions.some(
        (action) => action && (action.includes('GetItem') || action.includes('Query') || action.includes('Scan') || action.includes('BatchGetItem')),
      );
      const resourceStr = JSON.stringify(stmt.Resource || '');
      const hasInputResource =
        resourceStr.includes('YutaiMaster') || resourceStr.includes('GyakuhibuActual') || resourceStr.includes('MarginBalance');
      return hasReadActions && hasInputResource;
    });
  });
  expect(hasReadAccessToInputs).toBe(true);
});

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

test('tseMarginFeatures=false drops the margin balance schedule and flips the env var to false', () => {
  const app = new cdk.App({ context: { tseMarginFeatures: false } });
  const template = Template.fromStack(new JQuantsStack(app, 'TestStack'));

  const rules = template.findResources('AWS::Events::Rule');
  const scheduleExpressions = Object.values(rules).map(
    (r) => (r as { Properties?: { ScheduleExpression?: string } }).Properties?.ScheduleExpression,
  );
  expect(scheduleExpressions).not.toContain('cron(30 8 ? * MON-FRI *)');
  expect(scheduleExpressions.filter(Boolean)).toHaveLength(6); // 既定の7つから信用残バッチ分が減る

  template.hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'index.handler',
    Environment: {
      Variables: Match.exact({
        YUTAI_MASTER_TABLE_NAME: Match.anyValue(),
        GYAKUHIBU_ACTUAL_TABLE_NAME: Match.anyValue(),
        MARGIN_BALANCE_TABLE_NAME: Match.anyValue(),
        GYAKUHIBU_FORECAST_TABLE_NAME: Match.anyValue(),
        TSE_MARGIN_FEATURES_ENABLED: 'false',
      }),
    },
  });
});

test('tseMarginFeatures passed as the string "false" (as the CLI -c flag does) is treated as disabled', () => {
  const app = new cdk.App({ context: { tseMarginFeatures: 'false' } });
  const template = Template.fromStack(new JQuantsStack(app, 'TestStack'));

  const rules = template.findResources('AWS::Events::Rule');
  const scheduleExpressions = Object.values(rules).map(
    (r) => (r as { Properties?: { ScheduleExpression?: string } }).Properties?.ScheduleExpression,
  );
  expect(scheduleExpressions.filter(Boolean)).toHaveLength(6);
});

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
  template.hasResource('AWS::DynamoDB::Table', {
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
  });
});

test('yutai-tdnet-watch-batch has read access to the yutai master table and write access to the tdnet event table', () => {
  const template = synth();

  template.hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'index.handler',
    Environment: {
      // Use Match.exact() to pin this to YutaiTdnetWatchBatchFunction specifically: ReferenceApiFunction
      // also has both of these env vars (among many more), so Match.objectLike would spuriously pass
      // even if YutaiTdnetWatchBatchFunction itself lost the env var entirely.
      Variables: Match.exact({
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
        TABLE_NAME: Match.anyValue(),
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

test('the yutai detail sync Lambda has the yutai master table and a long timeout', () => {
  const template = synth();

  // Timeout/MemorySize/Environmentは既存の兄弟Lambdaも同じ値を持つため、プロパティだけの
  // 照合では新Lambdaが無くても通ってしまう。論理IDの接頭辞(CDKがハッシュを付ける)で
  // 対象を特定してから検証する。
  const functions = template.findResources('AWS::Lambda::Function');
  const detailSync = Object.entries(functions).filter(([logicalId]) =>
    logicalId.startsWith('YutaiDetailSyncBatchFunction'),
  );
  expect(detailSync).toHaveLength(1);

  const props = detailSync[0][1].Properties;
  expect(props.Timeout).toBe(840);
  expect(props.MemorySize).toBe(256);
  expect(props.Handler).toBe('index.handler');
  expect(props.Environment.Variables.YUTAI_MASTER_TABLE_NAME.Ref).toMatch(/YutaiMasterTable/);
  // kabuyutai.comへの1リクエスト/秒はLambda内の待機だけでなく同時実行数でも担保する。
  // 2つ目の実行(運用者の重複起動や実行中の単一銘柄モード)が走ると秒2リクエストに
  // なるため、ここは必ず1。
  expect(props.ReservedConcurrentExecutions).toBe(1);
});

test('the detail sync bucket relies on the CDK default Lambda retrier only', () => {
  // LambdaInvokeはコンストラクタでLambdaのサービス例外用のリトライヤー(2秒 × 6回)を
  // 登録する。Step Functionsは最初に一致したリトライヤーだけを使うため、同じエラー名を
  // 後ろに足しても死蔵される。独自Retryを足し直さないようここで形を固定する。
  // なおLambda自体のタイムアウトはLambda.Unknownとして出て、どのリトライヤーにも
  // 一致しない(タイムアウトしたバケットは再試行されず、後続バケットも走らない)。
  const template = synth();
  const machines = template.findResources('AWS::StepFunctions::StateMachine');
  const joined = Object.values(machines)[0].Properties.DefinitionString['Fn::Join'][1]
    .map((part: unknown) => (typeof part === 'string' ? part : 'X'))
    .join('');
  // バケットのタスクはMapのItemProcessorの中にある(トップレベルのStatesにはMapだけ)。
  const map = JSON.parse(joined).States.YutaiDetailSyncBuckets;
  const bucket = map.ItemProcessor.States.YutaiDetailSyncBucket;

  expect(bucket.Retry).toEqual([
    {
      ErrorEquals: [
        'Lambda.ClientExecutionTimeoutException',
        'Lambda.ServiceException',
        'Lambda.AWSLambdaException',
        'Lambda.SdkClientException',
      ],
      IntervalSeconds: 2,
      MaxAttempts: 6,
      BackoffRate: 2,
    },
  ]);
});

test('the detail sync state machine fans out to nine code-prefix buckets one at a time', () => {
  const template = synth();

  // 並列にするとkabuyutai.comへ秒9リクエストを送ることになり、各Lambda内の
  // 1リクエスト/秒ガードが無意味になる。Mapは15分制限の回避だけが目的なので
  // MaxConcurrencyは必ず1でなければならない。
  template.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
  const machines = template.findResources('AWS::StepFunctions::StateMachine');
  // DefinitionStringはFn::Joinになり、JSON.stringifyすると二重にエスケープされる
  // (実測: {\\\"codePrefix\\\":\\\"1\\\"})。エスケープ形に依存しないよう、Joinの文字列片を
  // 連結してJSONとして読み戻し、中身を直接検証する(Ref/GetAttは文字列内の穴埋めなので
  // 仮の文字列に置き換えてよい)。
  const joined = Object.values(machines)[0].Properties.DefinitionString['Fn::Join'][1]
    .map((part: unknown) => (typeof part === 'string' ? part : 'X'))
    .join('');
  const definition = JSON.parse(joined);
  const map = definition.States.YutaiDetailSyncBuckets;

  expect(map.Type).toBe('Map');
  expect(map.MaxConcurrency).toBe(1);
  expect(map.Items).toEqual(
    ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((codePrefix) => ({ codePrefix })),
  );
});

test('the detail sync batch has no EventBridge schedule of its own', () => {
  // 優待条件は年1回も変わらないため手動運用。スケジュールを足すと
  // kabuyutai.comへ無意味な定期アクセスを続けることになる。
  const template = synth();
  // 関数が存在しないと「含まない」が自明に成り立つため、先に存在を確認する。
  const functionIds = Object.keys(template.findResources('AWS::Lambda::Function'));
  expect(functionIds.some((id) => id.startsWith('YutaiDetailSyncBatchFunction'))).toBe(true);
  const rules = template.findResources('AWS::Events::Rule');
  const targets = Object.values(rules).flatMap((rule) => rule.Properties.Targets ?? []);
  const targetArns = JSON.stringify(targets);
  expect(targetArns).not.toContain('YutaiDetailSyncBatchFunction');
});

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

test('creates the ForecastSnapshotFunction wired to master/actual/price tables, the api secret, and the validation bucket, with no schedule of its own', () => {
  const template = synth();

  template.hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'index.handler',
    Runtime: 'nodejs22.x',
    Timeout: 840, // 14 minutes in seconds
    MemorySize: 512,
    Environment: {
      Variables: Match.objectLike({
        YUTAI_MASTER_TABLE_NAME: Match.anyValue(),
        GYAKUHIBU_ACTUAL_TABLE_NAME: Match.anyValue(),
        STOCK_PRICES_TABLE_NAME: Match.anyValue(),
        VALIDATION_BUCKET_NAME: Match.anyValue(),
        SECRET_ARN: Match.anyValue(),
      }),
    },
  });

  const policies = template.findResources('AWS::IAM::Policy');
  const policyEntries = Object.entries(policies);

  function hasStatement(namePrefix: string, predicate: (actions: string[], resourceStr: string) => boolean): boolean {
    return policyEntries.some(([name, p]) => {
      if (!name.includes(namePrefix)) return false;
      const statements =
        (p as { Properties?: { PolicyDocument?: { Statement?: Array<{ Action?: string[] | string; Resource?: any }> } } })
          .Properties?.PolicyDocument?.Statement || [];
      return statements.some((stmt) => {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : stmt.Action ? [stmt.Action] : [];
        const resourceStr = JSON.stringify(stmt.Resource || '');
        return predicate(actions, resourceStr);
      });
    });
  }

  const hasReadAccess = (resourceKeyword: string) =>
    hasStatement(
      'ForecastSnapshotFunction',
      (actions, resourceStr) =>
        actions.some((a) => a.includes('GetItem') || a.includes('Query') || a.includes('Scan')) && resourceStr.includes(resourceKeyword),
    );
  expect(hasReadAccess('YutaiMaster')).toBe(true);
  expect(hasReadAccess('GyakuhibuActual')).toBe(true);
  expect(hasReadAccess('StockPrices')).toBe(true);

  expect(hasStatement('ForecastSnapshotFunction', (actions) => actions.some((a) => a.includes('secretsmanager:GetSecretValue')))).toBe(
    true,
  );

  expect(
    hasStatement(
      'ForecastSnapshotFunction',
      (actions, resourceStr) => actions.some((a) => a.includes('PutObject')) && resourceStr.includes('GyakuhibuValidationBucket'),
    ),
  ).toBe(true);
  expect(
    hasStatement(
      'ForecastSnapshotFunction',
      (actions, resourceStr) => actions.some((a) => a.includes('GetObject')) && resourceStr.includes('GyakuhibuValidationBucket'),
    ),
  ).toBe(true);

  // Task 2の時点ではスケジュールを追加しない(EventBridge SchedulerでのTask 3の対象)。
  // 既存7スケジュール(price/financial-summary/margin-balance/gyakuhibu-history/
  // tdnet-watch/yutai-risk-precompute/gyakuhibu-forecast)から増えていないことを確認する。
  const rules = template.findResources('AWS::Events::Rule');
  const scheduleExpressions = Object.values(rules).map(
    (r) => (r as { Properties?: { ScheduleExpression?: string } }).Properties?.ScheduleExpression,
  );
  expect(scheduleExpressions.filter(Boolean)).toHaveLength(7);
});

test('schedules the two one-time forecast validation snapshots via EventBridge Scheduler at the correct JST wall-clock times', () => {
  const template = synth();

  // scheduler.ScheduleExpression.at(date, timeZone)は「dateのtoISOString()の数字」をat(...)
  // リテラルにそのまま埋め込み、timeZoneはその数字をどのタイムゾーンの現地時刻として解釈
  // するかを別途指定する。つまりScheduleExpressionの文字列自体はJSTの壁時計表記(00:00/15:00)
  // のまま、Timezoneフィールドで'Asia/Tokyo'を指定して初めて正しい実時刻(UTC 15:00/06:00)に
  // なる。この2つが揃っていることを確認しないと、UTC変換を誤って9時間ずれるバグ
  // (実装時に発見・修正済み)を再発検知できない。
  // スナップショットAは当初9/25 20:00 JST予定だったが、デプロイ自体が20:00頃になる見込みの
  // ため9/26 00:00 JST(=9/25の「24:00」)に後ろ倒しした(ユーザー指示、2026-09-25)。
  template.hasResourceProperties('AWS::Scheduler::Schedule', {
    ScheduleExpression: 'at(2026-09-26T00:00:00)',
    ScheduleExpressionTimezone: 'Asia/Tokyo',
    Target: Match.objectLike({
      Input: Match.serializedJson(
        Match.objectLike({
          rightsDate: '2026-09-28',
          asofLabel: '2026-09-26T0000JST',
          variant: 'final',
          asofDate: '2026-09-24',
        }),
      ),
    }),
  });

  // スナップショットBは当初variant:'prelim'を想定していたが、9/25リハーサルで同日分の
  // 品貸料率が常に空欄(確報は翌営業日)であることが再現確認されたため、per-tickerの
  // 確報/速報フォールバックは実装せず「常にfinal(確報)を待つ」に単純化した。
  template.hasResourceProperties('AWS::Scheduler::Schedule', {
    ScheduleExpression: 'at(2026-09-28T15:00:00)',
    ScheduleExpressionTimezone: 'Asia/Tokyo',
    Target: Match.objectLike({
      Input: Match.serializedJson(
        Match.objectLike({
          rightsDate: '2026-09-28',
          asofLabel: '2026-09-28T1500JST',
          variant: 'final',
          asofDate: '2026-09-25',
        }),
      ),
    }),
  });

  // 合計のAWS::Scheduler::Scheduleリソース数(2→4)の確認はTask 2で追加した
  // 「schedules the two one-time actuals-fetch runs...」テストが担う。このテストは
  // スナップショットA/Bの2つのプロパティ検証にスコープを絞る。
});

test('creates the ForecastActualsFunction wired to the actual table and the validation bucket (read+write)', () => {
  const template = synth();

  template.hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'index.handler',
    Runtime: 'nodejs22.x',
    Timeout: 840, // 14 minutes in seconds
    MemorySize: 512,
    Environment: {
      Variables: Match.objectLike({
        VALIDATION_BUCKET_NAME: Match.anyValue(),
        GYAKUHIBU_ACTUAL_TABLE_NAME: Match.anyValue(),
      }),
    },
  });

  const policies = template.findResources('AWS::IAM::Policy');
  const policyEntries = Object.entries(policies);

  function hasStatement(namePrefix: string, predicate: (actions: string[], resourceStr: string) => boolean): boolean {
    return policyEntries.some(([name, p]) => {
      if (!name.includes(namePrefix)) return false;
      const statements =
        (p as { Properties?: { PolicyDocument?: { Statement?: Array<{ Action?: string[] | string; Resource?: any }> } } })
          .Properties?.PolicyDocument?.Statement || [];
      return statements.some((stmt) => {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : stmt.Action ? [stmt.Action] : [];
        const resourceStr = JSON.stringify(stmt.Resource || '');
        return predicate(actions, resourceStr);
      });
    });
  }

  expect(
    hasStatement(
      'ForecastActualsFunction',
      (actions, resourceStr) =>
        actions.some((a) => a.includes('GetItem') || a.includes('Query') || a.includes('Scan')) &&
        resourceStr.includes('GyakuhibuActual'),
    ),
  ).toBe(true);

  expect(
    hasStatement(
      'ForecastActualsFunction',
      (actions, resourceStr) => actions.some((a) => a.includes('PutObject')) && resourceStr.includes('GyakuhibuValidationBucket'),
    ),
  ).toBe(true);
  expect(
    hasStatement(
      'ForecastActualsFunction',
      (actions, resourceStr) => actions.some((a) => a.includes('GetObject')) && resourceStr.includes('GyakuhibuValidationBucket'),
    ),
  ).toBe(true);
});

test('schedules the two one-time actuals-fetch runs via EventBridge Scheduler at the correct JST wall-clock times', () => {
  const template = synth();

  // ForecastSnapshotA/Bと同じ仕組み: scheduler.ScheduleExpression.at(date, timeZone)は
  // dateのtoISOString()の数字をat(...)リテラルにそのまま埋め込み、timeZoneはその数字を
  // どのタイムゾーンの現地時刻として解釈するかを別途指定する。ScheduleExpressionの文字列
  // 自体はJSTの壁時計表記(20:00)のまま、Timezoneフィールドで'Asia/Tokyo'を指定して初めて
  // 正しい実時刻(UTC 11:00)になる。この2つが揃っていることを確認しないと、UTC変換を
  // 誤って9時間ずれるバグを再発検知できない。
  template.hasResourceProperties('AWS::Scheduler::Schedule', {
    ScheduleExpression: 'at(2026-09-29T20:00:00)',
    ScheduleExpressionTimezone: 'Asia/Tokyo',
    Target: Match.objectLike({
      Input: Match.serializedJson(
        Match.objectLike({
          rightsDate: '2026-09-28',
          fetchedLabel: '2026-09-29T2000JST',
        }),
      ),
    }),
  });

  template.hasResourceProperties('AWS::Scheduler::Schedule', {
    ScheduleExpression: 'at(2026-10-02T20:00:00)',
    ScheduleExpressionTimezone: 'Asia/Tokyo',
    Target: Match.objectLike({
      Input: Match.serializedJson(
        Match.objectLike({
          rightsDate: '2026-09-28',
          fetchedLabel: '2026-10-02T2000JST',
        }),
      ),
    }),
  });

  const schedules = template.findResources('AWS::Scheduler::Schedule');
  expect(Object.keys(schedules)).toHaveLength(4);
});
