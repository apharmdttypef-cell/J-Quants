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
// 3日分(offset+2〜offsetの3日)のループになるようにし、日付ごとに1回fetchWithRetryが
// 呼ばれることをテストで確認しやすくする。
process.env.LOOKBACK_DAYS = '2';
process.env.DELIVERY_DELAY_DAYS = '10';

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

test('queries once per day in the lookback window, by date only (no code parameter)', async () => {
  mockGetTargetTickers.mockResolvedValueOnce(['7203']);
  mockGetApiKey.mockResolvedValueOnce('test-api-key');
  mockFetchWithRetry.mockResolvedValue({ json: async () => ({ data: [] }) });

  await handler();

  // LOOKBACK_DAYS=2 → 3日分(from〜to inclusive)
  expect(mockFetchWithRetry).toHaveBeenCalledTimes(3);
  for (const [url] of mockFetchWithRetry.mock.calls) {
    expect(url as string).toContain('/equities/bars/daily');
    expect(url as string).toMatch(/date=\d{8}/);
    expect(url as string).not.toContain('code=');
  }
});

test('upserts only bars for tickers in the target set, ignoring the rest of the market snapshot', async () => {
  mockGetTargetTickers.mockResolvedValueOnce(['7203']);
  mockGetApiKey.mockResolvedValueOnce('test-api-key');
  mockFetchWithRetry.mockResolvedValue({
    json: async () => ({
      data: [
        { Code: '72030', Date: '2026-08-01', O: 100, H: 110, L: 95, C: 105, Vo: 1000 },
        { Code: '99990', Date: '2026-08-01', O: 1, H: 2, L: 1, C: 2, Vo: 5 },
      ],
    }),
  });

  await handler();

  const putCalls = mockDdbSend.mock.calls.filter(([cmd]) => 'Item' in (cmd as Record<string, unknown>));
  // 3日分ループする環境設定のため、一致した1件が日ごとに書き込まれ3件になる
  expect(putCalls).toHaveLength(3);
  for (const [cmd] of putCalls) {
    expect(cmd).toMatchObject({ TableName: 'JQuantsStockPrices', Item: { ticker: '7203', date: '2026-08-01' } });
  }
});

test('prefers the common-stock record (5th digit 0) when a ticker has multiple share classes listed', async () => {
  mockGetTargetTickers.mockResolvedValueOnce(['1301']);
  mockGetApiKey.mockResolvedValueOnce('test-api-key');
  mockFetchWithRetry.mockResolvedValue({
    json: async () => ({
      data: [
        { Code: '13011', Date: '2026-08-01', O: 999, H: 999, L: 999, C: 999, Vo: 999 }, // 優先株式(先に出現)
        { Code: '13010', Date: '2026-08-01', O: 100, H: 110, L: 95, C: 105, Vo: 1000 }, // 普通株式
      ],
    }),
  });

  await handler();

  const putCalls = mockDdbSend.mock.calls.filter(([cmd]) => 'Item' in (cmd as Record<string, unknown>));
  expect(putCalls).toHaveLength(3);
  for (const [cmd] of putCalls) {
    expect(cmd).toMatchObject({ Item: { ticker: '1301', close: 105 } }); // 普通株式側の値
  }
});

test('prefers the common-stock record even when it appears first (the ordering J-Quants actually returns)', async () => {
  mockGetTargetTickers.mockResolvedValueOnce(['1301']);
  mockGetApiKey.mockResolvedValueOnce('test-api-key');
  mockFetchWithRetry.mockResolvedValue({
    json: async () => ({
      data: [
        { Code: '13010', Date: '2026-08-01', O: 100, H: 110, L: 95, C: 105, Vo: 1000 }, // 普通株式(先に出現、実際のJ-Quantsの並び順)
        { Code: '13011', Date: '2026-08-01', O: 999, H: 999, L: 999, C: 999, Vo: 999 }, // 優先株式
      ],
    }),
  });

  await handler();

  const putCalls = mockDdbSend.mock.calls.filter(([cmd]) => 'Item' in (cmd as Record<string, unknown>));
  expect(putCalls).toHaveLength(3);
  for (const [cmd] of putCalls) {
    expect(cmd).toMatchObject({ Item: { ticker: '1301', close: 105 } }); // 普通株式側の値のまま
  }
});

test('matches a 5-digit watchlist ticker by exact Code, not the truncated 4-digit prefix', async () => {
  mockGetTargetTickers.mockResolvedValueOnce(['72030']);
  mockGetApiKey.mockResolvedValueOnce('test-api-key');
  mockFetchWithRetry.mockResolvedValue({
    json: async () => ({
      data: [{ Code: '72030', Date: '2026-08-01', O: 100, H: 110, L: 95, C: 105, Vo: 1000 }],
    }),
  });

  await handler();

  const putCalls = mockDdbSend.mock.calls.filter(([cmd]) => 'Item' in (cmd as Record<string, unknown>));
  expect(putCalls).toHaveLength(3);
  for (const [cmd] of putCalls) {
    expect(cmd).toMatchObject({ TableName: 'JQuantsStockPrices', Item: { ticker: '72030', date: '2026-08-01' } });
  }
});

test('follows pagination_key when a single date response is paginated', async () => {
  mockGetTargetTickers.mockResolvedValueOnce(['7203']);
  mockGetApiKey.mockResolvedValueOnce('test-api-key');
  mockFetchWithRetry
    .mockResolvedValueOnce({
      json: async () => ({
        data: [{ Code: '72030', Date: '2026-08-01', O: 100, H: 110, L: 95, C: 105, Vo: 1000 }],
        pagination_key: 'page2',
      }),
    })
    .mockResolvedValue({ json: async () => ({ data: [] }) });

  await handler();

  // 1日目が2ページ(pagination_key追跡)+残り2日分=合計4回
  expect(mockFetchWithRetry).toHaveBeenCalledTimes(4);
  expect(mockFetchWithRetry.mock.calls[1][0]).toContain('pagination_key=page2');
});

test('queries by date only regardless of how many target tickers exist', async () => {
  mockGetTargetTickers.mockResolvedValueOnce(['7203', '1301']);
  mockGetApiKey.mockResolvedValueOnce('test-api-key');
  mockFetchWithRetry.mockResolvedValue({
    json: async () => ({
      data: [
        { Code: '72030', Date: '2026-08-01', O: 100, H: 110, L: 95, C: 105, Vo: 1000 },
        { Code: '13010', Date: '2026-08-01', O: 200, H: 210, L: 195, C: 205, Vo: 2000 },
      ],
    }),
  });

  await handler();

  // LOOKBACK_DAYS=2 → 3日分(from〜to inclusive)。複数銘柄を指定しても
  // 1日ごとに1回のfetchWithRetryだけ呼ばれる(tickers.length × 3 ではない)
  expect(mockFetchWithRetry).toHaveBeenCalledTimes(3);

  const putCalls = mockDdbSend.mock.calls.filter(([cmd]) => 'Item' in (cmd as Record<string, unknown>));
  // 2銘柄 × 3日分
  expect(putCalls).toHaveLength(6);
  const tickers = new Set(putCalls.map(([cmd]) => (cmd as { Item: { ticker: string } }).Item.ticker));
  expect(tickers).toEqual(new Set(['7203', '1301']));
});
