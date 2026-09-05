import {
  excessRatio,
  fillRatio,
  binFor,
  weightedQuantile,
  buildPool,
  forecast,
  chooseScenario,
  forecastStatus,
  ForecastSample,
} from '../lambda/shared/gyakuhibu-forecast';

test('excessRatio: positive when lending exceeds financing, Infinity when financing is 0 and lending > 0, null when both 0', () => {
  expect(excessRatio(100, 250)).toBeCloseTo(1.5);
  expect(excessRatio(100, 50)).toBeCloseTo(-0.5);
  expect(excessRatio(0, 10)).toBe(Infinity);
  expect(excessRatio(0, 0)).toBeNull();
});

test('fillRatio divides the total fee for the period by the actual max rate and clamps to [0,1]', () => {
  expect(fillRatio(14.4, 1, 14.4)).toBe(1);
  expect(fillRatio(0, 0, 3.6)).toBe(0);
  expect(fillRatio(2, 1, null)).toBeNull();
});

test('binFor uses exclusive upper edges', () => {
  expect(binFor(0.5).label).toBe('0.5〜1');
  expect(binFor(-0.01).label).toBe('融資超過');
  expect(binFor(Infinity).label).toBe('5以上');
});

function sample(fillRatio: number, overrides: Partial<ForecastSample> = {}): ForecastSample {
  return { ticker: 'T', rightsDate: '2026-01-01', month: 1, excessRatio: 1.5, fillRatio, regulated: false, ...overrides };
}

test('weightedQuantile picks the first value whose cumulative weight reaches q (no interpolation)', () => {
  // Step 3の方式(累積重みがq以上になる最初の値。補間しない)で手計算した値。
  // [1,2,3,4]を等重みで正規化すると各0.25、累積は0.25/0.5/0.75/1.0。
  // q=0.5は累積0.5(=2番目の値2)で条件を満たす -- 補間すれば2.5になるが、
  // この実装は補間しないので2が正しい。
  expect(weightedQuantile([1, 2, 3, 4], [1, 1, 1, 1], 0.5)).toBe(2);
  expect(weightedQuantile([1, 2, 3, 4], [1, 1, 1, 1], 0.9)).toBe(4);
});

test('buildPool counts zeros in the quantiles', () => {
  // 同一ビン(excessRatio=1.5 → '1〜2')にfill=[0,0,0,0.4,0.8]。等重みの累積は
  // 0.2/0.4/0.6/0.8/1.0。pOccur=2/5=0.4。P50(累積>=0.5の最初)=3番目の値0。
  // P90(累積>=0.9の最初)=5番目の値0.8。fillMean=(0+0+0+0.4+0.8)/5=0.24。
  const samples = [0, 0, 0, 0.4, 0.8].map((f) => sample(f));
  const pool = buildPool(samples);
  const bin = pool.find((b) => b.label === '1〜2')!;
  expect(bin.n).toBe(5);
  expect(bin.pOccur).toBeCloseTo(0.4);
  expect(bin.fillP50).toBe(0);
  expect(bin.fillP90).toBeCloseTo(0.8);
  expect(bin.fillMean).toBeCloseTo(0.24);
});

test('forecast with no ticker samples equals the pool bin distribution', () => {
  // poolSamplesのfill=[0, 0.5, 1.0]、等重み累積0.333/0.667/1.0。
  // P50(累積>=0.5の最初)=2番目の値0.5。P90(累積>=0.9の最初)=3番目の値1.0。
  const poolSamples = [0, 0.5, 1.0].map((f) => sample(f));
  const result = forecast({
    tickerSamples: [], poolSamples, scenario: 'last-rights', excessRatio: 1.5, maxGyakuhibu: 1000, value: 500,
  });
  expect(result.fillP50).toBeCloseTo(0.5);
  expect(result.fillP90).toBeCloseTo(1.0);
  expect(result.tickerSamples).toBe(0);
  expect(result.poolSamples).toBe(3);
});

