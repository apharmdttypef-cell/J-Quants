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

describe('fetchTaisyakuCsv', () => {
  const mockFetch = jest.fn();
  beforeEach(() => {
    mockFetch.mockReset();
    (global as unknown as { fetch: typeof mockFetch }).fetch = mockFetch;
  });

  test('fetches the CSRF token from the detail page, POSTs the date-range search, then GETs the CSV with the same session cookie', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        headers: { getSetCookie: () => ['ci_session=abc123; Path=/'] },
        text: async () => '<input type="hidden" name="csrf_test_name" value="tok-1">',
      })
      .mockResolvedValueOnce({ ok: true, headers: { getSetCookie: () => [] }, text: async () => '<html>search result</html>' })
      .mockResolvedValueOnce({ ok: true, headers: { getSetCookie: () => [] }, text: async () => 'csv-body' });

    const result = await fetchTaisyakuCsv('7203', '2026-08-05', '2026-08-14');

    expect(result).toBe('csv-body');
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[0][0]).toBe('https://www.taisyaku.jp/app/stock/detail/7203-01');

    const [searchUrl, searchInit] = mockFetch.mock.calls[1];
    expect(searchUrl).toBe('https://www.taisyaku.jp/app/stock/detail/7203/search');
    expect(searchInit.method).toBe('POST');
    expect(searchInit.headers.Cookie).toBe('ci_session=abc123');
    const body = new URLSearchParams(searchInit.body as string);
    expect(body.get('csrf_test_name')).toBe('tok-1');
    expect(body.get('orgMgrCd')).toBe('7203');
    expect(body.get('mkYmdFrom')).toBe('2026 / 08 / 05');
    expect(body.get('mkYmdTo')).toBe('2026 / 08 / 14');
    expect(body.get('trjoKbn')).toBe('01');

    const [csvUrl, csvInit] = mockFetch.mock.calls[2];
    expect(csvUrl).toBe('https://www.taisyaku.jp/app/stock/detail/7203/csv');
    expect(csvInit.headers.Cookie).toBe('ci_session=abc123');
  });

  test('throws when the detail page request fails', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'server error' });
    await expect(fetchTaisyakuCsv('7203', '2026-08-05', '2026-08-14')).rejects.toThrow('taisyaku.jp');
  });
});
