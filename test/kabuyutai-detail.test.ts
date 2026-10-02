import { parseBenefitDetail, deriveBenefitScalars } from '../lambda/shared/kabuyutai-detail';

// 2026-10-01 に実ページから取得した断片。設計書
// docs/superpowers/specs/2026-10-01-yutai-condition-master-design.md の表の
// 期待値と対応する。末尾の「この企業の公式ホームページ」はセクションの終端
// アンカーで、ここより後ろ(サイドバーの他社情報)を拾わないための境界。

// 鳥羽洋行: 条件なしのグループと3年以上のグループ。素直なケース。
const TOBA_HTML = `
<section id="yutai_detail">
<h3>◎緑の募金への寄付金付きオリジナルQUOカード（クオカード）</h3>
<table class="yutai_table">
<tr><td>100株</td><td><b>1,000円</b>相当</td></tr>
<tr><td>500株</td><td><b>2,000円</b>相当</td></tr>
<tr><td>1,000株</td><td><b>3,000円</b>相当</td></tr>
</table>
<div class="stit">【株式継続保有期間3年以上】</div>
<table class="yutai_table">
<tr><td>100株</td><td><b>2,000円</b>相当</td></tr>
<tr><td>500株</td><td><b>4,000円</b>相当</td></tr>
<tr><td>1,000株</td><td><b>6,000円</b>相当</td></tr>
</table>
</section>
<p>この企業の公式ホームページ</p>
<table class="other"><tr><td>999株</td><td><b>99,999円</b>相当</td></tr></table>
`;

// ミライト: 両グループに継続保有条件。選択式で先頭の金額を採る。
const MIRAIT_HTML = `
<section id="yutai_detail">
<h3>◎QUOカードなど（選択式）</h3>
<div class="stit">【株式継続保有期間1年以上】</div>
<table class="yutai_table">
<tr><td>100株</td><td><span class="choice hosoku">【下記から1点を選択】</span><br> （1）<b>1,000円</b>相当<br> （2）<b>1,000円</b>相当<br> （3）<b>1kg</b>（抽選で600人）<br> （4）<b>1,000円</b>相当</td></tr>
<tr><td>1,000株</td><td><span class="choice hosoku">【下記から1点を選択】</span><br> （1）<b>3,000円</b>相当<br> （2）<b>3,000円</b>相当<br> （3）<b>1kg</b>（抽選で50人）<br> （4）<b>3,000円</b>相当</td></tr>
</table>
<div class="stit">【株式継続保有期間3年以上】</div>
<table class="yutai_table">
<tr><td>100株</td><td><span class="choice hosoku">【下記から1点を選択】</span><br> （1）<b>1,000円</b>相当<br> （2）<b>1,000円</b>相当<br> （3）<b>1kg</b>（抽選で600人）<br> （4）<b>1,000円</b>相当</td></tr>
<tr><td>1,000株</td><td><span class="choice hosoku">【下記から1点を選択】</span><br> （1）<b>4,000円</b>相当 <br> （2）<b>4,000円</b>相当<br> （3）<b>5kg</b>（抽選で210人）<br> （4）<b>4,000円</b>相当</td></tr>
</table>
</section>
<p>この企業の公式ホームページ</p>
`;

// マイタケ: 「か月」表記の継続保有条件が1グループだけ。
const MAITAKE_HTML = `
<section id="yutai_detail">
<h3>◎自社製品セット</h3>
<div class="stit">【株式継続保有期間6か月以上】</div>
<table class="yutai_table">
<tr><td>100株</td><td><b>3,000円</b>相当</td></tr>
<tr><td>300株</td><td><b>5,000円</b>相当</td></tr>
<tr><td>1,000株</td><td><b>7,000円</b>相当</td></tr>
</table>
</section>
<p>この企業の公式ホームページ</p>
`;

// 第一興商: 単元100株だが優待は200株から。必要株数が正確値で取れることの証拠。
const DKKARAOKE_HTML = `
<section id="yutai_detail">
<h3>◎「ビッグエコー」のほか、グループ店舗で使える優待利用割引カードなど（×年2回）</h3>
<table class="yutai_table">
<tr><td>200株</td><td><span class="choice hosoku">【下記から1点を選択】</span><br> （1）<b>5,000円</b>相当<br> （2）<b>1枚</b></td></tr>
<tr><td>2,000株</td><td><span class="choice hosoku">【下記から1点を選択】</span><br> （1）<b>12,500円</b>相当<br> （2）<b>2枚</b></td></tr>
</table>
</section>
<p>この企業の公式ホームページ</p>
`;

