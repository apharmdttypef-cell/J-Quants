// 予算から探す(/yutai/budget)の判定ロジック(フロントの純関数)をルートのjestで検証する。
import { getLocalTradingCalendar, rightsDateForMonth } from '../lambda/shared/trading-calendar';
import {
  addToCart,
  changeShares,
  defaultBudgetMonth,
  evaluateBudget,
  matchesMonth,
  minShares,
  monthBounds,
  parseCash,
  pricePerShare,
  removeFromCart,
  sortRows,
  visibleRows,
  type BudgetItem,
  type CartEntry,
} from '../frontend/src/lib/yutai-budget';

function item(overrides: Partial<BudgetItem> & { ticker: string }): BudgetItem {
  return {
    unitShares: 100,
    requiredShares: 100,
    closePrice: 1000,
    minInvestment: null,
    rightsMonths: [11],
    value: 1000,
    ...overrides,
  };
}

describe('minShares', () => {
  test('rounds the required shares up to whole units', () => {
    expect(minShares(item({ ticker: 'A', requiredShares: 200 }))).toBe(200);
    expect(minShares(item({ ticker: 'A', requiredShares: 1 }))).toBe(100);
    expect(minShares(item({ ticker: 'A', requiredShares: 150 }))).toBe(200);
  });

  test('falls back to the unit when the required shares are unknown', () => {
    expect(minShares(item({ ticker: 'A', requiredShares: null }))).toBe(100);
  });
});

describe('pricePerShare', () => {
  test('uses the close price first', () => {
    expect(pricePerShare(item({ ticker: 'A', closePrice: 1844, minInvestment: 366400 }))).toEqual({
      price: 1844,
      source: 'close',
    });
  });

  test('estimates from minInvestment over the minimum shares when there is no close price', () => {
    expect(
      pricePerShare(item({ ticker: 'A', closePrice: null, requiredShares: 200, minInvestment: 366400 })),
    ).toEqual({ price: 1832, source: 'minInvestment' });
  });

  test('is null when neither is known', () => {
    expect(pricePerShare(item({ ticker: 'A', closePrice: null, minInvestment: null }))).toBeNull();
  });
});

test('matchesMonth matches any of the rights months', () => {
  const twice = item({ ticker: 'A', rightsMonths: [3, 9] });
  expect(matchesMonth(twice, 3)).toBe(true);
  expect(matchesMonth(twice, 9)).toBe(true);
  expect(matchesMonth(twice, 11)).toBe(false);
});

// 画面と同じ手順で既定月を求める(当月の月末の権利付き最終日をカレンダーから計算して渡す)
function defaultMonthOn(today: string): number {
  const { from, to, year, month } = monthBounds(today);
  return defaultBudgetMonth(today, rightsDateForMonth(getLocalTradingCalendar(from, to), year, month, null));
}

describe('defaultBudgetMonth', () => {
  // 2026-11の月末の権利付き最終日は11/26(11/30が月曜の最終営業日、その2営業日前)
  test('stays in this month up to and including the last day to buy for month-end rights', () => {
    expect(defaultMonthOn('2026-11-18')).toBe(11);
    expect(defaultMonthOn('2026-11-26')).toBe(11);
  });

  test('moves to next month after that day, and from December to January', () => {
    expect(defaultMonthOn('2026-11-27')).toBe(12);
    expect(defaultMonthOn('2026-12-31')).toBe(1);
  });

  test('stays in this month when the rights date is unknown', () => {
    expect(defaultBudgetMonth('2026-11-27', undefined)).toBe(11);
  });
});

test('parseCash accepts commas and yen, and treats empty or non-positive input as no cash', () => {
  expect(parseCash('1,000,000')).toBe(1000000);
  expect(parseCash(' 500000円 ')).toBe(500000);
  expect(parseCash('')).toBeNull();
  expect(parseCash(null)).toBeNull();
  expect(parseCash('0')).toBeNull();
  expect(parseCash('abc')).toBeNull();
});

describe('cart operations', () => {
  const daiichi = item({ ticker: '7458', requiredShares: 200, closePrice: 1844 });

  test('adds at the minimum shares and never twice', () => {
    const cart = addToCart([], daiichi);
    expect(cart).toEqual([{ ticker: '7458', shares: 200 }]);
    expect(addToCart(cart, daiichi)).toBe(cart);
  });

  test('changes shares by one unit and not below the minimum', () => {
    let cart: CartEntry[] = [{ ticker: '7458', shares: 200 }];
    cart = changeShares(cart, daiichi, 1);
    expect(cart[0].shares).toBe(300);
    cart = changeShares(cart, daiichi, -1);
    cart = changeShares(cart, daiichi, -1);
    expect(cart[0].shares).toBe(200);
  });

  test('removes by ticker', () => {
    expect(removeFromCart([{ ticker: 'A', shares: 100 }, { ticker: 'B', shares: 100 }], 'A')).toEqual([
      { ticker: 'B', shares: 100 },
    ]);
  });
});

