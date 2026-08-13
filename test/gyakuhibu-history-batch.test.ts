const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  GetCommand: jest.fn((input: unknown) => input),
  PutCommand: jest.fn((input: unknown) => input),
  QueryCommand: jest.fn((input: unknown) => input),
  ScanCommand: jest.fn((input: unknown) => input),
}));
jest.mock('../lambda/gyakuhibu-history-batch/taisyaku-client', () => ({
  fetchTaisyakuCsv: jest.fn(),
  parseTaisyakuCsv: jest.fn(),
}));

process.env.YUTAI_RIGHTS_DATE_TABLE_NAME = 'JQuantsYutaiRightsDate';
process.env.YUTAI_MASTER_TABLE_NAME = 'JQuantsYutaiMaster';
process.env.GYAKUHIBU_ACTUAL_TABLE_NAME = 'JQuantsGyakuhibuActual';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/gyakuhibu-history-batch/index') as { handler: () => Promise<void> };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const taisyakuClient = require('../lambda/gyakuhibu-history-batch/taisyaku-client') as {
  fetchTaisyakuCsv: jest.Mock;
  parseTaisyakuCsv: jest.Mock;
};

beforeEach(() => {
  mockSend.mockReset();
  taisyakuClient.fetchTaisyakuCsv.mockReset();
  taisyakuClient.parseTaisyakuCsv.mockReset();
});

test('fetches and upserts actual gyakuhibu only for past rights dates not yet in JQuantsGyakuhibuActual', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '7203', rightsDate: '2026-03-30' }] }) // rights-date scan (past)
    .mockResolvedValueOnce({ Item: undefined }) // not yet in gyakuhibu-actual
    .mockResolvedValueOnce({ Item: { ticker: '7203', unitShares: 100 } }); // yutai master lookup
  taisyakuClient.fetchTaisyakuCsv.mockResolvedValueOnce('csv-body');
  taisyakuClient.parseTaisyakuCsv.mockReturnValueOnce({
    rightsDate: '2026-03-30',
    totalAmount: 680,
    days: 2,
    avgRate: 0.4,
  });
  mockSend.mockResolvedValue({});

  await handler();

  const putCalls = mockSend.mock.calls.filter(([cmd]) => 'Item' in (cmd as Record<string, unknown>) && (cmd as { TableName?: string }).TableName === 'JQuantsGyakuhibuActual');
  expect(putCalls).toHaveLength(1);
  expect(putCalls[0][0]).toMatchObject({
    Item: { ticker: '7203', rightsDate: '2026-03-30', totalAmount: 680, days: 2, avgRate: 0.4 },
  });
});

test('writes a noGyakuhibu marker row (instead of nothing) when parseTaisyakuCsv finds no lending fee, so the date is not re-scraped forever', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '7203', rightsDate: '2026-03-30' }] }) // rights-date scan (past)
    .mockResolvedValueOnce({ Item: undefined }) // not yet in gyakuhibu-actual
    .mockResolvedValueOnce({ Item: { ticker: '7203', unitShares: 100 } }); // yutai master lookup
  taisyakuClient.fetchTaisyakuCsv.mockResolvedValueOnce('csv-body');
  taisyakuClient.parseTaisyakuCsv.mockReturnValueOnce(undefined); // no shortage occurred that day
  mockSend.mockResolvedValue({});

  await handler();

  const putCalls = mockSend.mock.calls.filter(([cmd]) => 'Item' in (cmd as Record<string, unknown>) && (cmd as { TableName?: string }).TableName === 'JQuantsGyakuhibuActual');
  expect(putCalls).toHaveLength(1);
  expect(putCalls[0][0]).toMatchObject({
    Item: { ticker: '7203', rightsDate: '2026-03-30', noGyakuhibu: true },
  });
});

test('skips rights dates older than 3 years', async () => {
  const fourYearsAgo = new Date();
  fourYearsAgo.setFullYear(fourYearsAgo.getFullYear() - 4);
  mockSend.mockResolvedValueOnce({
    Items: [{ ticker: '7203', rightsDate: fourYearsAgo.toISOString().slice(0, 10) }],
  });

  await handler();

  expect(taisyakuClient.fetchTaisyakuCsv).not.toHaveBeenCalled();
});
