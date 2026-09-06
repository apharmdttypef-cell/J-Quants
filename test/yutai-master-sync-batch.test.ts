const mockSend = jest.fn();
const mockFetchAllListings = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  UpdateCommand: jest.fn((input: unknown) => input),
}));
jest.mock('../lambda/shared/kabuyutai-client', () => ({
  fetchAllListings: (...args: unknown[]) => mockFetchAllListings(...args),
}));

process.env.YUTAI_MASTER_TABLE_NAME = 'JQuantsYutaiMaster';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/yutai-master-sync-batch/index') as { handler: () => Promise<void> };

beforeEach(() => {
  mockSend.mockReset();
  mockFetchAllListings.mockReset();
});

test('upserts each listed entry with unitShares fixed at 100 and minInvestment carried through', async () => {
  mockFetchAllListings.mockResolvedValueOnce([
    {
      ticker: '2157',
      companyName: 'コシダカホールディングス',
      content: '割引券（2,000円相当～）',
      rightsMonths: [2, 8],
      value: 2000,
      minInvestment: 102200,
    },
  ]);
  mockSend.mockResolvedValue({});

  await handler();

  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockSend.mock.calls[0][0]).toMatchObject({
    TableName: 'JQuantsYutaiMaster',
    Key: { ticker: '2157' },
    ExpressionAttributeValues: {
      ':companyName': 'コシダカホールディングス',
      ':content': '割引券（2,000円相当～）',
      ':value': 2000,
      ':unitShares': 100,
      ':minInvestment': 102200,
      ':rightsMonths': [2, 8],
    },
  });
});

test('coalesces a missing minInvestment to null rather than leaving it undefined', async () => {
  mockFetchAllListings.mockResolvedValueOnce([
    { ticker: '5555', companyName: 'C社', content: '特典あり（1点～）', rightsMonths: [6], value: 100, minInvestment: undefined },
  ]);
  mockSend.mockResolvedValue({});

  await handler();

  expect(mockSend.mock.calls[0][0]).toMatchObject({
    ExpressionAttributeValues: { ':minInvestment': null },
  });
});

test('upserts an entry with no extractable value as value: null instead of skipping it', async () => {
  mockFetchAllListings.mockResolvedValueOnce([
    { ticker: '9001', companyName: '東武鉄道', content: '優待乗車証（回数券：2枚～）など', rightsMonths: [3], value: undefined, minInvestment: undefined },
  ]);
  mockSend.mockResolvedValue({});

  await handler();

  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockSend.mock.calls[0][0]).toMatchObject({
    TableName: 'JQuantsYutaiMaster',
    Key: { ticker: '9001' },
    ExpressionAttributeValues: expect.objectContaining({ ':value': null }),
  });
});

test('skips an entry with no rightsMonths, logging a warning', async () => {
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    mockFetchAllListings.mockResolvedValueOnce([
      { ticker: '2222', companyName: 'テスト企業2', content: 'QUOカード（500円相当～）', rightsMonths: [], value: 500 },
    ]);

    await handler();

    expect(mockSend).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('2222'));
  } finally {
    warnSpy.mockRestore();
  }
});

test('continues past a single upsert failure and processes the remaining entries', async () => {
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    mockFetchAllListings.mockResolvedValueOnce([
      { ticker: '3333', companyName: 'A社', content: 'QUOカード（500円相当～）', rightsMonths: [3], value: 500 },
      { ticker: '4444', companyName: 'B社', content: '商品券（1,000円相当～）', rightsMonths: [9], value: 1000 },
    ]);
    mockSend.mockRejectedValueOnce(new Error('DynamoDB error')).mockResolvedValueOnce({});

    await handler();

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('3333'), expect.any(Error));
  } finally {
    errorSpy.mockRestore();
  }
});
