import { createHash } from 'crypto';
import { Readable } from 'stream';

const mockDdbSend = jest.fn();
const mockS3Send = jest.fn();
const mockFetchTaisyakuCsv = jest.fn();
const mockParseTaisyakuCsv = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  GetCommand: jest.fn((input: unknown) => input),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  // input: unknownだとTS2698(spread types may only be created from object types)になるため、
  // 既存のGetCommandモック(input: unknown、spreadしない)とは違いここではspreadする必要が
  // あるので、brief記載のunknownからRecord<string, unknown>に変更する(ふるまいは同じ)。
  PutObjectCommand: jest.fn((input: Record<string, unknown>) => ({ __type: 'put', ...input })),
  GetObjectCommand: jest.fn((input: Record<string, unknown>) => ({ __type: 'get', ...input })),
}));
jest.mock('../lambda/gyakuhibu-history-batch/taisyaku-client', () => {
  const actual = jest.requireActual('../lambda/gyakuhibu-history-batch/taisyaku-client');
  return {
    ...actual,
    fetchTaisyakuCsv: (...args: unknown[]) => mockFetchTaisyakuCsv(...args),
    parseTaisyakuCsv: (...args: unknown[]) => mockParseTaisyakuCsv(...args),
  };
});

process.env.VALIDATION_BUCKET_NAME = 'test-validation-bucket';
process.env.GYAKUHIBU_ACTUAL_TABLE_NAME = 'JQuantsGyakuhibuActual';
process.env.TAISYAKU_REQUEST_INTERVAL_MS = '0';
process.env.SNAPSHOT_A_KEY = 'forecast-snapshots/rightsDate=2026-09-28/asof=2026-09-26T0000JST/run=run=1/forecast.json';

function frozenForecastJsonBody(records: unknown[]): string {
  return JSON.stringify({ records });
}

function s3GetObjectStub(body: string) {
  return { Body: Readable.from([Buffer.from(body, 'utf8')]) };
}

// taisyaku-client.ts全体をjest.mockしている(fetchTaisyakuCsvとparseTaisyakuCsv両方)ため、
// mockParseTaisyakuCsvに実装を与えないと常にundefinedを返し、fetchTickerActualsInput/
// handlerの実質的な計算ロジック(lendingFeeTotal・multiplierActual・crossCheck等)を
// 一切検証できない(何を渡してもno_row/nullになり、偶然一致するケース以外は落ちる)。
// このテストスイートで本当にネットワークI/Oとして差し替えたいのはfetchTaisyakuCsvだけ
// (parseTaisyakuCsvは純粋関数でありCSVの中身次第で正しい値を計算する必要がある)ため、
// デフォルトでは実装(realParseTaisyakuCsv)にそのまま委譲する。
const { parseTaisyakuCsv: realParseTaisyakuCsv } = jest.requireActual(
  '../lambda/gyakuhibu-history-batch/taisyaku-client',
) as typeof import('../lambda/gyakuhibu-history-batch/taisyaku-client');

beforeEach(() => {
  mockDdbSend.mockReset();
  mockDdbSend.mockResolvedValue({}); // デフォルトはItem無し(クロスチェック対象無し)
  mockS3Send.mockReset();
  mockFetchTaisyakuCsv.mockReset();
  mockParseTaisyakuCsv.mockReset();
  mockParseTaisyakuCsv.mockImplementation((...args: Parameters<typeof realParseTaisyakuCsv>) =>
    realParseTaisyakuCsv(...args),
  );
});

