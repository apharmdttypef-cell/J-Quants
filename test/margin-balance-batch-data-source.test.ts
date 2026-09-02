const mockFetchWithRetry = jest.fn();

jest.mock('../lambda/shared/jquants-batch-client', () => ({
  fetchWithRetry: (...args: unknown[]) => mockFetchWithRetry(...args),
  normalizeDate: (raw: string) => (raw.includes('-') ? raw : `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fetchAllWeeklyBalancesForDate, fetchAllDailyAlertBalancesForDate } = require('../lambda/margin-balance-batch/data-source') as {
  fetchAllWeeklyBalancesForDate: (date: string, apiKey: string) => Promise<unknown[]>;
  fetchAllDailyAlertBalancesForDate: (date: string, apiKey: string) => Promise<unknown[]>;
};

beforeEach(() => {
  mockFetchWithRetry.mockReset();
});

describe('fetchAllWeeklyBalancesForDate', () => {
  test('calls /markets/margin-interest with date only (no code) and maps system-margin fields for every ticker in the response', async () => {
    mockFetchWithRetry.mockResolvedValueOnce({
      json: async () => ({
        data: [
          { Date: '2026-08-28', Code: '72030', LongVol: 225000, ShrtVol: 257400, LongStdVol: 143100, ShrtStdVol: 14600 },
          { Date: '2026-08-28', Code: '13010', LongVol: 5000, ShrtVol: 6000, LongStdVol: 4000, ShrtStdVol: 500 },
        ],
      }),
    });

    const result = await fetchAllWeeklyBalancesForDate('2026-08-28', 'test-api-key');

    expect(mockFetchWithRetry).toHaveBeenCalledTimes(1);
    expect(mockFetchWithRetry).toHaveBeenCalledWith(
      expect.stringContaining('/markets/margin-interest'),
      'test-api-key',
      500,
      5,
    );
    const url = mockFetchWithRetry.mock.calls[0][0] as string;
    expect(url).toContain('date=2026-08-28');
    expect(url).not.toContain('code=');

    expect(result).toEqual([
      { code: '72030', date: '2026-08-28', financingBalance: 143100, lendingBalance: 14600, source: 'weekly' },
      { code: '13010', date: '2026-08-28', financingBalance: 4000, lendingBalance: 500, source: 'weekly' },
    ]);
  });

  test('follows pagination_key across multiple pages', async () => {
    mockFetchWithRetry
      .mockResolvedValueOnce({
        json: async () => ({
          data: [{ Date: '2026-08-28', Code: '72030', LongStdVol: 100, ShrtStdVol: 50 }],
          pagination_key: 'page2',
        }),
      })
      .mockResolvedValueOnce({
        json: async () => ({ data: [{ Date: '2026-08-28', Code: '13010', LongStdVol: 200, ShrtStdVol: 60 }] }),
      });

    const result = await fetchAllWeeklyBalancesForDate('2026-08-28', 'test-api-key');

    expect(mockFetchWithRetry).toHaveBeenCalledTimes(2);
    expect(mockFetchWithRetry.mock.calls[1][0]).toContain('pagination_key=page2');
    expect(result).toHaveLength(2);
  });

  test('normalizes a non-dashed Date field', async () => {
    mockFetchWithRetry.mockResolvedValueOnce({
      json: async () => ({ data: [{ Date: '20260828', Code: '72030', LongStdVol: 100, ShrtStdVol: 50 }] }),
    });

    const result = await fetchAllWeeklyBalancesForDate('2026-08-28', 'test-api-key');

    expect(result[0]).toMatchObject({ date: '2026-08-28' });
  });

  test('returns an empty array when the date has no data', async () => {
    mockFetchWithRetry.mockResolvedValueOnce({ json: async () => ({ data: [] }) });

    const result = await fetchAllWeeklyBalancesForDate('2026-08-28', 'test-api-key');

    expect(result).toEqual([]);
  });

  test('does not throw when the response omits the data field', async () => {
    mockFetchWithRetry.mockResolvedValueOnce({ json: async () => ({}) });

    const result = await fetchAllWeeklyBalancesForDate('2026-08-28', 'test-api-key');

    expect(result).toEqual([]);
  });
});

describe('fetchAllDailyAlertBalancesForDate', () => {
  test('calls /markets/margin-alert with date only (no code) and uses AppDate (not PubDate) as the point date', async () => {
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

    const result = await fetchAllDailyAlertBalancesForDate('2026-08-27', 'test-api-key');

    expect(mockFetchWithRetry).toHaveBeenCalledTimes(1);
    expect(mockFetchWithRetry).toHaveBeenCalledWith(
      expect.stringContaining('/markets/margin-alert'),
      'test-api-key',
      500,
      5,
    );
    const url = mockFetchWithRetry.mock.calls[0][0] as string;
    expect(url).toContain('date=2026-08-27');
    expect(url).not.toContain('code=');

    expect(result).toEqual([
      { code: '72030', date: '2026-08-26', financingBalance: 8410, lendingBalance: 920, source: 'daily-alert' },
    ]);
  });

  test('returns an empty array when no daily-alert data exists for the date', async () => {
    mockFetchWithRetry.mockResolvedValueOnce({ json: async () => ({ data: [] }) });

    const result = await fetchAllDailyAlertBalancesForDate('2026-08-27', 'test-api-key');

    expect(result).toEqual([]);
  });
});
