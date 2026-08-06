import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  QueryCommand: jest.fn((input: unknown) => input),
}));

process.env.TABLE_NAME = 'JQuantsStockPrices';
process.env.TICKERS = '7203,6758';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/reference-api/index') as {
  handler: (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2>;
};

function makeEvent(
  routeKey: string,
  pathParameters?: Record<string, string>,
  queryStringParameters?: Record<string, string>,
): APIGatewayProxyEventV2 {
  return { routeKey, pathParameters, queryStringParameters } as unknown as APIGatewayProxyEventV2;
}

function body(result: APIGatewayProxyResultV2): unknown {
  return JSON.parse((result as { body: string }).body);
}

beforeEach(() => {
  mockSend.mockReset();
});

test('GET /tickers returns the configured watchlist', async () => {
  const result = await handler(makeEvent('GET /tickers'));

  expect((result as { statusCode: number }).statusCode).toBe(200);
  expect(body(result)).toEqual({ tickers: ['7203', '6758'] });
});

test('GET /tickers/{ticker}/prices returns 404 for an unknown ticker', async () => {
  const result = await handler(makeEvent('GET /tickers/{ticker}/prices', { ticker: '9999' }));

  expect((result as { statusCode: number }).statusCode).toBe(404);
  expect(mockSend).not.toHaveBeenCalled();
});

test('GET /tickers/{ticker}/prices rejects unsupported range values', async () => {
  const result = await handler(makeEvent('GET /tickers/{ticker}/prices', { ticker: '7203' }, { range: '1y' }));

  expect((result as { statusCode: number }).statusCode).toBe(400);
  expect(mockSend).not.toHaveBeenCalled();
});

test('GET /tickers/{ticker}/prices queries DynamoDB and maps items', async () => {
  mockSend.mockResolvedValueOnce({
    Items: [{ ticker: '7203', date: '2026-08-01', open: 100, high: 110, low: 95, close: 105, volume: 1000 }],
  });

  const result = await handler(makeEvent('GET /tickers/{ticker}/prices', { ticker: '7203' }));

  expect((result as { statusCode: number }).statusCode).toBe(200);
  expect(body(result)).toEqual({
    ticker: '7203',
    range: '12w',
    prices: [{ date: '2026-08-01', open: 100, high: 110, low: 95, close: 105, volume: 1000 }],
  });
});

test('GET /tickers/{ticker}/summary returns 501 (data collection not implemented yet)', async () => {
  const result = await handler(makeEvent('GET /tickers/{ticker}/summary', { ticker: '7203' }));

  expect((result as { statusCode: number }).statusCode).toBe(501);
});

test('unknown route returns 404', async () => {
  const result = await handler(makeEvent('GET /unknown'));

  expect((result as { statusCode: number }).statusCode).toBe(404);
});