// -----------------------------------------------------------------------
// extractMinRateActual / fetchTickerActualsInput: '-' → 0円、行欠損 → no_row、
// クォート付きの値のパース、倍率の判定
// -----------------------------------------------------------------------
describe('fetchTickerActualsInput', () => {
  const { fetchTickerActualsInput: realFetch } = jest.requireActual(
    '../lambda/gyakuhibu-forecast-actuals/actuals-input',
  ) as typeof import('../lambda/gyakuhibu-forecast-actuals/actuals-input');
  const { parseTaisyakuCsv: realParse } = jest.requireActual(
    '../lambda/gyakuhibu-history-batch/taisyaku-client',
  ) as typeof import('../lambda/gyakuhibu-history-batch/taisyaku-client');

  const CSV_HEADER =
    '"銘柄コード","申込日","融資残高（株）","貸株残高（株）","貸借値段（円）","品貸料率（品貸日数分/円）","品貸日数","品貸料率（年率換算/％）","最高料率（品貸日数分/円）","最低料率（品貸日数分/円）","応札ランク","制限措置","臨時措置"';

  test('returns fetch_error (no fallback) when fetchTaisyakuCsv throws', async () => {
    mockFetchTaisyakuCsv.mockRejectedValueOnce(new Error('network error'));

    const result = await realFetch('1234', '2026-09-28');

    expect(result).toEqual({
      ticker: '1234',
      fetchStatus: 'fetch_error',
      lendingFeeTotal: null,
      days: null,
      maxRateActual: null,
      minRateActual: null,
      financingBalance: null,
      lendingBalance: null,
      bidRank: null,
      measures: [],
      rawCsv: null,
      errorMessage: 'network error',
    });
  });

  test('returns no_row when the target date is missing from the CSV (page fetched but no matching row)', async () => {
    const csv = `${CSV_HEADER}\n"1234","20260924","8000","500","3551.00","0.20","1","2.05","14.40","0.00","F","",""`;
    mockFetchTaisyakuCsv.mockResolvedValueOnce(csv);

    const result = await realFetch('1234', '2026-09-28');

    expect(result.fetchStatus).toBe('no_row');
    expect(result.rawCsv).toBe(csv); // ページ自体の取得には成功しているので生CSVは保持
  });

  test('parses a quoted "-" (no gyakuhibu) row as ok with lendingFeeTotal effectively 0, and extracts minRateActual', async () => {
    const csv = `${CSV_HEADER}\n"1234","20260928","8000","500","3551.00","-","1","-","14.40","0.00","-","",""`;
    mockFetchTaisyakuCsv.mockResolvedValueOnce(csv);

    const result = await realFetch('1234', '2026-09-28');

    expect(result.fetchStatus).toBe('ok');
    expect(result.lendingFeeTotal).toBe(0); // parseTaisyakuCsvの仕様: perShareRateがnullならtotalAmount=0
    expect(result.maxRateActual).toBe(14.4);
    expect(result.minRateActual).toBe(0);
    expect(result.bidRank).toBeNull(); // '-' はnullに丸められる(blankToNull)
  });

  test('parses a real occurrence row with quoted numeric values and populates measures from restriction/emergencyMeasure', async () => {
    const csv = `${CSV_HEADER}\n"1234","20260928","8000","500","3551.00","0.60","1","2.19","14.40","0.00","F","注意銘柄","臨時"`;
    mockFetchTaisyakuCsv.mockResolvedValueOnce(csv);

    const result = await realFetch('1234', '2026-09-28');

    expect(result.fetchStatus).toBe('ok');
    expect(result.lendingFeeTotal).toBe(0.6); // unitShares=1で呼ぶので1株あたりの生値そのまま
    expect(result.days).toBe(1);
    expect(result.measures).toEqual(['注意銘柄', '臨時']);
  });

  test('sanity-checks against the real parseTaisyakuCsv (not the mock) to confirm the unitShares=1 convention', () => {
    const csv = `${CSV_HEADER}\n"1234","20260928","8000","500","3551.00","0.60","1","2.19","14.40","0.00","F","",""`;
    const point = realParse(csv, '2026-09-28', 1, '1234');
    expect(point?.totalAmount).toBe(0.6); // unitShares=1のときtotalAmount=perShareRateそのもの
  });
});

