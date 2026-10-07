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
process.env.TSE_MARGIN_FEATURES_ENABLED = 'false';

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
      .mockResolvedValueOnce({}); // 1234のforecast put

    await handler();

    const puts = putCalls();
    expect(puts).toHaveLength(2);
    expect((puts[0][0] as { Item: { ticker: string } }).Item.ticker).toBe('_POOL_');
    expect((puts[1][0] as { Item: { ticker: string } }).Item.ticker).toBe('1234');
  });
});

test('does not fall back to current-tse: a ticker with no history gets scenario none and never queries the margin table', async () => {
  await withFixedNow(async () => {
    mockSend
      .mockResolvedValueOnce({ Items: [{ ticker: '1234', value: 1000, unitShares: 100, rightsMonths: [8], maxGyakuhibu: 5000 }] }) // yutai master scan
      .mockResolvedValueOnce({ Items: [] }) // gyakuhibu actual scan (履歴なし)
      .mockResolvedValueOnce({}) // _POOL_ put
      .mockResolvedValueOnce({}); // 1234のforecast put

    await handler();

    const item = (putCalls()[1][0] as { Item: Record<string, unknown> }).Item;
    expect(item.scenario).toBe('none');
    expect(item.forecastStatus).toBe('na');
    // 銘柄ごとのQueryCommand(旧latestMarginBalance)は発行されない
    expect(mockSend.mock.calls.some(([cmd]) => 'KeyConditionExpression' in (cmd as Record<string, unknown>))).toBe(false);
  });
});

test('marks a ticker that cannot be shorted under 制度信用 (信用/その他) as general-only instead of forecasting it', async () => {
  await withFixedNow(async () => {
    mockSend
      .mockResolvedValueOnce({
        Items: [
          { ticker: '8798', value: 1000, unitShares: 100, rightsMonths: [8], maxGyakuhibu: null, marginName: '信用' },
          { ticker: '1234', value: 1000, unitShares: 100, rightsMonths: [8], maxGyakuhibu: 5000, marginName: '貸借' },
        ],
      }) // yutai master scan
      .mockResolvedValueOnce({
        Items: [
          // 8798は貸借だった頃の実績を持つが、今は制度信用で売れないので予測しない
          {
            ticker: '8798', rightsDate: '2025-08-27', financingBalance: 100, lendingBalance: 250,
            avgRate: 10, days: 1, maxRateActual: 10, restriction: null, emergencyMeasure: null, enriched: true,
          },
        ],
      }) // gyakuhibu actual scan
      .mockResolvedValueOnce({}) // _POOL_ put
      .mockResolvedValueOnce({}) // 8798のforecast put
      .mockResolvedValueOnce({}); // 1234のforecast put

    await handler();

    const itemOf = (ticker: string) =>
      (putCalls().find((c) => (c[0] as { Item: { ticker: string } }).Item.ticker === ticker)![0] as { Item: Record<string, unknown> }).Item;
    const generalOnly = itemOf('8798');
    expect(generalOnly.forecastStatus).toBe('general-only');
    expect(generalOnly.fillP90).toBeNull();
    expect(generalOnly.forecastP90).toBeNull();
    expect(itemOf('1234').forecastStatus).not.toBe('general-only');
  });
});

test('forecasts a ticker whose margin classification is unknown (東証外上場など) as usual', async () => {
  await withFixedNow(async () => {
    mockSend
      .mockResolvedValueOnce({ Items: [{ ticker: '9942', value: 1000, unitShares: 100, rightsMonths: [8], maxGyakuhibu: null }] }) // marginNameなし
      .mockResolvedValueOnce({ Items: [] }) // gyakuhibu actual scan
      .mockResolvedValueOnce({}) // _POOL_ put
      .mockResolvedValueOnce({}); // 9942のforecast put

    await handler();

    expect((putCalls()[1][0] as { Item: Record<string, unknown> }).Item.forecastStatus).toBe('na');
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

test('judges a ticker whose yutai value is unknown (the status depends only on the fill ratio)', async () => {
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
      .mockResolvedValueOnce({}); // 9001のforecast put

    await handler();

    const puts = putCalls();
    expect(puts).toHaveLength(2);
    const item = (puts[1][0] as { Item: Record<string, unknown> }).Item;
    expect(item.ticker).toBe('9001');
    expect(item.forecastStatus).toBe('danger'); // 充足率1.0の実績1件 → P90=100%
    expect(item.expectedNet).toBeNull(); // 優待価値との差額だけは出せない
    expect(typeof item.forecastP50).toBe('number');
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
        .mockRejectedValueOnce(new Error('DynamoDB error')) // 1111のforecast putが失敗
        .mockResolvedValueOnce({}); // 2222のforecast put

      await handler();

      const tickerPuts = putCalls().filter((c) => (c[0] as { Item: { ticker: string } }).Item.ticker !== '_POOL_');
      expect(tickerPuts.map((c) => (c[0] as { Item: { ticker: string } }).Item.ticker)).toEqual(['1111', '2222']);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('1111'), expect.any(Error));
    });
  } finally {
    errorSpy.mockRestore();
  }
});

