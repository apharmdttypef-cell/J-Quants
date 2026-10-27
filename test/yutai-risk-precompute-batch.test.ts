// このファイルをモジュールにする。トップレベルのimport/exportが無いとファイルの宣言が
// グローバルスコープに出てしまい、同名の宣言(mockSend・handlerなど)を持つ他のテスト
// ファイルとts-jestの型検査で衝突する(TS2451)。どのファイルが同じワーカーに割り当て
// られるかで発火するため非決定的に落ちていた。
export {};

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  QueryCommand: jest.fn((input: unknown) => input),
  ScanCommand: jest.fn((input: unknown) => input),
  UpdateCommand: jest.fn((input: unknown) => input),
}));

// 貸借区分は信用残バッチがtaisyaku.jpのCSVからマスタに書く。このバッチはJ-Quantsを呼ばない。
const mockGetApiKey = jest.fn();
jest.mock('../lambda/shared/jquants-batch-client', () => ({
  getApiKey: (...args: unknown[]) => mockGetApiKey(...args),
  fetchWithRetry: jest.fn(),
}));

process.env.YUTAI_MASTER_TABLE_NAME = 'JQuantsYutaiMaster';
process.env.TABLE_NAME = 'JQuantsStockPrices';
process.env.GYAKUHIBU_ACTUAL_TABLE_NAME = 'JQuantsGyakuhibuActual';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/yutai-risk-precompute-batch/index') as { handler: () => Promise<void> };

beforeEach(() => {
  mockSend.mockReset();
  mockGetApiKey.mockReset();
});

function updateCalls() {
  return mockSend.mock.calls.filter(
    ([cmd]) => 'UpdateExpression' in (cmd as Record<string, unknown>),
  );
}

test('writes null risk amounts when rightsMonths is empty (no upcoming rights date)', async () => {
  mockSend.mockResolvedValueOnce({
    Items: [{ ticker: '1234', marginName: '貸借', value: 1000, unitShares: 100, rightsMonths: [] }],
  }); // yutai master scan
  mockSend.mockResolvedValueOnce({ Items: [] }); // gyakuhibu actuals

  await handler();

  const calls = updateCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0][0]).toMatchObject({
    TableName: 'JQuantsYutaiMaster',
    Key: { ticker: '1234' },
    ExpressionAttributeValues: { ':maxGyakuhibu': null, ':maxRate': null, ':days': null, ':closePrice': null },
  });
});

test('the master scan projects only the attributes the batch reads', async () => {
  // benefitGroups(1銘柄0.7〜2KB × 1,642銘柄)はこのバッチでは使わないのに、Scanの
  // 1MBページングの往復回数を押し上げる。MasterRowに項目を足したときは射影にも
  // 足すこと(足し忘れると黙ってundefinedになる)。
  mockSend.mockResolvedValueOnce({ Items: [] }); // yutai master scan

  await handler();

  const scanInput = mockSend.mock.calls[0][0] as {
    ProjectionExpression: string;
    ExpressionAttributeNames: Record<string, string>;
  };
  expect(scanInput.ProjectionExpression.split(',').map((name) => name.trim())).toEqual([
    'ticker',
    'unitShares',
    'requiredShares',
    'rightsMonths',
    'marginName',
  ]);
  // 判定をやめたので優待価値(value)は読まない
  expect(scanInput.ExpressionAttributeNames).toBeUndefined();
});

test('writes null risk amounts when the margin classification is unknown (no stored marginName)', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '9942', value: 1000, unitShares: 100, rightsMonths: [8] }] }) // yutai master scan
    .mockResolvedValueOnce({ Items: [] }) // gyakuhibu actuals(区分不明でも走る)
    .mockResolvedValueOnce({}); // update

  await handler();

  const calls = updateCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0][0]).toMatchObject({
    ExpressionAttributeValues: { ':maxGyakuhibu': null, ':maxRate': null, ':days': null, ':closePrice': null },
  });
  expect(mockSend).toHaveBeenCalledTimes(3); // 株価Queryは呼ばない
});

