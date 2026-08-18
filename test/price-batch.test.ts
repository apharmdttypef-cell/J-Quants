const mockDdbSend = jest.fn();
const mockGetApiKey = jest.fn();
const mockGetTargetTickers = jest.fn();
const mockFetchWithRetry = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  PutCommand: jest.fn((input: unknown) => input),
}));

jest.mock('../lambda/shared/jquants-batch-client', () => ({
  getApiKey: (...args: unknown[]) => mockGetApiKey(...args),
  getTargetTickers: (...args: unknown[]) => mockGetTargetTickers(...args),
  fetchWithRetry: (...args: unknown[]) => mockFetchWithRetry(...args),
  normalizeDate: (raw: string) => (raw.includes('-') ? raw : `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`),
  formatDate: (date: Date) => date.toISOString().slice(0, 10).replace(/-/g, ''),
}));

process.env.TABLE_NAME = 'JQuantsStockPrices';
process.env.WATCHLIST_TABLE_NAME = 'JQuantsWatchlist';
process.env.YUTAI_MASTER_TABLE_NAME = 'JQuantsYutaiMaster';
process.env.SECRET_ARN = 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:JQuantsApiKey';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/price-batch/index') as { handler: () => Promise<void> };

beforeEach(() => {
  mockDdbSend.mockReset();
  mockGetApiKey.mockReset();
  mockGetTargetTickers.mockReset();
  mockFetchWithRetry.mockReset();
});

test('does nothing when there are no target tickers', async () => {
  mockGetTargetTickers.mockResolvedValueOnce([]);

  await handler();

  expect(mockGetApiKey).not.toHaveBeenCalled();
  expect(mockFetchWithRetry).not.toHaveBeenCalled();
});

test('fetches daily bars for each target ticker and upserts them', async () => {
  mockGetTargetTickers.mockResolvedValueOnce(['7203']);
  mockGetApiKey.mockResolvedValueOnce('test-api-key');
  mockFetchWithRetry.mockResolvedValueOnce({
    json: async () => ({ data: [{ Code: '7203', Date: '2026-08-01', O: 100, H: 110, L: 95, C: 105, Vo: 1000 }] }),
  });

  await handler();

  expect(mockFetchWithRetry).toHaveBeenCalledTimes(1);
  expect(mockFetchWithRetry.mock.calls[0][0]).toContain('/equities/bars/daily');
  expect(mockFetchWithRetry.mock.calls[0][0]).toContain('code=7203');

  const putCalls = mockDdbSend.mock.calls.filter(([cmd]) => 'Item' in (cmd as Record<string, unknown>));
  expect(putCalls).toHaveLength(1);
  expect(putCalls[0][0]).toMatchObject({ TableName: 'JQuantsStockPrices', Item: { ticker: '7203', date: '2026-08-01' } });
});

test('fetches for multiple target tickers independently', async () => {
  mockGetTargetTickers.mockResolvedValueOnce(['7203', '9999']);
  mockGetApiKey.mockResolvedValueOnce('test-api-key');
  mockFetchWithRetry.mockResolvedValue({ json: async () => ({ data: [] }) });

  await handler();

  expect(mockFetchWithRetry).toHaveBeenCalledTimes(2);
  const urls = mockFetchWithRetry.mock.calls.map(([url]) => url as string);
  expect(urls.some((u) => u.includes('code=7203'))).toBe(true);
  expect(urls.some((u) => u.includes('code=9999'))).toBe(true);
});
