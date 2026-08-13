import { fetchWeeklyBalances } from '../lambda/margin-balance-batch/data-source';

test('fetchWeeklyBalances returns one point per week in range, deterministic for the same ticker+date', async () => {
  const a = await fetchWeeklyBalances('7203', '2026-01-05', '2026-01-19');
  const b = await fetchWeeklyBalances('7203', '2026-01-05', '2026-01-19');

  expect(a).toEqual(b); // 同じ入力なら同じ値(バッチを毎日回してもグラフがジャンプしないため)
  expect(a.length).toBeGreaterThan(0);
  for (const point of a) {
    expect(point.source).toBe('weekly');
    expect(point.financingBalance).toBeGreaterThanOrEqual(0);
    expect(point.lendingBalance).toBeGreaterThanOrEqual(0);
  }
});

test('fetchWeeklyBalances differs across tickers (not the same seed for every ticker)', async () => {
  const a = await fetchWeeklyBalances('7203', '2026-01-05', '2026-01-05');
  const b = await fetchWeeklyBalances('9999', '2026-01-05', '2026-01-05');

  expect(a[0].lendingBalance).not.toBe(b[0].lendingBalance);
});