test('writes null risk amounts when there is no price data for the ticker', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', marginName: '貸借', value: 1000, unitShares: 100, rightsMonths: [8] }] }) // yutai master scan
    .mockResolvedValueOnce({ Items: [] }) // latest close: none
    .mockResolvedValueOnce({ Items: [] }); // gyakuhibu actuals

  await handler();

  const calls = updateCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0][0]).toMatchObject({
    ExpressionAttributeValues: { ':maxGyakuhibu': null, ':maxRate': null, ':days': null, ':closePrice': null },
  });
});

test('writes the numeric risk fields including closePrice, and removes the old riskStatus verdict', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', marginName: '貸借', value: 100000, unitShares: 100, rightsMonths: [8] }] }) // yutai master scan
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', marginName: '貸借', date: '2026-08-12', close: 500 }] }) // latest close
    .mockResolvedValueOnce({ Items: [] }); // gyakuhibu actuals

  await handler();

  const calls = updateCalls();
  expect(calls).toHaveLength(1);
  const update = calls[0][0] as { UpdateExpression: string; ExpressionAttributeValues: Record<string, unknown> };
  const values = update.ExpressionAttributeValues;
  // 判定は逆日歩予測バッチが出す。旧方式の判定が残らないよう属性ごと消す
  expect(update.UpdateExpression).toContain('REMOVE riskStatus');
  expect(values).not.toHaveProperty(':riskStatus');
  expect(typeof values[':maxGyakuhibu']).toBe('number');
  expect(typeof values[':maxRate']).toBe('number');
  expect(typeof values[':days']).toBe('number');
  expect(values[':closePrice']).toBe(500); // 前日株価(latestCloseの値)がそのまま書き込まれる
});

test('computes maxGyakuhibu/maxRate/days even when value is null (優待価値が抽出できない銘柄)', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '9001', marginName: '貸借', unitShares: 100, rightsMonths: [8] }] }) // yutai master scan (valueフィールド無し = 東武鉄道のような銘柄)
    .mockResolvedValueOnce({ Items: [{ ticker: '9001', marginName: '貸借', date: '2026-08-12', close: 500 }] }) // latest close
    .mockResolvedValueOnce({ Items: [] }); // gyakuhibu actuals

  await handler();

  const calls = updateCalls();
  expect(calls).toHaveLength(1);
  const values = (calls[0][0] as { ExpressionAttributeValues: Record<string, unknown> }).ExpressionAttributeValues;
  expect(typeof values[':maxGyakuhibu']).toBe('number'); // valueの有無に関わらず計算される
  expect(typeof values[':maxRate']).toBe('number');
  expect(typeof values[':days']).toBe('number');
});

test('uses requiredShares instead of estimating from minInvestment', async () => {
  // 第一興商: 単元100株だが優待は200株。推定ではなく個別ページ由来の正確値を使う。
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '7458', marginName: '貸借', value: 5000, unitShares: 100, minInvestment: 400000, requiredShares: 200, rightsMonths: [3] }] })
    .mockResolvedValueOnce({ Items: [{ close: 2000 }] }) // 直近終値
    .mockResolvedValueOnce({ Items: [] }) // 逆日歩実績なし
    .mockResolvedValueOnce({}); // update

  await handler();

  const update = updateCalls()[0][0] as {
    UpdateExpression: string;
    ExpressionAttributeValues: Record<string, unknown>;
  };
  // unitSharesはもう書かない(単元株数の意味に戻した)
  expect(update.UpdateExpression).not.toContain('unitShares');
  expect(update.ExpressionAttributeValues).not.toHaveProperty(':unitShares');
  // 必要資金 = 終値 × 必要株数
  expect(update.ExpressionAttributeValues[':requiredInvestment']).toBe(400000);
});

test('falls back to unitShares when requiredShares has not been fetched yet', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '1111', marginName: '貸借', value: 3000, unitShares: 100, minInvestment: null, rightsMonths: [3] }] })
    .mockResolvedValueOnce({ Items: [{ close: 1500 }] })
    .mockResolvedValueOnce({ Items: [] })
    .mockResolvedValueOnce({});

  await handler();

  const update = updateCalls()[0][0] as { ExpressionAttributeValues: Record<string, unknown> };
  expect(update.ExpressionAttributeValues[':requiredInvestment']).toBe(150000);
});

