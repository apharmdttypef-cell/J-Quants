import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

const TABLE_NAME = process.env.TABLE_NAME!;
const FINANCIAL_TABLE_NAME = process.env.FINANCIAL_TABLE_NAME!;
const WATCHLIST_TABLE_NAME = process.env.WATCHLIST_TABLE_NAME!;
const SECRET_ARN = process.env.SECRET_ARN!;
const API_BASE_URL = process.env.API_BASE_URL ?? 'https://api.jquants.com/v2';
// J-Quants Freeプランは直近12週間分しか取得できないため、公開する範囲もそれに合わせる。
const PRICE_RANGE_DAYS = 12 * 7;
// 4桁(普通株式)または5桁(末尾0付き)の銘柄コードのみ受け付ける。
const TICKER_CODE_PATTERN = /^\d{4,5}$/;

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secretsClient = new SecretsManagerClient({});

let cachedApiKey: string | undefined;

async function getApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;
  const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: SECRET_ARN }));
  if (!result.SecretString) {
    throw new Error('J-Quants API key secret has no string value');
  }
  cachedApiKey = result.SecretString;
  return cachedApiKey;
}

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function emptyResponse(statusCode: number): APIGatewayProxyResultV2 {
  return { statusCode };
}

async function isWatchedTicker(ticker: string): Promise<boolean> {
  const result = await ddbDocClient.send(
    new GetCommand({ TableName: WATCHLIST_TABLE_NAME, Key: { ticker } }),
  );
  return result.Item !== undefined;
}

async function listTickers(): Promise<APIGatewayProxyResultV2> {
  const tickers: Array<{ ticker: string; companyName?: string; addedAt?: string }> = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await ddbDocClient.send(
      new ScanCommand({ TableName: WATCHLIST_TABLE_NAME, ExclusiveStartKey: exclusiveStartKey }),
    );
    for (const item of result.Items ?? []) {
      tickers.push({ ticker: item.ticker, companyName: item.companyName, addedAt: item.addedAt });
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  tickers.sort((a, b) => a.ticker.localeCompare(b.ticker));
  return jsonResponse(200, { tickers });
}

interface ListedInstrument {
  Code: string;
  CoName: string;
}

interface ListedInstrumentResponse {
  data: ListedInstrument[];
}

// 銘柄コードの実在確認と会社名表示のため、追加時に一度だけ問い合わせる
// (全銘柄一覧の常時同期はしない。詳細はADR/要件書6-4を参照)。
async function lookupCompanyName(ticker: string): Promise<string | undefined> {
  const apiKey = await getApiKey();
  const response = await fetch(`${API_BASE_URL}/equities/master?code=${ticker}`, {
    headers: { 'x-api-key': apiKey },
  });

  if (!response.ok) {
    throw new Error(`J-Quants API error ${response.status}: ${await response.text()}`);
  }

  const body = (await response.json()) as ListedInstrumentResponse;
  return body.data[0]?.CoName;
}

async function addTicker(rawBody: string | undefined): Promise<APIGatewayProxyResultV2> {
  let ticker: unknown;
  try {
    ticker = rawBody ? (JSON.parse(rawBody) as { ticker?: unknown }).ticker : undefined;
  } catch {
    return jsonResponse(400, { message: 'Invalid JSON body' });
  }

  if (typeof ticker !== 'string' || !TICKER_CODE_PATTERN.test(ticker)) {
    return jsonResponse(400, { message: 'ticker must be a 4 or 5 digit stock code' });
  }

  let companyName: string | undefined;
  try {
    companyName = await lookupCompanyName(ticker);
  } catch (error) {
    console.error(`Failed to look up company name for ${ticker}`, error);
    return jsonResponse(502, { message: 'Failed to verify ticker with J-Quants API' });
  }

  if (!companyName) {
    return jsonResponse(400, { message: `Unknown ticker code: ${ticker}` });
  }

  const addedAt = new Date().toISOString();
  await ddbDocClient.send(
    new PutCommand({
      TableName: WATCHLIST_TABLE_NAME,
      Item: { ticker, companyName, addedAt },
    }),
  );

  return jsonResponse(201, { ticker, companyName, addedAt });
}

async function removeTicker(ticker: string): Promise<APIGatewayProxyResultV2> {
  await ddbDocClient.send(new DeleteCommand({ TableName: WATCHLIST_TABLE_NAME, Key: { ticker } }));
  return emptyResponse(204);
}

async function getPrices(ticker: string, range: string | undefined): Promise<APIGatewayProxyResultV2> {
  if (!(await isWatchedTicker(ticker))) {
    return jsonResponse(404, { message: `Unknown ticker: ${ticker}` });
  }
  if (range !== undefined && range !== '12w') {
    return jsonResponse(400, { message: 'Only range=12w is supported (J-Quants Free plan constraint)' });
  }

  const fromDate = new Date(Date.now() - PRICE_RANGE_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const result = await ddbDocClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'ticker = :ticker AND #date >= :fromDate',
      ExpressionAttributeNames: { '#date': 'date' },
      ExpressionAttributeValues: { ':ticker': ticker, ':fromDate': fromDate },
      ScanIndexForward: true,
    }),
  );

  return jsonResponse(200, {
    ticker,
    range: '12w',
    prices: (result.Items ?? []).map((item) => ({
      date: item.date,
      open: item.open,
      high: item.high,
      low: item.low,
      close: item.close,
      volume: item.volume,
    })),
  });
}

async function getSummary(ticker: string): Promise<APIGatewayProxyResultV2> {
  if (!(await isWatchedTicker(ticker))) {
    return jsonResponse(404, { message: `Unknown ticker: ${ticker}` });
  }

  const result = await ddbDocClient.send(
    new QueryCommand({
      TableName: FINANCIAL_TABLE_NAME,
      KeyConditionExpression: 'ticker = :ticker',
      ExpressionAttributeValues: { ':ticker': ticker },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );

  const latest = result.Items?.[0];
  if (!latest) {
    return jsonResponse(404, { message: `No financial summary available yet for ${ticker}` });
  }

  return jsonResponse(200, {
    ticker,
    discDate: latest.discDate,
    docType: latest.docType,
    curPerType: latest.curPerType,
    sales: latest.sales,
    operatingProfit: latest.operatingProfit,
    ordinaryProfit: latest.ordinaryProfit,
    netProfit: latest.netProfit,
    eps: latest.eps,
  });
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const ticker = event.pathParameters?.ticker;

  switch (event.routeKey) {
    case 'GET /tickers':
      return listTickers();
    case 'POST /tickers':
      return addTicker(event.body);
    case 'DELETE /tickers/{ticker}':
      return ticker ? removeTicker(ticker) : jsonResponse(400, { message: 'Missing ticker' });
    case 'GET /tickers/{ticker}/prices':
      return ticker
        ? getPrices(ticker, event.queryStringParameters?.range)
        : jsonResponse(400, { message: 'Missing ticker' });
    case 'GET /tickers/{ticker}/summary':
      return ticker ? await getSummary(ticker) : jsonResponse(400, { message: 'Missing ticker' });
    default:
      return jsonResponse(404, { message: 'Not found' });
  }
};
