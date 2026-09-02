const mockGetApiKey = jest.fn();
const mockFetchWithRetry = jest.fn();

jest.mock('../lambda/shared/jquants-batch-client', () => ({
  getApiKey: (...args: unknown[]) => mockGetApiKey(...args),
  fetchWithRetry: (...args: unknown[]) => mockFetchWithRetry(...args),
}));

process.env.SECRET_ARN = 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:JQuantsApiKey';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fetchWeeklyBalances, fetchDailyAlertBalances } = require('../lambda/margin-balance-batch/data-source') as {
  fetchWeeklyBalances: (ticker: string, from: string, to: string) => Promise<unknown[]>;
  fetchDailyAlertBalances: (tickers: string[], date: string) => Promise<unknown[]>;
};

beforeEach(() => {
  mockGetApiKey.mockReset();
  mockFetchWithRetry.mockReset();
});

describe('fetchWeeklyBalances', () => {
  test('calls /markets/margin-interest with code/from/to and maps system-margin fields only', async () => {
    mockGetApiKey.mockResolvedValueOnce('test-api-key');
    mockFetchWithRetry.mockResolvedValueOnce({
      json: async () => ({
        data: [
          {
            Date: '2026-08-28',
            Code: '72030',
            LongVol: 225000,
            ShrtVol: 257400,
            LongStdVol: 143100,
            ShrtStdVol: 14600,
          },
        ],
      }),
    });

    const result = await fetchWeeklyBalances('7203', '2026-08-01', '2026-08-31');

    expect(mockFetchWithRetry).toHaveBeenCalledTimes(1);
    const url = mockFetchWithRetry.mock.calls[0][0] as string;
    expect(url).toContain('/markets/margin-interest');
    expect(url).toContain('code=7203');
    expect(url).toContain('from=2026-08-01');
    expect(url).toContain('to=2026-08-31');

    // 一般信用込みの合計(LongVol/ShrtVol)ではなく制度信用のみ(*StdVol)を使うこと
    expect(result).toEqual([{ date: '2026-08-28', financingBalance: 143100, lendingBalance: 14600, source: 'weekly' }]);
  });

  test('follows pagination_key across multiple pages', async () => {
    mockGetApiKey.mockResolvedValueOnce('test-api-key');
    mockFetchWithRetry
      .mockResolvedValueOnce({
        json: async () => ({
          data: [{ Date: '2026-08-21', Code: '72030', LongStdVol: 100, ShrtStdVol: 50 }],
          pagination_key: 'page2',
        }),
      })
      .mockResolvedValueOnce({
        json: async () => ({ data: [{ Date: '2026-08-28', Code: '72030', LongStdVol: 200, ShrtStdVol: 60 }] }),
      });

    const result = await fetchWeeklyBalances('7203', '2026-08-01', '2026-08-31');

    expect(mockFetchWithRetry).toHaveBeenCalledTimes(2);
    expect(mockFetchWithRetry.mock.calls[1][0]).toContain('pagination_key=page2');
    expect(result).toHaveLength(2);
  });

  test('returns an empty array when the ticker has no margin balance history', async () => {
    mockGetApiKey.mockResolvedValueOnce('test-api-key');
    mockFetchWithRetry.mockResolvedValueOnce({ json: async () => ({ data: [] }) });

    const result = await fetchWeeklyBalances('7203', '2026-08-01', '2026-08-31');

    expect(result).toEqual([]);
  });
});

describe('fetchDailyAlertBalances', () => {
  test('calls /markets/margin-alert once per ticker with code/date, using AppDate (not PubDate) as the point date', async () => {
    mockGetApiKey.mockResolvedValueOnce('test-api-key');
    mockFetchWithRetry.mockResolvedValueOnce({
      json: async () => ({
        data: [
          {
            PubDate: '2026-08-27',
            Code: '72030',
            AppDate: '2026-08-26',
            LongOut: 9000,
            ShrtOut: 1000,
            LongStdOut: 8410,
            ShrtStdOut: 920,
          },
        ],
      }),
    });

    const result = await fetchDailyAlertBalances(['7203'], '2026-08-27');

    expect(mockFetchWithRetry).toHaveBeenCalledTimes(1);
    const url = mockFetchWithRetry.mock.calls[0][0] as string;
    expect(url).toContain('/markets/margin-alert');
    expect(url).toContain('code=7203');
    expect(url).toContain('date=2026-08-27');

    expect(result).toEqual([{ date: '2026-08-26', financingBalance: 8410, lendingBalance: 920, source: 'daily-alert' }]);
  });

  test('calls once per ticker when given multiple tickers', async () => {
    mockGetApiKey.mockResolvedValueOnce('test-api-key');
    mockFetchWithRetry.mockResolvedValue({ json: async () => ({ data: [] }) });

    await fetchDailyAlertBalances(['7203', '9999'], '2026-08-27');

    expect(mockFetchWithRetry).toHaveBeenCalledTimes(2);
    const urls = mockFetchWithRetry.mock.calls.map(([url]) => url as string);
    expect(urls.some((u) => u.includes('code=7203'))).toBe(true);
    expect(urls.some((u) => u.includes('code=9999'))).toBe(true);
  });

  test('returns an empty array for a ticker not on the daily-alert list', async () => {
    mockGetApiKey.mockResolvedValueOnce('test-api-key');
    mockFetchWithRetry.mockResolvedValueOnce({ json: async () => ({ data: [] }) });

    const result = await fetchDailyAlertBalances(['7203'], '2026-08-27');

    expect(result).toEqual([]);
  });
});
