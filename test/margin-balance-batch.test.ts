const mockSend = jest.fn();
const mockGetApiKey = jest.fn();
const mockFetchAllWeekly = jest.fn();
const mockFetchAllDailyAlert = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  ScanCommand: jest.fn((input: unknown) => ({ ...(input as object), __type: 'Scan' })),
  BatchWriteCommand: jest.fn((input: unknown) => ({ ...(input as object), __type: 'BatchWrite' })),
}));

jest.mock('../lambda/shared/jquants-batch-client', () => ({
  getApiKey: (...args: unknown[]) => mockGetApiKey(...args),
}));

jest.mock('../lambda/margin-balance-batch/data-source', () => ({
  fetchAllWeeklyBalancesForDate: (...args: unknown[]) => mockFetchAllWeekly(...args),
  fetchAllDailyAlertBalancesForDate: (...args: unknown[]) => mockFetchAllDailyAlert(...args),
}));

process.env.YUTAI_MASTER_TABLE_NAME = 'JQuantsYutaiMaster';
process.env.MARGIN_BALANCE_TABLE_NAME = 'JQuantsMarginBalance';
process.env.SECRET_ARN = 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:JQuantsApiKey';
process.env.LOOKBACK_DAYS = '14';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/margin-balance-batch/index') as { handler: () => Promise<void> };

beforeEach(() => {
  mockSend.mockReset();
  mockGetApiKey.mockReset();
  mockFetchAllWeekly.mockReset();
  mockFetchAllDailyAlert.mockReset();

  mockSend.mockResolvedValue({}); // default: BatchWriteCommand succeeds with no UnprocessedItems
  mockGetApiKey.mockResolvedValue('test-api-key');
  mockFetchAllWeekly.mockResolvedValue([]);
  mockFetchAllDailyAlert.mockResolvedValue([]);

  jest.useFakeTimers({
    doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick'],
  }).setSystemTime(new Date('2026-08-28T00:00:00Z')); // a Friday
});

afterEach(() => {
  jest.useRealTimers();
});

test('queries every Friday within LOOKBACK_DAYS and fetches today once for daily-alert', async () => {
  mockSend.mockResolvedValueOnce({ Items: [{ ticker: '7203' }] }); // yutai master scan

  await handler();

  // LOOKBACK_DAYS=14, today=2026-08-28 (Fri) -> Fridays: 08-28, 08-21, 08-14
  expect(mockFetchAllWeekly).toHaveBeenCalledTimes(3);
  const dates = mockFetchAllWeekly.mock.calls.map(([date]) => date);
  expect(dates).toEqual(['2026-08-28', '2026-08-21', '2026-08-14']);
  expect(mockFetchAllWeekly).toHaveBeenCalledWith('2026-08-28', 'test-api-key');

  expect(mockFetchAllDailyAlert).toHaveBeenCalledTimes(1);
  expect(mockFetchAllDailyAlert).toHaveBeenCalledWith('2026-08-28', 'test-api-key');
});

test('writes only target tickers via BatchWriteCommand, matching a 4-digit ticker to its 5-digit code', async () => {
  mockSend.mockResolvedValueOnce({ Items: [{ ticker: '7203' }] }); // yutai master scan
  mockFetchAllWeekly.mockResolvedValue([
    { code: '72030', date: '2026-08-28', financingBalance: 100, lendingBalance: 50, source: 'weekly' },
    { code: '13010', date: '2026-08-28', financingBalance: 999, lendingBalance: 999, source: 'weekly' }, // not a target ticker
  ]);

  await handler();

  const batchWriteCalls = mockSend.mock.calls
    .map(([cmd]) => cmd as Record<string, unknown>)
    .filter((cmd) => cmd.__type === 'BatchWrite');
  expect(batchWriteCalls.length).toBeGreaterThan(0);

  const putItems = batchWriteCalls.flatMap((cmd) => {
    const requestItems = cmd.RequestItems as Record<string, { PutRequest: { Item: Record<string, unknown> } }[]>;
    return requestItems['JQuantsMarginBalance'].map((r) => r.PutRequest.Item);
  });

  expect(putItems).toContainEqual({
    ticker: '7203',
    date: '2026-08-28',
    financingBalance: 100,
    lendingBalance: 50,
    source: 'weekly',
  });
  expect(putItems.some((item) => item.ticker === '13010')).toBe(false);
});

test('retries BatchWriteCommand when UnprocessedItems is returned', async () => {
  let batchWriteCallCount = 0;
  mockSend.mockImplementation((cmd: Record<string, unknown>) => {
    if (cmd.__type === 'Scan') return Promise.resolve({ Items: [{ ticker: '7203' }] });
    if (cmd.__type === 'BatchWrite') {
      batchWriteCallCount += 1;
      if (batchWriteCallCount === 1) {
        const requestItems = cmd.RequestItems as Record<string, unknown[]>;
        const firstItem = requestItems['JQuantsMarginBalance'][0];
        return Promise.resolve({ UnprocessedItems: { JQuantsMarginBalance: [firstItem] } });
      }
      return Promise.resolve({});
    }
    return Promise.resolve({});
  });
  mockFetchAllWeekly.mockResolvedValueOnce([
    { code: '72030', date: '2026-08-28', financingBalance: 100, lendingBalance: 50, source: 'weekly' },
  ]);

  await handler();

  expect(batchWriteCallCount).toBeGreaterThanOrEqual(2);
});

test('does nothing when yutai master is empty', async () => {
  mockSend.mockResolvedValueOnce({ Items: [] });

  await handler();

  expect(mockFetchAllWeekly).not.toHaveBeenCalled();
  expect(mockFetchAllDailyAlert).not.toHaveBeenCalled();
});
