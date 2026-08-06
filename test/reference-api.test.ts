import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

const mockSend = jest.fn();
const mockSecretsSend = jest.fn();
const mockFetch = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(),
}));

jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSecretsSend })),
  GetSecretValueCommand: jest.fn((input: unknown) => input),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  QueryCommand: jest.fn((input: unknown) => input),
  ScanCommand: jest.fn((input: unknown) => input),
  GetCommand: jest.fn((input: unknown) => input),
  PutCommand: jest.fn((input: unknown) => input),
  DeleteCommand: jest.fn((input: unknown) => input),
}));

process.env.TABLE_NAME = 'JQuantsStockPrices';
process.env.FINANCIAL_TABLE_NAME = 'JQuantsFinancialSummary';
process.env.WATCHLIST_TABLE_NAME = 'JQuantsWatchlist';
process.env.SECRET_ARN = 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:JQuantsApiKey';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/reference-api/index') as {
  handler: (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2>;
};

function makeEvent(
  routeKey: string,
  options: { pathParameters?: Record<string, string>; queryStringParameters?: Record<string, string>; body?: string } = {},
): APIGatewayProxyEventV2 {
  return { routeKey, ...options } as unknown as APIGatewayProxyEventV2;
}

function body(result: APIGatewayProxyResultV2): unknown {
  return JSON.parse((result as { body: string }).body);
}

beforeEach(() => {
  mockSend.mockReset();
  mockSecretsSend.mockReset();
  mockFetch.mockReset();
  (global as unknown as { fetch: typeof mockFetch }).fetch = mockFetch;
});

test('GET /tickers scans the watchlist table and returns it sorted', async () => {
  mockSend.mockResolvedValueOnce({
    Items: [
      { ticker: '9432', companyName: 'NTT', addedAt: '2026-01-01T00:00:00.000Z' },
      { ticker: '7203', companyName: 'トヨタ自動車', addedAt: '2026-01-02T00:00:00.000Z' },
    ],
  });

  const result = await handler(makeEvent('GET /tickers'));

  expect((result as { statusCode: number }).statusCode).toBe(200);
  expect(body(result)).toEqual({
    tickers: [
      { ticker: '7203', companyName: 'トヨタ自動車', addedAt: '2026-01-02T00:00:00.000Z' },
      { ticker: '9432', companyName: 'NTT', addedAt: '2026-01-01T00:00:00.000Z' },
    ],
  });
});

test('POST /tickers rejects a malformed ticker without calling J-Quants', async () => {
  const result = await handler(makeEvent('POST /tickers', { body: JSON.stringify({ ticker: 'abc' }) }));

  expect((result as { statusCode: number }).statusCode).toBe(400);
  expect(mockFetch).not.toHaveBeenCalled();
});

test('POST /tickers looks up the company name and upserts the watchlist', async () => {
  mockSecretsSend.mockResolvedValueOnce({ SecretString: 'test-api-key' });
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ data: [{ Code: '7203', CoName: 'トヨタ自動車' }] }),
  });
  mockSend.mockResolvedValueOnce({});

  const result = await handler(makeEvent('POST /tickers', { body: JSON.stringify({ ticker: '7203' }) }));

  expect(mockFetch).toHaveBeenCalledWith(
    expect.stringContaining('/equities/master?code=7203'),
    expect.objectContaining({ headers: { 'x-api-key': 'test-api-key' } }),
  );
  expect((result as { statusCode: number }).statusCode).toBe(201);
  expect(body(result)).toMatchObject({ ticker: '7203', companyName: 'トヨタ自動車' });
});

test('POST /tickers returns 400 when J-Quants has no data for the code', async () => {
  mockSecretsSend.mockResolvedValueOnce({ SecretString: 'test-api-key' });
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) });

  const result = await handler(makeEvent('POST /tickers', { body: JSON.stringify({ ticker: '9999' }) }));

  expect((result as { statusCode: number }).statusCode).toBe(400);
  expect(mockSend).not.toHaveBeenCalled();
});

