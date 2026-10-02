// kabuyutai.comの個別ページから株数段階別の優待内容を取り出す。純関数のみで、
// ネットワークには触れない(取得はkabuyutai-client.fetchDetailPageの責務)。

// 型だけを取り込む。kabuyutai-clientはfetchを含むため、値のimportにすると
// この純関数モジュールとそのテストにネットワークコードが混ざる。
import type { ListBadge } from './kabuyutai-client';

export interface BenefitTier {
  shares: number;
  // 金額が読み取れない段階(「ー」= 該当なし、自社製品の個数表記など)はnull。
  // 表示にはrawTextを使うため、nullでも情報は失われない。
  valueYen: number | null;
  rawText: string;
}

export interface BenefitGroup {
  // <h3>の優待種別。セクション先頭にh3が無い場合はnull。
  title: string | null;
  // 継続保有条件の月数。条件なしはnull。
  holdingMonths: number | null;
  holdingRaw: string | null;
  tiers: BenefitTier[];
}

// セクションの終端候補。段階表は文書のかなり後方(実測で約74%の位置)にあるため、
// 終端候補は「必ず段階表より後ろに現れるもの」に限らなければならない。開発中に
// '<div class="comment' を候補に入れたところ段階表より手前でマッチし、全銘柄で
// パース結果が0件になった(2026-10-01)。
const SECTION_END_ANCHORS = ['この企業の公式ホームページ', 'の優待権利確定日情報', 'id="yutai_kijunbi"'];

function detailSection(html: string): string | null {
  const start = html.indexOf('id="yutai_detail"');
  if (start === -1) return null;

  let end = html.length;
  for (const anchor of SECTION_END_ANCHORS) {
    const position = html.indexOf(anchor, start);
    if (position !== -1 && position < end) end = position;
  }
  return html.slice(start, end);
}

// 継続保有条件の表記を月数に正規化する。kabuyutai.comの書式は1系統ではなく、
// 2026-10-02の本番初回取得で少なくとも次の3系統が実在することが分かった。
//
//   【株式継続保有期間3年以上】             … 最も明示的
//   【2年連続で100株以上を保有】            … NTT(9432)
//   【通常優待の取得条件を3年連続で満たす】  … 三井不動産(8801)
//
// 当初は1系統目のリテラル「継続保有期間」だけを要求していたため、2・3系統目を取りこぼして
// holdingKind を none/bonus と誤判定していた。結果 crossEligible が ok になり、「1回のクロスでは
// 取れない銘柄を取れる」と出す危険側の誤りになる。一覧ページのバッジとの突き合わせが8件を
// 検出したが、バッジが無い銘柄では警告すら出ないため根本を直した。
//
// 「100株以上」を年数と読まないよう、数字の直後に年/月の単位を必ず要求する。
const HOLDING_PATTERNS = [
  /継続保有期間\s*(\d+)\s*(年|ヶ月|か月|カ月)(?:以上)?/,
  /(\d+)\s*(年|ヶ月|か月|カ月)連続/,
  /(\d+)\s*(年|ヶ月|か月|カ月)以上(?:継続して)?保有/,
];

function parseHolding(text: string): { months: number; raw: string } | null {
  for (const pattern of HOLDING_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;
    const amount = Number(match[1]);
    // rawは画面にそのまま出すので、見出し全体から【】を外したものを使う。部分一致
    // (「2年連続」)だけでは何株を何年持つのか読めない。
    return {
      months: match[2] === '年' ? amount * 12 : amount,
      raw: text.replace(/^[【\s]+/, '').replace(/[】\s]+$/, ''),
    };
  }
  return null;
}