test('judges tickers without maxGyakuhibu by fill ratio, leaving only the yen amounts null', async () => {
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
      }) // 履歴はある(n_t=1)
      .mockResolvedValueOnce({}) // _POOL_ put
      .mockResolvedValueOnce({}); // 1234のforecast put

    await handler();

    const tickerPut = putCalls().find((c) => (c[0] as { Item: { ticker: string } }).Item.ticker === '1234')!;
    const item = (tickerPut[0] as { Item: Record<string, unknown> }).Item;
    expect(item.tickerSamples).toBe(1);
    expect(item.forecastStatus).toBe('danger'); // 充足率1.0の実績1件 → P90=100%
    expect(item.forecastP90).toBeNull(); // 金額は出せない
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
      .mockResolvedValueOnce({}); // 1234のforecast put

    await handler();

    for (const [cmd] of putCalls()) {
      const { Item } = cmd as { Item: Record<string, unknown> };
      expect(() => marshall(Item)).not.toThrow();
    }
  });
});

function withTseEnabled(fn: () => Promise<void>): Promise<void> {
  process.env.TSE_MARGIN_FEATURES_ENABLED = 'true';
  return fn().finally(() => {
    process.env.TSE_MARGIN_FEATURES_ENABLED = 'false';
  });
}

test('writes _POOL_TSE_ after _POOL_ and a tseForecast per ticker when the flag is on', async () => {
  await withTseEnabled(() =>
    withFixedNow(async () => {
      mockSend
        .mockResolvedValueOnce({ Items: [{ ticker: '1234', value: 1000, unitShares: 100, rightsMonths: [8], maxGyakuhibu: 5000 }] }) // yutai master scan
        .mockResolvedValueOnce({
          Items: [
            {
              ticker: '1234', rightsDate: '2025-08-27', financingBalance: 100, lendingBalance: 250,
              avgRate: 10, days: 1, maxRateActual: 10, restriction: null, emergencyMeasure: null, enriched: true,
            },
          ],
        }) // gyakuhibu actual scan
        .mockResolvedValueOnce({
          Items: [
            { ticker: '1234', date: '2025-08-01', financingBalance: 100, lendingBalance: 250, source: 'weekly' }, // 権利日2025-08-27の26日前(バケット'22+'のサンプル用、超過率1.5)
            { ticker: '1234', date: '2026-07-03', financingBalance: 100, lendingBalance: 25, source: 'weekly' }, // 4週前比の基準
            { ticker: '1234', date: '2026-07-31', financingBalance: 100, lendingBalance: 50, source: 'weekly' }, // 直近(today=2026-08-01)
          ],
        }) // margin balance scan
        .mockResolvedValueOnce({}) // _POOL_ put
        .mockResolvedValueOnce({}) // _POOL_TSE_ put
        .mockResolvedValueOnce({}); // 1234のforecast put

      await handler();

      const puts = putCalls();
      expect(puts.map((c) => (c[0] as { Item: { ticker: string } }).Item.ticker)).toEqual(['_POOL_', '_POOL_TSE_', '1234']);

      const pool = (puts[1][0] as { Item: { buckets: Record<string, unknown[]> } }).Item;
      expect(Object.keys(pool.buckets).sort()).toEqual(['0-7', '22+', '8-21']);
      expect(pool.buckets['22+']).toHaveLength(6);

      const tse = (puts[2][0] as { Item: { tseForecast: Record<string, unknown> } }).Item.tseForecast;
      // 直近スナップショット2026-07-31 → 次回権利日2026-08-27 まで27日 → バケット'22+'。
      expect(tse.snapshotDate).toBe('2026-07-31');
      expect(tse.lagDays).toBe(27);
      expect(tse.lagBucket).toBe('22+');
      expect(tse.scenario).toBe('current-tse');
      // 超過率 (50-100)/100 = -0.5 → 融資超過ビン。プールに同ビンのサンプルは無く、自銘柄の
      // '22+'サンプル(2025-08-01時点の超過率1.5、充足率1)だけで w=1 → forecastP50 = 1×5000。
      expect(tse.bin).toBe('融資超過');
      expect(tse.forecastP50).toBe(5000);
      expect(tse.forecastStatus).toBe('danger'); // value 1000 <= P50 5000
      expect(tse.lendingGrowth4w).toBeCloseTo(2); // 50 / 25
    }),
  );
});

