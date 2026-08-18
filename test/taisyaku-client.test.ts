import { extractCsrfToken, parseTaisyakuCsv, fetchTaisyakuCsv } from '../lambda/gyakuhibu-history-batch/taisyaku-client';

test('extractCsrfToken reads the csrf_test_name hidden input value', () => {
  const html = '<input type="hidden" name="csrf_test_name" value="abc123def456">';
  expect(extractCsrfToken(html)).toBe('abc123def456');
});

test('extractCsrfToken throws when the token is missing', () => {
  expect(() => extractCsrfToken('<html></html>')).toThrow();
});

// CSVは日付ごとに1行、taisyaku.jpの画面表示テーブルと同じ列名(申込日/品貸料率(品貸日数分/円)/品貸日数)を持つ想定。
// 実際にダウンロードしたCSVの列名・行列の向きが異なると判明した場合は、このテストと
// parseTaisyakuCsvの実装を実物に合わせて書き換えること(docs/superpowers/notes/2026-08-13-taisyaku-csv-format.md 参照)。
test('parseTaisyakuCsv scales the per-share lending fee to unitShares for the matching rights date', () => {
  const csv = [
    '申込日,品貸料率(品貸日数分/円),品貸日数',
    '2026-08-25,6.00,1',
    '2026-08-26,18.00,3',
  ].join('\n');

  const result = parseTaisyakuCsv(csv, '2026-08-26', 100);

  expect(result).toEqual({
    rightsDate: '2026-08-26',
    totalAmount: 18.0 * 100,
    days: 3,
    avgRate: 18.0 / 3,
  });
});

test('parseTaisyakuCsv returns undefined when the matching date has no lending fee (a dash, meaning no shortage occurred)', () => {
  const csv = ['申込日,品貸料率(品貸日数分/円),品貸日数', '2026-08-26,-,1'].join('\n');
  expect(parseTaisyakuCsv(csv, '2026-08-26', 100)).toBeUndefined();
});

test('parseTaisyakuCsv returns undefined when the rights date is not in the CSV at all', () => {
  const csv = ['申込日,品貸料率(品貸日数分/円),品貸日数', '2026-08-20,6.00,1'].join('\n');
  expect(parseTaisyakuCsv(csv, '2026-08-26', 100)).toBeUndefined();
});

// Fix 3: CSV側の日付フォーマットは未確認("YYYY / MM / DD"の可能性が高いが確定情報ではない)。
// 内部形式("YYYY-MM-DD")と一致しなくても、数字だけを見て一致すれば拾えることを確認する。
test('parseTaisyakuCsv matches a slash-formatted CSV date against an ISO-formatted rightsDate', () => {
  const csv = ['申込日,品貸料率(品貸日数分/円),品貸日数', '2026 / 08 / 13,6.00,1'].join('\n');
  const result = parseTaisyakuCsv(csv, '2026-08-13', 100);
  expect(result).toEqual({ rightsDate: '2026-08-13', totalAmount: 600, days: 1, avgRate: 6 });
});

test('parseTaisyakuCsv also matches a plain slash date (no spaces) against an ISO rightsDate', () => {
  const csv = ['申込日,品貸料率(品貸日数分/円),品貸日数', '2026/08/13,6.00,1'].join('\n');
  const result = parseTaisyakuCsv(csv, '2026-08-13', 100);
  expect(result).toEqual({ rightsDate: '2026-08-13', totalAmount: 600, days: 1, avgRate: 6 });
});

// Fix 6: taisyaku.jpが実際に返すCSVは全フィールドがダブルクォートで囲まれている
// (例: "2026-08-26","18.00","3")。trim()だけではクォートが残ったままNumber()に渡ってしまい
// (Number('"18.00"')はNaN)、実際に逆日歩が発生した行でも常にNaN判定→undefined(「実績なし」)
// を返してしまうバグが実機検証で発覚した(日付一致判定は数字以外除去で偶然クォートの影響を
// 受けなかったため、これまで気づけなかった)。
test('parseTaisyakuCsv strips surrounding double quotes from CSV fields before parsing numbers', () => {
  const csv = [
    '"申込日","品貸料率(品貸日数分/円)","品貸日数"',
    '"2026-08-25","6.00","1"',
    '"2026-08-26","18.00","3"',
  ].join('\n');

  const result = parseTaisyakuCsv(csv, '2026-08-26', 100);

  expect(result).toEqual({
    rightsDate: '2026-08-26',
    totalAmount: 18.0 * 100,
    days: 3,
    avgRate: 18.0 / 3,
  });
});

// Fix 4-3: 融資残高等の株数列はカンマ区切りの桁区切り("1,234,567")で入ることがあり、
// 素朴なsplit(',')だと列がずれる。列数がヘッダーと合わない行は読み違えを防ぐためスキップする。
test('parseTaisyakuCsv skips a row whose column count does not match the header, logging a warning', () => {
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const csv = [
      '申込日,品貸料率(品貸日数分/円),品貸日数',
      '2026-08-26,"1,234",3', // カンマを含む値のせいで列がずれた行(4列になってしまう)
    ].join('\n');

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
  // Shift_JISとしてデコードし直す必要がある。既知の日本語文字列をShift_JISへ実際に
  // エンコードしたバイト列(Python `str.encode('shift_jis')`で生成、16進文字列で埋め込み)
  // を使って検証する。
  test('decodes a Shift_JIS-encoded CSV response correctly (falls back from the Fetch spec default of UTF-8)', async () => {
    // '申込日,品貸料率(品貸日数分/円),品貸日数\n2026-08-26,18.00,3' を shift_jis でエンコードしたバイト列
    const shiftJisHex =
      '905c8d9e93fa2c956991dd97bf97a628956991dd93fa909495aa2f897e292c956991dd93fa90940a323032362d30382d32362c31382e30302c33';
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

    const result = await fetchTaisyakuCsv('7203', '2026-08-26', '2026-08-26');

    expect(result).toContain('申込日');
    expect(result).toContain('品貸料率');

    const point = parseTaisyakuCsv(result, '2026-08-26', 100);
    expect(point).toEqual({ rightsDate: '2026-08-26', totalAmount: 1800, days: 3, avgRate: 6 });
  });
});