function parseTiers(tableHtml: string): BenefitTier[] {
  const tiers: BenefitTier[] = [];

  for (const row of tableHtml.matchAll(/<tr>\s*<td>([^<]*)<\/td>\s*<td>([\s\S]*?)<\/td>/g)) {
    const sharesMatch = row[1].trim().match(/^([\d,]+)\s*株/);
    // 株数列でない行(「権利確定月」等の説明行)は段階ではない。
    if (!sharesMatch) continue;

    const rawText = row[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    // 選択式(【下記から1点を選択】)は先頭の金額を採る。実データでは選択肢の金額が
    // 揃っているため先頭で足りる(揃っていない銘柄が出たら設計を見直す)。
    const valueMatch = rawText.match(/([\d,]+)\s*円/);

    tiers.push({
      shares: Number(sharesMatch[1].replace(/,/g, '')),
      valueYen: valueMatch ? Number(valueMatch[1].replace(/,/g, '')) : null,
      rawText,
    });
  }

  return tiers;
}

type Token =
  | { kind: 'title'; text: string }
  | { kind: 'holding'; text: string }
  | { kind: 'table'; html: string };

// h3 / stit / table を出現順に並べる。並び順そのものが意味を持つ(stitは直後の表に、
// h3はそれ以降の表に効く)ため、種類ごとに別々に集めてはならない。
function tokenize(section: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /<h3>([\s\S]*?)<\/h3>|<div class="stit">([^<]*)<\/div>|<table[^>]*>([\s\S]*?)<\/table>/g;

  for (let match = pattern.exec(section); match !== null; match = pattern.exec(section)) {
    if (match[1] !== undefined) {
      tokens.push({ kind: 'title', text: match[1].replace(/<[^>]+>/g, '').trim() });
    } else if (match[2] !== undefined) {
      tokens.push({ kind: 'holding', text: match[2].trim() });
    } else {
      tokens.push({ kind: 'table', html: match[3] });
    }
  }

  return tokens;
}

export function parseBenefitDetail(html: string): BenefitGroup[] {
  const section = detailSection(html);
  if (section === null) return [];

  const groups: BenefitGroup[] = [];
  let title: string | null = null;
  let holding: { months: number; raw: string } | null = null;

  for (const token of tokenize(section)) {
    if (token.kind === 'title') {
      // 新しい優待種別に入ったら継続保有条件はリセットする。ノジマのように
      // 「条件なしの表 → 2年以上の表 → 次の種別の条件なしの表」と並ぶため、
      // h3を越えてstitを引き継ぐと条件なしの表を誤って条件付きにしてしまう。
      title = token.text;
      holding = null;
      continue;
    }
    if (token.kind === 'holding') {
      holding = parseHolding(token.text);
      continue;
    }

    const tiers = parseTiers(token.html);
    // 株数段階を1つも含まない表は優待内容の表ではない。
    if (tiers.length === 0) continue;

    groups.push({
      title,
      holdingMonths: holding?.months ?? null,
      holdingRaw: holding?.raw ?? null,
      tiers,
    });
  }

  return groups;
}

export type HoldingKind = 'none' | 'bonus' | 'required' | 'unknown';
export type CrossEligible = 'ok' | 'ng' | 'unknown';

export interface DerivedBenefitScalars {
  requiredShares: number | null;
  holdingKind: HoldingKind;
  holdingMinMonths: number | null;
  crossEligible: CrossEligible;
  minTierValueYen: number | null;
  // 解析の不完全さの理由をカンマ区切りで連結する(例 'duplicate-groups,no-values')。
  // 該当なしはnull。画面で「この銘柄は要確認」と出すために使う。
  benefitParseWarning: string | null;
}

// 一覧ページのバッジだけから見たクロス可否。'chouki'(長期優遇あり)は長期保有で
// 上乗せされるだけなので最低段階はクロスで取れる。バッジなしも条件なしなので取れる。
function crossEligibleFromBadge(listBadge: ListBadge | undefined): CrossEligible {
  if (listBadge === undefined) return 'unknown';
  return listBadge === 'choukinomi' ? 'ng' : 'ok';
}

// requiredShares と minTierValueYen を一意に決める。実データでは同じ株数の段階が
// 複数グループに現れる(鳥羽洋行の100株は「条件なし=1,000円」と「3年以上=2,000円」の
// 両方にある)ため、株数だけで価値を決めてはならない。
function chooseGroup(groups: BenefitGroup[]): { group: BenefitGroup; shares: number } | null {
  // クロスで取れるグループを優先する。1つも無ければ(全グループが継続保有必須)
  // 全グループを候補にして「保有条件を満たせば何株必要か」を示す。
  const unconditional = groups.filter((group) => group.holdingMonths === null);
  const candidates = unconditional.length > 0 ? unconditional : groups;

  const allShares = candidates.flatMap((group) => group.tiers.map((tier) => tier.shares));
  if (allShares.length === 0) return null;
  const shares = Math.min(...allShares);

  // 同じ最小株数を持つグループが複数あれば、継続保有期間が短い方(= 到達しやすい方)を
  // 採り、それも同じなら文書順で先のものを採る。sortは安定なので文書順は保たれる。
  const holders = candidates
    .filter((group) => group.tiers.some((tier) => tier.shares === shares))
    .sort((a, b) => (a.holdingMonths ?? -1) - (b.holdingMonths ?? -1));

  return { group: holders[0], shares };
}

export function deriveBenefitScalars(
  groups: BenefitGroup[],
  listBadge: ListBadge | undefined,
): DerivedBenefitScalars {
  if (groups.length === 0) {
    // 解析できなかった場合だけ一覧ページのバッジに頼る。バッジは保有条件の有無しか
    // 分からないので、必要株数や段階の金額は埋められない。
    return {
      requiredShares: null,
      holdingKind: 'unknown',
      holdingMinMonths: null,
      crossEligible: crossEligibleFromBadge(listBadge),
      minTierValueYen: null,
      benefitParseWarning: 'no-groups',
    };
  }

  const conditional = groups.filter((group) => group.holdingMonths !== null);
  const holdingKind: HoldingKind =
    conditional.length === groups.length ? 'required' : conditional.length > 0 ? 'bonus' : 'none';
  const crossEligible: CrossEligible = holdingKind === 'required' ? 'ng' : 'ok';

  const chosen = chooseGroup(groups);
  const shares = chosen?.shares ?? null;
  const minTierValueYen =
    chosen === null
      ? null
      : (chosen.group.tiers.find((tier) => tier.shares === chosen.shares)?.valueYen ?? null);

  const warnings: string[] = [];

  const groupKeys = groups.map((group) => `${group.title ?? ''}|${group.holdingMonths ?? ''}`);
  if (new Set(groupKeys).size !== groupKeys.length) warnings.push('duplicate-groups');

  if (groups.every((group) => group.tiers.every((tier) => tier.valueYen === null))) {
    warnings.push('no-values');
  }

  const badgeView = crossEligibleFromBadge(listBadge);
  if (badgeView !== 'unknown' && badgeView !== crossEligible) warnings.push('badge-mismatch');

  return {
    requiredShares: shares,
    holdingKind,
    // 全グループが継続保有必須のときだけ「最低どれだけ持つ必要があるか」が意味を持つ。
    // bonusのときは条件なしで取れるので最低保有期間は無い。
    holdingMinMonths:
      holdingKind === 'required' ? Math.min(...conditional.map((group) => group.holdingMonths as number)) : null,
    crossEligible,
    minTierValueYen,
    benefitParseWarning: warnings.length > 0 ? warnings.join(',') : null,
  };
}
