import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { JQuantsStack } from '../lib/j-quants-stack';

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

test('creates the J-Quants API key secret without an inline value', () => {
  const template = synth();

  template.hasResourceProperties('AWS::SecretsManager::Secret', {
    Name: 'JQuantsApiKey',
  });
});

test('creates the batch fetch Lambda with table/secret env vars and a daily schedule', () => {
  const template = synth();

  template.hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'index.handler',
    Runtime: 'nodejs22.x',
    Environment: {
      Variables: {
        TICKERS: '7203,6758',
      },
    },
  });
  template.hasResourceProperties('AWS::Events::Rule', {
    ScheduleExpression: 'cron(0 9 * * ? *)',
    State: 'ENABLED',
  });
});
