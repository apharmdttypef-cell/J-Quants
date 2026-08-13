const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  PutCommand: jest.fn((input: unknown) => input),
  QueryCommand: jest.fn((input: unknown) => input),
  ScanCommand: jest.fn((input: unknown) => input),
}));

jest.mock('../lambda/margin-balance-batch/data-source', () => ({
  fetchWeeklyBalances: jest.fn(),
  fetchDailyAlertBalances: jest.fn(),
}));

process.env.YUTAI_MASTER_TABLE_NAME = 'JQuantsYutaiMaster';
process.env.MARGIN_BALANCE_TABLE_NAME = 'JQuantsMarginBalance';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/margin-balance-batch/index') as { handler: () => Promise<void> };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const dataSource = require('../lambda/margin-balance-batch/data-source') as {
  fetchWeeklyBalances: jest.Mock;
  fetchDailyAlertBalances: jest.Mock;
};

beforeEach(() => {
  mockSend.mockReset();
  dataSource.fetchWeeklyBalances.mockReset();
  dataSource.fetchDailyAlertBalances.mockReset();
});

test('backfills 1-2 years for a ticker with no existing margin balance rows', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '7203' }] }) // yutai master scan
    .mockResolvedValueOnce({ Items: [] }); // margin balance query for 7203: empty → backfill
  dataSource.fetchWeeklyBalances.mockResolvedValueOnce([
    { date: '2025-01-06', financingBalance: 100, lendingBalance: 200, source: 'weekly' },
  ]);
  dataSource.fetchDailyAlertBalances.mockResolvedValueOnce([]);
  mockSend.mockResolvedValue({});

  await handler();

  expect(dataSource.fetchWeeklyBalances).toHaveBeenCalledTimes(1);
  const [, from, to] = dataSource.fetchWeeklyBalances.mock.calls[0];
  const spanDays = (new Date(to).getTime() - new Date(from).getTime()) / (24 * 60 * 60 * 1000);
  expect(spanDays).toBeGreaterThan(300); // 1年以上のバックフィル期間

  const putCalls = mockSend.mock.calls.filter(([cmd]) => 'Item' in (cmd as Record<string, unknown>));
  expect(putCalls[0][0]).toMatchObject({
    TableName: 'JQuantsMarginBalance',
    Item: { ticker: '7203', date: '2025-01-06', financingBalance: 100, lendingBalance: 200, source: 'weekly' },
  });
});

test('fetches only the recent diff for a ticker that already has margin balance rows', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '7203' }] })
    .mockResolvedValueOnce({ Items: [{ date: '2026-08-03' }] }); // already has data → not a backfill
  dataSource.fetchWeeklyBalances.mockResolvedValueOnce([]);
  dataSource.fetchDailyAlertBalances.mockResolvedValueOnce([]);

  await handler();

  const [, from, to] = dataSource.fetchWeeklyBalances.mock.calls[0];
  const spanDays = (new Date(to).getTime() - new Date(from).getTime()) / (24 * 60 * 60 * 1000);
  expect(spanDays).toBeLessThan(30); // 通常の日次差分取得(短い範囲)
});
