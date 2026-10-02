import { summarizeActuals } from '../lambda/shared/gyakuhibu-actual-summary';

// JQuantsGyakuhibuActualの行の形(ticker/rightsDateがキー、avgRateは1株1日あたり料率、
// daysは品貸日数)。gyakuhibu-history-batchが書いている値をそのまま使う。
const ROWS = [
  { rightsDate: '2024-09-26', avgRate: 1.5, days: 3 },
  { rightsDate: '2025-03-27', avgRate: 0.5, days: 1 },
  { rightsDate: '2025-09-26', avgRate: 2.0, days: 3 },
];

test('takes the row with the latest rights date as the last result', () => {
  const { last } = summarizeActuals(ROWS, '2026-09-28', 300, 100);
  expect(last).toEqual({
    rightsDate: '2025-09-26',
    avgRate: 2.0,
    days: 3,
    // perShareRate = avgRate × days。taisyaku.jpの1株あたり品貸料そのもの。
    perShareRate: 6,
    // cost = perShareRate × 必要株数
    cost: 1800,
    basedOnUnitShares: false,
  });
});

test('takes the same calendar month of the previous year for the seasonal comparison', () => {
  const { sameMonthLastYear } = summarizeActuals(ROWS, '2026-09-28', 300, 100);
  // 次回権利日が2026-09なので、前年同月は2025-09(2024-09ではない)
  expect(sameMonthLastYear?.rightsDate).toBe('2025-09-26');
  expect(sameMonthLastYear?.cost).toBe(1800);
});

test('falls back to unitShares and flags it when the required share count is unknown', () => {
  const { last } = summarizeActuals(ROWS, '2026-09-28', null, 100);
  expect(last?.cost).toBe(600);
  expect(last?.basedOnUnitShares).toBe(true);
});

test('keeps a no-fee rights date as a zero cost rather than dropping it', () => {
  // 逆日歩が付かなかった権利日はavgRate=0・days=0で記録される
  // (gyakuhibu-history-batchのnoGyakuhibu行)。「前回は0円だった」は
  // 「前回のデータが無い」とは全く違う情報なので落としてはならない。
  const { last } = summarizeActuals([{ rightsDate: '2026-03-27', avgRate: 0, days: 0 }], '2026-09-28', 300, 100);
  expect(last).toEqual({
    rightsDate: '2026-03-27',
    avgRate: 0,
    days: 0,
    perShareRate: 0,
    cost: 0,
    basedOnUnitShares: false,
  });
});

test('ignores rows whose rate or day count is not a number', () => {
  const rows = [
    { rightsDate: '2025-09-26', avgRate: 2.0, days: 3 },
    { rightsDate: '2026-03-27', avgRate: null, days: 1 },
    { rightsDate: '2026-09-28' },
  ];
  // 壊れた行を落とした結果、最新は2025-09-26になる
  expect(summarizeActuals(rows, '2026-09-28', 100, 100).last?.rightsDate).toBe('2025-09-26');
});

test('returns nulls when there is no usable history', () => {
  expect(summarizeActuals([], '2026-09-28', 100, 100)).toEqual({ last: null, sameMonthLastYear: null });
});

test('returns a null seasonal comparison when the next rights date is unknown', () => {
  const { last, sameMonthLastYear } = summarizeActuals(ROWS, undefined, 100, 100);
  expect(last?.rightsDate).toBe('2025-09-26');
  expect(sameMonthLastYear).toBeNull();
});

test('returns a null seasonal comparison when the previous year has no row in that month', () => {
  const { sameMonthLastYear } = summarizeActuals(ROWS, '2026-06-26', 100, 100);
  expect(sameMonthLastYear).toBeNull();
});

test('does not treat the same row as both last and seasonal when the year differs', () => {
  const rows = [{ rightsDate: '2026-09-28', avgRate: 1.0, days: 2 }];
  const { last, sameMonthLastYear } = summarizeActuals(rows, '2026-09-28', 100, 100);
  // 今年の同じ権利日は「前年同月」ではない
  expect(last?.rightsDate).toBe('2026-09-28');
  expect(sameMonthLastYear).toBeNull();
});

test('drops rows with NaN or Infinity so no cost can become NaN or Infinity', () => {
  const rows = [
    { rightsDate: '2025-09-26', avgRate: 2.0, days: 3 },
    { rightsDate: '2026-03-27', avgRate: NaN, days: 1 },
    { rightsDate: '2026-09-28', avgRate: 1.0, days: Infinity },
  ];
  const { last } = summarizeActuals(rows, '2026-09-28', 100, 100);
  expect(last?.rightsDate).toBe('2025-09-26');
  expect(Number.isFinite(last?.cost)).toBe(true);
});

test('takes the greatest rights date even when the rows arrive newest first', () => {
  // DynamoDBのQueryはScanIndexForward:falseで新しい順に返すことも、別の順で
  // 返ることもある。「前回」は並び順に依存せず最大の権利日でなければならない。
  const descending = [
    { rightsDate: '2025-09-26', avgRate: 2.0, days: 3 },
    { rightsDate: '2025-03-27', avgRate: 0.5, days: 1 },
    { rightsDate: '2024-09-26', avgRate: 1.5, days: 3 },
  ];
  expect(summarizeActuals(descending, '2026-09-28', 300, 100).last?.rightsDate).toBe('2025-09-26');
});

test('takes the later of two rows in the same prior-year month', () => {
  // 前年同月に2行ある場合は遅い方(より直近)を採る。入力の並び順に依存しない。
  const sameMonthTwice = [
    { rightsDate: '2025-09-26', avgRate: 2.0, days: 3 },
    { rightsDate: '2025-09-05', avgRate: 9.0, days: 1 },
  ];
  const { sameMonthLastYear } = summarizeActuals(sameMonthTwice, '2026-09-28', 300, 100);
  expect(sameMonthLastYear?.rightsDate).toBe('2025-09-26');
  expect(sameMonthLastYear?.cost).toBe(1800);
});

test('never reads the stored totalAmount and recomputes the cost from avgRate and days', () => {
  // JQuantsGyakuhibuActual.totalAmountは記録当時のunitSharesを掛けた値で、
  // 必要株数とは別の株数を指している。読んでしまうと株数の意味が混ざるため、
  // 行にtotalAmountがあっても必ずavgRate × days × 株数で組み直す。
  const rows = [{ rightsDate: '2025-09-26', avgRate: 2.0, days: 3, totalAmount: 999_999 }];
  const { last } = summarizeActuals(rows, '2026-09-28', 200, 100);
  // 2.0 × 3 × 200 = 1,200円。保存値の999,999円ではない。
  expect(last?.cost).toBe(1200);
  expect(last?.perShareRate).toBe(6);
});
