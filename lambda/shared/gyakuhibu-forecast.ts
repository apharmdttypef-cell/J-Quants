// 逆日歩予測(貸株超過率 → 実績逆日歩)の純粋関数群。副作用(AWS呼び出し・I/O)は一切持たない。
// 設計: docs/superpowers/specs/2026-09-05-gyakuhibu-forecast-design.md
//
// JQuantsGyakuhibuActual(taisyaku.jp CSVの権利日1行、enriched拡張済み)の1行。
// gyakuhibu-history-batch/taisyaku-client.tsのGyakuhibuActualPoint(CSVパース直後、
// ticker/enriched/noGyakuhibuを持たない)とは別物 -- こちらはDynamoDB Item形状。
export interface GyakuhibuActualRow {
  ticker: string;
  rightsDate: string;
  financingBalance: number;
  lendingBalance: number;
  avgRate: number;
  days: number;
  maxRateActual: number | null;
  restriction: string | null;
  emergencyMeasure: string | null;
  enriched: boolean;
  noGyakuhibu?: boolean;
}

// 学習サンプル1件(1銘柄×1権利日)。
export interface ForecastSample {
  ticker: string;
  rightsDate: string;
  month: number;
  excessRatio: number | null;
  fillRatio: number;
  regulated: boolean;
}

// プールのビン別集計(全銘柄横断)。
export interface PoolBin {
  label: string;
  lo: number;
  hi: number;
  n: number;
  pOccur: number;
  fillP50: number;
  fillP90: number;
  fillMean: number;
}

export type ForecastStatus = 'safe' | 'caution' | 'danger' | 'na';
export type Scenario = 'last-rights' | 'current-tse' | 'none';

export interface ForecastResult {
  scenario: Scenario;
  excessRatio: number | null;
  bin: string | null;
  pOccur: number | null;
  fillP50: number | null;
  fillP90: number | null;
  fillMean: number | null;
  forecastP50: number | null;
  forecastP90: number | null;
  forecastMean: number | null;
  expectedNet: number | null;
  forecastStatus: ForecastStatus;
  tickerSamples: number;
  poolSamples: number;
}

// 貸株超過率の固定6ビン。hiはexclusive(未満)、最上位ビンだけhi=Infinityで
// r>=5(+Infinity含む)を受け持つ。境界は設計書どおり定数化しておく
// (実測分布を見て見直す可能性があるため; docs/superpowers/specs/2026-09-05-gyakuhibu-forecast-design.md参照)。
export const BIN_EDGES: ReadonlyArray<{ label: string; lo: number; hi: number }> = [
  { label: '融資超過', lo: -Infinity, hi: 0 },
  { label: '0〜0.5', lo: 0, hi: 0.5 },
  { label: '0.5〜1', lo: 0.5, hi: 1 },
  { label: '1〜2', lo: 1, hi: 2 },
  { label: '2〜5', lo: 2, hi: 5 },
  { label: '5以上', lo: 5, hi: Infinity },
];

// 縮小推定の強さ。銘柄実績がK件あればプールと重み半々になる(w = n_t/(n_t+K))。
export const SHRINKAGE_K = 4;

// 貸株超過率 = (貸株残高 - 融資残高) / 融資残高。
// 融資残高が0で貸株残高>0なら無限大に張り付いている状態として+Infinity(最上位ビン行き)、
// 両方0(残高データなし)ならビン付け不能としてnull。
export function excessRatio(financing: number, lending: number): number | null {
  if (financing === 0) {
    return lending === 0 ? null : Infinity;
  }
  return (lending - financing) / financing;
}

// 充足率 = 期間中の実績品貸料(avgRate×days、1株あたり)/ 最高料率(倍率適用済みの実値、1株あたり)。
// 両方とも1株あたりの金額なので単元株数の掛け算・割り算は不要(taisyaku-client.tsの
// parseTaisyakuCsvのコメント参照)。0〜1にクランプする(実績が上限を僅かに超える丸め誤差等を吸収)。
// maxRateActualが無い(null)行は充足率を定義できないため学習サンプルから除外(null返却)。
export function fillRatio(avgRate: number, days: number, maxRateActual: number | null): number | null {
  if (maxRateActual === null) return null;
  if (maxRateActual === 0) return 0; // 分母0でNaNにならないようガード(実データでは未観測)
  const raw = (avgRate * days) / maxRateActual;
  return Math.min(1, Math.max(0, raw));
}