// ノジマ: 4種別・7グループ。「ー」(該当なし)が混在し、同じ(種別,保有条件)の
// グループが重複して現れる(年2回の中間/期末の区別がこのパーサーでは落ちる)。
const NOJIMA_HTML = `
<section id="yutai_detail">
<h3>◎「ノジマ」で使える優待買物割引券（×年2回）</h3>
<table class="yutai_table">
<tr><td>300株</td><td><b>15,000円</b>相当</td></tr>
<tr><td>1,000株</td><td><b>50,000円</b>相当</td></tr>
</table>
<h3>◎ノジマポイント（1ポイント1円相当）</h3>
<table class="yutai_table">
<tr><td>10,000株</td><td><b>30,000円</b>相当</td></tr>
</table>
<div class="stit">【株式継続保有期間2年以上】</div>
<table class="yutai_table">
<tr><td>300株</td><td>ー</td></tr>
<tr><td>1,000株</td><td><b>10,000円</b>相当</td></tr>
</table>
<table class="yutai_table">
<tr><td>300株</td><td><b>5,000円</b>相当</td></tr>
<tr><td>1,000株</td><td><b>10,000円</b>相当</td></tr>
</table>
<h3>◎オリジナル商品</h3>
<table class="yutai_table">
<tr><td>3,000株</td><td><b>5,000円</b>相当</td></tr>
</table>
</section>
<p>この企業の公式ホームページ</p>
`;

test('parses a benefit with one unconditional group and one long-holding group', () => {
  const groups = parseBenefitDetail(TOBA_HTML);
  expect(groups).toHaveLength(2);
  expect(groups[0].title).toBe('◎緑の募金への寄付金付きオリジナルQUOカード（クオカード）');
  expect(groups[0].holdingMonths).toBeNull();
  expect(groups[0].holdingRaw).toBeNull();
  expect(groups[0].tiers).toEqual([
    { shares: 100, valueYen: 1000, rawText: '1,000円 相当' },
    { shares: 500, valueYen: 2000, rawText: '2,000円 相当' },
    { shares: 1000, valueYen: 3000, rawText: '3,000円 相当' },
  ]);
  // h3は引き継がれ、stitは次の表にだけ効く
  expect(groups[1].title).toBe(groups[0].title);
  expect(groups[1].holdingMonths).toBe(36);
  expect(groups[1].holdingRaw).toBe('株式継続保有期間3年以上');
  expect(groups[1].tiers[0].valueYen).toBe(2000);
});

test('stops at the section end anchor and ignores tables that follow it', () => {
  // 終端アンカーより後ろの999株の表を拾っていないこと
  const allShares = parseBenefitDetail(TOBA_HTML).flatMap((g) => g.tiers.map((t) => t.shares));
  expect(allShares).not.toContain(999);
});

test('takes the first yen amount from a selection-style benefit', () => {
  const groups = parseBenefitDetail(MIRAIT_HTML);
  expect(groups).toHaveLength(2);
  expect(groups.map((g) => g.holdingMonths)).toEqual([12, 36]);
  expect(groups[0].tiers[0].valueYen).toBe(1000);
  expect(groups[1].tiers[1].valueYen).toBe(4000);
  // 原文は表示の忠実性のため保持する
  expect(groups[0].tiers[0].rawText).toContain('【下記から1点を選択】');
});

test('reads a holding period written in months', () => {
  const groups = parseBenefitDetail(MAITAKE_HTML);
  expect(groups).toHaveLength(1);
  expect(groups[0].holdingMonths).toBe(6);
  expect(groups[0].holdingRaw).toBe('株式継続保有期間6か月以上');
});

test('reads a minimum tier above one trading unit', () => {
  const groups = parseBenefitDetail(DKKARAOKE_HTML);
  expect(groups).toHaveLength(1);
  expect(groups[0].holdingMonths).toBeNull();
  expect(groups[0].tiers.map((t) => t.shares)).toEqual([200, 2000]);
  expect(groups[0].tiers[0].valueYen).toBe(5000);
});

