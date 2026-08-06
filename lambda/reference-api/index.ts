import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

const TABLE_NAME = process.env.TABLE_NAME!;
const FINANCIAL_TABLE_NAME = process.env.FINANCIAL_TABLE_NAME!;
const TICKERS = (process.env.TICKERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
// J-Quants Freeプランは直近12週間分しか取得できないため、公開する範囲もそれに合わせる。
const PRICE_RANGE_DAYS = 12 * 7;

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function listTickers(): APIGatewayProxyResultV2 {
  return jsonResponse(200, { tickers: TICKERS });
}

async function getPrices(ticker: string, range: string | undefined): Promise<APIGatewayProxyResultV2> {
  if (!TICKERS.includes(ticker)) {
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
  if (!TICKERS.includes(ticker)) {
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
