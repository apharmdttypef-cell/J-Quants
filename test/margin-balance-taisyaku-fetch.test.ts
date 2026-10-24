import { readFileSync } from 'fs';
import { join } from 'path';
import { fetchTaisyakuBalanceCsv } from '../lambda/margin-balance-batch/data-source';

const pageResponse = {
  ok: true,
  headers: { getSetCookie: () => ['ci_session=abc123; Path=/; HttpOnly'] },
  text: async () => '<form><input type="hidden" name="csrf_test_name" value="tok123"></form>',
};
const searchResponse = (html: string) => ({ ok: true, headers: { getSetCookie: () => [] }, text: async () => html });
const fixtureBytes = readFileSync(join(__dirname, 'fixtures', 'taisyaku', 'stock-20261023.cp932.csv'));
const csvResponse = {
  ok: true,
  headers: { getSetCookie: () => [], get: () => 'application/octet-stream' },
  arrayBuffer: async () => fixtureBytes.buffer.slice(fixtureBytes.byteOffset, fixtureBytes.byteOffset + fixtureBytes.byteLength),
};

describe('fetchTaisyakuBalanceCsv', () => {
  const mockFetch = jest.fn();
  beforeEach(() => {
    mockFetch.mockReset();
    (global as unknown as { fetch: typeof mockFetch }).fetch = mockFetch;
  });

  test('calls the 3 steps in order and returns the CP932-decoded CSV', async () => {
    mockFetch
      .mockResolvedValueOnce(pageResponse)
      .mockResolvedValueOnce(searchResponse('<p>検索結果&nbsp;4756件</p>'))
      .mockResolvedValueOnce(csvResponse);

    const csv = await fetchTaisyakuBalanceCsv('2026-10-23', 0);

    expect(mockFetch).toHaveBeenCalledTimes(3);
    const [url1, init1] = mockFetch.mock.calls[0];
    expect(url1).toBe('https://www.taisyaku.jp/app/stock');
    expect(init1.headers['User-Agent']).toBeDefined();

    const [url2, init2] = mockFetch.mock.calls[1];
    expect(url2).toBe('https://www.taisyaku.jp/app/stock/search');
    expect(init2.method).toBe('POST');
    expect(init2.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(init2.headers.Cookie).toBe('ci_session=abc123');
    const params = new URLSearchParams(init2.body);
    expect([...params.keys()].sort()).toEqual(['csrf_test_name', 'mkYmd']);
    expect(params.get('csrf_test_name')).toBe('tok123');
    expect(params.get('mkYmd')).toBe('2026 / 10 / 23');

    const [url3, init3] = mockFetch.mock.calls[2];
    expect(url3).toBe('https://www.taisyaku.jp/app/stock/csv');
    expect(init3.headers.Cookie).toBe('ci_session=abc123');

    expect(csv).not.toBeNull();
    expect(csv!.startsWith('"銘柄コード","銘柄名","市場区分"')).toBe(true);
    expect(csv).toContain('"7203","トヨタ自動車","東証"');
  });

  test('returns null without fetching the CSV when the search has 0 results', async () => {
    mockFetch
      .mockResolvedValueOnce(pageResponse)
      .mockResolvedValueOnce(searchResponse('<p>検索結果&nbsp;0件</p><p>ご指定の条件に該当するデータはありません。</p>'));

    await expect(fetchTaisyakuBalanceCsv('2026-10-23', 0)).resolves.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('does not treat counts like 10件 as zero results', async () => {
    mockFetch
      .mockResolvedValueOnce(pageResponse)
      .mockResolvedValueOnce(searchResponse('<p>検索結果&nbsp;10件</p>'))
      .mockResolvedValueOnce(csvResponse);

    const csv = await fetchTaisyakuBalanceCsv('2026-10-23', 0);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(typeof csv).toBe('string');
  });

  test('throws on HTTP 503 at the first request', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, headers: { getSetCookie: () => [] } });
    await expect(fetchTaisyakuBalanceCsv('2026-10-23', 0)).rejects.toThrow('503');
  });

  test('throws on HTTP 500 at the search request', async () => {
    mockFetch
      .mockResolvedValueOnce(pageResponse)
      .mockResolvedValueOnce({ ok: false, status: 500, headers: { getSetCookie: () => [] } });
    await expect(fetchTaisyakuBalanceCsv('2026-10-23', 0)).rejects.toThrow('500');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('throws on HTTP 404 at the CSV request', async () => {
    mockFetch
      .mockResolvedValueOnce(pageResponse)
      .mockResolvedValueOnce(searchResponse('<p>検索結果&nbsp;4756件</p>'))
      .mockResolvedValueOnce({ ok: false, status: 404, headers: { getSetCookie: () => [] } });
    await expect(fetchTaisyakuBalanceCsv('2026-10-23', 0)).rejects.toThrow('404');
  });

  test('throws when the page has no CSRF token', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: { getSetCookie: () => [] },
      text: async () => '<html>no token</html>',
    });
    await expect(fetchTaisyakuBalanceCsv('2026-10-23', 0)).rejects.toThrow('csrf_test_name');
  });
});
