import { createHash } from 'crypto';
import { SHRINKAGE_K } from '../lambda/shared/gyakuhibu-forecast';

const mockDdbSend = jest.fn();
const mockS3Send = jest.fn();
const mockGetApiKey = jest.fn();
const mockFetchWithRetry = jest.fn();
const mockFetchTaisyakuCsv = jest.fn();
const mockParseTaisyakuCsv = jest.fn();
const mockResolveTargetTickers = jest.fn();
const mockFetchTickerSnapshotInput = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  ScanCommand: jest.fn((input: unknown) => input),
  QueryCommand: jest.fn((input: unknown) => input),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  PutObjectCommand: jest.fn((input: unknown) => input),
}));
jest.mock('../lambda/shared/jquants-batch-client', () => ({
  getApiKey: (...args: unknown[]) => mockGetApiKey(...args),
  fetchWithRetry: (...args: unknown[]) => mockFetchWithRetry(...args),
}));
jest.mock('../lambda/gyakuhibu-history-batch/taisyaku-client', () => ({
  fetchTaisyakuCsv: (...args: unknown[]) => mockFetchTaisyakuCsv(...args),
  parseTaisyakuCsv: (...args: unknown[]) => mockParseTaisyakuCsv(...args),
}));
jest.mock('../lambda/gyakuhibu-forecast-validation/target-tickers', () => ({
  resolveTargetTickers: (...args: unknown[]) => mockResolveTargetTickers(...args),
}));
jest.mock('../lambda/gyakuhibu-forecast-validation/snapshot-input', () => ({
  fetchTickerSnapshotInput: (...args: unknown[]) => mockFetchTickerSnapshotInput(...args),
}));

process.env.YUTAI_MASTER_TABLE_NAME = 'JQuantsYutaiMaster';
process.env.GYAKUHIBU_ACTUAL_TABLE_NAME = 'JQuantsGyakuhibuActual';
process.env.STOCK_PRICES_TABLE_NAME = 'JQuantsStockPrices';
process.env.SECRET_ARN = 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:JQuantsApiKey';
process.env.VALIDATION_BUCKET_NAME = 'test-validation-bucket';
process.env.TAISYAKU_REQUEST_INTERVAL_MS = '0'; // テストでは待機なしにする

beforeEach(() => {
  mockDdbSend.mockReset();
  // ハンドラは対象銘柄ごとにJQuantsStockPricesへの価格クエリ(fetchPricedClose)を1回追加で
  // 呼ぶため、個別にmockResolvedValueOnceを積んでいないテストでも(先頭2件の初期スキャン分を
  // 消費した後)必ず何かが返るようデフォルトを設定しておく。Items:[]は「価格データ無し」を
  // 意味し、maxRatePerShare/closePriceがnullになるだけで例外は起きない。
  mockDdbSend.mockResolvedValue({ Items: [] });
  mockS3Send.mockReset();
  mockGetApiKey.mockReset();
  mockFetchWithRetry.mockReset();
  mockFetchTaisyakuCsv.mockReset();
  mockParseTaisyakuCsv.mockReset();
  mockResolveTargetTickers.mockReset();
  mockFetchTickerSnapshotInput.mockReset();
});