test('aggregates the last and prior-year-same-month gyakuhibu costs', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '7458', marginName: '貸借', value: 5000, unitShares: 100, requiredShares: 200, rightsMonths: [3] }] })
    .mockResolvedValueOnce({ Items: [{ close: 2000 }] })
    .mockResolvedValueOnce({
      Items: [
        { rightsDate: '2024-03-27', avgRate: 1.0, days: 3 },
        { rightsDate: '2025-03-27', avgRate: 2.0, days: 3 },
      ],
    })
    .mockResolvedValueOnce({});

  await handler();

  const values = (updateCalls()[0][0] as { ExpressionAttributeValues: Record<string, unknown> })
    .ExpressionAttributeValues;
  const last = values[':lastGyakuhibu'] as { rightsDate: string; cost: number; basedOnUnitShares: boolean };
  expect(last.rightsDate).toBe('2025-03-27');
  expect(last.cost).toBe(1200); // 2.0 × 3日 × 200株
  expect(last.basedOnUnitShares).toBe(false);
});

test('writes null summaries for a ticker with no actual history', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '1111', marginName: '貸借', value: 3000, unitShares: 100, requiredShares: 100, rightsMonths: [3] }] })
    .mockResolvedValueOnce({ Items: [{ close: 1500 }] })
    .mockResolvedValueOnce({ Items: [] })
    .mockResolvedValueOnce({});

  await handler();

  const values = (updateCalls()[0][0] as { ExpressionAttributeValues: Record<string, unknown> })
    .ExpressionAttributeValues;
  expect(values[':lastGyakuhibu']).toBeNull();
  expect(values[':sameMonthLastYearGyakuhibu']).toBeNull();
});

test('still aggregates the actual history when maxGyakuhibu cannot be computed', async () => {
  // 貸借区分が不明で最大逆日歩が出せない銘柄でも、過去に実際に取られたコストは
  // 独立した事実なので一覧に出す価値がある。
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '9942', value: 3000, unitShares: 100, requiredShares: 100, rightsMonths: [3] }] })
    .mockResolvedValueOnce({ Items: [{ rightsDate: '2025-03-27', avgRate: 1.0, days: 2 }] })
    .mockResolvedValueOnce({});

  await handler();

  const values = (updateCalls()[0][0] as { ExpressionAttributeValues: Record<string, unknown> })
    .ExpressionAttributeValues;
  expect(values[':maxGyakuhibu']).toBeNull();
  expect((values[':lastGyakuhibu'] as { cost: number }).cost).toBe(200);
  expect(values[':requiredInvestment']).toBeNull();
});

test('applies the rights-day 4x rate multiplier (taisyaku.jp「倍率適用」) to maxRate and maxGyakuhibu', async () => {
  jest.useFakeTimers({
    doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick'],
  }).setSystemTime(new Date('2026-08-01T00:00:00Z'));

  try {
    mockSend
      .mockResolvedValueOnce({ Items: [{ ticker: '1234', marginName: '貸借', value: 100000, unitShares: 100, rightsMonths: [8] }] }) // yutai master scan
      .mockResolvedValueOnce({ Items: [{ ticker: '1234', marginName: '貸借', date: '2026-07-31', close: 500 }] }) // latest close
      .mockResolvedValueOnce({ Items: [] }); // gyakuhibu actuals

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
          { ticker: '1111', marginName: '貸借', value: 1000, unitShares: 100, rightsMonths: [] },
          { ticker: '2222', marginName: '貸借', value: 1000, unitShares: 100, rightsMonths: [] },
        ],
      }) // yutai master scan
      .mockResolvedValueOnce({ Items: [] }) // 1111's gyakuhibu actuals
      .mockRejectedValueOnce(new Error('DynamoDB error')) // 1111's UpdateCommand fails
      .mockResolvedValueOnce({ Items: [] }) // 2222's gyakuhibu actuals
      .mockResolvedValueOnce({}); // 2222's UpdateCommand succeeds

    await handler();

    const calls = updateCalls();
    expect(calls).toHaveLength(2);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('1111'), expect.any(Error));
  } finally {
    errorSpy.mockRestore();
  }
});

test('skips a row missing unitShares without crashing', async () => {
  mockSend.mockResolvedValueOnce({
    Items: [{ ticker: '9999', rightsMonths: [8] }], // unitSharesが欠落(valueも無いが、valueだけの欠落ではスキップされない)
  });

  await expect(handler()).resolves.not.toThrow();
  expect(updateCalls()).toHaveLength(0);
});