// GyakuhibuActualRow 1行を学習サンプルに変換する。enrichedでない、またはmaxRateActualが
// 無い行は充足率を定義できないためnullを返す(=学習から除外)。
// unitSharesはfillRatio/excessRatioの計算に使わない(両方とも1株あたりの値同士の比なので
// 単元株数は約分されて消える)。呼び出し側の他の変換関数とシグネチャを揃えるため受け取るのみ。
export function toSample(row: GyakuhibuActualRow, unitShares: number): ForecastSample | null {
  void unitShares;
  if (row.enriched !== true) return null;
  const fr = fillRatio(row.avgRate, row.days, row.maxRateActual);
  if (fr === null) return null;

  return {
    ticker: row.ticker,
    rightsDate: row.rightsDate,
    month: Number(row.rightsDate.slice(5, 7)),
    excessRatio: excessRatio(row.financingBalance, row.lendingBalance),
    fillRatio: fr,
    regulated: row.restriction != null || row.emergencyMeasure != null,
  };
}

// ratioが属するビンを返す。BIN_EDGESは上限exclusiveで並んでいるため、通常の比率は
// 対応するビンにヒットする。+Infinity(融資残高0で貸株残高>0のケース)はどのビンの
// 「hi未満」条件にも一致しない(Infinity < Infinityはfalse)ため、ループを抜けたら
// 最上位ビン(5以上)にフォールバックする。
export function binFor(ratio: number): { label: string; lo: number; hi: number } {
  for (const edge of BIN_EDGES) {
    if (ratio >= edge.lo && ratio < edge.hi) return edge;
  }
  return BIN_EDGES[BIN_EDGES.length - 1];
}

// 加重分位点: 値を昇順ソートし、重みを合計1に正規化して累積し、累積重みがq以上に
// 達した最初の値を返す。補間は一切しない(いわゆるnearest-rank方式)。
// 例: [1,2,3,4]を等重みで正規化すると各0.25、累積は0.25/0.5/0.75/1.0。q=0.5は
// 累積0.5(=2番目の値2)で条件を満たすので2を返す(補間すれば2.5になるが、この
// 実装は補間しない)。呼び出し側はvalues.length>0を保証すること(空配列は未定義動作)。
export function weightedQuantile(values: number[], weights: number[], q: number): number {
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  const pairs = values.map((v, i) => ({ v, w: weights[i] }));
  pairs.sort((a, b) => a.v - b.v);

  const EPS = 1e-9; // 浮動小数点の丸め誤差で累積がqをわずかに下回るのを防ぐ
  let cumulative = 0;
  for (const pair of pairs) {
    cumulative += pair.w / totalWeight;
    if (cumulative >= q - EPS) return pair.v;
  }
  return pairs[pairs.length - 1].v; // 理論上到達しないが型上の安全策
}

// 全銘柄プールをビンごとに集計する。excessRatioがnull(融資・貸株残高とも0)の
// サンプルはどのビンにも属せないため除外する。pOccur/fillP50/fillP90/fillMeanは
// **ゼロ充足を含む全サンプル**で計算する(発生しなかった権利日を除くと、
// 「典型的な結果」を過大評価してしまうため)。
export function buildPool(samples: ForecastSample[]): PoolBin[] {
  return BIN_EDGES.map((edge) => {
    const inBin = samples.filter((s) => s.excessRatio !== null && binFor(s.excessRatio).label === edge.label);
    const n = inBin.length;

    if (n === 0) {
      return { label: edge.label, lo: edge.lo, hi: edge.hi, n: 0, pOccur: 0, fillP50: 0, fillP90: 0, fillMean: 0 };
    }

    const fills = inBin.map((s) => s.fillRatio);
    const equalWeights = fills.map(() => 1);
    const pOccur = fills.filter((f) => f > 0).length / n;
    const fillP50 = weightedQuantile(fills, equalWeights, 0.5);
    const fillP90 = weightedQuantile(fills, equalWeights, 0.9);
    const fillMean = fills.reduce((sum, f) => sum + f, 0) / n;

    return { label: edge.label, lo: edge.lo, hi: edge.hi, n, pOccur, fillP50, fillP90, fillMean };
  });
}

// 次回権利日の貸株超過率シナリオを3段階の優先順位で決める:
//   1. 同銘柄の過去権利日サンプルのうち、次回と同じ月があれば直近(rightsDateが新しい方)
//   2. 同月が無ければ、同銘柄の全サンプル中で最も新しい権利日
//   3. 銘柄サンプルが1件も無ければ、東証信用残(mkt-margin-int)の直近値から計算(参考値)
//   4. どちらも無ければ'none'(超過率なし)
// 同銘柄のサンプルは超過率で条件付けしない(件数が少なく、同銘柄・同月の季節性のほうが
// 強いため)。
export function chooseScenario(
  tickerSamples: ForecastSample[],
  nextRightsMonth: number,
  tseLatest: { financingBalance: number; lendingBalance: number } | null,
): { scenario: Scenario; excessRatio: number | null } {
  const sameMonth = tickerSamples.filter((s) => s.month === nextRightsMonth);
  const candidates = sameMonth.length > 0 ? sameMonth : tickerSamples;

  if (candidates.length > 0) {
    const latest = candidates.reduce((a, b) => (b.rightsDate > a.rightsDate ? b : a));
    return { scenario: 'last-rights', excessRatio: latest.excessRatio };
  }

  if (tseLatest !== null) {
    return { scenario: 'current-tse', excessRatio: excessRatio(tseLatest.financingBalance, tseLatest.lendingBalance) };
  }

  return { scenario: 'none', excessRatio: null };
}