describe('evaluateBudget', () => {
  test('judges a 200-share yutai by the cost of 200 shares', () => {
    const daiichi = item({ ticker: '7458', requiredShares: 200, closePrice: 1844 });
    const below = evaluateBudget({ items: [daiichi], cart: [], cash: 368799, month: 11 });
    expect(below.rows[0]).toMatchObject({ cost: 368800, status: 'unaffordable', shortfall: 1 });
    const exact = evaluateBudget({ items: [daiichi], cart: [], cash: 368800, month: 11 });
    expect(exact.rows[0]).toMatchObject({ status: 'affordable', shortfall: null });
  });

  test('judges a ticker without a close price by minInvestment', () => {
    const noClose = item({ ticker: 'A', closePrice: null, minInvestment: 125000 });
    const result = evaluateBudget({ items: [noClose], cart: [], cash: 200000, month: 11 });
    expect(result.rows[0]).toMatchObject({ cost: 125000, status: 'affordable' });
    expect(result.rows[0].price?.source).toBe('minInvestment');
  });

  test('marks a ticker with no price at all as unknown', () => {
    const unknown = item({ ticker: 'A', closePrice: null, minInvestment: null });
    expect(evaluateBudget({ items: [unknown], cart: [], cash: 100000, month: 11 }).rows[0].status).toBe('unknown');
  });

  test('only lists tickers with the chosen rights month', () => {
    const items = [item({ ticker: 'A', rightsMonths: [11] }), item({ ticker: 'B', rightsMonths: [3, 9] })];
    expect(evaluateBudget({ items, cart: [], cash: null, month: 9 }).rows.map((r) => r.item.ticker)).toEqual(['B']);
  });

  test('adding to the cart lowers the remaining budget and turns others unaffordable', () => {
    const a = item({ ticker: 'A', closePrice: 3000 }); // 300,000
    const b = item({ ticker: 'B', closePrice: 2500 }); // 250,000
    const result = evaluateBudget({ items: [a, b], cart: [{ ticker: 'A', shares: 100 }], cash: 500000, month: 11 });
    expect(result.cartTotal).toBe(300000);
    expect(result.remaining).toBe(200000);
    expect(result.rows.find((r) => r.item.ticker === 'A')?.status).toBe('inCart');
    expect(result.rows.find((r) => r.item.ticker === 'B')).toMatchObject({ status: 'unaffordable', shortfall: 50000 });
  });

  test('more shares in the cart change the totals but not the list cost', () => {
    const a = item({ ticker: 'A', closePrice: 1000 });
    const result = evaluateBudget({ items: [a], cart: [{ ticker: 'A', shares: 300 }], cash: 1000000, month: 11 });
    expect(result.cartLines[0]).toMatchObject({ shares: 300, cost: 300000, canDecrease: true });
    expect(result.cartTotal).toBe(300000);
    expect(result.rows[0].cost).toBe(100000);
  });

  test('allows one more unit only when it fits the remaining budget', () => {
    const a = item({ ticker: 'A', closePrice: 1000 });
    const fits = evaluateBudget({ items: [a], cart: [{ ticker: 'A', shares: 100 }], cash: 200000, month: 11 });
    expect(fits.cartLines[0]).toMatchObject({ canIncrease: true, canDecrease: false });
    const full = evaluateBudget({ items: [a], cart: [{ ticker: 'A', shares: 100 }], cash: 199999, month: 11 });
    expect(full.cartLines[0].canIncrease).toBe(false);
    const noCash = evaluateBudget({ items: [a], cart: [{ ticker: 'A', shares: 100 }], cash: null, month: 11 });
    expect(noCash.cartLines[0].canIncrease).toBe(true);
  });

  test('reports a shortage when the cash is lowered below the cart total', () => {
    const a = item({ ticker: 'A', closePrice: 1000 });
    const result = evaluateBudget({ items: [a], cart: [{ ticker: 'A', shares: 200 }], cash: 150000, month: 11 });
    expect(result.remaining).toBe(-50000);
    expect(result.shortage).toBe(true);
  });

  test('without cash every priced ticker is affordable and there is no shortage', () => {
    const result = evaluateBudget({ items: [item({ ticker: 'A' })], cart: [], cash: null, month: 11 });
    expect(result.remaining).toBeNull();
    expect(result.shortage).toBe(false);
    expect(result.rows[0].status).toBe('affordable');
  });
});

test('visibleRows hides unaffordable rows unless asked', () => {
  const items = [item({ ticker: 'A', closePrice: 1000 }), item({ ticker: 'B', closePrice: 5000 })];
  const { rows } = evaluateBudget({ items, cart: [], cash: 200000, month: 11 });
  expect(visibleRows(rows, false).map((r) => r.item.ticker)).toEqual(['A']);
  expect(visibleRows(rows, true).map((r) => r.item.ticker)).toEqual(['A', 'B']);
});

test('sortRows puts rows with an unknown value last in either direction', () => {
  const items = [
    item({ ticker: 'A', value: 1000 }),
    item({ ticker: 'N', value: null }),
    item({ ticker: 'B', value: 3000 }),
  ];
  const { rows } = evaluateBudget({ items, cart: [], cash: null, month: 11 });
  expect(sortRows(rows, 'value', -1).map((r) => r.item.ticker)).toEqual(['B', 'A', 'N']);
  expect(sortRows(rows, 'value', 1).map((r) => r.item.ticker)).toEqual(['A', 'B', 'N']);
  expect(sortRows(rows, 'yield', -1).map((r) => r.item.ticker)).toEqual(['B', 'A', 'N']);
});