// -----------------------------------------------------------------------
// resolveTargetTickers: yutai masterとequities/masterの積集合が正しく計算されること
// -----------------------------------------------------------------------
describe('resolveTargetTickers', () => {
  // target-tickers.tsの実装そのものをテストするため、上のjest.mockを経由しない
  // requireActualで実体を読み込む(このdescribeブロック内だけで使う)。
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { resolveTargetTickers: realResolveTargetTickers } = jest.requireActual(
    '../lambda/gyakuhibu-forecast-validation/target-tickers',
  ) as typeof import('../lambda/gyakuhibu-forecast-validation/target-tickers');

  test('intersects yutai-master rows (rightsMonths includes the target month) with equities/master margin-eligible tickers', async () => {
    mockDdbSend.mockResolvedValueOnce({
      Items: [
        { ticker: '1111', companyName: 'A社', value: 1000, unitShares: 100, maxGyakuhibu: 5000, rightsMonths: [9] },
        { ticker: '2222', companyName: 'B社', value: 2000, unitShares: 100, maxGyakuhibu: 3000, rightsMonths: [9] },
        { ticker: '3333', companyName: 'C社', value: 500, unitShares: 100, maxGyakuhibu: 1000, rightsMonths: [3] }, // 対象月(9)を含まない
      ],
    });
    mockGetApiKey.mockResolvedValueOnce('test-api-key');
    mockFetchWithRetry.mockResolvedValueOnce({
      json: async () => ({
        data: [
          { Code: '11110', MrgnNm: '貸借' }, // 1111にマッチ
          { Code: '22220', MrgnNm: '信用' }, // 貸借ではないので除外
          { Code: '99990', MrgnNm: '貸借' }, // yutai masterに無い銘柄
        ],
      }),
    });

    const result = await realResolveTargetTickers(9);

    expect(result.map((r) => r.ticker)).toEqual(['1111']);
    expect(result[0]).toEqual({
      ticker: '1111',
      companyName: 'A社',
      value: 1000,
      unitShares: 100,
      maxGyakuhibu: 5000,
      rightsMonths: [9],
    });
  });

  test('paginates equities/master using pagination_key before intersecting', async () => {
    mockDdbSend.mockResolvedValueOnce({
      Items: [{ ticker: '4444', companyName: 'D社', value: null, unitShares: 100, maxGyakuhibu: null, rightsMonths: [9] }],
    });
    mockGetApiKey.mockResolvedValueOnce('test-api-key');
    mockFetchWithRetry
      .mockResolvedValueOnce({ json: async () => ({ data: [{ Code: '11110', MrgnNm: '貸借' }], pagination_key: 'page2' }) })
      .mockResolvedValueOnce({ json: async () => ({ data: [{ Code: '44440', MrgnNm: '貸借' }] }) });

    const result = await realResolveTargetTickers(9);

    expect(mockFetchWithRetry).toHaveBeenCalledTimes(2);
    expect(result.map((r) => r.ticker)).toEqual(['4444']);
  });

  test('paginates the yutai master DynamoDB scan using LastEvaluatedKey', async () => {
    mockDdbSend
      .mockResolvedValueOnce({
        Items: [{ ticker: '5555', companyName: 'E社', value: 100, unitShares: 100, maxGyakuhibu: 200, rightsMonths: [9] }],
        LastEvaluatedKey: { ticker: '5555' },
      })
      .mockResolvedValueOnce({
        Items: [{ ticker: '6666', companyName: 'F社', value: 100, unitShares: 100, maxGyakuhibu: 200, rightsMonths: [9] }],
      });
    mockGetApiKey.mockResolvedValueOnce('test-api-key');
    mockFetchWithRetry.mockResolvedValueOnce({
      json: async () => ({ data: [{ Code: '55550', MrgnNm: '貸借' }, { Code: '66660', MrgnNm: '貸借' }] }),
    });

    const result = await realResolveTargetTickers(9);

    expect(result.map((r) => r.ticker).sort()).toEqual(['5555', '6666']);
  });
});

