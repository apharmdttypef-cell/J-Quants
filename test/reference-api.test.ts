import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

const mockSend = jest.fn();
const mockSecretsSend = jest.fn();
const mockFetch = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(),
}));

jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSecretsSend })),
  GetSecretValueCommand: jest.fn((input: unknown) => input),
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
process.env.WATCHLIST_TABLE_NAME = 'JQuantsWatchlist';
process.env.SECRET_ARN = 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:JQuantsApiKey';
process.env.YUTAI_MASTER_TABLE_NAME = 'JQuantsYutaiMaster';
process.env.YUTAI_RIGHTS_DATE_TABLE_NAME = 'JQuantsYutaiRightsDate';
process.env.MARGIN_BALANCE_TABLE_NAME = 'JQuantsMarginBalance';
process.env.GYAKUHIBU_ACTUAL_TABLE_NAME = 'JQuantsGyakuhibuActual';

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
  mockSecretsSend.mockReset();
  mockFetch.mockReset();
  (global as unknown as { fetch: typeof mockFetch }).fetch = mockFetch;
});

test('GET /tickers scans the watchlist table and returns it sorted', async () => {
  mockSend.mockResolvedValueOnce({
    Items: [
      { ticker: '9432', companyName: 'NTT', addedAt: '2026-01-01T00:00:00.000Z' },
      { ticker: '7203', companyName: 'トヨタ自動車', addedAt: '2026-01-02T00:00:00.000Z' },
    ],
  });

  const result = await handler(makeEvent('GET /tickers'));

  expect((result as { statusCode: number }).statusCode).toBe(200);
  expect(body(result)).toEqual({
    tickers: [
      { ticker: '7203', companyName: 'トヨタ自動車', addedAt: '2026-01-02T00:00:00.000Z' },
      { ticker: '9432', companyName: 'NTT', addedAt: '2026-01-01T00:00:00.000Z' },
    ],
  });
});

test('POST /tickers rejects a malformed ticker without calling J-Quants', async () => {
  const result = await handler(makeEvent('POST /tickers', { body: JSON.stringify({ ticker: 'abc' }) }));

  expect((result as { statusCode: number }).statusCode).toBe(400);
  expect(mockFetch).not.toHaveBeenCalled();
});

test('POST /tickers looks up the company name and upserts the watchlist', async () => {
  mockSecretsSend.mockResolvedValueOnce({ SecretString: 'test-api-key' });
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ data: [{ Code: '7203', CoName: 'トヨタ自動車' }] }),
  });
  mockSend.mockResolvedValueOnce({});

  const result = await handler(makeEvent('POST /tickers', { body: JSON.stringify({ ticker: '7203' }) }));

  expect(mockFetch).toHaveBeenCalledWith(
    expect.stringContaining('/equities/master?code=7203'),
    expect.objectContaining({ headers: { 'x-api-key': 'test-api-key' } }),
  );
  expect((result as { statusCode: number }).statusCode).toBe(201);
  expect(body(result)).toMatchObject({ ticker: '7203', companyName: 'トヨタ自動車' });
});

test('POST /tickers returns 400 when J-Quants has no data for the code', async () => {
  mockSecretsSend.mockResolvedValueOnce({ SecretString: 'test-api-key' });
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) });

  const result = await handler(makeEvent('POST /tickers', { body: JSON.stringify({ ticker: '9999' }) }));

  expect((result as { statusCode: number }).statusCode).toBe(400);
  expect(mockSend).not.toHaveBeenCalled();
});

test('DELETE /tickers/{ticker} removes the item and returns 204', async () => {
  mockSend.mockResolvedValueOnce({});

  const result = await handler(makeEvent('DELETE /tickers/{ticker}', { pathParameters: { ticker: '7203' } }));

  expect((result as { statusCode: number }).statusCode).toBe(204);
});