test('parses multiple benefit types and resets the holding condition at each h3', () => {
  const groups = parseBenefitDetail(NOJIMA_HTML);
  expect(groups).toHaveLength(5);
  expect(groups.map((g) => g.holdingMonths)).toEqual([null, null, 24, 24, null]);
  expect(groups[1].title).toBe('◎ノジマポイント（1ポイント1円相当）');
  // h3の直後の表は、前のh3配下のstitを引き継がない
  expect(groups[1].holdingMonths).toBeNull();
  expect(groups[4].title).toBe('◎オリジナル商品');
});

test('records a dash value as null while keeping its raw text', () => {
  const groups = parseBenefitDetail(NOJIMA_HTML);
  const dashTier = groups[2].tiers[0];
  expect(dashTier.shares).toBe(300);
  expect(dashTier.valueYen).toBeNull();
  expect(dashTier.rawText).toBe('ー');
});

test('returns an empty array when the yutai_detail section is absent', () => {
  expect(parseBenefitDetail('<html><body><p>no detail here</p></body></html>')).toEqual([]);
});

test('skips tables that have no share rows', () => {
  const html = `
<section id="yutai_detail">
<h3>◎説明だけの表</h3>
<table><tr><td>権利確定月</td><td>3月</td></tr></table>
</section>
<p>この企業の公式ホームページ</p>
`;
  expect(parseBenefitDetail(html)).toEqual([]);
});

test('derives bonus kind when an unconditional group sits alongside a long-holding one', () => {
  const derived = deriveBenefitScalars(parseBenefitDetail(TOBA_HTML), 'chouki');
  expect(derived).toEqual({
    requiredShares: 100,
    holdingKind: 'bonus',
    holdingMinMonths: null,
    crossEligible: 'ok',
    minTierValueYen: 1000,
    benefitParseWarning: null,
  });
});

test('picks the easiest holding group when several share the minimum tier', () => {
  // ミライトは1年以上と3年以上の両方に100株段階がある。クロス後に実際に
  // 到達しやすいのは1年以上の方なので、その価値(1,000円)を採る。
  const derived = deriveBenefitScalars(parseBenefitDetail(MIRAIT_HTML), 'choukinomi');
  expect(derived.requiredShares).toBe(100);
  expect(derived.holdingKind).toBe('required');
  expect(derived.holdingMinMonths).toBe(12);
  expect(derived.crossEligible).toBe('ng');
  expect(derived.minTierValueYen).toBe(1000);
  expect(derived.benefitParseWarning).toBeNull();
});

test('derives required kind from a single long-holding group', () => {
  const derived = deriveBenefitScalars(parseBenefitDetail(MAITAKE_HTML), 'choukinomi');
  expect(derived.holdingKind).toBe('required');
  expect(derived.holdingMinMonths).toBe(6);
  expect(derived.crossEligible).toBe('ng');
  expect(derived.requiredShares).toBe(100);
  expect(derived.minTierValueYen).toBe(3000);
});

test('derives none kind and an above-unit required share count', () => {
  const derived = deriveBenefitScalars(parseBenefitDetail(DKKARAOKE_HTML), null);
  expect(derived.holdingKind).toBe('none');
  expect(derived.holdingMinMonths).toBeNull();
  expect(derived.crossEligible).toBe('ok');
  expect(derived.requiredShares).toBe(200);
  expect(derived.minTierValueYen).toBe(5000);
  expect(derived.benefitParseWarning).toBeNull();
});

test('ignores long-holding groups when choosing the required share count', () => {
  // ノジマの条件なしグループは300株・10,000株・3,000株。2年以上グループの
  // 300株に引きずられず、条件なしの最小(300株=15,000円)を採る。
  const derived = deriveBenefitScalars(parseBenefitDetail(NOJIMA_HTML), 'chouki');
  expect(derived.requiredShares).toBe(300);
  expect(derived.holdingKind).toBe('bonus');
  expect(derived.crossEligible).toBe('ok');
  expect(derived.minTierValueYen).toBe(15000);
});

