import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  QueryCommand: jest.fn((input: unknown) => input),
  ScanCommand: jest.fn((input: unknown) => input),
  GetCommand: jest.fn((input: unknown) => input),
  PutCommand: jest.fn((input: unknown) => input),
  DeleteCommand: jest.fn((input: unknown) => input),
}));

process.env.TABLE_NAME = 'JQuantsStockPrices';
process.env.FINANCIAL_TABLE_NAME = 'JQuantsFinancialSummary';
process.env.YUTAI_MASTER_TABLE_NAME = 'JQuantsYutaiMaster';
process.env.MARGIN_BALANCE_TABLE_NAME = 'JQuantsMarginBalance';
process.env.GYAKUHIBU_ACTUAL_TABLE_NAME = 'JQuantsGyakuhibuActual';
process.env.GYAKUHIBU_FORECAST_TABLE_NAME = 'JQuantsGyakuhibuForecast';
process.env.YUTAI_TDNET_EVENT_TABLE_NAME = 'JQuantsYutaiTdnetEvent';
process.env.TSE_MARGIN_FEATURES_ENABLED = 'true';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/reference-api/index') as {
  handler: (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2>;
};

function makeEvent(
  routeKey: string,
  options: { pathParameters?: Record<string, string>; queryStringParameters?: Record<string, string>; body?: string } = {},
): APIGatewayProxyEventV2 {
  return { routeKey, ...options } as unknown as APIGatewayProxyEventV2;
}

function body(result: APIGatewayProxyResultV2): unknown {
  return JSON.parse((result as { body: string }).body);
}

beforeEach(() => {
  mockSend.mockReset();
});

test('GET /tickers/{ticker}/prices returns 404 for a ticker not in JQuantsYutaiMaster', async () => {
  mockSend.mockResolvedValueOnce({ Item: undefined });

  const result = await handler(makeEvent('GET /tickers/{ticker}/prices', { pathParameters: { ticker: '9999' } }));

  expect((result as { statusCode: number }).statusCode).toBe(404);
  expect(mockSend).toHaveBeenCalledTimes(1);
  // isKnownTicker must check JQuantsYutaiMaster (not the removed WATCHLIST_TABLE_NAME) —
  // otherwise this test would pass identically against the old watchlist-based behavior.
  expect(mockSend.mock.calls[0][0]).toMatchObject({
    TableName: 'JQuantsYutaiMaster',
    Key: { ticker: '9999' },
  });
});

test('GET /tickers/{ticker}/prices rejects unsupported range values', async () => {
  mockSend.mockResolvedValueOnce({ Item: { ticker: '7203' } });

  const result = await handler(
    makeEvent('GET /tickers/{ticker}/prices', { pathParameters: { ticker: '7203' }, queryStringParameters: { range: '1y' } }),
  );

  expect((result as { statusCode: number }).statusCode).toBe(400);
});

test('GET /tickers/{ticker}/prices queries the most recent stored rows regardless of "today"', async () => {
  mockSend.mockResolvedValueOnce({ Item: { ticker: '7203' } });
  // DynamoDB側はScanIndexForward:falseで新しい順に返す想定なので、そのまま渡す。
  mockSend.mockResolvedValueOnce({
    Items: [
      { ticker: '7203', date: '2026-05-08', open: 105, high: 112, low: 100, close: 108, volume: 900 },
      { ticker: '7203', date: '2026-05-07', open: 100, high: 110, low: 95, close: 105, volume: 1000 },
    ],
  });

  const result = await handler(makeEvent('GET /tickers/{ticker}/prices', { pathParameters: { ticker: '7203' } }));

  expect((result as { statusCode: number }).statusCode).toBe(200);
  // 配信遅延で"今日"より何ヶ月も前の日付しか保存されていなくても、日付フィルタなしで返す。
  // レスポンスは日付昇順に揃える。
  expect(body(result)).toEqual({
    ticker: '7203',
    range: '12w',
    prices: [
      { date: '2026-05-07', open: 100, high: 110, low: 95, close: 105, volume: 1000 },
      { date: '2026-05-08', open: 105, high: 112, low: 100, close: 108, volume: 900 },
    ],
  });

  expect(mockSend.mock.calls[1][0]).toMatchObject({ ScanIndexForward: false, Limit: 60 });
});

