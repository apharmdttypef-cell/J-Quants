// 逆日歩予測 精度検証(2026-09-28権利付き最終日)の評価指標。純粋関数のみ、I/O無し。
// 設計: docs/superpowers/specs/2026-09-24-gyakuhibu-forecast-validation-design.md Task 5

import { weightedQuantile } from '../../lambda/shared/gyakuhibu-forecast';

export type ForecastStatusValue = 'safe' | 'caution' | 'danger' | 'na';

// スナップショット(予測)1レコードと実績1レコードをticker単位でjoinした評価用サンプル。
// このjoinはTask 4(evaluate-forecast.ts)が組み立てる。
export interface JoinedSample {
  ticker: string;
  bin: string | null;
  fillP50: number | null;
  fillP90: number | null;
  fillRatioActual: number | null;
  forecastStatusValue: ForecastStatusValue;
  statusActual: ForecastStatusValue;
  value: number | null;
  costActual: number | null;
  maxGyakuhibu: number | null;
  excessGroup: 'excess' | 'no_excess' | null;
  specialMultiplier: boolean;
  fetchStatus: 'ok' | 'no_row' | 'fetch_error';
  // ベースライン(b)(a)算出用。forecast()の入力に使われた生のfillRatio配列
  // (Task 4がJQuantsGyakuhibuActual/JQuantsYutaiMasterを再スキャンして復元する)。
  tickerSamplesForBaseline: number[];
  poolSamplesForBaseline: number[];
}

function assertNonEmpty(samples: JoinedSample[], fnName: string): void {
  if (samples.length === 0) {
    throw new Error(`${fnName}: samples array must not be empty (caller must check min sample size first)`);
  }
}

export function quantileCoverage(samples: JoinedSample[]): { p50Coverage: number; p90Coverage: number } {
  assertNonEmpty(samples, 'quantileCoverage');
  let p50Count = 0;
  let p90Count = 0;
  for (const s of samples) {
    if (s.fillRatioActual === null || s.fillP50 === null || s.fillP90 === null) continue;
    if (s.fillRatioActual <= s.fillP50) p50Count++;
    if (s.fillRatioActual <= s.fillP90) p90Count++;
  }
  return { p50Coverage: p50Count / samples.length, p90Coverage: p90Count / samples.length };
}

// pinball loss(分位点損失)。tau=0.5ならMAEの半分に相当する対称版、tau=0.9なら
// 過小予測(実績>予測)側をより強く罰する非対称版になる。
export function pinballLoss(
  samples: JoinedSample[],
  tau: number,
  predictedField: 'fillP50' | 'fillP90',
): number {
  assertNonEmpty(samples, 'pinballLoss');
  let total = 0;
  let n = 0;
  for (const s of samples) {
    const predicted = s[predictedField];
    if (predicted === null || s.fillRatioActual === null) continue;
    const diff = s.fillRatioActual - predicted;
    total += diff >= 0 ? tau * diff : (tau - 1) * diff;
    n++;
  }
  if (n === 0) throw new Error('pinballLoss: no samples had both predicted and actual values');
  return total / n;
}

export function occurrenceConfusionMatrix(samples: JoinedSample[]): {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  trueNegative: number;
} {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let trueNegative = 0;
  for (const s of samples) {
    if (s.fillP50 === null || s.fillRatioActual === null) continue;
    const predictedOccurred = s.fillP50 > 0;
    const actualOccurred = s.fillRatioActual > 0;
    if (predictedOccurred && actualOccurred) truePositive++;
    else if (predictedOccurred && !actualOccurred) falsePositive++;
    else if (!predictedOccurred && actualOccurred) falseNegative++;
    else trueNegative++;
  }
  return { truePositive, falsePositive, falseNegative, trueNegative };
}

export function occurrenceRateByBin(
  samples: JoinedSample[],
): Record<string, { n: number; predictedRate: number; actualRate: number }> {
  const groups = new Map<string, JoinedSample[]>();
  for (const s of samples) {
    if (s.bin === null) continue;
    const list = groups.get(s.bin) ?? [];
    list.push(s);
    groups.set(s.bin, list);
  }
  const result: Record<string, { n: number; predictedRate: number; actualRate: number }> = {};
  for (const [bin, list] of groups) {
    const valid = list.filter((s) => s.fillP50 !== null && s.fillRatioActual !== null);
    const predictedOccurredCount = valid.filter((s) => s.fillP50! > 0).length;
    const actualOccurredCount = valid.filter((s) => s.fillRatioActual! > 0).length;
    result[bin] = {
      n: valid.length,
      predictedRate: valid.length > 0 ? predictedOccurredCount / valid.length : 0,
      actualRate: valid.length > 0 ? actualOccurredCount / valid.length : 0,
    };
  }
  return result;
}

export function statusConfusionMatrix(
  samples: JoinedSample[],
): Record<ForecastStatusValue, Record<ForecastStatusValue, number>> {
  const statuses: ForecastStatusValue[] = ['safe', 'caution', 'danger', 'na'];
  const matrix = Object.fromEntries(
    statuses.map((predicted) => [predicted, Object.fromEntries(statuses.map((actual) => [actual, 0]))]),
  ) as Record<ForecastStatusValue, Record<ForecastStatusValue, number>>;

  for (const s of samples) {
    matrix[s.forecastStatusValue][s.statusActual]++;
  }
  return matrix;
}