test('forecast with 4 ticker samples weights ticker and pool equally (K=4)', () => {
  const tickerSamples = Array.from({ length: 4 }, () => sample(1));
  const poolSamples = Array.from({ length: 4 }, () => sample(0));
  const result = forecast({
    tickerSamples, poolSamples, scenario: 'last-rights', excessRatio: 1.5, maxGyakuhibu: 1000, value: 500,
  });
  // w = 4/(4+4) = 0.5 -> fillMean = 0.5*1 + 0.5*0 = 0.5
  expect(result.fillMean).toBeCloseTo(0.5);
});

test('forecast only blends pool samples from the chosen scenario bin, ignoring other bins', () => {
  const wrongBinSamples = [0.9, 0.9].map((f) => sample(f, { excessRatio: 3.5 })); // bin '2〜5'
  const rightBinSamples = [0.1, 0.1].map((f) => sample(f, { excessRatio: 1.5 })); // bin '1〜2'
  const result = forecast({
    tickerSamples: [],
    poolSamples: [...wrongBinSamples, ...rightBinSamples],
    scenario: 'last-rights',
    excessRatio: 1.5,
    maxGyakuhibu: 1000,
    value: 500,
  });
  // 採用ビン('1〜2')に属するのはrightBinSamplesの2件のみ。wrongBinSamples(ビン'2〜5')が
  // 混ざっていれば poolSamples は4、fillMean は (0.9+0.9+0.1+0.1)/4=0.5 になってしまうはずで、
  // この期待値(2件・0.1)はビンフィルタが正しく効いていることを示す。
  expect(result.poolSamples).toBe(2);
  expect(result.fillMean).toBeCloseTo(0.1);
});

test('forecast with an empty pool bin falls back to ticker samples only', () => {
  const tickerSamples = [0.2, 0.6, 1.0].map((f) => sample(f));
  const result = forecast({
    tickerSamples, poolSamples: [], scenario: 'last-rights', excessRatio: 1.5, maxGyakuhibu: 1000, value: 500,
  });
  // n_p=0 -> 重みは銘柄側1.0に倒れ、銘柄分布そのものと一致する
  expect(result.fillMean).toBeCloseTo((0.2 + 0.6 + 1.0) / 3);
  expect(result.poolSamples).toBe(0);
});

test('chooseScenario prefers the latest same-month rights date, then the latest rights date, then TSE, then none', () => {
  const tickerSamples = [
    sample(0.5, { rightsDate: '2024-09-26', month: 9, excessRatio: 1.0 }),
    sample(0.8, { rightsDate: '2025-09-26', month: 9, excessRatio: 2.0 }),
    sample(0.1, { rightsDate: '2025-03-27', month: 3, excessRatio: 0.3 }),
  ];

  // 対象月(9月)のサンプルが複数あれば、そのうち直近(rightsDateが新しい方)を採用
  expect(chooseScenario(tickerSamples, 9, null)).toEqual({ scenario: 'last-rights', excessRatio: 2.0 });

  // 対象月(6月)のサンプルが無ければ、全サンプル中で最も新しい権利日を採用
  expect(chooseScenario(tickerSamples, 6, null)).toEqual({ scenario: 'last-rights', excessRatio: 2.0 });

  // 銘柄サンプルが無ければ東証信用残ベース(excessRatio(100,250)=1.5)
  expect(chooseScenario([], 9, { financingBalance: 100, lendingBalance: 250 })).toEqual({
    scenario: 'current-tse', excessRatio: 1.5,
  });

  // どちらも無ければnone
  expect(chooseScenario([], 9, null)).toEqual({ scenario: 'none', excessRatio: null });
});

test('forecastStatus boundaries: value == p90 is caution, value == p50 is danger', () => {
  expect(forecastStatus(5000, 1000, 4000)).toBe('safe');
  expect(forecastStatus(4000, 1000, 4000)).toBe('caution');
  expect(forecastStatus(1000, 1000, 4000)).toBe('danger');
});

test('forecast returns na when maxGyakuhibu is null or there are no samples at all', () => {
  const result1 = forecast({
    tickerSamples: [sample(0.5)], poolSamples: [], scenario: 'last-rights', excessRatio: 1.5, maxGyakuhibu: null, value: 500,
  });
  expect(result1.forecastStatus).toBe('na');

  const result2 = forecast({
    tickerSamples: [], poolSamples: [], scenario: 'none', excessRatio: null, maxGyakuhibu: 1000, value: 500,
  });
  expect(result2.forecastStatus).toBe('na');
});