test('GET /tickers/{ticker}/summary returns 404 for a ticker not in JQuantsYutaiMaster', async () => {
  mockSend.mockResolvedValueOnce({ Item: undefined });

  const result = await handler(makeEvent('GET /tickers/{ticker}/summary', { pathParameters: { ticker: '9999' } }));

  expect((result as { statusCode: number }).statusCode).toBe(404);
  // isKnownTicker must check JQuantsYutaiMaster (not the removed WATCHLIST_TABLE_NAME) —
  // otherwise this test would pass identically against the old watchlist-based behavior.
  expect(mockSend.mock.calls[0][0]).toMatchObject({
    TableName: 'JQuantsYutaiMaster',
    Key: { ticker: '9999' },
  });
});

test('GET /tickers/{ticker}/summary returns 404 when no disclosure has been collected yet', async () => {
  mockSend.mockResolvedValueOnce({ Item: { ticker: '7203' } });
  mockSend.mockResolvedValueOnce({ Items: [] });

  const result = await handler(makeEvent('GET /tickers/{ticker}/summary', { pathParameters: { ticker: '7203' } }));

  expect((result as { statusCode: number }).statusCode).toBe(404);
});

test('GET /tickers/{ticker}/summary returns the latest disclosure', async () => {
  mockSend.mockResolvedValueOnce({ Item: { ticker: '7203' } });
  mockSend.mockResolvedValueOnce({
    Items: [
      {
        ticker: '7203',
        discDate: '2026-05-08',
        docType: 'FYFinancialStatements_Consolidated_IFRS',
        curPerType: 'FY',
        sales: '45095325000000',
        operatingProfit: '4795586000000',
        ordinaryProfit: '',
        netProfit: '4765002000000',
        eps: '345.42',
      },
    ],
  });

  const result = await handler(makeEvent('GET /tickers/{ticker}/summary', { pathParameters: { ticker: '7203' } }));

  expect((result as { statusCode: number }).statusCode).toBe(200);
  expect(body(result)).toEqual({
    ticker: '7203',
    discDate: '2026-05-08',
    docType: 'FYFinancialStatements_Consolidated_IFRS',
    curPerType: 'FY',
    sales: '45095325000000',
    operatingProfit: '4795586000000',
    ordinaryProfit: '',
    netProfit: '4765002000000',
    eps: '345.42',
  });
});

test('unknown route returns 404', async () => {
  const result = await handler(makeEvent('GET /unknown'));

  expect((result as { statusCode: number }).statusCode).toBe(404);
});

