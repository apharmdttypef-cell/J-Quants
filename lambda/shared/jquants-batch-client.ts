import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';

const secretsClient = new SecretsManagerClient({});
const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

let cachedApiKey: string | undefined;

export async function getApiKey(secretArn: string): Promise<string> {
  if (cachedApiKey) return cachedApiKey;
  const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!result.SecretString) {
    throw new Error('J-Quants API key secret has no string value');
  }
  cachedApiKey = result.SecretString;
  return cachedApiKey;
}

export async function scanTickerColumn(tableName: string): Promise<string[]> {
  const tickers: string[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await ddbDocClient.send(
      new ScanCommand({ TableName: tableName, ExclusiveStartKey: exclusiveStartKey }),
    );
    for (const item of result.Items ?? []) {
      if (typeof item.ticker === 'string') tickers.push(item.ticker);
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return tickers;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 呼び出しのたびにレート制限分スリープするので、呼び出し側は間隔を意識しなくてよい。
export async function fetchWithRetry(
  url: string,
  apiKey: string,
  requestIntervalMs: number,
  maxRetries: number,
  attempt = 0,
): Promise<Response> {
  const response = await fetch(url, { headers: { 'x-api-key': apiKey } });

  if (response.status === 429 && attempt < maxRetries) {
    const backoffMs = requestIntervalMs * 2 ** attempt;
    console.warn(`Rate limited, backing off ${backoffMs}ms (attempt ${attempt + 1})`);
    await sleep(backoffMs);
    return fetchWithRetry(url, apiKey, requestIntervalMs, maxRetries, attempt + 1);
  }

  if (!response.ok) {
    throw new Error(`J-Quants API error ${response.status}: ${await response.text()}`);
  }

  await sleep(requestIntervalMs);
  return response;
}

export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

// APIのDateはドキュメント上 "20210907" / "2021-09-07" どちらの形式もあり得るため正規化する。
export function normalizeDate(raw: string): string {
  if (raw.includes('-')) return raw;
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}
