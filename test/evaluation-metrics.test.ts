import {
  type JoinedSample,
  quantileCoverage,
  pinballLoss,
  occurrenceConfusionMatrix,
  occurrenceRateByBin,
  statusConfusionMatrix,
  safeMissList,
  binBreakdown,
  poolOnlyPinballLoss,
  tickerOnlyPinballLoss,
  fullFillPinballLoss,
  crossSnapshotComparison,
  populationBreakdown,
} from '../scripts/lib/evaluation-metrics';

function sample(overrides: Partial<JoinedSample> = {}): JoinedSample {
  return {
    ticker: '1111',
    bin: '0〜0.5',
    fillP50: 0.1,
    fillP90: 0.6,
    fillRatioActual: 0.2,
    forecastStatusValue: 'safe',
    statusActual: 'safe',
    value: 1000,
    costActual: 100,
    maxGyakuhibu: 1000,
    excessGroup: 'excess',
    specialMultiplier: false,
    fetchStatus: 'ok',
    tickerSamplesForBaseline: [0.1, 0.3],
    poolSamplesForBaseline: [0.05, 0.2, 0.4],
    ...overrides,
  };
}

describe('quantileCoverage', () => {
  test('counts the fraction of samples where actual fill ratio is <= predicted p50/p90', () => {
    const samples = [
      sample({ fillP50: 0.1, fillP90: 0.6, fillRatioActual: 0.05 }), // <=both
      sample({ fillP50: 0.1, fillP90: 0.6, fillRatioActual: 0.3 }), // <=p90 only
      sample({ fillP50: 0.1, fillP90: 0.6, fillRatioActual: 0.9 }), // <=neither
    ];

    const result = quantileCoverage(samples);

    expect(result.p50Coverage).toBeCloseTo(1 / 3, 10);
    expect(result.p90Coverage).toBeCloseTo(2 / 3, 10);
  });

  test('throws on an empty sample array (caller must check min sample size first)', () => {
    expect(() => quantileCoverage([])).toThrow();
  });
});

describe('pinballLoss', () => {
  test('computes the average pinball loss for tau=0.5 (equal penalty both directions)', () => {
    // predicted=0.1, actual=0.2 (under-predicted, actual>predicted): loss = tau*(actual-predicted) = 0.5*0.1 = 0.05
    // predicted=0.1, actual=0.05 (over-predicted, actual<predicted): loss = (1-tau)*(predicted-actual) = 0.5*0.05 = 0.025
    const samples = [
      sample({ fillP50: 0.1, fillRatioActual: 0.2 }),
      sample({ fillP50: 0.1, fillRatioActual: 0.05 }),
    ];

    const result = pinballLoss(samples, 0.5, 'fillP50');

    expect(result).toBeCloseTo((0.05 + 0.025) / 2, 10);
  });

  test('computes the average pinball loss for tau=0.9 (asymmetric penalty)', () => {
    // predicted=0.6, actual=0.8: under-predicted, loss = 0.9*(0.8-0.6) = 0.18
    const samples = [sample({ fillP90: 0.6, fillRatioActual: 0.8 })];

    const result = pinballLoss(samples, 0.9, 'fillP90');

    expect(result).toBeCloseTo(0.18, 10);
  });
});

describe('occurrenceConfusionMatrix', () => {
  test('classifies predicted-occurred (pOccur-derived, here via fillP50>0 as the proxy) vs actual-occurred (fillRatioActual>0)', () => {
    const samples = [
      sample({ fillP50: 0.1, fillRatioActual: 0.2 }), // predicted yes, actual yes -> TP
      sample({ fillP50: 0.1, fillRatioActual: 0 }), // predicted yes, actual no -> FP
      sample({ fillP50: 0, fillRatioActual: 0.1 }), // predicted no, actual yes -> FN
      sample({ fillP50: 0, fillRatioActual: 0 }), // predicted no, actual no -> TN
    ];

    const result = occurrenceConfusionMatrix(samples);

    expect(result).toEqual({ truePositive: 1, falsePositive: 1, falseNegative: 1, trueNegative: 1 });
  });
});

