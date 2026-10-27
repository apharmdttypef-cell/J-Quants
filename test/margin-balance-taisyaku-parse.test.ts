import { readFileSync } from 'fs';
import { join } from 'path';
import {
  parseTaisyakuBalanceCsv,
  parseTaisyakuMarginNames,
  TaisyakuCsvFormatError,
  TAISYAKU_BALANCE_CSV_HEADER,
} from '../lambda/margin-balance-batch/data-source';

// 実CSV(CP932)をそのままフィクスチャにしている。ヘッダー行だけ末尾が\r\n、データ行は\n
const fixtureText = new TextDecoder('shift_jis').decode(
  readFileSync(join(__dirname, 'fixtures', 'taisyaku', 'stock-20261023.cp932.csv')),
);
const HEADER_LINE = TAISYAKU_BALANCE_CSV_HEADER.map((h) => `"${h}"`).join(',');

describe('parseTaisyakuBalanceCsv', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('実CSVから東証行だけを、検索日を日付にして返す', () => {
    expect(parseTaisyakuBalanceCsv(fixtureText, '2026-10-23')).toEqual([
      { code: '1301', date: '2026-10-23', financingBalance: 7200, lendingBalance: 7200, source: 'taisyaku' },
      { code: '3197', date: '2026-10-23', financingBalance: 12900, lendingBalance: 138400, source: 'taisyaku' },
      { code: '7203', date: '2026-10-23', financingBalance: 639600, lendingBalance: 800, source: 'taisyaku' },
      { code: '9418', date: '2026-10-23', financingBalance: 81900, lendingBalance: 81900, source: 'taisyaku' },
    ]);
  });

  it('融資残高が-の行と貸株残高が空の行は捨てる', () => {
    const csv = [
      HEADER_LINE,
      '"1111","A","東証","貸借","20270331","","-","100","0","1.00","0.00","-","-","-"',
      '"2222","B","東証","貸借","20270331","","100","","0","1.00","0.00","-","-","-"',
      '"3333","C","東証","貸借","20270331","","10","20","-10","1.00","0.00","-","-","-"',
    ].join('\n');
    expect(parseTaisyakuBalanceCsv(csv, '2026-10-23')).toEqual([
      { code: '3333', date: '2026-10-23', financingBalance: 10, lendingBalance: 20, source: 'taisyaku' },
    ]);
  });

  it('桁区切りのある値を数値にする', () => {
    const csv = [
      HEADER_LINE,
      '"4444","D","東証","貸借","20270331","","1,234","5,678","-4,444","1.00","0.00","-","-","-"',
    ].join('\n');
    expect(parseTaisyakuBalanceCsv(csv, '2026-10-23')).toEqual([
      { code: '4444', date: '2026-10-23', financingBalance: 1234, lendingBalance: 5678, source: 'taisyaku' },
    ]);
  });

  it('英字入りコードはそのまま返す', () => {
    const csv = [
      HEADER_LINE,
      '"130A","E","東証","貸借","20270331","","500","600","-100","1.00","0.00","-","-","-"',
    ].join('\n');
    expect(parseTaisyakuBalanceCsv(csv, '2026-10-23').map((p) => p.code)).toEqual(['130A']);
  });

  it('ヘッダーのみ・空文字は空配列', () => {
    expect(parseTaisyakuBalanceCsv(HEADER_LINE, '2026-10-23')).toEqual([]);
    expect(parseTaisyakuBalanceCsv(`${HEADER_LINE}\r\n`, '2026-10-23')).toEqual([]);
    expect(parseTaisyakuBalanceCsv('', '2026-10-23')).toEqual([]);
  });

  it('列数が14でない行は警告ログを出して捨て、他の行は返す', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const csv = [
      HEADER_LINE,
      '"5555","F","東証","貸借","20270331","","10"',
      '"6666","G","東証","貸借","20270331","","10","20","-10","1.00","0.00","-","-","-"',
    ].join('\n');
    expect(parseTaisyakuBalanceCsv(csv, '2026-10-23').map((p) => p.code)).toEqual(['6666']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('ヘッダーが一致しないとTaisyakuCsvFormatErrorを投げる', () => {
    const renamed = HEADER_LINE.replace('融資残高（株）', '融資残高');
    expect(() => parseTaisyakuBalanceCsv(renamed, '2026-10-23')).toThrow(TaisyakuCsvFormatError);

    const fewer = TAISYAKU_BALANCE_CSV_HEADER.slice(0, 13).map((h) => `"${h}"`).join(',');
    expect(() => parseTaisyakuBalanceCsv(fewer, '2026-10-23')).toThrow(TaisyakuCsvFormatError);

    expect(() => parseTaisyakuBalanceCsv('<html><body>error</body></html>', '2026-10-23')).toThrow(TaisyakuCsvFormatError);
  });

  it('TAISYAKU_BALANCE_CSV_HEADERは14列で、7・8番目が残高列', () => {
    expect(TAISYAKU_BALANCE_CSV_HEADER).toHaveLength(14);
    expect(TAISYAKU_BALANCE_CSV_HEADER[6]).toBe('融資残高（株）');
    expect(TAISYAKU_BALANCE_CSV_HEADER[7]).toBe('貸株残高（株）');
  });
});

describe('parseTaisyakuMarginNames', () => {
  it('実CSVから東証行の銘柄コード→貸借区分を返す(7203の名証行は見ない)', () => {
    expect(parseTaisyakuMarginNames(fixtureText)).toEqual(
      new Map([
        ['1301', '貸借'],
        ['3197', '貸借'],
        ['7203', '貸借'],
        ['9418', '貸借'],
      ]),
    );
  });

  it('東証以外の行は値が違っても無視し、貸借区分が空の行は含めない', () => {
    const csv = [
      HEADER_LINE,
      '"1111","A","東証","貸借融資","20270331","","100","100","0","1.00","0.00","-","-","-"',
      '"1111","A","名証","非貸借","20270331","","100","100","0","1.00","0.00","-","-","-"',
      '"2222","B","名証","貸借","20270331","","100","100","0","1.00","0.00","-","-","-"',
      '"3333","C","東証","","20270331","","100","100","0","1.00","0.00","-","-","-"',
      '"4444","D","東証","非貸借","20270331","","-","-","-","-","-","-","-","-"',
    ].join('\n');
    expect(parseTaisyakuMarginNames(csv)).toEqual(
      new Map([
        ['1111', '貸借融資'],
        ['4444', '非貸借'],
      ]),
    );
  });

  it('空のテキストは空のMapを返す', () => {
    expect(parseTaisyakuMarginNames('')).toEqual(new Map());
  });

  it('ヘッダーが想定と違えばTaisyakuCsvFormatErrorを投げる', () => {
    expect(() => parseTaisyakuMarginNames('"銘柄コード","銘柄名"\n"1301","極洋"')).toThrow(TaisyakuCsvFormatError);
  });
});
