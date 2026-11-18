// 予算から探す(/yutai/budget)の判定ロジック。画面から切り離した純関数で、ルートのjestで検証する。
// 設計: docs/superpowers/specs/2026-11-18-yutai-budget-design.md
//
// このファイルは相対importを持たない。ルートのtsc(NodeNext)はfrontend配下を"type": "module"の
// ESMとして扱い、拡張子なしの相対importをエラーにする(テストがこのファイルをimportするため)。

// 判定に使う一覧API(YutaiForecastListItem)の項目だけ。構造的に一致すればよい。
export interface BudgetItem {
  ticker: string;
  unitShares: number;
  requiredShares: number | null;
  closePrice: number | null;
  minInvestment: number | null;
  rightsMonths: number[];
  value: number | null;
}

// 単元に切り上げた必要株数(購入できる最小の株数)。必要株数が単元の倍数でない銘柄
// (実データで1株以上が25件、150株以上など)は、単元未満では買えないので切り上げる。
export function minShares(item: BudgetItem): number {
  const unit = item.unitShares > 0 ? item.unitShares : 1;
  const required = item.requiredShares ?? item.unitShares;
  return Math.max(unit, Math.ceil(required / unit) * unit);
}

export type PriceSource = 'close' | 'minInvestment';

export interface PricePerShare {
  price: number;
  source: PriceSource;
}

// 1株あたり価格。終値が無い銘柄は、kabuyutaiの必要投資金額(必要株数ベース)を最小株数で割った推定値。
export function pricePerShare(item: BudgetItem): PricePerShare | null {
  if (item.closePrice !== null && item.closePrice > 0) return { price: item.closePrice, source: 'close' };
  if (item.minInvestment !== null && item.minInvestment > 0) {
    return { price: item.minInvestment / minShares(item), source: 'minInvestment' };
  }
  return null;
}

export function matchesMonth(item: BudgetItem, month: number): boolean {
  return item.rightsMonths.includes(month);
}

// 既定の権利確定月。当月の月末権利の権利付き最終日(thisMonthRightsDate)が今日以降なら当月、
// 過ぎていれば翌月。20日・15日締めの銘柄は既定月の決定には使わない(優待一覧の既定の権利日範囲と同じ)。
// 権利付き最終日は呼び出し側がlambda/shared/trading-calendarのrightsDateForMonth(..., null)で求める。
export function defaultBudgetMonth(today: string, thisMonthRightsDate: string | undefined): number {
  const m = Number(today.slice(5, 7));
  if (thisMonthRightsDate === undefined || thisMonthRightsDate >= today) return m;
  return m === 12 ? 1 : m + 1;
}

// 当月の範囲(権利付き最終日の計算に渡すカレンダーの期間)
export function monthBounds(today: string): { from: string; to: string; year: number; month: number } {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const to = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { from: `${today.slice(0, 7)}-01`, to, year, month };
}

