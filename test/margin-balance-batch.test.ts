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

test('fetches the last 14 days (newest first) from both endpoints and skips the full Friday backfill on a non-Monday', async () => {
  mockSend.mockResolvedValueOnce({ Items: [{ ticker: '7203' }] }); // yutai master scan
  mockFetchAllWeekly.mockResolvedValueOnce([
    { code: '7203', date: '2026-08-28', financingBalance: 1, lendingBalance: 1, source: 'weekly' },
  ]);

  await handler();

  // today=2026-08-28(金) -> 08-28, 08-27, ..., 08-15 の14日分。金曜は週次バックフィルの対象外(UTC月曜ではない)。
  const expectedDates = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 7, 28 - i));
    return d.toISOString().slice(0, 10);
  });
  expect(mockFetchAllWeekly.mock.calls.map(([date]) => date)).toEqual(expectedDates);
  expect(mockFetchAllDailyAlert.mock.calls.map(([date]) => date)).toEqual(expectedDates);
  expect(mockFetchAllWeekly).toHaveBeenCalledWith('2026-08-28', 'test-api-key');
  expect(mockFetchAllDailyAlert).toHaveBeenCalledWith('2026-08-28', 'test-api-key');
});

test('runs the 2-year Friday backfill (LOOKBACK_DAYS) after the recent window on UTC Mondays', async () => {
  jest.setSystemTime(new Date('2026-08-31T00:00:00Z')); // a Monday
  mockSend.mockResolvedValueOnce({ Items: [{ ticker: '7203' }] });
  mockFetchAllWeekly.mockResolvedValue([
    { code: '7203', date: '2026-08-28', financingBalance: 1, lendingBalance: 1, source: 'weekly' },
  ]);

  await handler();

  // 直近14日(08-31..08-18) + LOOKBACK_DAYS=14以内の金曜(08-28, 08-21)。
  const dates = mockFetchAllWeekly.mock.calls.map(([date]) => date);
  expect(dates).toHaveLength(16);
  expect(dates.slice(14)).toEqual(['2026-08-28', '2026-08-21']);
  expect(mockFetchAllDailyAlert).toHaveBeenCalledTimes(14);
});

test('runs the full Friday backfill on any day when FORCE_FULL_BACKFILL=true', async () => {
  process.env.FORCE_FULL_BACKFILL = 'true';
  try {
    mockSend.mockResolvedValueOnce({ Items: [{ ticker: '7203' }] });
    mockFetchAllWeekly.mockResolvedValue([
      { code: '7203', date: '2026-08-28', financingBalance: 1, lendingBalance: 1, source: 'weekly' },
    ]);

    await handler();

    // 直近14日 + 金曜(08-28, 08-21, 08-14)。
    expect(mockFetchAllWeekly).toHaveBeenCalledTimes(17);
  } finally {
    delete process.env.FORCE_FULL_BACKFILL;
  }
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

test('prefers the common-stock (0-suffixed) record when a 4-digit ticker matches multiple codes, common stock listed first', async () => {
  mockSend.mockResolvedValueOnce({ Items: [{ ticker: '7203' }] });
  mockFetchAllWeekly.mockResolvedValueOnce([
    { code: '72030', date: '2026-08-28', financingBalance: 100, lendingBalance: 50, source: 'weekly' },
    { code: '72031', date: '2026-08-28', financingBalance: 999, lendingBalance: 999, source: 'weekly' },
  ]);

  await handler();

  const putItems = mockSend.mock.calls
    .map(([cmd]) => cmd as Record<string, unknown>)
    .filter((cmd) => cmd.__type === 'BatchWrite')
    .flatMap((cmd) => {
      const requestItems = cmd.RequestItems as Record<string, { PutRequest: { Item: Record<string, unknown> } }[]>;
      return requestItems['JQuantsMarginBalance'].map((r) => r.PutRequest.Item);
    });

  expect(putItems.filter((item) => item.ticker === '7203')).toEqual([
    { ticker: '7203', date: '2026-08-28', financingBalance: 100, lendingBalance: 50, source: 'weekly' },
  ]);
});

test('prefers the common-stock record when listed second (order-independent)', async () => {
  mockSend.mockResolvedValueOnce({ Items: [{ ticker: '7203' }] });
  mockFetchAllWeekly.mockResolvedValueOnce([
    { code: '72031', date: '2026-08-28', financingBalance: 999, lendingBalance: 999, source: 'weekly' },
    { code: '72030', date: '2026-08-28', financingBalance: 100, lendingBalance: 50, source: 'weekly' },
  ]);

  await handler();

  const putItems = mockSend.mock.calls
    .map(([cmd]) => cmd as Record<string, unknown>)
    .filter((cmd) => cmd.__type === 'BatchWrite')
    .flatMap((cmd) => {
      const requestItems = cmd.RequestItems as Record<string, { PutRequest: { Item: Record<string, unknown> } }[]>;
      return requestItems['JQuantsMarginBalance'].map((r) => r.PutRequest.Item);
    });

  expect(putItems.filter((item) => item.ticker === '7203')).toEqual([
    { ticker: '7203', date: '2026-08-28', financingBalance: 100, lendingBalance: 50, source: 'weekly' },
  ]);
});

test('writes matched daily-alert points with correct field mapping', async () => {
  mockSend.mockResolvedValueOnce({ Items: [{ ticker: '7203' }] });
  mockFetchAllDailyAlert.mockResolvedValueOnce([
    { code: '72030', date: '2026-08-26', financingBalance: 8410, lendingBalance: 920, source: 'daily-alert' },
  ]);

  await handler();

  const putItems = mockSend.mock.calls
    .map(([cmd]) => cmd as Record<string, unknown>)
    .filter((cmd) => cmd.__type === 'BatchWrite')
    .flatMap((cmd) => {
      const requestItems = cmd.RequestItems as Record<string, { PutRequest: { Item: Record<string, unknown> } }[]>;
      return requestItems['JQuantsMarginBalance'].map((r) => r.PutRequest.Item);
    });

  expect(putItems).toContainEqual({
    ticker: '7203',
    date: '2026-08-26',
    financingBalance: 8410,
    lendingBalance: 920,
    source: 'daily-alert',
  });
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

test('throws when every weekly date and the daily-alert fetch fail', async () => {
  mockSend.mockResolvedValueOnce({ Items: [{ ticker: '7203' }] });
  mockFetchAllDailyAlert.mockRejectedValue(new Error('boom-daily'));
  mockFetchAllWeekly.mockRejectedValue(new Error('boom-weekly'));

  await expect(handler()).rejects.toThrow('all 28 fetch/upsert calls failed');
});

test('throws when every call succeeds but 0 tickers match across all dates', async () => {
  mockSend.mockResolvedValueOnce({ Items: [{ ticker: '7203' }] });
  // beforeEach's defaults already resolve both fetch mocks to [] -- nothing to override

  await expect(handler()).rejects.toThrow('0 points matched');
});
