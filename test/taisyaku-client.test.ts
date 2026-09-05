import { extractCsrfToken, splitCsvLine, parseTaisyakuCsv, fetchTaisyakuCsv } from '../lambda/gyakuhibu-history-batch/taisyaku-client';

test('extractCsrfToken reads the csrf_test_name hidden input value', () => {
  const html = '<input type="hidden" name="csrf_test_name" value="abc123def456">';
  expect(extractCsrfToken(html)).toBe('abc123def456');
});

test('extractCsrfToken throws when the token is missing', () => {
  expect(() => extractCsrfToken('<html></html>')).toThrow();
});

// Task 0(docs/superpowers/notes/2026-09-05-taisyaku-csv-balance-columns.md)で実機確認した
// 実物のヘッダー・行をそのまま使う(全角括弧・全27列)。
const HEADER =
  '"銘柄コード","銘柄名","直後基準日","直近制限措置","直近臨時措置","直近特別措置","申込日","市場区分","貸借区分","融資新規（株）","融資返済（株）","融資残高（株）","貸株新規（株）","貸株返済（株）","貸株残高（株）","差引残高（株）","貸借値段（円）","品貸料率（品貸日数分/円）","品貸日数","品貸料率（年率換算/％）","最高料率（品貸日数分/円）","最低料率（品貸日数分/円）","応札ランク","制限措置","臨時措置","特別措置","新株引受・権利入札"';

// splitCsvLineのクォート考慮パーサ自体は、実機データ(3ヶ月・63行)ではカンマ区切りの
// 数値を一度も観測できなかったため防御的な実装(将来カンマ区切りの列が来ても壊れない)。
// このテストは実在パターンではなく、想定される入力形への耐性を確認するもの。
test('splitCsvLine keeps thousands separators inside quoted fields', () => {
  expect(splitCsvLine('"2026-08-27","1,234,567","2,000,000"')).toEqual(['2026-08-27', '1,234,567', '2,000,000']);
});

test('parseTaisyakuCsv returns balances and the actual max rate alongside the fee', () => {
  // 実物(9418、2026-08-27、権利付き最終日): 融資残高1,100/貸株残高2,039,300/差引残高-2,038,200
  // (=融資残高-貸株残高。excessRatioの符号とは逆なので自前計算に使わない)/
  // 貸借値段1,752円/品貸料率14.40円(=最高料率と一致、応札ランクA=最も逼迫)。
  const row =
    '"9418","","20270228","","","","20260827","東証","貸借","0","500","1100","1785200","1800","2039300","-2038200","1752.00","14.40","1","300.00","14.40","0.00","A","","","",""';
  const csv = [HEADER, row].join('\n');
  expect(parseTaisyakuCsv(csv, '2026-08-27', 100)).toEqual({
    rightsDate: '2026-08-27',
    occurred: true,
    totalAmount: 1440,
    days: 1,
    avgRate: 14.4,
    financingBalance: 1100,
    lendingBalance: 2039300,
    lendingPrice: 1752,
    maxRateActual: 14.4,
    bidRank: 'A',
    restriction: null,
    emergencyMeasure: null,
  });
});

test('parseTaisyakuCsv returns occurred=false with balances when the fee is a dash', () => {
  // 実物(9418、2026-08-20、通常日): 品貸料率"-"(品薄なし)。応札ランクも"-"(=null)。
  const row =
    '"9418","","20270228","","","","20260820","東証","貸借","0","5300","25800","0","2000","21900","3900","1775.00","-","1","-","7.20","0.00","-","","","",""';
  const csv = [HEADER, row].join('\n');
  const point = parseTaisyakuCsv(csv, '2026-08-20', 100);
  expect(point?.occurred).toBe(false);
  expect(point?.totalAmount).toBe(0);
  expect(point?.lendingBalance).toBe(21900);
  expect(point?.maxRateActual).toBe(7.2);
  expect(point?.bidRank).toBeNull();
});

test('parseTaisyakuCsv treats a non-numeric "*****" fee the same as a dash (occurred=false)', () => {
  // 実機で発見した想定外パターン(9418、2026-08-21): 融資残高=貸株残高=26,100で差引残高が
  // ちょうど0になる境界日にだけ、品貸料率・年率換算の両方が"-"ではなく"*****"になる
  // (Task 0のnotes参照、63行中1行のみ観測)。Number('*****')はNaNなので、
  // 「'-'と等しいか」ではなく「数値としてparseできるか」で判定しないとoccurred:trueに
  // 誤判定され、totalAmount等がNaNになる。最高料率自体は通常通りの数値のまま。
  const row =
    '"9418","","20270228","","","","20260821","東証","貸借","16800","16500","26100","10300","6100","26100","0","1755.00","*****","1","*****","7.20","0.00","-","","","",""';
  const csv = [HEADER, row].join('\n');
  const point = parseTaisyakuCsv(csv, '2026-08-21', 100);
  expect(point?.occurred).toBe(false);
  expect(point?.totalAmount).toBe(0);
  expect(point?.maxRateActual).toBe(7.2);
});