describe('occurrenceRateByBin', () => {
  test('groups by bin and reports predicted vs actual occurrence rate plus sample count', () => {
    const samples = [
      sample({ bin: '0〜0.5', fillP50: 0.1, fillRatioActual: 0.2 }),
      sample({ bin: '0〜0.5', fillP50: 0, fillRatioActual: 0 }),
      sample({ bin: '1〜2', fillP50: 0.3, fillRatioActual: 0 }),
    ];

    const result = occurrenceRateByBin(samples);

    expect(result['0〜0.5']).toEqual({ n: 2, predictedRate: 0.5, actualRate: 0.5 });
    expect(result['1〜2']).toEqual({ n: 1, predictedRate: 1, actualRate: 0 });
  });
});

describe('statusConfusionMatrix / safeMissList', () => {
  test('cross-tabulates predicted status x actual status', () => {
    const samples = [
      sample({ forecastStatusValue: 'safe', statusActual: 'safe' }),
      sample({ forecastStatusValue: 'safe', statusActual: 'danger' }),
      sample({ forecastStatusValue: 'danger', statusActual: 'danger' }),
    ];

    const matrix = statusConfusionMatrix(samples);

    expect(matrix.safe.safe).toBe(1);
    expect(matrix.safe.danger).toBe(1);
    expect(matrix.danger.danger).toBe(1);
  });

  test('safeMissList returns every sample predicted safe but realized as a loss (actual danger), in full (not truncated)', () => {
    const samples = [
      sample({ ticker: '1111', forecastStatusValue: 'safe', statusActual: 'safe' }),
      sample({ ticker: '2222', forecastStatusValue: 'safe', statusActual: 'danger' }),
      sample({ ticker: '3333', forecastStatusValue: 'safe', statusActual: 'danger' }),
    ];

    const misses = safeMissList(samples);

    expect(misses.map((m) => m.ticker)).toEqual(['2222', '3333']);
  });
});

describe('binBreakdown', () => {
  test('reports n/coverage/pinball loss per bin, skipping bins with zero samples', () => {
    const samples = [
      sample({ bin: '0〜0.5', fillP50: 0.1, fillP90: 0.6, fillRatioActual: 0.2 }),
      sample({ bin: '1〜2', fillP50: 0.2, fillP90: 0.7, fillRatioActual: 0.1 }),
    ];

    const result = binBreakdown(samples);

    expect(Object.keys(result).sort()).toEqual(['0〜0.5', '1〜2']);
    expect(result['0〜0.5'].n).toBe(1);
    expect(result['0〜0.5'].p50Coverage).toBe(0); // 0.2 > 0.1なのでカバーされない
  });
});

describe('crossSnapshotComparison', () => {
  test('lists only tickers whose predicted status differs between snapshot A and B, and says which one matched the actual', () => {
    const samplesA = [
      sample({ ticker: '1111', forecastStatusValue: 'safe', statusActual: 'safe' }), // 一致、対象外
      sample({ ticker: '2222', forecastStatusValue: 'safe', statusActual: 'danger' }), // A=safe, B=dangerで食い違う予定
      sample({ ticker: '3333', forecastStatusValue: 'caution', statusActual: 'na' }), // Bに無い(対象外)
    ];
    const samplesB = [
      sample({ ticker: '1111', forecastStatusValue: 'safe', statusActual: 'safe' }),
      sample({ ticker: '2222', forecastStatusValue: 'danger', statusActual: 'danger' }),
    ];

    const result = crossSnapshotComparison(samplesA, samplesB);

    expect(result).toEqual([
      { ticker: '2222', statusA: 'safe', statusB: 'danger', statusActual: 'danger', whichMatched: 'B' },
    ]);
  });

  test('reports whichMatched as "A" when only snapshot A agrees with the actual, and "neither" when both disagree', () => {
    const samplesA = [
      // A=caution matches actual(caution), B=safeは食い違う -> whichMatched='A'
      sample({ ticker: '4444', forecastStatusValue: 'caution', statusActual: 'caution' }),
      // A=safe, B=cautionどちらも実績(danger)と食い違う -> whichMatched='neither'
      sample({ ticker: '5555', forecastStatusValue: 'safe', statusActual: 'danger' }),
    ];
    const samplesB = [
      sample({ ticker: '4444', forecastStatusValue: 'safe', statusActual: 'caution' }),
      sample({ ticker: '5555', forecastStatusValue: 'caution', statusActual: 'danger' }),
    ];

    const result = crossSnapshotComparison(samplesA, samplesB);

    expect(result.find((r) => r.ticker === '4444')!.whichMatched).toBe('A');
    expect(result.find((r) => r.ticker === '5555')!.whichMatched).toBe('neither');
  });
});

