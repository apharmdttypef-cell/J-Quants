// 銘柄の貸借区分(taisyaku.jp 全銘柄一括CSVの「貸借区分」: '貸借' | '貸借融資' | '非貸借')。
// 信用残バッチが東証行の値を優待マスタのmarginNameに書く。制度信用で売れる(=逆日歩が発生しうる)
// のは'貸借'だけ。'貸借融資'は買いのみ、'非貸借'は制度信用の対象外で、どちらもクロスは一般信用
// (証券会社の在庫)でしか組めない。移行前にJ-Quantsから取り込んだ'信用'・'その他'も同じ扱いになる。

// 区分が分かっていて、かつ制度信用で売れない銘柄。区分が分からない銘柄(東証行が無い地方市場
// 単独上場の銘柄など)は決めつけずにfalseを返す。
export function isGeneralMarginOnly(marginName: string | null): boolean {
  return marginName !== null && marginName !== '貸借';
}