test('DELETE /tickers/{ticker} removes the item and returns 204', async () => {
  mockSend.mockResolvedValueOnce({});

  const result = await handler(makeEvent('DELETE /tickers/{ticker}', { pathParameters: { ticker: '7203' } }));

  expect((result as { statusCode: number }).statusCode).toBe(204);
});

test('GET /tickers/{ticker}/prices returns 404 for an unwatched ticker', async () => {
  mockSend.mockResolvedValueOnce({ Item: undefined });

  const result = await handler(makeEvent('GET /tickers/{ticker}/prices', { pathParameters: { ticker: '9999' } }));

  expect((result as { statusCode: number }).statusCode).toBe(404);
  expect(mockSend).toHaveBeenCalledTimes(1);
});

test('GET /tickers/{ticker}/prices rejects unsupported range values', async () => {
  mockSend.mockResolvedValueOnce({ Item: { ticker: '7203' } });

  const result = await handler(
    makeEvent('GET /tickers/{ticker}/prices', { pathParameters: { ticker: '7203' }, queryStringParameters: { range: '1y' } }),
  );

  expect((result as { statusCode: number }).statusCode).toBe(400);
});

test('GET /tickers/{ticker}/prices queries DynamoDB and maps items', async () => {
  mockSend.mockResolvedValueOnce({ Item: { ticker: '7203' } });
  mockSend.mockResolvedValueOnce({
    Items: [{ ticker: '7203', date: '2026-08-01', open: 100, high: 110, low: 95, close: 105, volume: 1000 }],
  });

  const result = await handler(makeEvent('GET /tickers/{ticker}/prices', { pathParameters: { ticker: '7203' } }));

  expect((result as { statusCode: number }).statusCode).toBe(200);
  expect(body(result)).toEqual({
    ticker: '7203',
    range: '12w',
    prices: [{ date: '2026-08-01', open: 100, high: 110, low: 95, close: 105, volume: 1000 }],
  });
});

test('GET /tickers/{ticker}/summary returns 404 for an unwatched ticker', async () => {
  mockSend.mockResolvedValueOnce({ Item: undefined });

  const result = await handler(makeEvent('GET /tickers/{ticker}/summary', { pathParameters: { ticker: '9999' } }));

  expect((result as { statusCode: number }).statusCode).toBe(404);
});

test('GET /tickers/{ticker}/summary returns 404 when no disclosure has been collected yet', async () => {
  mockSend.mockResolvedValueOnce({ Item: { ticker: '7203' } });
  mockSend.mockResolvedValueOnce({ Items: [] });

  const result = await handler(makeEvent('GET /tickers/{ticker}/summary', { pathParameters: { ticker: '7203' } }));

  expect((result as { statusCode: number }).statusCode).toBe(404);
});

test('GET /tickers/{ticker}/summary returns the latest disclosure', async () => {
  mockSend.mockResolvedValueOnce({ Item: { ticker: '7203' } });
  mockSend.mockResolvedValueOnce({
    Items: [
      {
        ticker: '7203',
        discDate: '2026-05-08',
        docType: 'FYFinancialStatements_Consolidated_IFRS',
        curPerType: 'FY',
        sales: '45095325000000',
        operatingProfit: '4795586000000',
        ordinaryProfit: '',
        netProfit: '4765002000000',
        eps: '345.42',
      },
    ],
  });

  const result = await handler(makeEvent('GET /tickers/{ticker}/summary', { pathParameters: { ticker: '7203' } }));

  expect((result as { statusCode: number }).statusCode).toBe(200);
  expect(body(result)).toEqual({
    ticker: '7203',
    discDate: '2026-05-08',
    docType: 'FYFinancialStatements_Consolidated_IFRS',
    curPerType: 'FY',
    sales: '45095325000000',
    operatingProfit: '4795586000000',
    ordinaryProfit: '',
    netProfit: '4765002000000',
    eps: '345.42',
  });
});

test('unknown route returns 404', async () => {
  const result = await handler(makeEvent('GET /unknown'));

  expect((result as { statusCode: number }).statusCode).toBe(404);
});
