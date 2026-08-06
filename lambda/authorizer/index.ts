import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { APIGatewayRequestAuthorizerEventV2, APIGatewaySimpleAuthorizerResult } from 'aws-lambda';

const SECRET_ARN = process.env.SECRET_ARN!;

const secretsClient = new SecretsManagerClient({});

let cachedPassword: string | undefined;

async function getAppPassword(): Promise<string> {
  if (cachedPassword) return cachedPassword;
  const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: SECRET_ARN }));
  if (!result.SecretString) {
    throw new Error('App password secret has no string value');
  }
  cachedPassword = result.SecretString;
  return cachedPassword;
}

// フロント/API共通の共有パスワードを x-app-password ヘッダーで検証する簡易オーソライザー。
// 個人利用規模のアプリのため、Cognito等は導入せずシンプルな共有シークレット方式にしている。
export const handler = async (event: APIGatewayRequestAuthorizerEventV2): Promise<APIGatewaySimpleAuthorizerResult> => {
  const provided = event.headers?.['x-app-password'];
  if (!provided) {
    return { isAuthorized: false };
  }

  const expected = await getAppPassword();
  return { isAuthorized: provided === expected };
};