test('warns when the same benefit type and holding period appear twice', () => {
  // ノジマは「ポイント/2年以上」のグループが2つ現れる(年2回の中間/期末の
  // 区別がパーサーで落ちている)。表示用途では許容するが、黙って見過ごさない。
  const derived = deriveBenefitScalars(parseBenefitDetail(NOJIMA_HTML), 'chouki');
  expect(derived.benefitParseWarning).toBe('duplicate-groups');
});

test('warns and falls back to the badge when nothing could be parsed', () => {
  expect(deriveBenefitScalars([], 'choukinomi')).toEqual({
    requiredShares: null,
    holdingKind: 'unknown',
    holdingMinMonths: null,
    crossEligible: 'ng',
    minTierValueYen: null,
    benefitParseWarning: 'no-groups',
  });
  expect(deriveBenefitScalars([], 'chouki').crossEligible).toBe('ok');
  expect(deriveBenefitScalars([], null).crossEligible).toBe('ok');
  // バッジ自体が未取得(この変更より前に同期された行)なら判定できない
  expect(deriveBenefitScalars([], undefined).crossEligible).toBe('unknown');
});

test('warns when no tier anywhere has a readable yen amount', () => {
  const groups = [
    { title: '◎自社製品', holdingMonths: null, holdingRaw: null, tiers: [{ shares: 100, valueYen: null, rawText: '自社製品1点' }] },
  ];
  const derived = deriveBenefitScalars(groups, null);
  expect(derived.benefitParseWarning).toBe('no-values');
  expect(derived.minTierValueYen).toBeNull();
  // 金額が読めなくても必要株数は確定できる
  expect(derived.requiredShares).toBe(100);
});

test('warns when the badge disagrees with the parsed holding conditions', () => {
  // バッジは「長期優待のみ」(=クロス不可)だが、個別ページには条件なしの
  // グループがある。どちらかの解析が壊れているので可視化する。
  const derived = deriveBenefitScalars(parseBenefitDetail(DKKARAOKE_HTML), 'choukinomi');
  expect(derived.benefitParseWarning).toBe('badge-mismatch');
  // 食い違ったときは保有条件の原文を読んでいる個別ページ側を採る
  expect(derived.crossEligible).toBe('ok');
});

// 継続保有条件の表記ゆれ。「以上」を伴わない書き方と、「ヶ月」「カ月」の2つの
// 異字体は現在のfixture(「年」「か月」)に現れないため、個別に固定しておく。
// 「以上」をrawに含める扱いは、このブランチで一度直した箇所でもある。
test('reads a holding period written without 以上', () => {
  const html = `
<section id="yutai_detail">
<h3>◎自社製品</h3>
<div class="stit">【株式継続保有期間3年】</div>
<table class="yutai_table"><tr><td>100株</td><td><b>1,000円</b>相当</td></tr></table>
</section>
<p>この企業の公式ホームページ</p>
`;
  const groups = parseBenefitDetail(html);
  expect(groups).toHaveLength(1);
  expect(groups[0].holdingMonths).toBe(36);
  // 「以上」が無い原文には「以上」を足さない(原文のまま残す)
  expect(groups[0].holdingRaw).toBe('株式継続保有期間3年');
});

test('reads the ヶ月 and カ月 spellings of a holding period', () => {
  const sectionWith = (stit: string) => `
<section id="yutai_detail">
<h3>◎自社製品</h3>
<div class="stit">${stit}</div>
<table class="yutai_table"><tr><td>100株</td><td><b>1,000円</b>相当</td></tr></table>
</section>
<p>この企業の公式ホームページ</p>
`;

  const kyaGetsu = parseBenefitDetail(sectionWith('【株式継続保有期間6ヶ月以上】'));
  expect(kyaGetsu[0].holdingMonths).toBe(6);
  expect(kyaGetsu[0].holdingRaw).toBe('株式継続保有期間6ヶ月以上');

  const kaGetsu = parseBenefitDetail(sectionWith('【株式継続保有期間12カ月以上】'));
  expect(kaGetsu[0].holdingMonths).toBe(12);
  expect(kaGetsu[0].holdingRaw).toBe('株式継続保有期間12カ月以上');
});