describe('populationBreakdown', () => {
  test('counts samples by why they were excluded from the primary population (no_excess/specialMultiplier/fetch failure), not just the primary count', () => {
    const samples = [
      sample({ excessGroup: 'excess', specialMultiplier: false, fetchStatus: 'ok' }), // 本命
      sample({ excessGroup: 'no_excess', specialMultiplier: false, fetchStatus: 'ok' }),
      sample({ excessGroup: 'excess', specialMultiplier: true, fetchStatus: 'ok' }),
      sample({ excessGroup: 'excess', specialMultiplier: false, fetchStatus: 'fetch_error' }),
      sample({ excessGroup: 'excess', specialMultiplier: false, fetchStatus: 'no_row' }),
    ];

    const result = populationBreakdown(samples);

    expect(result).toEqual({ total: 5, primary: 1, noExcess: 1, specialMultiplier: 1, fetchFailed: 2 });
  });
});

describe('baseline pinball losses', () => {
  test('poolOnlyPinballLoss computes p50/p90 from equal-weighted pool samples only (ignoring ticker samples)', () => {
    const samples = [
      sample({
        fillRatioActual: 0.3,
        poolSamplesForBaseline: [0.1, 0.2, 0.3, 0.4], // p50=0.2(reuses weightedQuantile ranking), p90=0.4
      }),
    ];

    const result = poolOnlyPinballLoss(samples, 0.5);

    // weightedQuantile([0.1,0.2,0.3,0.4], equal weights, 0.5) は累積0.5に達する2番目の値=0.2
    // pinball(tau=0.5, predicted=0.2, actual=0.3) = 0.5*(0.3-0.2) = 0.05
    expect(result).toBeCloseTo(0.05, 10);
  });

  test('tickerOnlyPinballLoss computes p50/p90 from equal-weighted ticker samples only (ignoring pool)', () => {
    const samples = [
      sample({ fillRatioActual: 0.5, tickerSamplesForBaseline: [0.1, 0.9] }),
    ];

    const result = tickerOnlyPinballLoss(samples, 0.5);

    // weightedQuantile([0.1,0.9], equal weights, 0.5)は累積0.5に達する1番目=0.1
    expect(result).toBeCloseTo(0.5 * (0.5 - 0.1), 10);
  });

  test('fullFillPinballLoss uses fillRatio=1.0 (充足率100%、最大逆日歩) as the constant baseline prediction', () => {
    const samples = [sample({ fillRatioActual: 0.3 })];

    const result = fullFillPinballLoss(samples, 0.5);

    // predicted=1.0 (definitely over-predicted since fillRatioActual<=1 always): (tau-1)*(1-0.3) = -0.5*0.7
    expect(result).toBeCloseTo(0.5 * (1 - 0.3), 10); // pinball lossは非負なので絶対値側の式を使う
  });

  test('baseline functions skip samples with an empty baseline array rather than crashing', () => {
    const samples = [sample({ poolSamplesForBaseline: [] })];

    expect(() => poolOnlyPinballLoss(samples, 0.5)).not.toThrow();
  });
});