test('GET /tickers/{ticker}/prices returns 404 for an unwatched ticker', async () => {
  mockSend.mockResolvedValueOnce({ Item: undefined });

  const result = await handler(makeEvent('GET /tickers/{ticker}/prices', { pathParameters: { ticker: '9999' } }));

  expect((result as { statusCode: number }).statusCode).toBe(404);
  expect(mockSend).toHaveBeenCalledTimes(1);
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

test('GET /tickers/{ticker}/summary returns 404 for an unwatched ticker', async () => {
  mockSend.mockResolvedValueOnce({ Item: undefined });

  const result = await handler(makeEvent('GET /tickers/{ticker}/summary', { pathParameters: { ticker: '9999' } }));

  expect((result as { statusCode: number }).statusCode).toBe(404);
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

test('GET /yutai returns each ticker with its next rights date and a safe/danger/na risk badge', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', companyName: '○○HD', content: 'QUOカード', value: 1000, unitShares: 100 }] }) // yutai master scan
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', rightsDate: '2026-08-20' }] }) // rights-date query for 1234
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', date: '2026-08-10', financingBalance: 100, lendingBalance: 200 }] }) // margin balance presence check
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', date: '2026-08-12', close: 500 }] }); // latest close price

  // トレーディングカレンダーはJ-Quants(fetch)ではなくgetLocalTradingCalendarで
  // ローカル計算されるため、ここではmockFetchのセットアップは不要。

  const result = await handler(makeEvent('GET /yutai', { queryStringParameters: {} }));

  expect((result as { statusCode: number }).statusCode).toBe(200);
  const parsed = body(result) as { tickers: Array<{ ticker: string; riskStatus: string }>; currentMonthLastTradableDate: string };
  expect(parsed.tickers[0]).toMatchObject({ ticker: '1234' });
  expect(['safe', 'danger', 'na']).toContain(parsed.tickers[0].riskStatus);
  expect(parsed.currentMonthLastTradableDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test('GET /yutai filters by keyword against company name and content', async () => {
  mockSend
    .mockResolvedValueOnce({
      Items: [
        { ticker: '1234', companyName: '○○ホールディングス', content: 'QUOカード', value: 1000, unitShares: 100 },
        { ticker: '5678', companyName: '△△工業', content: '自社製品', value: 3000, unitShares: 100 },
      ],
    })
    .mockResolvedValue({ Items: [] }); // rights-date/margin-balance queries: no data → treated as 対象外

  const result = await handler(makeEvent('GET /yutai', { queryStringParameters: { keyword: 'QUO' } }));

  const parsed = body(result) as { tickers: Array<{ ticker: string }> };
  expect(parsed.tickers.map((t) => t.ticker)).toEqual(['1234']);
});

test('GET /yutai returns rightsDate: null (not a missing key) when there is no upcoming rights date', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '9999', companyName: '□□コーチ', content: '割引券', value: 500, unitShares: 100 }] }) // yutai master scan
    .mockResolvedValueOnce({ Items: [] }); // rights-date query: no upcoming rights date

  const result = await handler(makeEvent('GET /yutai', { queryStringParameters: {} }));

  // JSON.stringify drops keys whose value is `undefined`, so this only passes if the
  // implementation coerces a missing rights date to `null` before pushing the item.
  const rawBody = (result as { body: string }).body;
  expect(rawBody).toContain('"rightsDate":null');

  const parsed = body(result) as { tickers: Array<Record<string, unknown>> };
  expect(parsed.tickers[0]).toHaveProperty('rightsDate', null);
  expect(parsed.tickers[0].riskStatus).toBe('na');
});

test('GET /yutai/{ticker} returns basic info, risk calc, and rights history', async () => {
  mockSend
    .mockResolvedValueOnce({ Item: { ticker: '1234', companyName: '○○HD', content: 'QUOカード', value: 1000, unitShares: 100 } }) // yutai master get
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', date: '2026-08-12', close: 500, volume: 10000 }] }) // latest price (latestPricePoint, for basicInfo)
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', discDate: '2026-05-08', eps: '10.0', sales: '100', operatingProfit: '10', netProfit: '5' }] }) // financial summary
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', rightsDate: '2026-08-20' }] }) // next rights date
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', date: '2026-08-10' }] }) // margin balance presence (inside calcRisk)
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', date: '2026-08-12', close: 500 }] }) // latest close (inside calcRisk, separate query from latestPricePoint above)
    .mockResolvedValueOnce({
      Items: [{ ticker: '1234', rightsDate: '2026-03-30', totalAmount: 680, days: 2, avgRate: 0.4 }],
    }); // gyakuhibu actual history
  // トレーディングカレンダーはgetLocalTradingCalendarでローカル計算されるため
  // mockFetchのセットアップは不要(rightsDate=2026-08-20から実カレンダーでdays=1になる)。

  const result = await handler(makeEvent('GET /yutai/{ticker}', { pathParameters: { ticker: '1234' } }));

  expect((result as { statusCode: number }).statusCode).toBe(200);
  const parsed = body(result) as {
    basicInfo: { closePrice: number; per: number | null };
    risk: { maxGyakuhibu: number };
    rightsHistory: Array<{ rightsDate: string; totalAmount: number }>;
  };
  expect(parsed.basicInfo.closePrice).toBe(500);
  expect(parsed.risk.maxGyakuhibu).toBeGreaterThan(0);
  expect(parsed.rightsHistory).toEqual([{ rightsDate: '2026-03-30', totalAmount: 680, days: 2, avgRate: 0.4 }]);
});

test('GET /yutai/{ticker} rightsHistory excludes noGyakuhibu marker rows (checked-but-no-shortage dates from Fix 2)', async () => {
  mockSend
    .mockResolvedValueOnce({ Item: { ticker: '1234', companyName: '○○HD', content: 'QUOカード', value: 1000, unitShares: 100 } }) // yutai master get
    .mockResolvedValueOnce({ Items: [] }) // latest price
    .mockResolvedValueOnce({ Items: [] }) // financial summary
    .mockResolvedValueOnce({ Items: [] }) // next rights date: none upcoming (skip risk calc entirely)
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

test('GET /yutai/{ticker} pins the safe/danger comparison direction: value just above maxGyakuhibu is safe, just below is danger', async () => {
  // closePrice=500 * unitShares=100 => investmentUnit=50,000 (<=50,000 boundary) => cap=100円.
  // rawRate = 100/100 = 1 (<=1) => maxRate=1円. rightsDate=2026-08-17(月)の実カレンダー:
  // settlement=2026-08-19(水、T+2)、翌営業日=2026-08-20(木) -> calendarDaysBetween=1。
  // So maxGyakuhibu = 1 * 100 * 1 = 100円 exactly。
  function mockDetailCalls(value: number) {
    mockSend
      .mockResolvedValueOnce({ Item: { ticker: '1234', companyName: '○○HD', content: 'QUOカード', value, unitShares: 100 } }) // yutai master get
      .mockResolvedValueOnce({ Items: [{ ticker: '1234', date: '2026-08-12', close: 500, volume: 10000 }] }) // latest price (basicInfo)
      .mockResolvedValueOnce({ Items: [] }) // financial summary
      .mockResolvedValueOnce({ Items: [{ ticker: '1234', rightsDate: '2026-08-17' }] }) // next rights date
      .mockResolvedValueOnce({ Items: [{ ticker: '1234', date: '2026-08-10' }] }) // margin balance presence (calcRisk)
      .mockResolvedValueOnce({ Items: [{ ticker: '1234', date: '2026-08-12', close: 500 }] }) // latest close (calcRisk)
      .mockResolvedValueOnce({ Items: [] }); // gyakuhibu actual history
    // トレーディングカレンダーはgetLocalTradingCalendarでローカル計算されるため
    // mockFetchのセットアップは不要。
  }

  mockDetailCalls(101); // value just above maxGyakuhibu (100) -> safe
  const safeResult = await handler(makeEvent('GET /yutai/{ticker}', { pathParameters: { ticker: '1234' } }));
  const safeBody = body(safeResult) as { risk: { maxGyakuhibu: number; riskStatus: string } };
  expect(safeBody.risk.maxGyakuhibu).toBe(100);
  expect(safeBody.risk.riskStatus).toBe('safe');

  mockDetailCalls(99); // value just below maxGyakuhibu (100) -> danger
  const dangerResult = await handler(makeEvent('GET /yutai/{ticker}', { pathParameters: { ticker: '1234' } }));
  const dangerBody = body(dangerResult) as { risk: { maxGyakuhibu: number; riskStatus: string } };
  expect(dangerBody.risk.maxGyakuhibu).toBe(100);
  expect(dangerBody.risk.riskStatus).toBe('danger');
});

test('GET /yutai/{ticker} returns 404 for a ticker not in the yutai master', async () => {
  mockSend.mockResolvedValueOnce({ Item: undefined });

  const result = await handler(makeEvent('GET /yutai/{ticker}', { pathParameters: { ticker: '9999' } }));

  expect((result as { statusCode: number }).statusCode).toBe(404);
});

test('GET /yutai/{ticker} returns rightsDate: null and companyName: null (not missing keys) and an all-null risk object when there is no upcoming rights date and no companyName on record', async () => {
  mockSend
    .mockResolvedValueOnce({ Item: { ticker: '1234', content: 'QUOカード', value: 1000, unitShares: 100 } }) // yutai master get (no companyName)
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', date: '2026-08-12', close: 500, volume: 10000 }] }) // latest price
    .mockResolvedValueOnce({ Items: [] }) // financial summary: none yet
    .mockResolvedValueOnce({ Items: [] }) // next rights date: none upcoming
    .mockResolvedValueOnce({ Items: [] }); // gyakuhibu actual history: none

  const result = await handler(makeEvent('GET /yutai/{ticker}', { pathParameters: { ticker: '1234' } }));

  expect((result as { statusCode: number }).statusCode).toBe(200);
  // JSON.stringify drops keys whose value is `undefined`, so this only passes if the
  // implementation coerces a missing rights date / companyName to `null` before returning.
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
