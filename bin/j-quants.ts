#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { JQuantsStack } from '../lib/j-quants-stack';

// フロント/APIを守る共有パスワードは、CloudFront FunctionがSecrets Managerを実行時参照
// できないためsynth時に値が必要になる。毎回`APP_PASSWORD=xxx npx cdk deploy`と打たずに
// 済むよう、既にAWS上にあるシークレット`JQuantsAppPassword`をここで読んでスタックへ渡す
// (デプロイには元々AWS認証情報が必要なので、新しい信頼境界は増えない)。
//
// 環境変数APP_PASSWORDが設定されていればそちらを優先する。用途は2つ:
//   1. 初回デプロイ(シークレットがまだ存在しない)
//   2. パスワードのローテーション(新しい値を明示的に入れる。1回デプロイすれば
//      シークレット側も更新されるので、以降は環境変数なしで新しい値が使われる)
const SECRET_NAME = 'JQuantsAppPassword';

async function resolveAppPassword(): Promise<string> {
  const fromEnv = process.env.APP_PASSWORD;
  if (fromEnv) return fromEnv;

  const client = new SecretsManagerClient({});
  try {
    const result = await client.send(new GetSecretValueCommand({ SecretId: SECRET_NAME }));
    if (!result.SecretString) {
      throw new Error(`Secret ${SECRET_NAME} exists but has no string value`);
    }
    return result.SecretString;
  } catch (error) {
    throw new Error(
      `Could not read the ${SECRET_NAME} secret (${error instanceof Error ? error.message : String(error)}). ` +
        'For the first deploy, or to rotate the password, pass it explicitly instead: ' +
        'APP_PASSWORD=xxxxx npx cdk deploy',
    );
  }
}

async function main(): Promise<void> {
  const appPassword = await resolveAppPassword();

  const app = new cdk.App();
  new JQuantsStack(app, 'JQuantsStack', { appPassword });
  app.synth();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
