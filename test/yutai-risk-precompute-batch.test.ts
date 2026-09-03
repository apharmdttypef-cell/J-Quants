const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  QueryCommand: jest.fn((input: unknown) => input),
  ScanCommand: jest.fn((input: unknown) => input),
  UpdateCommand: jest.fn((input: unknown) => input),
}));

process.env.YUTAI_MASTER_TABLE_NAME = 'JQuantsYutaiMaster';
process.env.MARGIN_BALANCE_TABLE_NAME = 'JQuantsMarginBalance';
process.env.TABLE_NAME = 'JQuantsStockPrices';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/yutai-risk-precompute-batch/index') as { handler: () => Promise<void> };

beforeEach(() => {
  mockSend.mockReset();
});

function updateCalls() {
  return mockSend.mock.calls.filter(
    ([cmd]) => 'UpdateExpression' in (cmd as Record<string, unknown>),
  );
}

test('writes riskStatus na when rightsMonths is empty (no upcoming rights date)', async () => {
  mockSend.mockResolvedValueOnce({
    Items: [{ ticker: '1234', value: 1000, unitShares: 100, rightsMonths: [] }],
  }); // yutai master scan

  await handler();

  const calls = updateCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0][0]).toMatchObject({
    TableName: 'JQuantsYutaiMaster',
    Key: { ticker: '1234' },
    ExpressionAttributeValues: { ':riskStatus': 'na', ':maxGyakuhibu': null, ':maxRate': null, ':days': null },
  });
});

test('writes riskStatus na when there is no margin balance data for the ticker', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', value: 1000, unitShares: 100, rightsMonths: [8] }] }) // yutai master scan
    .mockResolvedValueOnce({ Items: [] }); // margin balance presence: none

  await handler();

  const calls = updateCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0][0]).toMatchObject({
    ExpressionAttributeValues: { ':riskStatus': 'na', ':maxGyakuhibu': null, ':maxRate': null, ':days': null },
  });
});

test('writes riskStatus na when there is no price data for the ticker', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', value: 1000, unitShares: 100, rightsMonths: [8] }] }) // yutai master scan
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', date: '2026-08-10' }] }) // margin balance presence: yes
    .mockResolvedValueOnce({ Items: [] }); // latest close: none

  await handler();

  const calls = updateCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0][0]).toMatchObject({
    ExpressionAttributeValues: { ':riskStatus': 'na', ':maxGyakuhibu': null, ':maxRate': null, ':days': null },
  });
});

test('computes safe/danger based on value vs maxGyakuhibu and writes the numeric fields', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', value: 100000, unitShares: 100, rightsMonths: [8] }] }) // yutai master scan
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', date: '2026-08-10' }] }) // margin balance presence: yes
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', date: '2026-08-12', close: 500 }] }); // latest close

  await handler();

  const calls = updateCalls();
  expect(calls).toHaveLength(1);
  const values = (calls[0][0] as { ExpressionAttributeValues: Record<string, unknown> }).ExpressionAttributeValues;
  expect(values[':riskStatus']).toBe('safe'); // value=100000は十分大きいのでmaxGyakuhibuを上回るはず
  expect(typeof values[':maxGyakuhibu']).toBe('number');
  expect(typeof values[':maxRate']).toBe('number');
  expect(typeof values[':days']).toBe('number');
});

test('derives unitShares from minInvestment÷closePrice when it implies more than the stored default (第一興商-style: 単元100株だが優待には200株必要)', async () => {
  mockSend
    .mockResolvedValueOnce({
      Items: [{ ticker: '7458', value: 5000, unitShares: 100, minInvestment: 378600, rightsMonths: [8] }],
    }) // yutai master scan (unitSharesは単元株数のまま100で保存されている)
    .mockResolvedValueOnce({ Items: [{ ticker: '7458', date: '2026-08-10' }] }) // margin balance presence: yes
    .mockResolvedValueOnce({ Items: [{ ticker: '7458', date: '2026-08-12', close: 1893 }] }); // latest close

  await handler();

  const values = (updateCalls()[0][0] as { ExpressionAttributeValues: Record<string, unknown> }).ExpressionAttributeValues;
  // 378,600円 ÷ 1,893円 = 200.0 → 100株単位に丸めて200株。
  expect(values[':unitShares']).toBe(200);
});

test('falls back to the stored unitShares when minInvestment is unavailable', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '9999', value: 1000, unitShares: 100, rightsMonths: [8] }] }) // minInvestmentフィールド無し
    .mockResolvedValueOnce({ Items: [{ ticker: '9999', date: '2026-08-10' }] })
    .mockResolvedValueOnce({ Items: [{ ticker: '9999', date: '2026-08-12', close: 500 }] });

  await handler();

  const values = (updateCalls()[0][0] as { ExpressionAttributeValues: Record<string, unknown> }).ExpressionAttributeValues;
  expect(values[':unitShares']).toBe(100);
});

test('applies the rights-day 4x rate multiplier (taisyaku.jp「倍率適用」) to maxRate and maxGyakuhibu', async () => {
  jest.useFakeTimers({
    doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick'],
  }).setSystemTime(new Date('2026-08-01T00:00:00Z'));

  try {
    mockSend
      .mockResolvedValueOnce({ Items: [{ ticker: '1234', value: 100000, unitShares: 100, rightsMonths: [8] }] }) // yutai master scan
      .mockResolvedValueOnce({ Items: [{ ticker: '1234', date: '2026-08-10' }] }) // margin balance presence: yes
      .mockResolvedValueOnce({ Items: [{ ticker: '1234', date: '2026-07-31', close: 500 }] }); // latest close

    await handler();

    const calls = updateCalls();
    expect(calls).toHaveLength(1);
    const values = (calls[0][0] as { ExpressionAttributeValues: Record<string, unknown> }).ExpressionAttributeValues;
    // rightsDate=2026-08-27(2026年8月の権利付き最終日), settlement=2026-08-31, followingTradingDay=2026-09-01, days=1。
    // close=500・unitShares=100 → investmentUnit=50,000ちょうど → 通常時cap=100円 → 通常時maxRate=1.0円。
    // 権利付き最終日(=権利落日の前営業日)は taisyaku.jp の「倍率適用」規定により最高料率が常に4倍になるため、
    // maxRate=4.0円、maxGyakuhibu=4.0円×100株×1日=400円。
    expect(values[':days']).toBe(1);
    expect(values[':maxRate']).toBe(4.0);
    expect(values[':maxGyakuhibu']).toBe(400);
  } finally {
    jest.useRealTimers();
  }
});

test('continues past a single row failure and processes the remaining rows', async () => {
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    mockSend
      .mockResolvedValueOnce({
        Items: [
          { ticker: '1111', value: 1000, unitShares: 100, rightsMonths: [] },
          { ticker: '2222', value: 1000, unitShares: 100, rightsMonths: [] },
        ],
      }) // yutai master scan
      .mockRejectedValueOnce(new Error('DynamoDB error')) // 1111's UpdateCommand fails
      .mockResolvedValueOnce({}); // 2222's UpdateCommand succeeds

    await handler();

    const calls = updateCalls();
    expect(calls).toHaveLength(2);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('1111'), expect.any(Error));
  } finally {
    errorSpy.mockRestore();
  }
});

test('skips a row missing value or unitShares without crashing', async () => {
  mockSend.mockResolvedValueOnce({
    Items: [{ ticker: '9999', rightsMonths: [8] }], // valueもunitSharesも欠落
  });

  await expect(handler()).resolves.not.toThrow();
  expect(updateCalls()).toHaveLength(0);
});
