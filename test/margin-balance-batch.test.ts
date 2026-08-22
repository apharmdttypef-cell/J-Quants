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

test('defers new backfills beyond the per-run cap, but still applies diff updates to already-covered tickers', async () => {
  const backfillTickers = Array.from({ length: 151 }, (_, i) => `T${String(i).padStart(4, '0')}`);
  const diffTicker = '7203';
  const allTickers = [...backfillTickers, diffTicker];

  mockSend.mockImplementation((cmd: Record<string, unknown>) => {
    if (cmd.TableName === 'JQuantsYutaiMaster') {
      return Promise.resolve({ Items: allTickers.map((ticker) => ({ ticker })) });
    }
    if ('KeyConditionExpression' in cmd) {
      const values = cmd.ExpressionAttributeValues as Record<string, string>;
      const hasData = values[':ticker'] === diffTicker;
      return Promise.resolve({ Items: hasData ? [{ date: '2026-08-01' }] : [] });
    }
    return Promise.resolve({}); // PutCommand
  });
  dataSource.fetchWeeklyBalances.mockResolvedValue([]);
  dataSource.fetchDailyAlertBalances.mockResolvedValue([]);

  await handler();

  // 151件が新規バックフィル対象だが上限150に達した時点で151件目は次回に持ち越し。
  // 既存データがあるdiffTickerは上限と無関係に毎回処理される。
  expect(dataSource.fetchWeeklyBalances).toHaveBeenCalledTimes(151);
  const processedTickers = dataSource.fetchWeeklyBalances.mock.calls.map(([ticker]) => ticker);
  expect(processedTickers).toContain(backfillTickers[0]);
  expect(processedTickers).toContain(backfillTickers[149]);
  expect(processedTickers).not.toContain(backfillTickers[150]);
  expect(processedTickers).toContain(diffTicker);
});
