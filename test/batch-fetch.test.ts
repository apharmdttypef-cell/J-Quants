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
  PutCommand: jest.fn((input: unknown) => input),
  ScanCommand: jest.fn((input: unknown) => input),
}));

process.env.TABLE_NAME = 'JQuantsStockPrices';
process.env.FINANCIAL_TABLE_NAME = 'JQuantsFinancialSummary';
process.env.WATCHLIST_TABLE_NAME = 'JQuantsWatchlist';
process.env.YUTAI_MASTER_TABLE_NAME = 'JQuantsYutaiMaster';
process.env.SECRET_ARN = 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:JQuantsApiKey';
process.env.REQUEST_INTERVAL_MS = '0';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/batch-fetch/index') as { handler: () => Promise<void> };

beforeEach(() => {
  mockSend.mockReset();
  mockSecretsSend.mockReset();
  mockFetch.mockReset();
  (global as unknown as { fetch: typeof mockFetch }).fetch = mockFetch;
});

test('does nothing when both watchlist and yutai master are empty', async () => {
  mockSend.mockResolvedValueOnce({ Items: [] }).mockResolvedValueOnce({ Items: [] });

  await handler();

  expect(mockSecretsSend).not.toHaveBeenCalled();
  expect(mockFetch).not.toHaveBeenCalled();
});

test('fetches bars and financial summaries for each watchlist ticker and upserts both', async () => {
  mockSend.mockResolvedValueOnce({ Items: [{ ticker: '7203' }] }); // watchlist scan
  mockSecretsSend.mockResolvedValueOnce({ SecretString: 'test-api-key' });
  mockFetch
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ Code: '7203', Date: '2026-08-01', O: 100, H: 110, L: 95, C: 105, Vo: 1000 }] }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            Code: '7203',
            DiscDate: '2026-05-08',
            DocType: 'FYFinancialStatements_Consolidated_IFRS',
            CurPerType: 'FY',
            Sales: '45095325000000',
            OP: '4795586000000',
            OdP: '',
            NP: '4765002000000',
            EPS: '345.42',
          },
        ],
      }),
    });
  mockSend.mockResolvedValue({}); // PutCommand calls

  await handler();

  expect(mockFetch).toHaveBeenCalledTimes(2);
  expect(mockFetch.mock.calls[0][0]).toContain('/equities/bars/daily');
  expect(mockFetch.mock.calls[1][0]).toContain('/fins/summary');

  const putCalls = mockSend.mock.calls.filter(([cmd]) => 'Item' in (cmd as Record<string, unknown>));
  expect(putCalls).toHaveLength(2);
  expect(putCalls[0][0]).toMatchObject({ TableName: 'JQuantsStockPrices', Item: { ticker: '7203', date: '2026-08-01' } });
  expect(putCalls[1][0]).toMatchObject({
    TableName: 'JQuantsFinancialSummary',
    Item: { ticker: '7203', discDate: '2026-05-08', sales: '45095325000000' },
  });
});

test('fetches for the union of watchlist and yutai-master tickers, deduped', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '7203' }] }) // watchlist scan
    .mockResolvedValueOnce({ Items: [{ ticker: '7203' }, { ticker: '9999' }] }); // yutai master scan
  mockSecretsSend.mockResolvedValueOnce({ SecretString: 'test-api-key' });
  mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
  mockSend.mockResolvedValue({});

  await handler();

  // 7203は重複排除で1回だけ、9999も含めて2銘柄分(各銘柄バー+サマリで2回ずつ)fetchされる
  const barUrls = mockFetch.mock.calls.map(([url]) => url as string).filter((u) => u.includes('/equities/bars/daily'));
  expect(barUrls).toHaveLength(2);
  expect(barUrls.some((u) => u.includes('code=7203'))).toBe(true);
  expect(barUrls.some((u) => u.includes('code=9999'))).toBe(true);
});
