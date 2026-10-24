// モジュール化(TS2451回避)。
export {};

const mockSend = jest.fn();

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  ScanCommand: jest.fn((input: unknown) => ({ ...(input as object), __type: 'Scan' })),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isLegacyMarginRow, findLegacyMarginKeys, LEGACY_MARGIN_SOURCES } = require('../scripts/lib/legacy-margin-balance') as {
  isLegacyMarginRow: (item: Record<string, unknown>) => boolean;
  findLegacyMarginKeys: (
    client: unknown,
    tableName: string,
  ) => Promise<{ keys: Array<{ ticker: string; date: string }>; countsBySource: Record<string, number> }>;
  LEGACY_MARGIN_SOURCES: readonly string[];
};

beforeEach(() => {
  mockSend.mockReset();
});

test('LEGACY_MARGIN_SOURCES lists the J-Quants sources', () => {
  expect([...LEGACY_MARGIN_SOURCES]).toEqual(['weekly', 'daily-alert']);
});

test('isLegacyMarginRow matches only weekly / daily-alert rows', () => {
  expect(isLegacyMarginRow({ source: 'weekly' })).toBe(true);
  expect(isLegacyMarginRow({ source: 'daily-alert' })).toBe(true);
  expect(isLegacyMarginRow({ source: 'taisyaku' })).toBe(false);
  expect(isLegacyMarginRow({ ticker: '__cursor__', date: 'taisyaku', lastFetchedDate: '2026-10-23' })).toBe(false);
  expect(isLegacyMarginRow({})).toBe(false);
});

test('findLegacyMarginKeys pages through the scan and returns only legacy keys', async () => {
  mockSend
    .mockResolvedValueOnce({
      Items: [
        { ticker: '1111', date: '2026-01-02', source: 'weekly' },
        { ticker: '2222', date: '2026-01-03', source: 'daily-alert' },
        { ticker: '3333', date: '2026-01-04', source: 'taisyaku' },
      ],
      LastEvaluatedKey: { ticker: '3333', date: '2026-01-04' },
    })
    .mockResolvedValueOnce({
      Items: [
        { ticker: '4444', date: '2026-01-05', source: 'weekly' },
        { ticker: '__cursor__', date: 'taisyaku' },
      ],
    });

  const result = await findLegacyMarginKeys({ send: mockSend }, 'MarginTable');

  expect(result.keys).toEqual([
    { ticker: '1111', date: '2026-01-02' },
    { ticker: '2222', date: '2026-01-03' },
    { ticker: '4444', date: '2026-01-05' },
  ]);
  expect(result.countsBySource).toEqual({ weekly: 2, 'daily-alert': 1 });

  expect(mockSend).toHaveBeenCalledTimes(2);
  const first = mockSend.mock.calls[0][0];
  expect(first).toMatchObject({
    TableName: 'MarginTable',
    FilterExpression: '#source IN (:weekly, :dailyAlert)',
    ProjectionExpression: 'ticker, #date, #source',
    ExpressionAttributeNames: { '#date': 'date', '#source': 'source' },
    ExpressionAttributeValues: { ':weekly': 'weekly', ':dailyAlert': 'daily-alert' },
  });
  expect(first.ExclusiveStartKey).toBeUndefined();
  expect(mockSend.mock.calls[1][0].ExclusiveStartKey).toEqual({ ticker: '3333', date: '2026-01-04' });
});