export function safeMissList(samples: JoinedSample[]): JoinedSample[] {
  return samples.filter((s) => s.forecastStatusValue === 'safe' && s.statusActual === 'danger');
}

export function binBreakdown(
  samples: JoinedSample[],
): Record<string, { n: number; p50Coverage: number; p90Coverage: number; pinballP50: number; pinballP90: number }> {
  const groups = new Map<string, JoinedSample[]>();
  for (const s of samples) {
    if (s.bin === null) continue;
    const list = groups.get(s.bin) ?? [];
    list.push(s);
    groups.set(s.bin, list);
  }

  const result: ReturnType<typeof binBreakdown> = {};
  for (const [bin, list] of groups) {
    const coverage = quantileCoverage(list);
    result[bin] = {
      n: list.length,
      p50Coverage: coverage.p50Coverage,
      p90Coverage: coverage.p90Coverage,
      pinballP50: pinballLoss(list, 0.5, 'fillP50'),
      pinballP90: pinballLoss(list, 0.9, 'fillP90'),
    };
  }
  return result;
}

function baselinePinballLoss(
  samples: JoinedSample[],
  tau: number,
  baselineField: 'tickerSamplesForBaseline' | 'poolSamplesForBaseline',
): number {
  let total = 0;
  let n = 0;
  for (const s of samples) {
    const values = s[baselineField];
    if (values.length === 0 || s.fillRatioActual === null) continue;
    const equalWeights = values.map(() => 1);
    const predicted = weightedQuantile(values, equalWeights, tau === 0.9 ? 0.9 : 0.5);
    const diff = s.fillRatioActual - predicted;
    total += diff >= 0 ? tau * diff : (tau - 1) * diff;
    n++;
  }
  // 注: 個別サンプルがベースライン配列を欠いている場合はそのサンプルだけをスキップする
  // (ブリーフのテスト「baseline functions skip samples with an empty baseline array rather
  // than crashing」が要求する挙動)。全サンプルがスキップされ尽くしてn=0になった場合でも
  // 例外は投げず、呼び出し側が判別できるようNaNを返す。
  return n === 0 ? NaN : total / n;
}

// ベースライン(a): プールのみ(縮小推定の銘柄側重みを常に0にした場合)。
export function poolOnlyPinballLoss(samples: JoinedSample[], tau: number): number {
  return baselinePinballLoss(samples, tau, 'poolSamplesForBaseline');
}

// ベースライン(b): 銘柄自身のみ(縮小推定のプール側重みを常に0にした場合)。
export function tickerOnlyPinballLoss(samples: JoinedSample[], tau: number): number {
  return baselinePinballLoss(samples, tau, 'tickerSamplesForBaseline');
}

// ベースライン(c): 充足率100%(最大逆日歩)を常に予測したとみなす定数ベースライン。
export function fullFillPinballLoss(samples: JoinedSample[], tau: number): number {
  assertNonEmpty(samples, 'fullFillPinballLoss');
  let total = 0;
  let n = 0;
  for (const s of samples) {
    if (s.fillRatioActual === null) continue;
    const diff = s.fillRatioActual - 1;
    total += diff >= 0 ? tau * diff : (tau - 1) * diff;
    n++;
  }
  if (n === 0) throw new Error('fullFillPinballLoss: no samples had an actual value');
  return total / n;
}

export interface StatusFlip {
  ticker: string;
  statusA: ForecastStatusValue;
  statusB: ForecastStatusValue;
  statusActual: ForecastStatusValue;
  whichMatched: 'A' | 'B' | 'both' | 'neither';
}

// 2つのスナップショット(通常はA・B)で予測statusが食い違った銘柄だけを一覧化し、
// どちらが実績に近かったかを付記する。両スナップショットに存在する銘柄のみが対象
// (どちらか片方にしか無い銘柄は比較不能なので除外する)。
export function crossSnapshotComparison(samplesA: JoinedSample[], samplesB: JoinedSample[]): StatusFlip[] {
  const bByTicker = new Map(samplesB.map((s) => [s.ticker, s]));
  const flips: StatusFlip[] = [];

  for (const a of samplesA) {
    const b = bByTicker.get(a.ticker);
    if (!b) continue;
    if (a.forecastStatusValue === b.forecastStatusValue) continue;

    const aMatches = a.forecastStatusValue === a.statusActual;
    const bMatches = b.forecastStatusValue === b.statusActual;
    const whichMatched: StatusFlip['whichMatched'] =
      aMatches && bMatches ? 'both' : aMatches ? 'A' : bMatches ? 'B' : 'neither';

    flips.push({
      ticker: a.ticker,
      statusA: a.forecastStatusValue,
      statusB: b.forecastStatusValue,
      statusActual: a.statusActual,
      whichMatched,
    });
  }

  return flips;
}

// 本命集計から除外された理由別の件数。本命集計自体の件数(primary)も含めて返す。
export function populationBreakdown(samples: JoinedSample[]): {
  total: number;
  primary: number;
  noExcess: number;
  specialMultiplier: number;
  fetchFailed: number;
} {
  let primary = 0;
  let noExcess = 0;
  let specialMultiplier = 0;
  let fetchFailed = 0;

  for (const s of samples) {
    if (s.fetchStatus !== 'ok') {
      fetchFailed++;
    } else if (s.specialMultiplier) {
      specialMultiplier++;
    } else if (s.excessGroup === 'no_excess') {
      noExcess++;
    } else {
      primary++;
    }
  }

  return { total: samples.length, primary, noExcess, specialMultiplier, fetchFailed };
}