// -----------------------------------------------------------------------
// fetchTickerSnapshotInput: 取得失敗時にfetch_errorになり、フォールバックしないこと
// -----------------------------------------------------------------------
describe('fetchTickerSnapshotInput', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { fetchTickerSnapshotInput: realFetch } = jest.requireActual(
    '../lambda/gyakuhibu-forecast-validation/snapshot-input',
  ) as typeof import('../lambda/gyakuhibu-forecast-validation/snapshot-input');

  test('returns fetch_error (no fallback) when fetchTaisyakuCsv throws', async () => {
    mockFetchTaisyakuCsv.mockRejectedValueOnce(new Error('network error'));

    const result = await realFetch('1234', '2026-09-24', 100, 'final');

    expect(result).toEqual({
      ticker: '1234',
      variant: 'final',
      dataStatus: 'fetch_error',
      financingBalance: null,
      lendingBalance: null,
      fetchStatus: 'fetch_error',
      rawCsv: null,
      errorMessage: 'network error',
    });
    expect(mockParseTaisyakuCsv).not.toHaveBeenCalled();
  });

  test('passes an ISO from/to date range (asofDate and 30 days before) straight through to fetchTaisyakuCsv', async () => {
    mockFetchTaisyakuCsv.mockResolvedValueOnce('csv-text');
    mockParseTaisyakuCsv.mockReturnValueOnce(undefined);

    await realFetch('1234', '2026-09-24', 100, 'final');

    expect(mockFetchTaisyakuCsv).toHaveBeenCalledWith('1234', '2026-08-25', '2026-09-24');
  });

  test('returns dataStatus no_row when parseTaisyakuCsv finds no matching row (fetch itself succeeded)', async () => {
    mockFetchTaisyakuCsv.mockResolvedValueOnce('csv-text-without-the-date');
    mockParseTaisyakuCsv.mockReturnValueOnce(undefined);

    const result = await realFetch('1234', '2026-09-24', 100, 'final');

    expect(result.dataStatus).toBe('no_row');
    expect(result.fetchStatus).toBe('ok');
    expect(result.financingBalance).toBeNull();
    expect(result.lendingBalance).toBeNull();
    expect(result.rawCsv).toBe('csv-text-without-the-date'); // 取得自体は成功しているので生CSVは保持する
  });

  test('uses the caller-provided variant as dataStatus when a row is found (no automatic final/prelim detection)', async () => {
    mockFetchTaisyakuCsv.mockResolvedValueOnce('csv-text');
    mockParseTaisyakuCsv.mockReturnValueOnce({
      rightsDate: '2026-09-24',
      occurred: true,
      totalAmount: 100,
      days: 1,
      avgRate: 1,
      financingBalance: 8000,
      lendingBalance: 500,
      lendingPrice: null,
      maxRateActual: 1,
      bidRank: null,
      restriction: null,
      emergencyMeasure: null,
    });

    const finalResult = await realFetch('1234', '2026-09-24', 100, 'final');
    expect(finalResult.dataStatus).toBe('final');
    expect(finalResult.financingBalance).toBe(8000);
    expect(finalResult.lendingBalance).toBe(500);
    expect(finalResult.fetchStatus).toBe('ok');

    mockFetchTaisyakuCsv.mockResolvedValueOnce('csv-text');
    mockParseTaisyakuCsv.mockReturnValueOnce({
      rightsDate: '2026-09-25',
      occurred: false,
      totalAmount: 0,
      days: 0,
      avgRate: 0,
      financingBalance: 8000,
      lendingBalance: 500,
      lendingPrice: null,
      maxRateActual: null,
      bidRank: null,
      restriction: null,
      emergencyMeasure: null,
    });
    const prelimResult = await realFetch('1234', '2026-09-25', 100, 'prelim');
    expect(prelimResult.dataStatus).toBe('prelim');
  });
});