// 保有現金の入力欄の値。カンマ・空白・「円」を許し、正の数でなければnull(未入力扱い)。
export function parseCash(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = raw.replace(/[,，\s円]/g, '');
  if (cleaned === '') return null;
  const value = Number(cleaned);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export interface CartEntry {
  ticker: string;
  shares: number;
}

export function addToCart(cart: CartEntry[], item: BudgetItem): CartEntry[] {
  if (cart.some((c) => c.ticker === item.ticker)) return cart;
  return [...cart, { ticker: item.ticker, shares: minShares(item) }];
}

export function removeFromCart(cart: CartEntry[], ticker: string): CartEntry[] {
  return cart.filter((c) => c.ticker !== ticker);
}

// 株数を単元ずつ増減する。最小株数を下回らない。上限(残り予算)はcanIncreaseで画面側が止める。
export function changeShares(cart: CartEntry[], item: BudgetItem, direction: 1 | -1): CartEntry[] {
  const unit = item.unitShares > 0 ? item.unitShares : 1;
  const min = minShares(item);
  return cart.map((c) =>
    c.ticker === item.ticker ? { ...c, shares: Math.max(min, c.shares + direction * unit) } : c,
  );
}

export interface CartLine<T extends BudgetItem> {
  item: T;
  shares: number;
  minShares: number;
  price: PricePerShare;
  cost: number;
  canIncrease: boolean;
  canDecrease: boolean;
}

export type ListStatus = 'inCart' | 'affordable' | 'unaffordable' | 'unknown';

export interface ListRow<T extends BudgetItem> {
  item: T;
  minShares: number;
  price: PricePerShare | null;
  // 一覧の必要資金は最小株数で固定する(カートの株数に連動させると並び順が動くため)
  cost: number | null;
  yieldPct: number | null;
  status: ListStatus;
  // unaffordableのときの不足額(「あと◯円」)。それ以外はnull
  shortfall: number | null;
}

export interface BudgetResult<T extends BudgetItem> {
  cartLines: CartLine<T>[];
  cartTotal: number;
  // 保有現金が未入力ならnull
  remaining: number | null;
  shortage: boolean;
  rows: ListRow<T>[];
}

export function evaluateBudget<T extends BudgetItem>(args: {
  items: T[];
  cart: CartEntry[];
  cash: number | null;
  month: number;
}): BudgetResult<T> {
  const { items, cart, cash, month } = args;
  const byTicker = new Map(items.map((i) => [i.ticker, i]));

  const pricedCart = cart.flatMap((entry) => {
    const item = byTicker.get(entry.ticker);
    const price = item ? pricePerShare(item) : null;
    return item && price ? [{ entry, item, price }] : [];
  });
  const cartTotal = pricedCart.reduce((sum, c) => sum + c.price.price * c.entry.shares, 0);
  const remaining = cash === null ? null : cash - cartTotal;

  const cartLines = pricedCart.map(({ entry, item, price }) => {
    const unit = item.unitShares > 0 ? item.unitShares : 1;
    const min = minShares(item);
    return {
      item,
      shares: entry.shares,
      minShares: min,
      price,
      cost: price.price * entry.shares,
      canIncrease: remaining === null || price.price * unit <= remaining,
      canDecrease: entry.shares > min,
    };
  });

  const inCart = new Set(pricedCart.map((c) => c.item.ticker));
  const rows = items
    .filter((item) => matchesMonth(item, month))
    .map((item) => {
      const min = minShares(item);
      const price = pricePerShare(item);
      const cost = price ? price.price * min : null;
      const yieldPct = cost !== null && item.value !== null ? (item.value / cost) * 100 : null;
      let status: ListStatus;
      if (inCart.has(item.ticker)) status = 'inCart';
      else if (cost === null) status = 'unknown';
      else if (remaining === null || cost <= remaining) status = 'affordable';
      else status = 'unaffordable';
      const shortfall = status === 'unaffordable' && cost !== null && remaining !== null ? cost - remaining : null;
      return { item, minShares: min, price, cost, yieldPct, status, shortfall };
    });

  return { cartLines, cartTotal, remaining, shortage: remaining !== null && remaining < 0, rows };
}

// 既定では「追加済み + 買える銘柄」(と必要資金不明の銘柄)だけ。showOverで予算超過も出す。
export function visibleRows<T extends BudgetItem>(rows: ListRow<T>[], showOver: boolean): ListRow<T>[] {
  return showOver ? rows : rows.filter((r) => r.status !== 'unaffordable');
}

export type SortKey = 'cost' | 'value' | 'yield';
export type SortDir = 1 | -1;

// 値がnullの行(優待価値不明・必要資金不明)は昇順・降順とも末尾。同値は元の順を保つ。
export function sortRows<T extends BudgetItem>(rows: ListRow<T>[], key: SortKey, dir: SortDir): ListRow<T>[] {
  const pick = (r: ListRow<T>): number | null =>
    key === 'cost' ? r.cost : key === 'value' ? r.item.value : r.yieldPct;
  return [...rows].sort((a, b) => {
    const x = pick(a);
    const y = pick(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return (x - y) * dir;
  });
}
