import type { YutaiForecastStatus } from '../api/types';

// 判定の表示名。優待一覧のriskStatusと逆日歩予測のforecastStatusは同じ値なので、
// 全画面でこれを使う(画面ごとに書くと文言がずれる)。
export const RISK_STATUS_LABEL: Record<YutaiForecastStatus, string> = {
  danger: '危険',
  caution: '注意',
  safe: '安全',
  'general-only': '制度信用不可',
  na: '対象外',
};

// 'general-only'で分かっているのは「制度信用では売れない(貸借区分が貸借ではない)」ことだけ。
// 一般信用で売れるかは証券会社ごとの在庫次第で、このアプリは把握していない。
export const GENERAL_ONLY_NOTE =
  '制度信用では売れない銘柄です(逆日歩は発生しません)。一般信用の売り在庫があるかは証券会社ごとに確認してください。';

// 判定バッジのツールチップ。制度信用不可のときだけ補足を出す。
export function riskStatusTitle(status: YutaiForecastStatus): string | undefined {
  return status === 'general-only' ? GENERAL_ONLY_NOTE : undefined;
}
