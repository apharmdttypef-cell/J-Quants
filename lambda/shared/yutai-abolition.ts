// TDnetの開示タイトルから「優待制度そのものの廃止予告」を判定する。
// yutai-tdnet-watch-batch(毎週の検知)とscripts/backfill-abolition-notice.ts(過去分の一括反映)で共有する。
// 設計: docs/superpowers/specs/2026-11-12-yutai-change-apply-design.md

const YUTAI_KEYWORD = '株主優待';
// 「終了」は9223「現行株主優待制度の終了および…」のような言い回しを拾うため。
const ABOLITION_KEYWORDS = ['廃止', '終了'];
// 「一部変更（デジタルギフトの廃止）」のように、制度は続き一部の品目だけをやめる開示を除く。
const PARTIAL_KEYWORD = '一部';

export interface AbolitionNotice {
  disclosedAt: string;
  title: string;
}

export type YutaiTdnetEventType = 'start' | 'update' | 'abolition' | 'abolition-notice';

export function isAbolitionNotice(title: string): boolean {
  return (
    title.includes(YUTAI_KEYWORD) &&
    ABOLITION_KEYWORDS.some((keyword) => title.includes(keyword)) &&
    !title.includes(PARTIAL_KEYWORD)
  );
}

// 同じ銘柄に廃止予告が複数あれば(本開示+補足など)、最も新しい開示を記録する。
export function latestAbolitionNotice(
  disclosures: Array<{ disclosedAt: string; title: string }>,
): AbolitionNotice | null {
  let latest: AbolitionNotice | null = null;
  for (const { disclosedAt, title } of disclosures) {
    if (!isAbolitionNotice(title)) continue;
    if (!latest || disclosedAt > latest.disclosedAt) latest = { disclosedAt, title };
  }
  return latest;
}