// バッジと個別ページの突き合わせは「1回のクロスで優待が取れるか」という本機能の
// 中心的な問いに対する唯一の相互チェックなので、groupsが空の場合だけでなく
// 解析できた場合についても4通りのバッジを固定する。
test('cross-checks the badge against parsed groups for all four badge values', () => {
  // マイタケは全グループが継続保有必須 = クロス不可。
  const requiredGroups = parseBenefitDetail(MAITAKE_HTML);

  // 「長期優遇あり」バッジはクロス可を意味するので、解析結果(不可)と食い違う。
  const chouki = deriveBenefitScalars(requiredGroups, 'chouki');
  expect(chouki.benefitParseWarning).toBe('badge-mismatch');
  // 食い違っても採用するのは個別ページ側(保有条件の原文を読んでいる)。
  expect(chouki.crossEligible).toBe('ng');
  expect(chouki.holdingKind).toBe('required');

  // バッジなし(継続保有条件なし)も同じ理由で食い違う。
  expect(deriveBenefitScalars(requiredGroups, null).benefitParseWarning).toBe('badge-mismatch');

  // 「長期優待のみ」は解析結果と一致するので警告は出ない。
  expect(deriveBenefitScalars(requiredGroups, 'choukinomi').benefitParseWarning).toBeNull();

  // バッジ自体が未取得(undefined)なら突き合わせられないので警告は出ない。
  expect(deriveBenefitScalars(requiredGroups, undefined).benefitParseWarning).toBeNull();

  // 逆向き: 条件なしで解析できた銘柄は、クロス可を意味するバッジと一致する。
  const unconditionalGroups = parseBenefitDetail(DKKARAOKE_HTML);
  expect(deriveBenefitScalars(unconditionalGroups, 'chouki').benefitParseWarning).toBeNull();
  expect(deriveBenefitScalars(unconditionalGroups, null).benefitParseWarning).toBeNull();
  expect(deriveBenefitScalars(unconditionalGroups, undefined).benefitParseWarning).toBeNull();
  expect(deriveBenefitScalars(unconditionalGroups, 'choukinomi').benefitParseWarning).toBe('badge-mismatch');
});

test('joins several warnings with a comma', () => {
  const groups = [
    { title: '◎A', holdingMonths: 24, holdingRaw: '継続保有期間2年以上', tiers: [{ shares: 100, valueYen: null, rawText: 'ー' }] },
    { title: '◎A', holdingMonths: 24, holdingRaw: '継続保有期間2年以上', tiers: [{ shares: 100, valueYen: null, rawText: 'ー' }] },
  ];
  expect(deriveBenefitScalars(groups, null).benefitParseWarning).toBe('duplicate-groups,no-values,badge-mismatch');
});

// 2026-10-02 の本番初回取得で判明: kabuyutai.com の継続保有条件は「継続保有期間N年以上」
// だけではない。NTT(9432)は【2年連続で100株以上を保有】、三井不動産(8801)は
// 【通常優待の取得条件を3年連続で満たす】と書く。リテラル「継続保有期間」を要求していた
// ため条件を取りこぼし、holdingKind=none/bonus → crossEligible=ok と誤判定していた
// (= 1回のクロスで取れないのに「取れる」と出す危険側の誤り)。一覧ページのバッジとの
// 突き合わせが8件検出したが、バッジが無い銘柄では警告すら出ないため根本を直す。
const NTT_HTML = `
<section id="yutai_detail">
<h3>◎dポイント（1ポイント1円相当）</h3>
<div class="stit">【2年連続で100株以上を保有】</div>
<table><tr><td>100株</td><td><b>1,500</b>ポイント</td></tr></table>
<div class="stit">【5年連続で100株以上を保有】</div>
<table><tr><td>100株</td><td><b>3,000</b>ポイント</td></tr></table>
</section>
<p>この企業の公式ホームページ</p>
`;

