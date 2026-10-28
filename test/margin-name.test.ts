import { isGeneralMarginOnly } from '../lambda/shared/margin-name';

test('isGeneralMarginOnly: only 貸借 can be shorted under 制度信用; unknown stays unknown', () => {
  expect(isGeneralMarginOnly('貸借')).toBe(false);
  expect(isGeneralMarginOnly('貸借融資')).toBe(true);
  expect(isGeneralMarginOnly('非貸借')).toBe(true);
  // 移行前にJ-Quantsから取り込んだ表記も同じく扱う
  expect(isGeneralMarginOnly('信用')).toBe(true);
  expect(isGeneralMarginOnly('その他')).toBe(true);
  expect(isGeneralMarginOnly(null)).toBe(false); // 東証行が無いなど、区分が分からない銘柄は決めつけない
});