// -----------------------------------------------------------------------
// handler: 銘柄母集団の固定、multiplierActual/specialMultiplier判定、
// manifest.jsonが最後に書かれること、クロスチェック
// -----------------------------------------------------------------------
describe('handler', () => {
  const { handler } = require('../lambda/gyakuhibu-forecast-actuals/index') as {
    handler: (event: { rightsDate: string; fetchedLabel: string; prefix?: string }) => Promise<void>;
  };

  function s3Calls() {
    return mockS3Send.mock.calls.map(([cmd]) => cmd as { __type: string; Key?: string; Body?: string });
  }

  test('loads the fixed target population from the frozen Snapshot A forecast.json, not a fresh scan', async () => {
    mockS3Send.mockImplementationOnce(async () =>
      s3GetObjectStub(
        frozenForecastJsonBody([
          { ticker: '1111', companyName: 'A社', value: 1000, unitShares: 100, requiredShares: 100, closePrice: 1800, days: 1 },
        ]),
      ),
    );
    mockFetchTaisyakuCsv.mockResolvedValueOnce(
      '"銘柄コード","申込日","融資残高（株）","貸株残高（株）","貸借値段（円）","品貸料率（品貸日数分/円）","品貸日数","品貸料率（年率換算/％）","最高料率（品貸日数分/円）","最低料率（品貸日数分/円）","応札ランク","制限措置","臨時措置"\n"1111","20260928","100","50","1800.00","-","1","-","3.60","0.00","-","",""',
    );
    mockS3Send.mockResolvedValue({}); // 以降のput-objectは成功扱い

    await handler({ rightsDate: '2026-09-28', fetchedLabel: '2026-09-29T2000JST' });

    const getCall = mockS3Send.mock.calls[0][0] as { __type: string; Key: string };
    expect(getCall.__type).toBe('get');
    expect(getCall.Key).toBe('forecast-snapshots/rightsDate=2026-09-28/asof=2026-09-26T0000JST/run=run=1/forecast.json');

    const puts = s3Calls().filter((c) => c.__type === 'put');
    expect(puts).toHaveLength(3); // actuals.json, inputs/1111.csv, manifest.json
    expect(puts[0].Key).toBe('actuals/rightsDate=2026-09-28/fetchedAt=2026-09-29T2000JST/actuals.json');
    expect(puts[puts.length - 1].Key).toBe('actuals/rightsDate=2026-09-28/fetchedAt=2026-09-29T2000JST/manifest.json');
  });

  test('computes multiplierActual against the frozen closePrice/unitShares/days and flags specialMultiplier when it deviates from 4x', async () => {
    mockS3Send.mockImplementationOnce(async () =>
      s3GetObjectStub(
        frozenForecastJsonBody([
          { ticker: '1111', companyName: 'A社', value: 1000, unitShares: 100, requiredShares: 100, closePrice: 1800, days: 1 },
        ]),
      ),
    );
    // calcMaxRate(1800, 100) = 3.6 (投資単位180,000円→上限360円÷単元100株)。
    // 期待される4倍の最高料率 = 3.6 × 4 × 1日 = 14.4。ここでは8倍相当の28.8を実績として与える。
    mockFetchTaisyakuCsv.mockResolvedValueOnce(
      '"銘柄コード","申込日","融資残高（株）","貸株残高（株）","貸借値段（円）","品貸料率（品貸日数分/円）","品貸日数","品貸料率（年率換算/％）","最高料率（品貸日数分/円）","最低料率（品貸日数分/円）","応札ランク","制限措置","臨時措置"\n"1111","20260928","100","500","1800.00","10.00","1","-","28.80","5.00","F","","臨時"',
    );
    mockS3Send.mockResolvedValue({});

    await handler({ rightsDate: '2026-09-28', fetchedLabel: '2026-09-29T2000JST' });

    const actualsJsonBody = s3Calls().filter((c) => c.__type === 'put')[0].Body!;
    const parsed = JSON.parse(actualsJsonBody) as { records: Array<{ multiplierActual: number; specialMultiplier: boolean }> };
    expect(parsed.records[0].multiplierActual).toBeCloseTo(8, 5);
    expect(parsed.records[0].specialMultiplier).toBe(true);
  });

  test('flags a cross-check mismatch against the existing JQuantsGyakuhibuActual row', async () => {
    mockS3Send.mockImplementationOnce(async () =>
      s3GetObjectStub(
        frozenForecastJsonBody([
          { ticker: '1111', companyName: 'A社', value: 1000, unitShares: 100, requiredShares: 100, closePrice: 1800, days: 1 },
        ]),
      ),
    );
    mockFetchTaisyakuCsv.mockResolvedValueOnce(
      '"銘柄コード","申込日","融資残高（株）","貸株残高（株）","貸借値段（円）","品貸料率（品貸日数分/円）","品貸日数","品貸料率（年率換算/％）","最高料率（品貸日数分/円）","最低料率（品貸日数分/円）","応札ランク","制限措置","臨時措置"\n"1111","20260928","100","500","1800.00","0.60","1","2.19","14.40","0.00","F","",""',
    );
    mockDdbSend.mockResolvedValueOnce({ Item: { avgRate: 999 } }); // 明らかに食い違う既存値
    mockS3Send.mockResolvedValue({});

    await handler({ rightsDate: '2026-09-28', fetchedLabel: '2026-09-29T2000JST' });

    const manifestBody = s3Calls().filter((c) => c.__type === 'put').slice(-1)[0].Body!;
    const manifest = JSON.parse(manifestBody) as { crossCheckMismatches: Array<{ ticker: string }> };
    expect(manifest.crossCheckMismatches).toEqual([{ ticker: '1111', ours: 0.6, existing: 999 }]);
  });

  test('an unexpected exception thrown by fetchTickerActualsInput itself (not caught internally) is caught by the outer handler loop and treated as fetch_error, rather than aborting the run', async () => {
    mockS3Send.mockImplementationOnce(async () =>
      s3GetObjectStub(
        frozenForecastJsonBody([
          { ticker: '1111', companyName: 'A社', value: 1000, unitShares: 100, requiredShares: 100, closePrice: 1800, days: 1 },
        ]),
      ),
    );
    // fetchTaisyakuCsv自体の失敗はfetchTickerActualsInput内部のtry/catch(actuals-input.ts)で
    // 既にfetch_errorへ変換されるため(それは上のfetchTickerActualsInputのdescribeで別途検証済み)、
    // それをmockFetchTaisyakuCsv.mockRejectedValueOnceで模擬してもindex.ts側の外側のtry/catch
    // (1銘柄の想定外の例外がrun全体を止めないための最終防御、handler内のfor文)は一切通らない。
    // 実際に外側のcatchへ到達させるには、fetchTickerActualsInput自身が例外を投げる必要がある。
    // parseTaisyakuCsvの呼び出しはactuals-input.ts内でtry/catchされていない(taisyaku.jpの
    // CSVヘッダー形状が想定外だった場合にthrowする、taisyaku-client.ts参照)ため、ここから
    // 想定外の例外を模擬する。
    mockFetchTaisyakuCsv.mockResolvedValueOnce('dummy-csv-body');
    mockParseTaisyakuCsv.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    mockS3Send.mockResolvedValue({});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await handler({ rightsDate: '2026-09-28', fetchedLabel: '2026-09-29T2000JST' });
    } finally {
      errorSpy.mockRestore();
    }

    const actualsJsonBody = s3Calls().filter((c) => c.__type === 'put')[0].Body!;
    const parsed = JSON.parse(actualsJsonBody) as { records: Array<{ fetchStatus: string }> };
    expect(parsed.records[0].fetchStatus).toBe('fetch_error');
  });
});