const MITSUI_HTML = `
<section id="yutai_detail">
<h3>◎三井ショッピングパークポイント（通常優待）</h3>
<div class="stit">【株式継続保有期間1年以上】</div>
<table><tr><td>100株</td><td><b>1,000円</b>相当</td></tr></table>
<h3>◎三井ショッピングパークポイント（追加贈呈）</h3>
<div class="stit">【通常優待の取得条件を3年連続で満たす】</div>
<table><tr><td>100株</td><td><b>1,000円</b>相当を追加贈呈</td></tr></table>
<div class="stit">【通常優待の取得条件を5年連続で満たす】</div>
<table><tr><td>100株</td><td><b>2,000円</b>相当を追加贈呈</td></tr></table>
</section>
<p>この企業の公式ホームページ</p>
`;

test('reads a holding condition written as N年連続 rather than 継続保有期間', () => {
  const groups = parseBenefitDetail(NTT_HTML);
  expect(groups).toHaveLength(2);
  expect(groups.map((g) => g.holdingMonths)).toEqual([24, 60]);
  // 原文は株数の条件まで含めて出す(「2年連続」だけでは画面で意味が通らない)
  expect(groups[0].holdingRaw).toBe('2年連続で100株以上を保有');
});

test('treats every group as conditional when all conditions use the 連続 wording', () => {
  // NTTはバッジが choukinomi(長期優待のみ)。全グループに条件があるので required。
  const derived = deriveBenefitScalars(parseBenefitDetail(NTT_HTML), 'choukinomi');
  expect(derived.holdingKind).toBe('required');
  expect(derived.crossEligible).toBe('ng');
  expect(derived.holdingMinMonths).toBe(24);
  // バッジと一致するので mismatch は立たない。NTTの優待は「1,500ポイント」で円表記が
  // 無いため no-values だけが立つ(円に換算できない優待は想定内の分類)。
  expect(derived.benefitParseWarning).toBe('no-values');
});

test('reads a holding condition written as 取得条件をN年連続で満たす', () => {
  const groups = parseBenefitDetail(MITSUI_HTML);
  expect(groups).toHaveLength(3);
  expect(groups.map((g) => g.holdingMonths)).toEqual([12, 36, 60]);
  expect(groups[0].holdingRaw).toBe('株式継続保有期間1年以上');
  expect(groups[1].holdingRaw).toBe('通常優待の取得条件を3年連続で満たす');
});

test('derives required when a mix of 継続保有期間 and 連続 wordings all impose conditions', () => {
  const derived = deriveBenefitScalars(parseBenefitDetail(MITSUI_HTML), 'choukinomi');
  expect(derived.holdingKind).toBe('required');
  expect(derived.crossEligible).toBe('ng');
  expect(derived.holdingMinMonths).toBe(12);
  expect(derived.benefitParseWarning).toBeNull();
});

test('does not mistake a share count for a holding period', () => {
  // 【100株以上】だけの見出しは保有期間ではない。株数を年数と読んだら致命的。
  const html = `
<section id="yutai_detail">
<h3>◎QUOカード</h3>
<div class="stit">【100株以上】</div>
<table><tr><td>100株</td><td><b>1,000円</b>相当</td></tr></table>
</section>
<p>この企業の公式ホームページ</p>
`;
  expect(parseBenefitDetail(html)[0].holdingMonths).toBeNull();
});

test('reads 継続保有期 with the 間 missing, as kabuyutai writes it on some pages', () => {
  // カメイ(8037)の実ページは【株式継続保有期6か月以上】と書く(「間」が無い)。
  // 「間」を要求していたため条件を落とし、kind=none → crossEligible=ok と誤判定していた。
  const html = `
<section id="yutai_detail">
<h3>◎QUOカードなど</h3>
<div class="stit">【株式継続保有期6か月以上】</div>
<table><tr><td>100株</td><td><b>500円</b>相当</td></tr></table>
<div class="stit">【株式継続保有期1年以上】</div>
<table><tr><td>100株</td><td><b>1,000円</b>相当</td></tr></table>
</section>
<p>この企業の公式ホームページ</p>
`;
  const groups = parseBenefitDetail(html);
  expect(groups.map((g) => g.holdingMonths)).toEqual([6, 12]);
  expect(groups[0].holdingRaw).toBe('株式継続保有期6か月以上');
  const derived = deriveBenefitScalars(groups, 'choukinomi');
  expect(derived.holdingKind).toBe('required');
  expect(derived.crossEligible).toBe('ng');
  expect(derived.benefitParseWarning).toBeNull();
});