test('skips the TSE step entirely when the flag is off (no margin scan, no _POOL_TSE_, no tseForecast attribute)', async () => {
  await withFixedNow(async () => {
    mockSend
      .mockResolvedValueOnce({ Items: [{ ticker: '1234', value: 1000, unitShares: 100, rightsMonths: [8], maxGyakuhibu: 5000 }] }) // yutai master scan
      .mockResolvedValueOnce({ Items: [] }) // gyakuhibu actual scan
      .mockResolvedValueOnce({}) // _POOL_ put
      .mockResolvedValueOnce({}); // 1234のforecast put

    await handler();

    const puts = putCalls();
    expect(puts).toHaveLength(2);
    const item = (puts[1][0] as { Item: Record<string, unknown> }).Item;
    expect('tseForecast' in item).toBe(false);
    // ScanCommandはmaster/actualの2回のみ(margin balance scanは無い)
    const scans = mockSend.mock.calls.filter(([cmd]) => !('Item' in (cmd as Record<string, unknown>)));
    expect(scans).toHaveLength(2);
  });
});

test('writes tseForecast: null when the ticker has no fresh margin snapshot', async () => {
  await withTseEnabled(() =>
    withFixedNow(async () => {
      mockSend
        .mockResolvedValueOnce({ Items: [{ ticker: '1234', value: 1000, unitShares: 100, rightsMonths: [8], maxGyakuhibu: 5000 }] }) // yutai master scan
        .mockResolvedValueOnce({ Items: [] }) // gyakuhibu actual scan
        .mockResolvedValueOnce({
          Items: [{ ticker: '1234', date: '2026-06-01', financingBalance: 100, lendingBalance: 50, source: 'weekly' }], // 61日前 → 鮮度切れ
        }) // margin balance scan
        .mockResolvedValueOnce({}) // _POOL_ put
        .mockResolvedValueOnce({}) // _POOL_TSE_ put
        .mockResolvedValueOnce({}); // 1234のforecast put

      await handler();

      const item = (putCalls()[2][0] as { Item: Record<string, unknown> }).Item;
      expect(item.tseForecast).toBeNull();
    }),
  );
});

test('TSE items survive real DynamoDB marshalling when the current snapshot has financingBalance 0 (excessRatio Infinity)', async () => {
  await withTseEnabled(() =>
    withFixedNow(async () => {
      mockSend
        .mockResolvedValueOnce({ Items: [{ ticker: '1234', value: 1000, unitShares: 100, rightsMonths: [8], maxGyakuhibu: 5000 }] }) // yutai master scan
        .mockResolvedValueOnce({ Items: [] }) // gyakuhibu actual scan
        .mockResolvedValueOnce({
          Items: [
            { ticker: '1234', date: '2026-07-03', financingBalance: 0, lendingBalance: 0, source: 'weekly' }, // 4週前比の分母0 → null
            { ticker: '1234', date: '2026-07-31', financingBalance: 0, lendingBalance: 250, source: 'weekly' }, // excessRatio = Infinity
          ],
        }) // margin balance scan
        .mockResolvedValueOnce({}) // _POOL_ put
        .mockResolvedValueOnce({}) // _POOL_TSE_ put
        .mockResolvedValueOnce({}); // 1234のforecast put

      await handler();

      for (const [cmd] of putCalls()) {
        const { Item } = cmd as { Item: Record<string, unknown> };
        expect(() => marshall(Item)).not.toThrow();
      }
      const tse = (putCalls()[2][0] as { Item: { tseForecast: Record<string, unknown> } }).Item.tseForecast;
      expect(tse.excessRatio).toBeNull(); // Infinity → null
      expect(tse.bin).toBe('5以上');
      expect(tse.lendingGrowth4w).toBeNull();
    }),
  );
});
