import { calcMaxRate, calcMaxGyakuhibu } from '../lambda/shared/gyakuhibu-calc';

// 日証金公開PDF「株式 最高料率早見表」の実際の値と一致することを確認する
// https://www.taisyaku.jp/media/about-hayamihyo.pdf
test('calcMaxRate matches the published table at investment unit boundaries', () => {
  expect(calcMaxRate(500, 100)).toBeCloseTo(1.0); // 投資単位5万円ちょうど → 上限100円 → 100/100=1.0円
  expect(calcMaxRate(600, 100)).toBeCloseTo(1.2); // 投資単位6万円 → 上限120円 → 120/100=1.2円
  expect(calcMaxRate(5000, 100)).toBeCloseTo(10.0); // 投資単位50万円 → 上限1000円 → 1000/100=10.0円
  expect(calcMaxRate(50, 1000)).toBeCloseTo(1.0); // 投資単位5万円、単元1000株 → 100/1000=0.1円 → 1円以下なので1円に切り上げ
});

test('calcMaxRate rounds up to the nearest 10 sen above 1 yen', () => {
  // 投資単位55,500円(50,000円超) → 上限 = 100 + ceil(5500/10000)*20 = 100+20=120円
  // 単元株数100 → 120/100=1.2円(既に10銭単位なのでそのまま)
  expect(calcMaxRate(555, 100)).toBeCloseTo(1.2);
  // 単元株数97 → 120/97=1.237...円 → 10銭単位で切り上げ→1.3円
  expect(calcMaxRate(572.16, 97)).toBeCloseTo(1.3);
});

test('calcMaxGyakuhibu multiplies the per-share rate by trading unit and days', () => {
  expect(calcMaxGyakuhibu(500, 100, 3)).toBeCloseTo(1.0 * 100 * 3);
});