// -----------------------------------------------------------------------
// handler: manifest.jsonが最後に書かれること、sha256が計算されること、
// fetchStatusの内訳がmanifestに正しく反映されること
// -----------------------------------------------------------------------
describe('handler', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { handler } = require('../lambda/gyakuhibu-forecast-validation/index') as {
    handler: (event: {
      rightsDate: string;
      asofLabel: string;
      runId: string;
      prefix?: string;
      variant: 'final' | 'prelim';
      asofDate: string;
    }) => Promise<void>;
  };

  function baseEvent(overrides: Partial<Parameters<typeof handler>[0]> = {}) {
    return {
      rightsDate: '2026-09-28',
      asofLabel: '2026-09-25T2000JST',
      runId: 'run=1',
      variant: 'final' as const,
      asofDate: '2026-09-24',
      ...overrides,
    };
  }

  function s3PutCalls() {
    return mockS3Send.mock.calls.map(([cmd]) => cmd as { Key: string; Body: string; ContentType: string });
  }

  test('writes forecast.json then per-ticker CSVs then manifest.json last, with correct sha256 and status breakdown', async () => {
    mockResolveTargetTickers.mockResolvedValueOnce([
      { ticker: '1111', companyName: 'A社', value: 1000, unitShares: 100, maxGyakuhibu: 5000, rightsMonths: [9] },
      { ticker: '2222', companyName: 'B社', value: 2000, unitShares: 100, maxGyakuhibu: 3000, rightsMonths: [9] },
    ]);
    mockDdbSend
      .mockResolvedValueOnce({ Items: [{ ticker: '1111', unitShares: 100 }, { ticker: '2222', unitShares: 100 }] }) // unit shares scan
      .mockResolvedValueOnce({ Items: [] }); // gyakuhibu actual scan (履歴なし)

    mockFetchTickerSnapshotInput
      .mockResolvedValueOnce({
        ticker: '1111',
        variant: 'final',
        dataStatus: 'final',
        financingBalance: 8000,
        lendingBalance: 500,
        fetchStatus: 'ok',
        rawCsv: 'csv-for-1111',
      })
      .mockResolvedValueOnce({
        ticker: '2222',
        variant: 'final',
        dataStatus: 'fetch_error',
        financingBalance: null,
        lendingBalance: null,
        fetchStatus: 'fetch_error',
        rawCsv: null,
        errorMessage: 'boom',
      });

    mockS3Send.mockResolvedValue({});

    await handler(baseEvent());

    const puts = s3PutCalls();
    // forecast.json, inputs/1111.csv(2222はrawCsvが無いので書かれない), manifest.jsonの順で3件。
    expect(puts).toHaveLength(3);
    expect(puts[0].Key).toBe('forecast-snapshots/rightsDate=2026-09-28/asof=2026-09-25T2000JST/run=run=1/forecast.json');
    expect(puts[1].Key).toBe('forecast-snapshots/rightsDate=2026-09-28/asof=2026-09-25T2000JST/run=run=1/inputs/1111.csv');
    const manifestPut = puts[puts.length - 1];
    expect(manifestPut.Key).toBe('forecast-snapshots/rightsDate=2026-09-28/asof=2026-09-25T2000JST/run=run=1/manifest.json');

    const forecastJsonBody = puts[0].Body;
    const expectedForecastHash = createHash('sha256').update(forecastJsonBody, 'utf8').digest('hex');
    const expectedCsvHash = createHash('sha256').update('csv-for-1111', 'utf8').digest('hex');

    const manifest = JSON.parse(manifestPut.Body) as {
      files: Record<string, string>;
      tickerCounts: { total: number; byDataStatus: Record<string, number>; byFetchStatus: Record<string, number> };
      primaryVariant: string;
      modelParams: { shrinkageK: number; binEdges: Array<{ label: string; lo: number | null; hi: number | null }> };
    };
    expect(manifest.files['forecast.json']).toBe(expectedForecastHash);
    expect(manifest.files['inputs/1111.csv']).toBe(expectedCsvHash);
    expect(manifest.files['inputs/2222.csv']).toBeUndefined();
    expect(manifest.tickerCounts.total).toBe(2);
    expect(manifest.tickerCounts.byFetchStatus).toEqual({ ok: 1, fetch_error: 1 });
    expect(manifest.tickerCounts.byDataStatus).toEqual({ final: 1, fetch_error: 1 });
    expect(manifest.primaryVariant).toBe('final');
    expect(manifest.modelParams.shrinkageK).toBe(4);
    // BIN_EDGESの-Infinity/Infinityはmanifest上ではnullになる(finiteOrNull)。
    expect(manifest.modelParams.binEdges[0]).toEqual({ label: '融資超過', lo: null, hi: 0 });
    expect(manifest.modelParams.binEdges[manifest.modelParams.binEdges.length - 1].hi).toBeNull();

    const forecastJson = JSON.parse(forecastJsonBody) as { records: Array<Record<string, unknown>> };
    expect(forecastJson.records).toHaveLength(2);
    const record1111 = forecastJson.records.find((r) => r.ticker === '1111')!;
    expect(record1111.dataStatus).toBe('final');
    expect(record1111.requiredShares).toBe(100); // unitSharesをそのまま使う単純化(task-2-brief.md Step 3.5)
    const record2222 = forecastJson.records.find((r) => r.ticker === '2222')!;
    expect(record2222.dataStatus).toBe('fetch_error');
    expect(record2222.fetchStatus).toBe('fetch_error');
    expect(record2222.financingBalance).toBeNull();
  });

  test('a ticker with no history gets scenario none and forecastStatus na (no current-tse fallback)', async () => {
    mockResolveTargetTickers.mockResolvedValueOnce([
      { ticker: '1111', companyName: 'A社', value: 1000, unitShares: 100, maxGyakuhibu: 5000, rightsMonths: [9] },
    ]);
    mockDdbSend
      .mockResolvedValueOnce({ Items: [{ ticker: '1111', unitShares: 100 }] })
      .mockResolvedValueOnce({ Items: [] });
    mockFetchTickerSnapshotInput.mockResolvedValueOnce({
      ticker: '1111',
      variant: 'final',
      dataStatus: 'final',
      financingBalance: 100,
      lendingBalance: 50,
      fetchStatus: 'ok',
      rawCsv: 'csv',
    });
    mockS3Send.mockResolvedValue({});

    await handler(baseEvent());

    const puts = s3PutCalls();
    const forecastJson = JSON.parse(puts[0].Body) as {
      records: Array<{ forecast: { scenario: string; forecastStatus: string; shrinkageWeight: number | null } }>;
    };
    expect(forecastJson.records[0].forecast.scenario).toBe('none');
    expect(forecastJson.records[0].forecast.forecastStatus).toBe('na');
    // tickerSamples=0かつpoolSamples=0(真のna)のときは、forecast()内部でも縮小重みwを
    // 一切計算しないので、意味のある数値を捏造せずnullにする。
    expect(forecastJson.records[0].forecast.shrinkageWeight).toBeNull();
  });

  test('records a real fractional shrinkageWeight (nT/(nT+SHRINKAGE_K)) when both ticker and pool samples exist', async () => {
    mockResolveTargetTickers.mockResolvedValueOnce([
      { ticker: '1111', companyName: 'A社', value: 1000, unitShares: 100, maxGyakuhibu: 5000, rightsMonths: [9] },
    ]);
    mockDdbSend
      .mockResolvedValueOnce({ Items: [{ ticker: '1111', unitShares: 100 }] }) // unit shares scan
      .mockResolvedValueOnce({
        // 2件とも1111自身の過去実績(nT=2)。同じビンに属するプールサンプルにもなる(nP>=2)。
        // maxRateActualが無いとtoSample()がnull(除外)を返す(fillRatio()のガード)ため必須。
        Items: [
          {
            ticker: '1111',
            rightsDate: '2025-09-26',
            financingBalance: 100,
            lendingBalance: 500,
            avgRate: 1,
            days: 1,
            maxRateActual: 2,
            enriched: true,
          },
          {
            ticker: '1111',
            rightsDate: '2024-09-27',
            financingBalance: 100,
            lendingBalance: 500,
            avgRate: 1,
            days: 1,
            maxRateActual: 2,
            enriched: true,
          },
        ],
      });
    mockFetchTickerSnapshotInput.mockResolvedValueOnce({
      ticker: '1111',
      variant: 'final',
      dataStatus: 'final',
      financingBalance: 100,
      lendingBalance: 500,
      fetchStatus: 'ok',
      rawCsv: 'csv',
    });
    mockS3Send.mockResolvedValue({});

    await handler(baseEvent());

    const puts = s3PutCalls();
    const forecastJson = JSON.parse(puts[0].Body) as {
      records: Array<{ forecast: { tickerSamples: number; poolSamples: number; shrinkageWeight: number } }>;
    };
    const record = forecastJson.records[0].forecast;
    expect(record.tickerSamples).toBeGreaterThan(0);
    const expectedWeight = record.tickerSamples / (record.tickerSamples + SHRINKAGE_K);
    expect(record.shrinkageWeight).toBeCloseTo(expectedWeight, 10);
  });

  test('an unexpected exception from fetchTickerSnapshotInput is caught and treated as fetch_error rather than aborting the run', async () => {
    mockResolveTargetTickers.mockResolvedValueOnce([
      { ticker: '1111', companyName: 'A社', value: 1000, unitShares: 100, maxGyakuhibu: 5000, rightsMonths: [9] },
    ]);
    mockDdbSend
      .mockResolvedValueOnce({ Items: [{ ticker: '1111', unitShares: 100 }] })
      .mockResolvedValueOnce({ Items: [] });
    mockFetchTickerSnapshotInput.mockRejectedValueOnce(new Error('totally unexpected'));
    mockS3Send.mockResolvedValue({});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await handler(baseEvent());
    } finally {
      errorSpy.mockRestore();
    }

    const puts = s3PutCalls();
    const forecastJson = JSON.parse(puts[0].Body) as { records: Array<{ dataStatus: string; fetchStatus: string }> };
    expect(forecastJson.records[0].dataStatus).toBe('fetch_error');
    expect(forecastJson.records[0].fetchStatus).toBe('fetch_error');
    const manifest = JSON.parse(puts[puts.length - 1].Body) as { tickerCounts: { byFetchStatus: Record<string, number> } };
    expect(manifest.tickerCounts.byFetchStatus).toEqual({ fetch_error: 1 });
  });

  // -----------------------------------------------------------------------
  // 権利日(rightsDate)申込分の最高料率はJQuantsYutaiMasterの事前計算済みmaxGyakuhibuに
  // 頼らず、このLambda自身がJQuantsStockPricesから直接取得した終値で独立に算出すること
  // (設計書「最高料率は9/25終値で確定計算できる」/Task 2「9/25終値を取得する」)。
  // -----------------------------------------------------------------------
  test('computes closePrice/pricedAt/maxRatePerShare/days independently from JQuantsStockPrices rather than the stale yutai-master maxGyakuhibu field', async () => {
    mockResolveTargetTickers.mockResolvedValueOnce([
      // yutai-masterのmaxGyakuhibu(999999)はいつ計算されたか不明な事前計算値。
      // 独立計算の結果がこれを使っていないことを確認する。
      { ticker: '9418', companyName: 'U-NEXT HD', value: 3000, unitShares: 100, maxGyakuhibu: 999999, rightsMonths: [9] },
    ]);
    mockDdbSend
      .mockResolvedValueOnce({ Items: [{ ticker: '9418', unitShares: 100 }] }) // unit shares scan
      .mockResolvedValueOnce({ Items: [] }) // gyakuhibu actual scan
      .mockResolvedValueOnce({ Items: [{ ticker: '9418', date: '2026-09-25', close: 1800 }] }); // 価格クエリ
    mockFetchTickerSnapshotInput.mockResolvedValueOnce({
      ticker: '9418',
      variant: 'final',
      dataStatus: 'final',
      financingBalance: 100,
      lendingBalance: 50,
      fetchStatus: 'ok',
      rawCsv: 'csv',
    });
    mockS3Send.mockResolvedValue({});

    await handler(baseEvent());

    const puts = s3PutCalls();
    const forecastJson = JSON.parse(puts[0].Body) as {
      records: Array<{
        closePrice: number | null;
        pricedAt: string | null;
        maxRatePerShare: number | null;
        days: number;
        forecast: { maxGyakuhibu: number | null };
      }>;
    };
    const record = forecastJson.records[0];
    expect(record.closePrice).toBe(1800);
    expect(record.pricedAt).toBe('2026-09-25');
    // calcMaxRate(1800, 100) = 3.6(投資単位180,000円→上限360円÷単元100株) × RIGHTS_DAY_RATE_MULTIPLIER(4) = 14.4
    expect(record.maxRatePerShare).toBe(14.4);
    expect(record.days).toBe(1);
    // 14.4 × unitShares(100) × days(1) = 1440。yutai-masterの古いmaxGyakuhibu(999999)とは無関係。
    expect(record.forecast.maxGyakuhibu).toBe(1440);

    const priceQueryCall = mockDdbSend.mock.calls[2][0] as {
      TableName: string;
      KeyConditionExpression: string;
      ExpressionAttributeValues: Record<string, string>;
    };
    expect(priceQueryCall.TableName).toBe('JQuantsStockPrices');
    expect(priceQueryCall.KeyConditionExpression).toBe('ticker = :ticker AND #date < :beforeDate');
    // rightsDate(9/28)より前を問い合わせる(9/28自身の終値と混同しない)。
    expect(priceQueryCall.ExpressionAttributeValues[':beforeDate']).toBe('2026-09-28');
  });

  test('falls back to null closePrice/maxRatePerShare/maxGyakuhibu when no price row exists before rightsDate, without crashing the run', async () => {
    mockResolveTargetTickers.mockResolvedValueOnce([
      { ticker: '9418', companyName: 'U-NEXT HD', value: 3000, unitShares: 100, maxGyakuhibu: 999999, rightsMonths: [9] },
    ]);
    mockDdbSend
      .mockResolvedValueOnce({ Items: [{ ticker: '9418', unitShares: 100 }] })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [] }); // 価格データ無し
    mockFetchTickerSnapshotInput.mockResolvedValueOnce({
      ticker: '9418',
      variant: 'final',
      dataStatus: 'final',
      financingBalance: 100,
      lendingBalance: 50,
      fetchStatus: 'ok',
      rawCsv: 'csv',
    });
    mockS3Send.mockResolvedValue({});

    await handler(baseEvent());

    const puts = s3PutCalls();
    const forecastJson = JSON.parse(puts[0].Body) as {
      records: Array<{
        closePrice: number | null;
        pricedAt: string | null;
        maxRatePerShare: number | null;
        forecast: { maxGyakuhibu: number | null };
      }>;
    };
    const record = forecastJson.records[0];
    expect(record.closePrice).toBeNull();
    expect(record.pricedAt).toBeNull();
    expect(record.maxRatePerShare).toBeNull();
    expect(record.forecast.maxGyakuhibu).toBeNull();
  });
});
