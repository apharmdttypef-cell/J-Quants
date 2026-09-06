import { marshall } from '@aws-sdk/util-dynamodb';

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  QueryCommand: jest.fn((input: unknown) => input),
  ScanCommand: jest.fn((input: unknown) => input),
  PutCommand: jest.fn((input: unknown) => input),
}));

process.env.YUTAI_MASTER_TABLE_NAME = 'JQuantsYutaiMaster';
process.env.GYAKUHIBU_ACTUAL_TABLE_NAME = 'JQuantsGyakuhibuActual';
process.env.MARGIN_BALANCE_TABLE_NAME = 'JQuantsMarginBalance';
process.env.GYAKUHIBU_FORECAST_TABLE_NAME = 'JQuantsGyakuhibuForecast';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/gyakuhibu-forecast-batch/index') as { handler: () => Promise<void> };

beforeEach(() => {
  mockSend.mockReset();
});

function putCalls() {
  return mockSend.mock.calls.filter(([cmd]) => 'Item' in (cmd as Record<string, unknown>));
}

function withFixedNow(fn: () => Promise<void>): Promise<void> {
  jest.useFakeTimers({
    doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick'],
  }).setSystemTime(new Date('2026-08-01T00:00:00Z'));
  return fn().finally(() => jest.useRealTimers());
}

test('writes the _POOL_ row before any ticker row', async () => {
  await withFixedNow(async () => {
    mockSend
      .mockResolvedValueOnce({ Items: [{ ticker: '1234', value: 1000, unitShares: 100, rightsMonths: [8], maxGyakuhibu: 5000 }] }) // yutai master scan
      .mockResolvedValueOnce({ Items: [] }) // gyakuhibu actual scan (履歴なし)
      .mockResolvedValueOnce({}) // _POOL_ put
      .mockResolvedValueOnce({ Items: [] }) // 1234のmargin balance query
      .mockResolvedValueOnce({}); // 1234のforecast put

    await handler();

    const puts = putCalls();
    expect(puts).toHaveLength(2);
    expect((puts[0][0] as { Item: { ticker: string } }).Item.ticker).toBe('_POOL_');
    expect((puts[1][0] as { Item: { ticker: string } }).Item.ticker).toBe('1234');
  });
});

test('computes a forecast per ticker using its own rights history and the pool', async () => {
  await withFixedNow(async () => {
    mockSend
      .mockResolvedValueOnce({ Items: [{ ticker: '1234', value: 1000, unitShares: 100, rightsMonths: [8], maxGyakuhibu: 5000 }] }) // yutai master scan
      .mockResolvedValueOnce({
        Items: [
          {
            ticker: '1234', rightsDate: '2025-08-27', financingBalance: 100, lendingBalance: 250,
            avgRate: 10, days: 1, maxRateActual: 10, restriction: null, emergencyMeasure: null, enriched: true,
          },
        ],
      }) // gyakuhibu actual scan(同銘柄・同月の権利日履歴が1件)
      .mockResolvedValueOnce({}) // _POOL_ put
      .mockResolvedValueOnce({ Items: [] }) // margin balance query(銘柄自身の履歴があるので使われないはず)
      .mockResolvedValueOnce({}); // 1234のforecast put

    await handler();

    const tickerPut = putCalls().find((c) => (c[0] as { Item: { ticker: string } }).Item.ticker === '1234')!;
    const item = (tickerPut[0] as { Item: Record<string, unknown> }).Item;
    expect(item.rightsDate).toBe('2026-08-27');
    expect(item.scenario).toBe('last-rights');
    expect(item.tickerSamples).toBe(1);
    // 手計算: 唯一の履歴行がticker自身の分・プール全体の分の両方を兼ねる(n_t=1, n_p=1)。
    // w=1/(1+4)=0.2、両方ともfillRatio=1なので、加重しても分位点・平均とも1のまま。
    // forecastP90 = 1 * maxGyakuhibu(5000) = 5000。value(1000) <= forecastP50(5000)なのでdanger。
    expect(item.forecastP90).toBe(5000);
    expect(item.forecastStatus).toBe('danger');
  });
});