test('parseTaisyakuCsv still returns undefined when the rights date row is absent', () => {
  const row =
    '"9418","","20270228","","","","20260820","東証","貸借","0","5300","25800","0","2000","21900","3900","1775.00","-","1","-","7.20","0.00","-","","","",""';
  const csv = [HEADER, row].join('\n');
  expect(parseTaisyakuCsv(csv, '2026-08-26', 100)).toBeUndefined();
});

// Fix 3: CSV側の日付フォーマットは未確認("YYYY / MM / DD"の可能性が高いが確定情報ではない)。
// 内部形式("YYYY-MM-DD")と一致しなくても、数字だけを見て一致すれば拾えることを確認する。
test('parseTaisyakuCsv matches a slash-formatted CSV date against an ISO-formatted rightsDate', () => {
  const row =
    '"9418","","20270228","","","","2026 / 08 / 27","東証","貸借","0","500","1100","1785200","1800","2039300","-2038200","1752.00","6.00","1","300.00","14.40","0.00","A","","","",""';
  const csv = [HEADER, row].join('\n');
  const point = parseTaisyakuCsv(csv, '2026-08-27', 100);
  expect(point?.rightsDate).toBe('2026-08-27');
  expect(point?.occurred).toBe(true);
  expect(point?.totalAmount).toBe(600);
  expect(point?.days).toBe(1);
  expect(point?.avgRate).toBe(6);
});

test('parseTaisyakuCsv also matches a plain slash date (no spaces) against an ISO rightsDate', () => {
  const row =
    '"9418","","20270228","","","","2026/08/27","東証","貸借","0","500","1100","1785200","1800","2039300","-2038200","1752.00","6.00","1","300.00","14.40","0.00","A","","","",""';
  const csv = [HEADER, row].join('\n');
  const point = parseTaisyakuCsv(csv, '2026-08-27', 100);
  expect(point?.rightsDate).toBe('2026-08-27');
  expect(point?.occurred).toBe(true);
  expect(point?.totalAmount).toBe(600);
  expect(point?.days).toBe(1);
  expect(point?.avgRate).toBe(6);
});

// Fix 4-3: 融資残高等の株数列はカンマ区切りの桁区切り("1,234,567")で入ることがあり、
// 列数がヘッダーと合わない(genuinely破損した)行は読み違えを防ぐためスキップする。
test('parseTaisyakuCsv skips a row whose column count does not match the header, logging a warning', () => {
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const truncatedRow = '"9418","","20270228","","","","20260826","東証","貸借"'; // 27列より少ない、破損した行
    const csv = [HEADER, truncatedRow].join('\n');

    const result = parseTaisyakuCsv(csv, '2026-08-26', 100, '7203');

    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('7203'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('2026-08-26'));
  } finally {
    warnSpy.mockRestore();
  }
});

// UTF-8のArrayBufferとしてCSVテキストを返す(response.arrayBuffer()のモック用)。
function utf8Buffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