test('GET /yutai returns each ticker with its next rights date and its precomputed risk badge', async () => {
  mockSend.mockResolvedValueOnce({
    Items: [
      {
        ticker: '1234',
        companyName: '○○HD',
        content: 'QUOカード',
        value: 1000,
        unitShares: 100,
        rightsMonths: [8],
        riskStatus: 'safe',
        maxGyakuhibu: 200,
        maxRate: 2,
        days: 1,
      },
    ],
  }); // yutai master scan (precomputed risk fields already present)

  const result = await handler(makeEvent('GET /yutai', { queryStringParameters: {} }));

  expect((result as { statusCode: number }).statusCode).toBe(200);
  const parsed = body(result) as {
    tickers: Array<{ ticker: string; riskStatus: string; maxGyakuhibu: number | null }>;
    currentMonthLastTradableDate: string;
  };
  expect(parsed.tickers[0]).toMatchObject({ ticker: '1234', riskStatus: 'safe', maxGyakuhibu: 200 });
  expect(parsed.currentMonthLastTradableDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  // calcRiskが無くなったため、リクエスト全体でDynamoDBへのアクセスはyutai masterの
  // スキャン1回だけになる(N銘柄でも呼び出し回数が増えないことの確認、スケール対応の核心)。
  expect(mockSend).toHaveBeenCalledTimes(1);
});

test('GET /yutai filters by keyword against company name and content', async () => {
  mockSend.mockResolvedValueOnce({
    Items: [
      { ticker: '1234', companyName: '○○ホールディングス', content: 'QUOカード', value: 1000, unitShares: 100, rightsMonths: [8], riskStatus: 'safe', maxGyakuhibu: 200, maxRate: 2, days: 1 },
      { ticker: '5678', companyName: '△△工業', content: '自社製品', value: 3000, unitShares: 100, rightsMonths: [8], riskStatus: 'na', maxGyakuhibu: null, maxRate: null, days: null },
    ],
  });

  const result = await handler(makeEvent('GET /yutai', { queryStringParameters: { keyword: 'QUO' } }));

  const parsed = body(result) as { tickers: Array<{ ticker: string }> };
  expect(parsed.tickers.map((t) => t.ticker)).toEqual(['1234']);
});

test('GET /yutai returns rightsDate: null and riskStatus: na (not a missing key) when there is no upcoming rights date', async () => {
  mockSend.mockResolvedValueOnce({
    Items: [{ ticker: '9999', companyName: '□□コーチ', content: '割引券', value: 500, unitShares: 100, rightsMonths: [], riskStatus: 'na', maxGyakuhibu: null, maxRate: null, days: null }],
  });

  const result = await handler(makeEvent('GET /yutai', { queryStringParameters: {} }));

  // JSON.stringify drops keys whose value is `undefined`, so this only passes if the
  // implementation coerces a missing rights date to `null` before pushing the item.
  const rawBody = (result as { body: string }).body;
  expect(rawBody).toContain('"rightsDate":null');

  const parsed = body(result) as { tickers: Array<Record<string, unknown>> };
  expect(parsed.tickers[0]).toHaveProperty('rightsDate', null);
  expect(parsed.tickers[0].riskStatus).toBe('na');
});

test('GET /yutai falls back to riskStatus na for a row the precompute batch has not touched yet', async () => {
  mockSend.mockResolvedValueOnce({
    Items: [{ ticker: '8888', companyName: '新規上場HD', content: '未計算', value: 500, unitShares: 100, rightsMonths: [8] }],
  }); // no riskStatus/maxGyakuhibu/maxRate/days keys at all

  const result = await handler(makeEvent('GET /yutai', { queryStringParameters: {} }));

  const parsed = body(result) as { tickers: Array<{ ticker: string; riskStatus: string }> };
  expect(parsed.tickers[0]).toMatchObject({ ticker: '8888', riskStatus: 'na' });
});

test('GET /yutai returns value: null (not a missing key) for a row where the value attribute is entirely absent', async () => {
  mockSend.mockResolvedValueOnce({
    Items: [{ ticker: '8888', companyName: '新規上場HD', content: '未計算', unitShares: 100, rightsMonths: [8] }],
  }); // no value key at all (distinct from a stored `value: null`)

  const result = await handler(makeEvent('GET /yutai', { queryStringParameters: {} }));

  const parsed = body(result) as { tickers: Array<Record<string, unknown>> };
  expect(parsed.tickers[0]).toHaveProperty('value', null);
});

test('GET /yutai/{ticker} returns basic info, precomputed risk, and rights history', async () => {
  mockSend
    .mockResolvedValueOnce({
      Item: { ticker: '1234', companyName: '○○HD', content: 'QUOカード', value: 1000, unitShares: 100, rightsMonths: [8], riskStatus: 'safe', maxGyakuhibu: 200, maxRate: 2, days: 1 },
    }) // yutai master get
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', date: '2026-08-12', close: 500, volume: 10000 }] }) // latest price (basicInfo)
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', discDate: '2026-05-08', eps: '10.0', sales: '100', operatingProfit: '10', netProfit: '5' }] }) // financial summary
    .mockResolvedValueOnce({
      Items: [{ ticker: '1234', rightsDate: '2026-03-30', totalAmount: 680, days: 2, avgRate: 0.4 }],
    }); // gyakuhibu actual history

  const result = await handler(makeEvent('GET /yutai/{ticker}', { pathParameters: { ticker: '1234' } }));

  expect((result as { statusCode: number }).statusCode).toBe(200);
  const parsed = body(result) as {
    basicInfo: { closePrice: number; per: number | null };
    risk: { maxGyakuhibu: number; riskStatus: string };
    rightsHistory: Array<{ rightsDate: string; totalAmount: number }>;
  };
  expect(parsed.basicInfo.closePrice).toBe(500);
  expect(parsed.risk).toEqual({ riskStatus: 'safe', maxGyakuhibu: 200, maxRate: 2, days: 1 });
  expect(parsed.rightsHistory).toEqual([{ rightsDate: '2026-03-30', totalAmount: 680, days: 2, avgRate: 0.4 }]);
  // calcRiskの逐次クエリ(信用残の有無・前日終値)が無くなったため、リクエストあたりの
  // DynamoDBアクセスは4回(yutai master get・latest price・financial summary・gyakuhibu history)。
  expect(mockSend).toHaveBeenCalledTimes(4);
});

test('GET /yutai/{ticker} rightsHistory excludes noGyakuhibu marker rows (checked-but-no-shortage dates from Fix 2)', async () => {
  mockSend
    .mockResolvedValueOnce({
      Item: { ticker: '1234', companyName: '○○HD', content: 'QUOカード', value: 1000, unitShares: 100, rightsMonths: [], riskStatus: 'na', maxGyakuhibu: null, maxRate: null, days: null },
    }) // yutai master get
    .mockResolvedValueOnce({ Items: [] }) // latest price
    .mockResolvedValueOnce({ Items: [] }) // financial summary
    .mockResolvedValueOnce({
      Items: [
        { ticker: '1234', rightsDate: '2026-03-30', totalAmount: 680, days: 2, avgRate: 0.4 },
        { ticker: '1234', rightsDate: '2026-02-27', totalAmount: 0, days: 0, avgRate: 0, noGyakuhibu: true },
      ],
    }); // gyakuhibu actual history: one real entry + one "checked, no shortage" marker row

  const result = await handler(makeEvent('GET /yutai/{ticker}', { pathParameters: { ticker: '1234' } }));

  const parsed = body(result) as { rightsHistory: Array<{ rightsDate: string }> };
  expect(parsed.rightsHistory).toEqual([{ rightsDate: '2026-03-30', totalAmount: 680, days: 2, avgRate: 0.4 }]);
});

test('GET /yutai/{ticker} returns the precomputed risk fields verbatim, including the danger case', async () => {
  mockSend
    .mockResolvedValueOnce({
      Item: { ticker: '1234', companyName: '○○HD', content: 'QUOカード', value: 99, unitShares: 100, rightsMonths: [8], riskStatus: 'danger', maxGyakuhibu: 100, maxRate: 1, days: 1 },
    }) // yutai master get
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', date: '2026-08-12', close: 500, volume: 10000 }] }) // latest price
    .mockResolvedValueOnce({ Items: [] }) // financial summary
    .mockResolvedValueOnce({ Items: [] }); // gyakuhibu actual history

  const result = await handler(makeEvent('GET /yutai/{ticker}', { pathParameters: { ticker: '1234' } }));

  const parsed = body(result) as { risk: { maxGyakuhibu: number; riskStatus: string } };
  expect(parsed.risk).toEqual({ riskStatus: 'danger', maxGyakuhibu: 100, maxRate: 1, days: 1 });
});

test('GET /yutai/{ticker} returns 404 for a ticker not in the yutai master', async () => {
  mockSend.mockResolvedValueOnce({ Item: undefined });

  const result = await handler(makeEvent('GET /yutai/{ticker}', { pathParameters: { ticker: '9999' } }));

  expect((result as { statusCode: number }).statusCode).toBe(404);
});

test('GET /yutai/{ticker} returns rightsDate: null and companyName: null (not missing keys) and an all-null risk object when there is no upcoming rights date and no companyName on record', async () => {
  mockSend
    .mockResolvedValueOnce({
      Item: { ticker: '1234', content: 'QUOカード', value: 1000, unitShares: 100, rightsMonths: [], riskStatus: 'na', maxGyakuhibu: null, maxRate: null, days: null },
    }) // yutai master get (no companyName)
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', date: '2026-08-12', close: 500, volume: 10000 }] }) // latest price
    .mockResolvedValueOnce({ Items: [] }) // financial summary: none yet
    .mockResolvedValueOnce({ Items: [] }); // gyakuhibu actual history: none

  const result = await handler(makeEvent('GET /yutai/{ticker}', { pathParameters: { ticker: '1234' } }));

  expect((result as { statusCode: number }).statusCode).toBe(200);
  const rawBody = (result as { body: string }).body;
  expect(rawBody).toContain('"rightsDate":null');
  expect(rawBody).toContain('"companyName":null');

  const parsed = body(result) as {
    rightsDate: string | null;
    companyName: string | null;
    risk: { maxGyakuhibu: number | null; maxRate: number | null; days: number | null; riskStatus: string };
  };
  expect(parsed.rightsDate).toBeNull();
  expect(parsed.companyName).toBeNull();
  expect(parsed.risk).toEqual({ maxGyakuhibu: null, maxRate: null, days: null, riskStatus: 'na' });
});

test('GET /yutai/{ticker}/margin-trend returns the balance time series in ascending date order', async () => {
  mockSend.mockResolvedValueOnce({
    Items: [
      { ticker: '1234', date: '2026-08-05', financingBalance: 100, lendingBalance: 200 },
      { ticker: '1234', date: '2026-08-04', financingBalance: 90, lendingBalance: 180 },
    ],
  });

  const result = await handler(
    makeEvent('GET /yutai/{ticker}/margin-trend', { pathParameters: { ticker: '1234' } }),
  );

  expect((result as { statusCode: number }).statusCode).toBe(200);
  expect(body(result)).toEqual({
    ticker: '1234',
    range: '1y',
    points: [
      { date: '2026-08-04', financingBalance: 90, lendingBalance: 180 },
      { date: '2026-08-05', financingBalance: 100, lendingBalance: 200 },
    ],
  });
});

test('GET /yutai/forecast joins master and forecast tables by ticker and filters by forecastStatus', async () => {
  mockSend
    .mockResolvedValueOnce({
      Items: [
        { ticker: '1234', companyName: 'A', content: 'A優待', value: 1000, unitShares: 100, rightsMonths: [8], riskStatus: 'danger', maxGyakuhibu: 5000, closePrice: 480 },
        { ticker: '5678', companyName: 'B', content: 'B優待', value: 2000, unitShares: 100, rightsMonths: [8], riskStatus: 'safe', maxGyakuhibu: 100 },
      ],
    }) // yutai master scan
    .mockResolvedValueOnce({
      Items: [
        { ticker: '_POOL_', bins: [], computedAt: '2026-08-01' },
        { ticker: '1234', rightsDate: '2026-08-27', scenario: 'last-rights', forecastStatus: 'danger', forecastP50: 1000, forecastP90: 4000, tickerSamples: 3, poolSamples: 400, computedAt: '2026-08-01' },
        { ticker: '5678', rightsDate: '2026-08-27', scenario: 'none', forecastStatus: 'safe', forecastP50: 10, forecastP90: 50, tickerSamples: 0, poolSamples: 400, computedAt: '2026-08-01' },
      ],
    }); // gyakuhibu forecast scan

  const result = await handler(makeEvent('GET /yutai/forecast', { queryStringParameters: { forecastStatus: 'danger' } }));

  const parsed = body(result) as {
    tickers: Array<{ ticker: string; closePrice: number | null; forecast: { forecastStatus: string; forecastP90: number } }>;
    poolComputedAt: string;
  };
  expect(parsed.tickers).toHaveLength(1);
  expect(parsed.tickers[0].ticker).toBe('1234');
  expect(parsed.tickers[0].closePrice).toBe(480); // 前日株価がリスク事前計算バッチの書き込み値からそのまま返る
  expect(parsed.tickers[0].forecast.forecastStatus).toBe('danger');
  expect(parsed.tickers[0].forecast.forecastP90).toBe(4000);
  expect(parsed.poolComputedAt).toBe('2026-08-01');
});

test('GET /yutai/forecast marks a ticker with no forecast row yet as forecastStatus na', async () => {
  mockSend
    .mockResolvedValueOnce({
      Items: [{ ticker: '9999', companyName: 'C', content: 'C優待', value: 500, unitShares: 100, rightsMonths: [8], riskStatus: 'na', maxGyakuhibu: null }],
    }) // yutai master scan
    .mockResolvedValueOnce({ Items: [] }); // gyakuhibu forecast scan(_POOL_行も無い)

  const result = await handler(makeEvent('GET /yutai/forecast', {}));

  const parsed = body(result) as { tickers: Array<{ forecast: { forecastStatus: string } }>; poolComputedAt: unknown };
  expect(parsed.tickers).toHaveLength(1);
  expect(parsed.tickers[0].forecast.forecastStatus).toBe('na');
  expect(parsed.poolComputedAt).toBeNull();
});

test('GET /yutai/{ticker}/forecast returns history including noGyakuhibu rows with excessRatio/fillRatio/occurred', async () => {
  mockSend
    .mockResolvedValueOnce({
      Item: { ticker: '1234', companyName: 'A', content: 'A優待', value: 1000, unitShares: 100, rightsMonths: [8], riskStatus: 'danger', maxGyakuhibu: 5000, closePrice: 480 },
    }) // master get
    .mockResolvedValueOnce({
      Item: { ticker: '1234', rightsDate: '2026-08-27', scenario: 'last-rights', forecastStatus: 'danger', forecastP50: 1000, forecastP90: 4000, tickerSamples: 1, poolSamples: 1 },
    }) // forecast get
    .mockResolvedValueOnce({
      Item: { ticker: '_POOL_', bins: [{ label: '1〜2', lo: 1, hi: 2, n: 400, pOccur: 0.5, fillP50: 0.2, fillP90: 0.8, fillMean: 0.3 }], computedAt: '2026-08-01' },
    }) // _POOL_ get
    .mockResolvedValueOnce({
      Items: [
        {
          ticker: '1234', rightsDate: '2025-08-27', financingBalance: 100, lendingBalance: 250, avgRate: 10, days: 1,
          maxRateActual: 10, lendingPrice: 1700, bidRank: 'A', restriction: null, emergencyMeasure: null, totalAmount: 1000, enriched: true,
        },
        {
          ticker: '1234', rightsDate: '2024-08-27', financingBalance: 200, lendingBalance: 150, avgRate: 0, days: 0,
          maxRateActual: 5, noGyakuhibu: true, totalAmount: 0, enriched: true,
        },
      ],
    }) // gyakuhibu actual query(権利日降順、noGyakuhibu行も含む)
    .mockResolvedValueOnce({ Items: [] }); // margin balance query

  const result = await handler(makeEvent('GET /yutai/{ticker}/forecast', { pathParameters: { ticker: '1234' } }));

  const parsed = body(result) as { history: Array<Record<string, unknown>>; poolBins: Array<Record<string, unknown>>; closePrice: number | null };
  expect(parsed.closePrice).toBe(480); // 前日株価がリスク事前計算バッチの書き込み値からそのまま返る
  expect(parsed.history).toHaveLength(2); // noGyakuhibu行も含めて2件(既存/yutai/{ticker}のrightsHistoryとは違い除外しない)

  const occurredRow = parsed.history.find((h) => h.rightsDate === '2025-08-27')!;
  expect(occurredRow.excessRatio).toBeCloseTo(1.5); // (250-100)/100
  expect(occurredRow.excessShares).toBe(150); // 250-100
  expect(occurredRow.fillRatio).toBe(1); // (10*1)/10
  expect(occurredRow.occurred).toBe(true);

  const noFeeRow = parsed.history.find((h) => h.rightsDate === '2024-08-27')!;
  expect(noFeeRow.occurred).toBe(false);
  expect(noFeeRow.excessRatio).toBeCloseTo(-0.25); // (150-200)/200

  expect(parsed.poolBins).toHaveLength(1);
  expect(parsed.poolBins[0]).toMatchObject({ label: '1〜2', n: 400 });
});

test('GET /yutai/{ticker}/forecast returns forecastStatus na and empty history/poolBins when nothing is computed yet', async () => {
  mockSend
    .mockResolvedValueOnce({
      Item: { ticker: '9999', companyName: 'C', content: 'C優待', value: 500, unitShares: 100, rightsMonths: [8], riskStatus: 'na', maxGyakuhibu: null },
    }) // master get
    .mockResolvedValueOnce({}) // forecast get(Item無し)
    .mockResolvedValueOnce({}) // _POOL_ get(Item無し)
    .mockResolvedValueOnce({ Items: [] }) // gyakuhibu actual query
    .mockResolvedValueOnce({ Items: [] }); // margin balance query

  const result = await handler(makeEvent('GET /yutai/{ticker}/forecast', { pathParameters: { ticker: '9999' } }));

  const parsed = body(result) as { forecast: { forecastStatus: string }; poolBins: unknown[]; history: unknown[] };
  expect(parsed.forecast.forecastStatus).toBe('na');
  expect(parsed.poolBins).toEqual([]);
  expect(parsed.history).toEqual([]);
});

test('GET /yutai/{ticker}/forecast returns 404 for an unknown ticker', async () => {
  mockSend.mockResolvedValueOnce({}); // master get: Item無し

  const result = await handler(makeEvent('GET /yutai/{ticker}/forecast', { pathParameters: { ticker: '0000' } }));

  expect((result as { statusCode: number }).statusCode).toBe(404);
});

test('GET /yutai includes a ticker whose value is null instead of dropping it', async () => {
  mockSend.mockResolvedValueOnce({
    Items: [
      { ticker: '9001', companyName: '東武鉄道', content: '優待乗車証（回数券：2枚～）など', value: null, unitShares: 100, rightsMonths: [8], riskStatus: 'na', maxGyakuhibu: 12400, maxRate: 124, days: 1 },
    ],
  });

  const result = await handler(makeEvent('GET /yutai', { queryStringParameters: {} }));

  const parsed = body(result) as { tickers: Array<Record<string, unknown>> };
  expect(parsed.tickers).toHaveLength(1);
  expect(parsed.tickers[0]).toMatchObject({ ticker: '9001', value: null, riskStatus: 'na', maxGyakuhibu: 12400 });
});

test('GET /yutai/{ticker} returns value: null when the yutai value is unknown', async () => {
  mockSend
    .mockResolvedValueOnce({
      Item: { ticker: '9001', companyName: '東武鉄道', content: '優待乗車証（回数券：2枚～）など', value: null, unitShares: 100, rightsMonths: [8], riskStatus: 'na', maxGyakuhibu: 12400, maxRate: 124, days: 1 },
    }) // yutai master get
    .mockResolvedValueOnce({ Items: [] }) // latest price
    .mockResolvedValueOnce({ Items: [] }) // financial summary
    .mockResolvedValueOnce({ Items: [] }); // gyakuhibu actual history

  const result = await handler(makeEvent('GET /yutai/{ticker}', { pathParameters: { ticker: '9001' } }));

  const parsed = body(result) as { value: number | null };
  expect(parsed.value).toBeNull();
});

const TSE_ROW = {
  ticker: '1234', rightsDate: '2026-08-27', scenario: 'last-rights', forecastStatus: 'safe', forecastP50: 100, forecastP90: 400,
  tickerSamples: 3, poolSamples: 400, computedAt: '2026-08-01',
  tseForecast: {
    scenario: 'current-tse', excessRatio: 1.5, bin: '1〜2', pOccur: 0.9, fillP50: 0.1, fillP90: 0.5, fillMean: 0.2,
    forecastP50: 500, forecastP90: 2500, forecastMean: 1000, expectedNet: 0, forecastStatus: 'caution',
    tickerSamples: 2, poolSamples: 150, snapshotDate: '2026-07-31', lagDays: 27, lagBucket: '22+',
    financingBalance: 100, lendingBalance: 250, lendingGrowth4w: 2,
  },
};

test('GET /yutai/forecast includes tseForecast and features.tseMargin=true when the flag is on', async () => {
  mockSend
    .mockResolvedValueOnce({
      Items: [{ ticker: '1234', companyName: 'A', content: 'A優待', value: 1000, unitShares: 100, rightsMonths: [8], riskStatus: 'safe', maxGyakuhibu: 5000 }],
    }) // yutai master scan
    .mockResolvedValueOnce({ Items: [{ ticker: '_POOL_', bins: [], computedAt: '2026-08-01' }, TSE_ROW] }); // forecast scan

  const result = await handler(makeEvent('GET /yutai/forecast', {}));

  const parsed = body(result) as { tickers: Array<{ tseForecast: Record<string, unknown> | null }>; features: { tseMargin: boolean } };
  expect(parsed.features).toEqual({ tseMargin: true });
  expect(parsed.tickers[0].tseForecast).toMatchObject({
    snapshotDate: '2026-07-31', lagDays: 27, lagBucket: '22+', bin: '1〜2', forecastP50: 500, forecastStatus: 'caution', lendingGrowth4w: 2,
  });
});

test('GET /yutai/forecast returns tseForecast: null for a ticker whose forecast row has no tseForecast', async () => {
  const { tseForecast: _omit, ...rowWithoutTse } = TSE_ROW;
  void _omit;
  mockSend
    .mockResolvedValueOnce({
      Items: [{ ticker: '1234', companyName: 'A', content: 'A優待', value: 1000, unitShares: 100, rightsMonths: [8], riskStatus: 'safe', maxGyakuhibu: 5000 }],
    })
    .mockResolvedValueOnce({ Items: [rowWithoutTse] });

  const result = await handler(makeEvent('GET /yutai/forecast', {}));

  const parsed = body(result) as { tickers: Array<Record<string, unknown>> };
  expect(parsed.tickers[0]).toHaveProperty('tseForecast', null);
});

test('GET /yutai/forecast nulls tseForecast and reports features.tseMargin=false when the flag is off', async () => {
  process.env.TSE_MARGIN_FEATURES_ENABLED = 'false';
  try {
    mockSend
      .mockResolvedValueOnce({
        Items: [{ ticker: '1234', companyName: 'A', content: 'A優待', value: 1000, unitShares: 100, rightsMonths: [8], riskStatus: 'safe', maxGyakuhibu: 5000 }],
      })
      .mockResolvedValueOnce({ Items: [TSE_ROW] });

    const result = await handler(makeEvent('GET /yutai/forecast', {}));

    const parsed = body(result) as { tickers: Array<Record<string, unknown>>; features: { tseMargin: boolean } };
    expect(parsed.features).toEqual({ tseMargin: false });
    expect(parsed.tickers[0]).toHaveProperty('tseForecast', null);
    expect(parsed.tickers[0]).toHaveProperty('forecast'); // 過去実績ベースは影響を受けない
  } finally {
    process.env.TSE_MARGIN_FEATURES_ENABLED = 'true';
  }
});

test('GET /yutai/{ticker}/forecast includes tseForecast and features', async () => {
  mockSend
    .mockResolvedValueOnce({
      Item: { ticker: '1234', companyName: 'A', content: 'A優待', value: 1000, unitShares: 100, rightsMonths: [8], riskStatus: 'safe', maxGyakuhibu: 5000 },
    }) // master get
    .mockResolvedValueOnce({ Item: TSE_ROW }) // forecast get
    .mockResolvedValueOnce({}) // _POOL_ get
    .mockResolvedValueOnce({ Items: [] }) // gyakuhibu actual query
    .mockResolvedValueOnce({ Items: [] }); // margin balance query

  const result = await handler(makeEvent('GET /yutai/{ticker}/forecast', { pathParameters: { ticker: '1234' } }));

  const parsed = body(result) as { tseForecast: Record<string, unknown> | null; features: { tseMargin: boolean } };
  expect(parsed.features).toEqual({ tseMargin: true });
  expect(parsed.tseForecast).toMatchObject({ snapshotDate: '2026-07-31', lagBucket: '22+', forecastP90: 2500 });
});

test('GET /yutai/tdnet-events queries the event table by fixed pk and returns items newest-first', async () => {
  mockSend.mockResolvedValueOnce({
    Items: [
      {
        pk: 'ALL',
        eventId: '2026-09-08#2157#abcdef12',
        ticker: '2157',
        companyName: 'コシダカホールディングス',
        eventType: 'update',
        disclosureTitle: '株主優待制度の一部変更に関するお知らせ',
        disclosedAt: '2026-09-08',
        recordedAt: '2026-09-08T21:03:00.000Z',
      },
    ],
  });

  const result = await handler(makeEvent('GET /yutai/tdnet-events'));

  expect(mockSend.mock.calls[0][0]).toMatchObject({
    TableName: 'JQuantsYutaiTdnetEvent',
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': 'ALL' },
    ScanIndexForward: false,
  });
  const parsed = body(result) as { events: Array<Record<string, unknown>> };
  expect(parsed.events).toEqual([
    {
      ticker: '2157',
      companyName: 'コシダカホールディングス',
      eventType: 'update',
      disclosureTitle: '株主優待制度の一部変更に関するお知らせ',
      disclosedAt: '2026-09-08',
      recordedAt: '2026-09-08T21:03:00.000Z',
    },
  ]);
});

test('GET /yutai/tdnet-events returns an empty array when there are no events yet', async () => {
  mockSend.mockResolvedValueOnce({ Items: [] });

  const result = await handler(makeEvent('GET /yutai/tdnet-events'));

  expect(body(result)).toEqual({ events: [] });
});

test('GET /yutai/tdnet-events paginates through multiple pages and returns every row', async () => {
  mockSend
    .mockResolvedValueOnce({
      Items: [
        {
          ticker: '1001', companyName: 'A社', eventType: 'start',
          disclosureTitle: 'お知らせA', disclosedAt: '2026-09-01', recordedAt: '2026-09-01T00:00:00.000Z',
        },
      ],
      LastEvaluatedKey: { pk: 'ALL', eventId: '2026-09-01#1001#aaaaaaaa' },
    })
    .mockResolvedValueOnce({
      Items: [
        {
          ticker: '2002', companyName: 'B社', eventType: 'update',
          disclosureTitle: 'お知らせB', disclosedAt: '2026-08-25', recordedAt: '2026-08-25T00:00:00.000Z',
        },
      ],
    });

  const result = await handler(makeEvent('GET /yutai/tdnet-events'));

  expect(mockSend.mock.calls[1][0]).toMatchObject({
    ExclusiveStartKey: { pk: 'ALL', eventId: '2026-09-01#1001#aaaaaaaa' },
  });
  const parsed = body(result) as { events: Array<{ ticker: string }> };
  expect(parsed.events.map((e) => e.ticker)).toEqual(['1001', '2002']);
});