test('writes a forecast row (with forecastStatus na) for a ticker whose yutai value is unknown', async () => {
  await withFixedNow(async () => {
    mockSend
      .mockResolvedValueOnce({ Items: [{ ticker: '9001', unitShares: 100, rightsMonths: [8], maxGyakuhibu: 5000 }] }) // yutai master scan (valueフィールド無し)
      .mockResolvedValueOnce({
        Items: [
          {
            ticker: '9001', rightsDate: '2025-08-27', financingBalance: 100, lendingBalance: 250,
            avgRate: 10, days: 1, maxRateActual: 10, restriction: null, emergencyMeasure: null, enriched: true,
          },
        ],
      }) // gyakuhibu actual scan
      .mockResolvedValueOnce({}) // _POOL_ put
      .mockResolvedValueOnce({ Items: [] }) // margin balance query
      .mockResolvedValueOnce({}); // 9001のforecast put

    await handler();

    const puts = putCalls();
    expect(puts).toHaveLength(2);
    const item = (puts[1][0] as { Item: Record<string, unknown> }).Item;
    expect(item.ticker).toBe('9001');
    expect(item.forecastStatus).toBe('na'); // valueが無いので判定不能
    expect(typeof item.forecastP50).toBe('number'); // 分布自体は計算される
  });
});

test('continues with the next ticker when one ticker throws', async () => {
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await withFixedNow(async () => {
      mockSend
        .mockResolvedValueOnce({
          Items: [
            { ticker: '1111', value: 1000, unitShares: 100, rightsMonths: [8], maxGyakuhibu: 5000 },
            { ticker: '2222', value: 1000, unitShares: 100, rightsMonths: [8], maxGyakuhibu: 5000 },
          ],
        }) // yutai master scan
        .mockResolvedValueOnce({ Items: [] }) // gyakuhibu actual scan
        .mockResolvedValueOnce({}) // _POOL_ put
        .mockRejectedValueOnce(new Error('DynamoDB error')) // 1111のmargin balance queryが失敗
        .mockResolvedValueOnce({ Items: [] }) // 2222のmargin balance query
        .mockResolvedValueOnce({}); // 2222のforecast put

      await handler();

      const tickerPuts = putCalls().filter((c) => (c[0] as { Item: { ticker: string } }).Item.ticker !== '_POOL_');
      expect(tickerPuts).toHaveLength(1);
      expect((tickerPuts[0][0] as { Item: { ticker: string } }).Item.ticker).toBe('2222');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('1111'), expect.any(Error));
    });
  } finally {
    errorSpy.mockRestore();
  }
});

test('marks tickers without maxGyakuhibu as na even when sample history exists', async () => {
  await withFixedNow(async () => {
    mockSend
      .mockResolvedValueOnce({ Items: [{ ticker: '1234', value: 1000, unitShares: 100, rightsMonths: [8], maxGyakuhibu: null }] }) // risk-precompute未実行(maxGyakuhibuがまだ無い)
      .mockResolvedValueOnce({
        Items: [
          {
            ticker: '1234', rightsDate: '2025-08-27', financingBalance: 100, lendingBalance: 250,
            avgRate: 10, days: 1, maxRateActual: 10, restriction: null, emergencyMeasure: null, enriched: true,
          },
        ],
      }) // 履歴自体はある(n_t=1) -- naの原因がサンプル不足ではなくmaxGyakuhibu欠落そのものであることを分離するため
      .mockResolvedValueOnce({}) // _POOL_ put
      .mockResolvedValueOnce({ Items: [] }) // margin balance query
      .mockResolvedValueOnce({}); // 1234のforecast put

    await handler();

    const tickerPut = putCalls().find((c) => (c[0] as { Item: { ticker: string } }).Item.ticker === '1234')!;
    const item = (tickerPut[0] as { Item: Record<string, unknown> }).Item;
    expect(item.tickerSamples).toBe(1); // サンプルはある
    expect(item.forecastStatus).toBe('na'); // それでもmaxGyakuhibuが無いのでna
  });
});

test('every PutCommand Item survives real DynamoDB marshalling (no Infinity/-Infinity reaches storage)', async () => {
  await withFixedNow(async () => {
    mockSend
      .mockResolvedValueOnce({ Items: [{ ticker: '1234', value: 1000, unitShares: 100, rightsMonths: [8], maxGyakuhibu: 5000 }] }) // yutai master scan
      .mockResolvedValueOnce({
        Items: [
          {
            ticker: '1234', rightsDate: '2025-08-27', financingBalance: 0, lendingBalance: 250,
            avgRate: 10, days: 1, maxRateActual: 10, restriction: null, emergencyMeasure: null, enriched: true,
          },
        ],
      }) // financingBalance:0, lendingBalance>0 -> excessRatio = Infinity (実在しうる状態)
      .mockResolvedValueOnce({}) // _POOL_ put
      .mockResolvedValueOnce({ Items: [] }) // margin balance query
      .mockResolvedValueOnce({}); // 1234のforecast put

    await handler();

    for (const [cmd] of putCalls()) {
      const { Item } = cmd as { Item: Record<string, unknown> };
      expect(() => marshall(Item)).not.toThrow();
    }
  });
});
