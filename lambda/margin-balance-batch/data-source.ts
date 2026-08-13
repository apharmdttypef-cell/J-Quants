// フェーズ1: J-Quants Standardプラン(mkt-margin-int / mkt-margin-alert)へのアップグレードを
// 遅らせるため、信用残データはダミー生成する。ticker+dateから決定的な擬似乱数を作り、
// 同じ入力には常に同じ値を返す(実行のたびに値が変わるとトレンドグラフが毎日ジャンプするため)。
// フェーズ2ではこのファイルの中身だけをmkt-margin-int/mkt-margin-alert呼び出しに差し替える
// (呼び出し元はこの関数がダミーか本番かを意識しない)。
export interface MarginBalancePoint {
  date: string;
  financingBalance: number;
  lendingBalance: number;
  source: 'weekly' | 'daily-alert';
}

function seedFrom(...parts: string[]): number {
  let hash = 0;
  const input = parts.join('|');
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function pseudoRandom(seed: number): number {
  // 単純な線形合同法。暗号強度は不要(表示用ダミーデータのため)。
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function listMondays(from: string, to: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  // 直近の月曜まで戻す
  const day = cursor.getUTCDay();
  cursor.setUTCDate(cursor.getUTCDate() - ((day + 6) % 7));

  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return dates;
}

export async function fetchWeeklyBalances(ticker: string, from: string, to: string): Promise<MarginBalancePoint[]> {
  return listMondays(from, to).map((date) => {
    const seed = seedFrom(ticker, date);
    const base = 10_000 + Math.floor(pseudoRandom(seed) * 90_000);
    const lendingBalance = base + Math.floor(pseudoRandom(seed + 1) * 20_000);
    const financingBalance = base;
    return { date, financingBalance, lendingBalance, source: 'weekly' as const };
  });
}

export async function fetchDailyAlertBalances(tickers: string[], date: string): Promise<MarginBalancePoint[]> {
  return tickers.map((ticker) => {
    const seed = seedFrom(ticker, date, 'daily-alert');
    const base = 10_000 + Math.floor(pseudoRandom(seed) * 90_000);
    const lendingBalance = base + Math.floor(pseudoRandom(seed + 1) * 30_000);
    return { date, financingBalance: base, lendingBalance, source: 'daily-alert' as const };
  });
}