// value(優待価値)に対する判定。safe: 9割のケースで優待価値が逆日歩を上回る
// (value > p90)。caution: p50 < value <= p90。danger: value <= p50(中央値以下のケースでも
// 逆日歩が優待価値を上回りうる)。境界はちょうどp90/p50のときそれぞれcaution/dangerに倒す。
export function forecastStatus(value: number, p50: number, p90: number): ForecastStatus {
  if (value > p90) return 'safe';
  if (value > p50) return 'caution';
  return 'danger';
}

// 銘柄実績とプールを縮小推定でブレンドし、予測分布・予測逆日歩・判定を出す。
// w = n_t/(n_t+K)。銘柄サンプル1件あたりの重み = w/n_t、プールサンプル1件あたりの
// 重み = (1-w)/n_p。n_p=0(採用ビンにプールサンプルが無い、またはシナリオがnoneで
// ビン自体が無い)なら銘柄のみ(w=1相当)、n_t=0ならプールのみ(w=0相当)に自然に倒れる
// (どちらか片方のサンプルしか重み付き配列に積まないため、式でwを求めるまでもなく
// そのまま等価になる)。両方0ならna。maxGyakuhibuが無い場合も判定はnaにする
// (充足率分布そのものは計算できてもforecastStatusは金額比較のため未定義)。
export function forecast(args: {
  tickerSamples: ForecastSample[];
  poolSamples: ForecastSample[];
  scenario: Scenario;
  excessRatio: number | null;
  maxGyakuhibu: number | null;
  value: number;
}): ForecastResult {
  const { tickerSamples, poolSamples, scenario, excessRatio: chosenExcessRatio, maxGyakuhibu, value } = args;

  const bin = chosenExcessRatio !== null ? binFor(chosenExcessRatio) : null;
  const poolBinSamples = bin !== null
    ? poolSamples.filter((s) => s.excessRatio !== null && binFor(s.excessRatio).label === bin.label)
    : [];

  const nT = tickerSamples.length;
  const nP = poolBinSamples.length;

  if (nT === 0 && nP === 0) {
    return {
      scenario,
      excessRatio: chosenExcessRatio,
      bin: bin ? bin.label : null,
      pOccur: null,
      fillP50: null,
      fillP90: null,
      fillMean: null,
      forecastP50: null,
      forecastP90: null,
      forecastMean: null,
      expectedNet: null,
      forecastStatus: 'na',
      tickerSamples: nT,
      poolSamples: nP,
    };
  }

  // n_p=0なら銘柄のみ(w=1)、n_t=0ならプールのみ(w=0)に強制する。
  // どちらも件数>0なら通常の縮小推定式。
  let w: number;
  if (nP === 0) w = 1;
  else if (nT === 0) w = 0;
  else w = nT / (nT + SHRINKAGE_K);

  const values: number[] = [];
  const weights: number[] = [];
  if (nT > 0) {
    const tw = w / nT;
    for (const s of tickerSamples) {
      values.push(s.fillRatio);
      weights.push(tw);
    }
  }
  if (nP > 0) {
    const pw = (1 - w) / nP;
    for (const s of poolBinSamples) {
      values.push(s.fillRatio);
      weights.push(pw);
    }
  }

  const fillMean = values.reduce((sum, v, i) => sum + v * weights[i], 0);
  const fillP50 = weightedQuantile(values, weights, 0.5);
  const fillP90 = weightedQuantile(values, weights, 0.9);
  const pOccur = values.reduce((sum, v, i) => sum + (v > 0 ? weights[i] : 0), 0);

  let forecastP50: number | null = null;
  let forecastP90: number | null = null;
  let forecastMean: number | null = null;
  let expectedNet: number | null = null;
  let status: ForecastStatus = 'na';

  if (maxGyakuhibu !== null) {
    forecastP50 = fillP50 * maxGyakuhibu;
    forecastP90 = fillP90 * maxGyakuhibu;
    forecastMean = fillMean * maxGyakuhibu;
    expectedNet = value - forecastMean;
    status = forecastStatus(value, forecastP50, forecastP90);
  }

  return {
    scenario,
    excessRatio: chosenExcessRatio,
    bin: bin ? bin.label : null,
    pOccur,
    fillP50,
    fillP90,
    fillMean,
    forecastP50,
    forecastP90,
    forecastMean,
    expectedNet,
    forecastStatus: status,
    tickerSamples: nT,
    poolSamples: nP,
  };
}
