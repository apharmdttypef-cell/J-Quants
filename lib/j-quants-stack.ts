import * as cdk from 'aws-cdk-lib/core';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export class JQuantsStack extends cdk.Stack {
  public readonly stockPricesTable: dynamodb.Table;
  public readonly apiKeySecret: secretsmanager.Secret;

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
  }
}
