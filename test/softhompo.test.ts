import { readFileSync } from 'fs';
import { join } from 'path';
import { strToU8, zipSync } from 'fflate';
import {
  fetchSoftHompoDay,
  parseSoftHompoCsv,
  SoftHompoCsvFormatError,
  type MonthlyArchiveCache,
} from '../lambda/price-batch/softhompo';

const fixture = readFileSync(join(__dirname, 'fixtures', 'softhompo', 'stq_20261028.csv'), 'utf8');

describe('parseSoftHompoCsv', () => {
  test('reads a row traded in both sessions: open from the morning, close from the afternoon, high/low across both', () => {
    const bars = parseSoftHompoCsv(fixture);
    expect(bars.get('2301')).toEqual({ open: 1694, high: 1700, low: 1672, close: 1673, volume: 553500 });
  });

  test('uses the morning values when there was no afternoon trade', () => {
    const bars = parseSoftHompoCsv(fixture);
    expect(bars.get('1793')).toEqual({ open: 2043, high: 2063, low: 2022, close: 2063, volume: 700 });
  });

  test('uses the afternoon values when there was no morning trade', () => {
    const bars = parseSoftHompoCsv(fixture);
    expect(bars.get('1787')).toEqual({ open: 5500, high: 5500, low: 5500, close: 5500, volume: 100 });
  });

  test('leaves out a row with no trade all day', () => {
    const bars = parseSoftHompoCsv(fixture);
    expect(bars.has('1788')).toBe(false);
  });

  test('keeps alphanumeric codes, flagged rows, and rows after a repeated page heading', () => {
    const bars = parseSoftHompoCsv(fixture);
    expect(bars.get('256A')).toEqual({ open: 2228, high: 2240, low: 2211, close: 2211, volume: 115400 });
    expect(bars.get('3469')).toEqual({ open: 844, high: 855, low: 844, close: 845, volume: 1300 });
    expect([...bars.keys()].sort()).toEqual(['1301', '1787', '1793', '2301', '256A', '3469']);
  });

  test('handles a leading BOM and CRLF line endings', () => {
    const bars = parseSoftHompoCsv('﻿' + fixture.replace(/\r?\n/g, '\r\n'));
    expect(bars.get('2301')?.close).toBe(1673);
    expect(bars.size).toBe(6);
  });

  test('throws when the heading row is missing', () => {
    const withoutHeader = fixture
      .split('\n')
      .filter((line) => !line.startsWith('"! コード"'))
      .join('\n');
    expect(() => parseSoftHompoCsv(withoutHeader)).toThrow(SoftHompoCsvFormatError);
  });

  test('throws when a heading column changes', () => {
    expect(() => parseSoftHompoCsv(fixture.replace('"売買高(千株)"', '"出来高(千株)"'))).toThrow(SoftHompoCsvFormatError);
  });

  test('throws when a data row has an unexpected number of columns', () => {
    expect(() => parseSoftHompoCsv(fixture.replace('"2301","",100,', '"2301",100,'))).toThrow(SoftHompoCsvFormatError);
  });
});

describe('fetchSoftHompoDay', () => {
  const mockFetch = jest.fn();
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockFetch.mockReset();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  function zipResponse(files: Record<string, string>) {
    const bytes = zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));
    return {
      status: 200,
      ok: true,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  }
  const notFound = { status: 404, ok: false, arrayBuffer: async () => new ArrayBuffer(0) };

  test('reads the daily zip first', async () => {
    mockFetch.mockResolvedValueOnce(zipResponse({ 'stq_20261028.csv': '﻿daily' }));

    const csv = await fetchSoftHompoDay('2026-10-28', new Map());

    expect(csv).toBe('daily');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('https://softhompo.a.la9.jp/Data/stock/thisMonth/stq_20261028.zip');
  });

  test('falls back to the monthly zip when the daily zip is gone', async () => {
    mockFetch
      .mockResolvedValueOnce(notFound)
      .mockResolvedValueOnce(zipResponse({ 'stq_20260930.csv': 'sep30', 'stq_20260929.csv': 'sep29' }));

    const csv = await fetchSoftHompoDay('2026-09-30', new Map());

    expect(csv).toBe('sep30');
    expect(mockFetch.mock.calls[1][0]).toBe('https://softhompo.a.la9.jp/Data/stock/pastMonth/202609.zip');
  });

  test('returns null when neither the daily nor the monthly zip has the day', async () => {
    mockFetch.mockResolvedValueOnce(notFound).mockResolvedValueOnce(notFound);

    expect(await fetchSoftHompoDay('2026-10-25', new Map())).toBeNull();
  });

  test('returns null when the monthly zip does not contain the day (a holiday)', async () => {
    mockFetch.mockResolvedValueOnce(notFound).mockResolvedValueOnce(zipResponse({ 'stq_20260930.csv': 'sep30' }));

    expect(await fetchSoftHompoDay('2026-09-27', new Map())).toBeNull();
  });

  test('fetches each monthly zip only once per run through the shared cache', async () => {
    const cache: MonthlyArchiveCache = new Map();
    mockFetch
      .mockResolvedValueOnce(notFound)
      .mockResolvedValueOnce(zipResponse({ 'stq_20260930.csv': 'sep30', 'stq_20260929.csv': 'sep29' }))
      .mockResolvedValueOnce(notFound);

    expect(await fetchSoftHompoDay('2026-09-30', cache)).toBe('sep30');
    expect(await fetchSoftHompoDay('2026-09-29', cache)).toBe('sep29');

    // 2日目は日次の404を確かめるだけで、月次ファイルは取り直さない
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[2][0]).toBe('https://softhompo.a.la9.jp/Data/stock/thisMonth/stq_20260929.zip');
  });

  test('throws on an HTTP error other than 404', async () => {
    mockFetch.mockResolvedValueOnce({ status: 503, ok: false, arrayBuffer: async () => new ArrayBuffer(0) });

    await expect(fetchSoftHompoDay('2026-10-28', new Map())).rejects.toThrow('503');
  });

  test('throws when the daily zip does not hold the expected file', async () => {
    mockFetch.mockResolvedValueOnce(zipResponse({ 'other.csv': 'x' }));

    await expect(fetchSoftHompoDay('2026-10-28', new Map())).rejects.toThrow('stq_20261028.csv');
  });
});