describe('fetchTaisyakuCsv', () => {
  const mockFetch = jest.fn();
  beforeEach(() => {
    mockFetch.mockReset();
    (global as unknown as { fetch: typeof mockFetch }).fetch = mockFetch;
  });

  test('fetches the CSRF token from the detail page, POSTs the date-range search, then GETs the CSV (as arrayBuffer, decoded) with the same session cookie and a User-Agent header throughout', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        headers: { getSetCookie: () => ['ci_session=abc123; Path=/'] },
        text: async () => '<input type="hidden" name="csrf_test_name" value="tok-1">',
      })
      .mockResolvedValueOnce({ ok: true, headers: { getSetCookie: () => [] }, text: async () => '<html>search result</html>' })
      .mockResolvedValueOnce({
        ok: true,
        headers: { getSetCookie: () => [], get: (name: string) => (name === 'content-type' ? 'text/csv' : null) },
        arrayBuffer: async () => utf8Buffer('csv-body'),
      });

    const result = await fetchTaisyakuCsv('7203', '2026-08-05', '2026-08-14');

    // 'csv-body' はヘッダーマーカーを含まないため、UTF-8デコードのままフォールバックで返る。
    expect(result).toBe('csv-body');
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[0][0]).toBe('https://www.taisyaku.jp/app/stock/detail/7203-01');
    expect(mockFetch.mock.calls[0][1].headers['User-Agent']).toBeTruthy();

    const [searchUrl, searchInit] = mockFetch.mock.calls[1];
    expect(searchUrl).toBe('https://www.taisyaku.jp/app/stock/detail/7203/search');
    expect(searchInit.method).toBe('POST');
    expect(searchInit.headers.Cookie).toBe('ci_session=abc123');
    expect(searchInit.headers['User-Agent']).toBeTruthy();
    const body = new URLSearchParams(searchInit.body as string);
    expect(body.get('csrf_test_name')).toBe('tok-1');
    expect(body.get('orgMgrCd')).toBe('7203');
    expect(body.get('mkYmdFrom')).toBe('2026 / 08 / 05');
    expect(body.get('mkYmdTo')).toBe('2026 / 08 / 14');
    expect(body.get('trjoKbn')).toBe('01');

    const [csvUrl, csvInit] = mockFetch.mock.calls[2];
    expect(csvUrl).toBe('https://www.taisyaku.jp/app/stock/detail/7203/csv');
    expect(csvInit.headers.Cookie).toBe('ci_session=abc123');
    expect(csvInit.headers['User-Agent']).toBeTruthy();
  });

  test('throws when the detail page request fails', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'server error' });
    await expect(fetchTaisyakuCsv('7203', '2026-08-05', '2026-08-14')).rejects.toThrow('taisyaku.jp');
  });

  // Fix 4-1: 日本の金融サイトはExcel互換のためShift_JISでCSVを配信することがある。
  // response.text()は常にUTF-8としてデコードしてしまうため、arrayBuffer()を取得して
  // Shift_JISとしてデコードし直す必要がある。実機ヘッダー+実データ行(9418、2026-08-27)を
  // Shift_JISへ実際にエンコードしたバイト列(.NET Encoding.GetEncoding(932)で生成、
  // 16進文字列で埋め込み、Node のTextDecoder('shift_jis')でラウンドトリップ確認済み)を
  // 使って検証する。
  test('decodes a Shift_JIS-encoded CSV response correctly (falls back from the Fetch spec default of UTF-8)', async () => {
    const shiftJisHex =
      '2296c195bf8352815b8368222c2296c195bf96bc222c2292bc8ce38aee8f8093fa222c2292bc8bdf90a78cc0915b9275222c2292bc8bdf97d58e9e915b9275222c2292bc8bdf93c195ca915b9275222c22905c8d9e93fa222c228e738fea8be695aa222c2291dd8ed88be695aa222c22975a8e9190568b4b81698a94816a222c22975a8e9195d48dcf81698a94816a222c22975a8e918e638d8281698a94816a222c2291dd8a9490568b4b81698a94816a222c2291dd8a9495d48dcf81698a94816a222c2291dd8a948e638d8281698a94816a222c228db788f88e638d8281698a94816a222c2291dd8ed8926c92698169897e816a222c22956991dd97bf97a68169956991dd93fa909495aa2f897e816a222c22956991dd93fa9094222c22956991dd97bf97a68169944e97a68ab78e5a2f8193816a222c228dc58d8297bf97a68169956991dd93fa909495aa2f897e816a222c228dc592e197bf97a68169956991dd93fa909495aa2f897e816a222c22899e8e4483898393834e222c2290a78cc0915b9275222c2297d58e9e915b9275222c2293c195ca915b9275222c2290568a9488f88ef381458ca0979893fc8e44220a2239343138222c22222c223230323730323238222c22222c22222c22222c223230323630383237222c22938c8fd8222c2291dd8ed8222c2230222c22353030222c2231313030222c2231373835323030222c2231383030222c2232303339333030222c222d32303338323030222c22313735322e3030222c2231342e3430222c2231222c223330302e3030222c2231342e3430222c22302e3030222c2241222c22222c22222c22222c2222';
    const shiftJisBuffer = Buffer.from(shiftJisHex, 'hex');
    const arrayBuffer = shiftJisBuffer.buffer.slice(
      shiftJisBuffer.byteOffset,
      shiftJisBuffer.byteOffset + shiftJisBuffer.byteLength,
    );

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        headers: { getSetCookie: () => ['ci_session=abc123; Path=/'] },
        text: async () => '<input type="hidden" name="csrf_test_name" value="tok-1">',
      })
      .mockResolvedValueOnce({ ok: true, headers: { getSetCookie: () => [] }, text: async () => '<html>search result</html>' })
      .mockResolvedValueOnce({
        ok: true,
        headers: { getSetCookie: () => [], get: () => 'text/csv' },
        arrayBuffer: async () => arrayBuffer,
      });

    const result = await fetchTaisyakuCsv('7203', '2026-08-27', '2026-08-27');

    expect(result).toContain('申込日');
    expect(result).toContain('品貸料率');

    const point = parseTaisyakuCsv(result, '2026-08-27', 100);
    expect(point).toEqual({
      rightsDate: '2026-08-27',
      occurred: true,
      totalAmount: 1440,
      days: 1,
      avgRate: 14.4,
      financingBalance: 1100,
      lendingBalance: 2039300,
      lendingPrice: 1752,
      maxRateActual: 14.4,
      bidRank: 'A',
      restriction: null,
      emergencyMeasure: null,
    });
  });
});