function updateValues(): Record<string, unknown> {
  return (updateCalls()[0][0] as { ExpressionAttributeValues: Record<string, unknown> }).ExpressionAttributeValues;
}

test('computes the gyakuhibu amounts for a ticker whose stored classification is 貸借', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', unitShares: 100, rightsMonths: [8], marginName: '貸借' }] }) // yutai master scan
    .mockResolvedValueOnce({ Items: [{ close: 500 }] }) // latest close
    .mockResolvedValueOnce({ Items: [] }) // gyakuhibu actuals
    .mockResolvedValueOnce({}); // update

  await handler();

  expect(typeof updateValues()[':maxGyakuhibu']).toBe('number');
});

test('for a 貸借融資 ticker (cannot be shorted under 制度信用), writes no gyakuhibu amounts or past costs but keeps the investment amount', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '1380', unitShares: 100, requiredShares: 100, rightsMonths: [8], marginName: '貸借融資' }] }) // yutai master scan
    .mockResolvedValueOnce({ Items: [{ close: 800 }] }) // latest close
    .mockResolvedValueOnce({}); // update

  await handler();

  const values = updateValues();
  expect(values[':maxGyakuhibu']).toBeNull();
  expect(values[':maxRate']).toBeNull();
  expect(values[':days']).toBeNull();
  // 発生しえない逆日歩の「前回0円」を出さない
  expect(values[':lastGyakuhibu']).toBeNull();
  expect(values[':sameMonthLastYearGyakuhibu']).toBeNull();
  // 一般信用でクロスする場合も必要資金は要る
  expect(values[':closePrice']).toBe(800);
  expect(values[':requiredInvestment']).toBe(80000);
  // 信用残の有無も逆日歩実績も見に行かない(scan・終値・updateの3回だけ)
  expect(mockSend).toHaveBeenCalledTimes(3);
});

test('treats a ticker without a stored classification (no TSE row) as unknown, not as 一般信用のみ', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '9942', unitShares: 100, rightsMonths: [8] }] }) // yutai master scan
    .mockResolvedValueOnce({ Items: [] }) // gyakuhibu actuals
    .mockResolvedValueOnce({}); // update

  await handler();

  expect(updateValues()[':maxGyakuhibu']).toBeNull();
  expect(updateValues()[':lastGyakuhibu']).toBeNull();
});

test('never queries the margin balance table', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', marginName: '貸借', unitShares: 100, rightsMonths: [8] }] }) // yutai master scan
    .mockResolvedValueOnce({ Items: [{ close: 500 }] }) // latest close
    .mockResolvedValueOnce({ Items: [] }) // gyakuhibu actuals
    .mockResolvedValueOnce({}); // update

  await handler();

  expect(mockSend.mock.calls.some(([cmd]) => (cmd as { TableName?: string }).TableName === 'JQuantsMarginBalance')).toBe(false);
  expect(typeof updateValues()[':maxGyakuhibu']).toBe('number');
});

test('a stored J-Quants-era 信用 value is still treated as 一般信用のみ (until the margin balance batch rewrites it)', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '1380', unitShares: 100, rightsMonths: [8], marginName: '信用' }] })
    .mockResolvedValueOnce({ Items: [{ close: 800 }] })
    .mockResolvedValueOnce({});

  await handler();

  expect(updateValues()[':maxGyakuhibu']).toBeNull();
  expect(updateValues()[':requiredInvestment']).toBe(80000);
});

test('never calls J-Quants and never writes marginName (the margin balance batch owns it)', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', unitShares: 100, rightsMonths: [8], marginName: '貸借' }] })
    .mockResolvedValueOnce({ Items: [{ close: 500 }] })
    .mockResolvedValueOnce({ Items: [] })
    .mockResolvedValueOnce({});

  await handler();

  expect(mockGetApiKey).not.toHaveBeenCalled();
  const update = updateCalls()[0][0] as { UpdateExpression: string; ExpressionAttributeValues: Record<string, unknown> };
  expect(update.UpdateExpression).not.toContain('marginName');
  expect(update.ExpressionAttributeValues).not.toHaveProperty(':marginName');
});
