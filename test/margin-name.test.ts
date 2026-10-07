import { isGeneralMarginOnly, pickMarginNames } from '../lambda/shared/margin-name';

test('pickMarginNames keys by the 4-character ticker and prefers the common share (code ending in 0)', () => {
  // ソフトバンクは普通株(94340)が貸借、優先株(94345/94346)が信用。並び順に関わらず普通株を採る。
  const names = pickMarginNames([
    { Code: '94345', MrgnNm: '信用' },
    { Code: '94340', MrgnNm: '貸借' },
    { Code: '94346', MrgnNm: '信用' },
    { Code: '13750', MrgnNm: '信用' },
    { Code: '130A0', MrgnNm: '貸借' }, // 英字入りの新コード
  ]);
  expect(names.get('9434')).toBe('貸借');
  expect(names.get('1375')).toBe('信用');
  expect(names.get('130A')).toBe('貸借');
});

test('pickMarginNames skips records without a code or a margin name', () => {
  const names = pickMarginNames([{ Code: '12340', MrgnNm: null }, { MrgnNm: '貸借' }, { Code: '56', MrgnNm: '貸借' }]);
  expect(names.size).toBe(0);
});

test('isGeneralMarginOnly: only 貸借 can be shorted under 制度信用; unknown stays unknown', () => {
  expect(isGeneralMarginOnly('貸借')).toBe(false);
  expect(isGeneralMarginOnly('信用')).toBe(true);
  expect(isGeneralMarginOnly('その他')).toBe(true);
  expect(isGeneralMarginOnly(null)).toBe(false); // 東証外上場など、区分が分からない銘柄は決めつけない
});
