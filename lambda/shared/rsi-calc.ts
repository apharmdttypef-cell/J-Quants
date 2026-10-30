// RSI(相対力指数)の計算。優待一覧・詳細の「RSI高め/低め」ラベルの元になる
// (docs/superpowers/specs/2026-10-31-rsi-label-design.md)。
// 株価テーブルの終値は調整前の値なので、分割・併合の日を検出してそれより前を捨てる。

export const RSI_PERIOD = 14;
export const RSI_HIGH_THRESHOLD = 70;
export const RSI_LOW_THRESHOLD = 30;
// 最新終値がこれより古い(暦日)銘柄は、古いRSIを今のものとして見せないためnaにする
export const RSI_MAX_STALENESS_DAYS = 7;
// 前日比がこれ以下(−45%以下)なら分割、逆数以上(+82%以上)なら併合とみなす。
// 東証の値幅制限では、ごく低位の株を除き1日でここまで動かない。
export const RSI_SPLIT_DROP_RATIO = 0.55;
// RSIの計算に読む終値の件数(Wilderの平滑化を十分なじませる長さ)
export const RSI_PRICE_LOOKBACK = 60;

export type RsiLabel = 'high' | 'low' | 'neutral' | 'na';

export interface RsiSnapshot {
  rsi14: number | null;
  rsiLabel: RsiLabel;
  rsiAsOf: string | null;
}

const NA_SNAPSHOT: RsiSnapshot = { rsi14: null, rsiLabel: 'na', rsiAsOf: null };

function isValidClose(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

// 最後に分割・併合とみなした日の終値から後だけを返す。分割の日の終値は新しい基準なので残す。
function sinceLastSplit(closes: number[]): number[] {
  for (let i = closes.length - 1; i >= 1; i--) {
    const ratio = closes[i] / closes[i - 1];
    if (ratio <= RSI_SPLIT_DROP_RATIO || ratio >= 1 / RSI_SPLIT_DROP_RATIO) return closes.slice(i);
  }
  return closes;
}

// closesは日付昇順。欠損・非数値は除く。終値がperiod+1件に満たなければnull。
export function calcRsi(closes: ReadonlyArray<number | null | undefined>, period = RSI_PERIOD): number | null {
  const series = sinceLastSplit(closes.filter(isValidClose));
  if (series.length < period + 1) return null;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = series[i] - series[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period + 1; i < series.length; i++) {
    const diff = series[i] - series[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }

  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export function toRsiLabel(rsi: number | null): RsiLabel {
  if (rsi === null) return 'na';
  if (rsi >= RSI_HIGH_THRESHOLD) return 'high';
  if (rsi <= RSI_LOW_THRESHOLD) return 'low';
  return 'neutral';
}

function calendarDaysBetween(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

// pricesは株価テーブルの行(順不同)。todayはバッチ実行日(JSTのYYYY-MM-DD)。
export function computeRsiSnapshot(prices: ReadonlyArray<Record<string, unknown>>, today: string): RsiSnapshot {
  const valid = prices
    .filter((row): row is { date: string; close: number } => typeof row.date === 'string' && isValidClose(row.close))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (valid.length === 0) return NA_SNAPSHOT;

  const asOf = valid[valid.length - 1].date;
  if (calendarDaysBetween(asOf, today) > RSI_MAX_STALENESS_DAYS) return NA_SNAPSHOT;

  const rsi = calcRsi(valid.map((row) => row.close));
  if (rsi === null) return NA_SNAPSHOT;
  return { rsi14: Math.round(rsi * 10) / 10, rsiLabel: toRsiLabel(rsi), rsiAsOf: asOf };
}
