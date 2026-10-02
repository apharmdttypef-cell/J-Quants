// このファイルをモジュールにする。トップレベルのimport/exportが無いとファイルの宣言が
// グローバルスコープに出てしまい、同名の宣言(mockSend・handlerなど)を持つ他のテスト
// ファイルとts-jestの型検査で衝突する(TS2451)。どのファイルが同じワーカーに割り当て
// られるかで発火するため非決定的に落ちていた。
export {};

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

test('persists detailUrl and listBadge from the list page', async () => {
  mockFetchAllListings.mockResolvedValueOnce([
    {
      ticker: '7472',
      companyName: '鳥羽洋行',
      content: 'オリジナルQUOカード（1,000円相当～）',
      rightsMonths: [5],
      value: 1000,
      minInvestment: 196800,
      detailUrl: 'https://www.kabuyutai.com/kobetu/toba.html',
      listBadge: 'chouki',
    },
  ]);
  mockSend.mockResolvedValue({});

  await handler();

  expect(mockSend).toHaveBeenCalledTimes(1);
  const input = mockSend.mock.calls[0][0] as {
    UpdateExpression: string;
    ExpressionAttributeValues: Record<string, unknown>;
  };
  expect(input.UpdateExpression).toContain('detailUrl = :detailUrl');
  expect(input.UpdateExpression).toContain('listBadge = :listBadge');
  expect(input.ExpressionAttributeValues[':detailUrl']).toBe('https://www.kabuyutai.com/kobetu/toba.html');
  expect(input.ExpressionAttributeValues[':listBadge']).toBe('chouki');
});

test('writes null for a ticker with no badge and no detail URL', async () => {
  mockFetchAllListings.mockResolvedValueOnce([
    {
      ticker: '2157',
      companyName: 'コシダカホールディングス',
      content: '割引券（2,000円相当～）',
      rightsMonths: [2, 8],
      value: 2000,
      minInvestment: 102200,
      detailUrl: undefined,
      listBadge: null,
    },
  ]);
  mockSend.mockResolvedValue({});

  await handler();

  const input = mockSend.mock.calls[0][0] as { ExpressionAttributeValues: Record<string, unknown> };
  expect(input.ExpressionAttributeValues[':detailUrl']).toBeNull();
  expect(input.ExpressionAttributeValues[':listBadge']).toBeNull();
});
