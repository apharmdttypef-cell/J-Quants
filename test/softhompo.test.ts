import { readFileSync } from 'fs';
import { join } from 'path';
import { parseSoftHompoCsv, SoftHompoCsvFormatError } from '../lambda/price-batch/softhompo';

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
