// 逆日歩(品貸料率)は毎日の品貸入札で決まる変動相場であり、貸株超過株数から
// 一意に決まる固定表は存在しない。ここで計算するのは入札の上限である「最高料率」
// (投資単位=貸借値段×売買単位から一意に決まる)で、これを使って
// 「最大逆日歩(=最高料率で決着した場合の上限額)」というリスクの上限を算出する。
// 出典: 日証金公開PDF「株式 最高料率早見表」 https://www.taisyaku.jp/media/about-hayamihyo.pdf
// 参考:「貸借取引貸株超過銘柄等に対する取扱い」
//   投資単位が5万円以下: 品貸料の上限は100円
//   投資単位が5万円超: 100円に、5万円を超えた分を1万円単位で切り上げた口数×20円を加算
//   最高料率(1株あたり) = 品貸料の上限 ÷ 売買単位。1円以下なら1円、1円超は10銭単位で切り上げ
export function calcMaxRate(closePrice: number, tradingUnit: number): number {
  const investmentUnit = closePrice * tradingUnit;
  const cap = investmentUnit <= 50_000 ? 100 : 100 + Math.ceil((investmentUnit - 50_000) / 10_000) * 20;
  const rawRate = cap / tradingUnit;
  if (rawRate <= 1) return 1;
  return Math.ceil(rawRate * 10) / 10;
}

// 最大逆日歩(円) = 最高料率 × 保有株数(単元株数) × 品貸日数
export function calcMaxGyakuhibu(closePrice: number, tradingUnit: number, days: number): number {
  return calcMaxRate(closePrice, tradingUnit) * tradingUnit * days;
}

// taisyaku.jp「品貸入札、逆日歩、最高料率、応札ランク」の「倍率適用」規定より、配当・新株引受権等の
// 権利付銘柄は最高料率が引き上げられる: 権利落日6営業日前~2営業日前は2倍、権利落日の前営業日
// (=権利付き最終日そのもの)は4倍。このアプリの逆日歩見積りは常に権利付き最終日を評価対象と
// するため、権利付き最終日は定義上つねに「権利落日の前営業日」に一致し、倍率は条件分岐なく
// 常に4倍となる(2026-09-03にU-NEXT HD(9418)の実データで検証済み: 8/20-8/26の2倍・8/27の4倍が
// 早見表基準値と完全一致した。詳細はdocs/superpowers/notes/2026-09-03-taisyaku-rights-day-rate-multiplier.md参照)。
// なお倍率は最高料率(上限)にのみ適用され、実際の品貸料(入札結果)を保証するものではない。
export const RIGHTS_DAY_RATE_MULTIPLIER = 4;
