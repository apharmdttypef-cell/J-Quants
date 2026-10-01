# 優待条件マスタと一覧・検索の改善 設計書

作成日: 2026-10-01

## 目的

優待クロスの可否とコストを一覧画面だけで判断できるようにする。現状の一覧は
「優待価値」と「最大逆日歩」しか持たないため、以下が分からない。

- 何株買えばよいのか(単元100株では足りない銘柄がある)
- そもそも1回のクロスで取れるのか(継続保有が必須の銘柄はクロス不可)
- 前回いくら取られたのか(最大逆日歩は理論上限で、実績とは桁が違う)
- いくら資金を用意すればよいのか

あわせて、更新頻度の低い優待情報の取得と、日次で変わる逆日歩計算を
ジョブとして分離する。

## 要求

1. **優待条件マスタ**: 必要株数・継続保有条件・「1回のクロスで取れるか」判定
2. **一覧表示項目追加**: 必要株数、クロス可否、前回の逆日歩と概算コスト
3. **検索の絞り込み追加**: 株価・必要資金
4. **ジョブ分割**: 優待情報の更新(低頻度・手動+TDnet検知)と逆日歩計算(日次)を分離
5. **株数段階別の優待条件**: 100株→1,000円、500株→2,000円… の段階構造も登録する

依存関係があるため実装順は 4 → 1/5 → 2 → 3。

---

## データ取得方法

### 選択した方式: kabuyutai.com の個別ページをスクレイピング

J-Quants API に優待条件データは無い(`/equities/master` にも `/fins/summary` にも
優待の必要株数・継続保有条件は含まれない)。選択肢を比較した。

| 方式 | 初期コスト | 精度 | 追随性 | 判定 |
|---|---|---|---|---|
| **kabuyutai.com 個別ページ** | 1,642銘柄×1リクエスト ≒ 33分 | 段階表を構造化でき、必要株数は正確値 | TDnet検知で更新可 | **採用** |
| 手入力 | 1,642銘柄の目視入力 | 最高 | 人手が続かない | 却下 |
| 各社IR/TDnet本文の直接解析 | PDF解析が必要 | 表記が社ごとにばらばら | — | 却下 |
| 一覧ページの必要投資金額から逆算(現行) | 追加ゼロ | **不正確**(株価変動で結果が変わる) | — | 現行方式。廃止する |

現行の `estimateRequiredShares`(`minInvestment ÷ 株価` を100株単位に丸める)は
株価が動くと結果が変わる推定値で、実測で不安定と分かっている
(`docs/superpowers/notes/2026-09-04-kabuyutai-required-shares-mismatch.md`)。
個別ページは必要株数を正確値で持つため、これを置き換える。

### 取得元の構造(実測で確認済み)

**一覧ページ**(既存の `yutai-master-sync-batch` が取得している)から2つの情報が
**追加リクエストなしで**得られる。

1. **個別ページURL**: 銘柄ブロックの `<p><a href="..." class="kigyoumei">` の href。
   URL を推測する必要がない。
2. **クロス可否バッジ**:
   - `<div class="chouki tooltip">長期優遇あり` — 長期保有で**上乗せ**。クロス可
   - `<div class="chouki choukinomi tooltip">長期優待のみ` — 長期保有者**限定**。クロス不可
   - バッジ無し — 継続保有条件なし。クロス可

   実測: 1,642銘柄中821銘柄(50%)にバッジあり、うち「のみ」は328銘柄(20%)。

**個別ページ**の `<section id="yutai_detail">` 内に、出現順で以下が並ぶ。

- `<h3>` — 優待種別の見出し(例「◎緑の募金への寄付金付きオリジナルQUOカード」)
- `<div class="stit">【株式継続保有期間3年以上】</div>` — その後の表に効く保有条件
- `<tr><td>100株</td><td><b>1,000円</b>相当</td></tr>` — 株数段階の表

5銘柄で実測した結果:

| 銘柄 | グループ数 | 最小株数 | 特徴 |
|---|---|---|---|
| 7472 鳥羽洋行 | 2 | 100 | 条件なし + 3年以上。素直なケース |
| 1417 ミライト | 2 | 100 | 全グループに保有条件。選択式`【下記から1点を選択】` |
| 1375 マイタケ | 1 | 100 | 6か月以上のみ |
| 7458 第一興商 | 1 | **200** | 単元100株だが優待は200株。**正確値で取得できた** |
| 7419 ノジマ | 7 | **300** | 4種別×保有条件なし/2年/5年。`ー`(該当なし)混在 |

### セクション境界の確定方法

`id="yutai_detail"` を起点に、後続の安定アンカー
(`この企業の公式ホームページ` / `の優待権利確定日情報` / `id="yutai_kijunbi"`)の
最初に現れたものまでを対象領域とする。

開発中、終端候補に `<div class="comment` を含めたところ、段階表(文書の約74%の位置)より
手前でマッチして領域が切れ、全銘柄でパース結果0件になった。終端候補は段階表より
必ず後ろに現れるものだけに限る。

### レート制限

既存の `KABUYUTAI_REQUEST_INTERVAL_MS`(既定1,000ms)をそのまま使う。
1リクエスト/秒を超えてはならない。

---

## データモデル

### 新規フィールド(JQuantsYutaiMaster、PK=ticker)

テーブルは追加しない。既存の優待マスタ行に属性を足す。

#### 生データ(個別ページのパース結果をそのまま保持)

```ts
interface BenefitTier {
  shares: number;           // 100, 500, 1000 …
  valueYen: number | null;  // 金額が読めない場合 null(「ー」「自社製品」等)
  rawText: string;          // 表示の忠実性のため原文を必ず保持
}

interface BenefitGroup {
  title: string | null;        // <h3> の優待種別。取れなければ null
  holdingMonths: number | null; // 継続保有条件の月数。条件なしは null
  holdingRaw: string | null;    // 「継続保有期間3年以上」等の原文
  tiers: BenefitTier[];
}
```

`benefitGroups: BenefitGroup[]` として保存する。ノジマ(7グループ×最大4段階)でも
数KBで、DynamoDB の400KB制限に対して十分小さい。

#### 導出スカラー(非正規化して併存させる)

`benefitGroups` から機械的に導出できるが、API が絞り込みとソートに使うため
行に書き出す。導出ロジックは5銘柄で検証済み。

| フィールド | 型 | 導出規則 |
|---|---|---|
| `requiredShares` | `number \| null` | クロス可能なグループ(`holdingMonths === null`)の最小 `shares`。1つも無ければ全グループの最小 |
| `holdingKind` | `'none' \| 'bonus' \| 'required' \| 'unknown'` | 条件なしグループのみ→`none`、条件なしと条件付き両方→`bonus`、全て条件付き→`required`、パース失敗→`unknown` |
| `holdingMinMonths` | `number \| null` | `holdingKind === 'required'` のときのみ、全グループの `holdingMonths` の最小。それ以外は `null` |
| `crossEligible` | `'ok' \| 'ng' \| 'unknown'` | `holdingKind` が `none`/`bonus` → `ok`、`required` → `ng`。`unknown`(パース失敗)のときは一覧ページのバッジにフォールバックする |
| `minTierValueYen` | `number \| null` | `requiredShares` を導出したグループの、その株数の段階の `valueYen` |

`minTierValueYen` は**株数だけで決めてはならない**。鳥羽洋行は100株の段階が
「条件なし→1,000円」と「3年以上→2,000円」の2グループに現れる。クロスで実際に
得られるのは前者なので、`requiredShares` を導出したのと同じグループから取る。

**グループ選択の規則**(実データで同数の段階が複数グループに現れるため、
一意に決まるよう明文化する):

1. 候補 = `holdingMonths === null` のグループ。1つも無ければ全グループ
2. `requiredShares` = 候補の全段階の `shares` の最小値
3. 候補のうち `requiredShares` の段階を持つものから、`holdingMonths` が小さい順
   (`null` を最小とする)、同じなら文書順で先のものを選ぶ
4. `minTierValueYen` = そのグループの `requiredShares` 段階の `valueYen`

ミライト(1417)は1年以上と3年以上の両グループに100株段階があるため、この規則で
1年以上のグループ(1,000円)が選ばれる。

一覧ページには最小段階だけを出し、段階表の全体は詳細ページに置く。

#### 取得状態

| フィールド | 型 | 用途 |
|---|---|---|
| `detailUrl` | `string \| null` | 一覧ページの href。個別ページ取得に使う |
| `listBadge` | `'chouki' \| 'choukinomi' \| null` | 一覧ページのバッジ。個別ページが取れない間の暫定判定に使う |
| `conditionCheckedAt` | `string \| null` | 個別ページを最後に取得した日(`YYYY-MM-DD`)。再開とクールダウンの基準 |
| `benefitParseWarning` | `string \| null` | パースの不完全さを可視化する(下記) |

#### 既知の不完全さ

ノジマで、同じ種別・同じ保有条件のグループが重複して現れる(年2回の中間/期末の
区別がパーサーで落ちている)。表示用途では許容するが、黙って見過ごさないために
以下を検出したら `benefitParseWarning` に理由を入れる。

- グループが0件 → `"no-groups"`
- 同一 `(title, holdingMonths)` のグループが複数 → `"duplicate-groups"`
- `valueYen` が全段階で `null` → `"no-values"`

複数該当する場合はカンマ区切りで連結する(例 `"duplicate-groups,no-values"`)。
該当なしは `null`。

さらに、一覧ページのバッジからも `crossEligible` 相当が決まる
(`chouki`→`ok`、`choukinomi`→`ng`、バッジ無し→`ok`)。個別ページから導いた
`crossEligible` と食い違う場合は `"badge-mismatch"` として記録する。
両方を持つことで、どちらかの解析が壊れたときに気付ける。
食い違ったときは個別ページ側を採用する(保有条件の原文を実際に読んでいるため)。

### 逆日歩の実績(日次バッチが書き込む)

`JQuantsGyakuhibuActual`(PK=ticker, SK=rightsDate)から2つ引く。
API のリクエストごとに1,642回 Query するのは、`yutai-risk-precompute-batch` が
解消したはずのコスト構造に戻ることになるので、日次バッチで行に書き込む。

| フィールド | 内容 |
|---|---|
| `lastGyakuhibu` | 直近の権利日の実績 |
| `sameMonthLastYearGyakuhibu` | 次回権利日と同じ月の、前年の実績 |

どちらも `{ rightsDate, avgRate, days, perShareRate, cost } \| null`。

**コストの再計算**: `JQuantsGyakuhibuActual.totalAmount` は記録当時の
`unitShares` を掛けた値なので、必要株数が変わると意味が合わなくなる。
`avgRate`(1株1日あたり料率)と `days` は株数に依存しないため、

```
perShareRate = avgRate × days
cost = perShareRate × requiredShares
```

で必要株数ベースに再計算する。`requiredShares` が `null` のときは
`unitShares` で代替し、その旨を画面に出す。

### 廃止するもの

- `yutai-risk-precompute-batch` の `estimateRequiredShares` — `requiredShares` の
  バックフィル完了後に削除する
- 同バッチが `unitShares` を**上書きするのをやめる**。`unitShares` は
  単元株数(100株固定)の意味に戻し、必要株数は `requiredShares` が持つ。
  現在この上書きにより、第一興商の `unitShares` は 200 になっている

---

## ジョブ構成

### 現状

| ジョブ | 契機 | やっていること |
|---|---|---|
| `yutai-master-sync-batch` | 手動 | 一覧ページ12ヶ月分 → マスタ upsert |
| `yutai-tdnet-watch-batch` | 週次(月21:00 JST) | TDnet開示検知 → 該当銘柄を再 sync |
| `yutai-risk-precompute-batch` | 日次(18:20 JST) | リスク判定の事前計算 |

### 変更後

優待情報の取得(低頻度)と逆日歩計算(日次)を分離する。

| ジョブ | 契機 | 責務 |
|---|---|---|
| `yutai-master-sync-batch` | 手動 | 一覧ページ → マスタ upsert。**`detailUrl`/`listBadge` も保存する** |
| **`yutai-detail-sync-batch`**(新規) | Step Functions 経由・手動 | 個別ページ → `benefitGroups` と導出スカラー |
| `yutai-tdnet-watch-batch` | 週次 | TDnet検知 → 一覧再 sync + **`conditionCheckedAt` を REMOVE する**(次回の個別ページ再取得を促す) |
| `yutai-risk-precompute-batch` | 日次 | リスク判定 + **前回逆日歩の集計**。`unitShares` は書かない |

TDnet 検知時に `conditionCheckedAt` を消すだけにするのは、検知ハンドラの中で
個別ページを同期取得すると、多数の銘柄がヒットした週に14分のタイムアウトに
近づくため。実際の再取得は次の detail-sync に任せる。

### yutai-detail-sync-batch の設計

**EventBridge スケジュールは持たない**。優待情報は銘柄あたり年1回も変わらないため、
初回構築時と取りこぼし確認時に手動で Step Functions を起動する運用にする
(`yutai-master-sync-batch` と同じ扱い)。日次の変更追随は TDnet 検知が担う。

**1回の呼び出しで処理する対象**: `conditionCheckedAt` が未設定、または
クールダウン(既定90日)より古い行。`MAX_DETAIL_FETCHES_PER_RUN`(既定300)で上限を切る。
これは `gyakuhibu-history-batch` の「1回あたり上限 + `checkedAt` クールダウンで再開」
パターンをそのまま踏襲する。

上限300は最大バケット(3000台、274件)より大きいので、Step Functions 経由では
実際には発動しない。`codePrefix` を省略した全銘柄の手動実行と、将来バケットが
育ったときの安全弁として意味を持つ。発動した場合は残りが次回実行に持ち越される。

**入力**: `{ codePrefix?: string, tickers?: string[], maxFetches?: number }`

- `codePrefix` — `'1'`〜`'9'`。Step Functions の Map が渡す
- `tickers` — 特定銘柄だけを処理する単一銘柄モード。デバッグと個別修正用。
  指定された銘柄は `conditionCheckedAt` のクールダウンを**無視して必ず取得する**
  (直したパーサーを1銘柄で即座に確かめるための口なので、スキップされては困る)
- どちらも省略時は全銘柄が対象

**実行結果のログ**: 1回の呼び出しの最後に、取得件数・スキップ件数・失敗件数と、
`benefitParseWarning` が立った銘柄を理由ごとに集計して1行で出す。移行手順3の
「取りこぼしの評価」はこのログを読んで行う。

**Step Functions による分割**

1,642銘柄を1リクエスト/秒で直列処理すると約33分かかり、Lambda の15分制限を超える。
銘柄コードの先頭1桁でバケットに分ける(実測分布)。

| バケット | 件数 | 推定所要 |
|---|---|---|
| 1000台 | 54 | 1.1分 |
| 2000台 | 204 | 4.1分 |
| 3000台 | 274 | 5.5分 |
| 4000台 | 186 | 3.7分 |
| 5000台 | 96 | 1.9分 |
| 6000台 | 141 | 2.8分 |
| 7000台 | 269 | 5.4分 |
| 8000台 | 184 | 3.7分 |
| 9000台 | 234 | 4.7分 |

最大バケットは5.5分で、15分制限に対して余裕がある。

**`maxConcurrency: 1` は必須**。並列にすると kabuyutai.com へ秒9リクエストを
送ることになり、各 Lambda 内の1リクエスト/秒ガードが無意味になる。
Map は「15分制限を回避するための分割」であって並列化ではない。

各バケットに Retry(`Lambda.ServiceException`/`Lambda.TooManyRequestsException`/
`States.Timeout`、3回、指数バックオフ)を付ける。`conditionCheckedAt` により
リトライは冪等で、成功済みの銘柄は再取得されない。

`ResultPath: null` を付けてバケットの戻り値を捨てる(Step Functions の
ペイロード上限にカウントされないようにする)。

---

## API 変更

### GET /yutai

レスポンス項目を追加する(既存項目は変えない)。

```ts
interface YutaiListItem {
  // 既存
  ticker: string;
  companyName?: string;
  content: string;
  value: number | null;
  rightsDate: string | null;
  riskStatus: YutaiRiskStatus;
  maxGyakuhibu: number | null;
  // 追加
  unitShares: number;                  // 単元株数(100)
  requiredShares: number | null;       // 優待に必要な株数
  crossEligible: 'ok' | 'ng' | 'unknown';
  holdingKind: 'none' | 'bonus' | 'required' | 'unknown';
  holdingMinMonths: number | null;
  minTierValueYen: number | null;
  closePrice: number | null;
  requiredInvestment: number | null;   // closePrice × requiredShares
  lastGyakuhibu: GyakuhibuActualRef | null;
  sameMonthLastYearGyakuhibu: GyakuhibuActualRef | null;
}

interface GyakuhibuActualRef {
  rightsDate: string;
  avgRate: number;
  days: number;
  cost: number;        // avgRate × days × requiredShares
  basedOnUnitShares: boolean; // requiredShares が無く unitShares で代替した
}
```

クエリパラメータを追加する。既存の `keyword`/`rightsDateFrom`/`rightsDateTo`/
`riskStatus` と同じくサーバ側で絞り込む。

| パラメータ | 意味 |
|---|---|
| `priceMin` / `priceMax` | `closePrice` の範囲 |
| `investmentMin` / `investmentMax` | `requiredInvestment` の範囲 |
| `crossEligible` | `ok` / `ng` / `unknown` / `all`(既定) |

値が `null` の行は、その項目に範囲指定があるとき除外する
(「株価100万円以下」に株価不明の銘柄を混ぜない)。

### GET /yutai/:ticker

`benefitGroups` をそのまま返す。詳細画面が段階表を描くために使う。

---

## 画面変更

### 優待クロス スクリーニング(`YutaiListPage`)

追加する列:

| 列 | 内容 |
|---|---|
| 必要株数 | `requiredShares` と単元数を併記する(例「200株 (2単元)」)。`unitShares` と異なるとき強調する |
| クロス | `ok`→「可」/`ng`→「長期のみ」/`unknown`→「—」のバッジ |
| 必要資金 | `requiredInvestment` |
| 前回逆日歩 | `lastGyakuhibu.cost` と権利日。前年同月は括弧で併記 |

追加する絞り込み: 株価(下限/上限)、必要資金(下限/上限)、クロス可否。

`null` のソートは既存の列と同じく null-last を守る
(`YutaiForecastListPage` の `sortUndefined` と揃える)。

### 逆日歩予測一覧(`YutaiForecastListPage`)

同じ4列と3つの絞り込みを追加する。両方の一覧で同じ判断ができるようにする。

### 優待詳細(`YutaiDetailPage`)

`benefitGroups` を種別ごとに見出し付きで表示する。各グループは
保有条件のラベル(「継続保有期間3年以上」または「条件なし」)と、
株数→内容の表を持つ。`valueYen` が `null` の段階は `rawText` を出す。

`benefitParseWarning` があるときは、解析が不完全である旨と
個別ページへのリンクを添える。

---

## テスト方針

既存の `test/` 配下のパターン(Lambda ハンドラごとに1ファイル、DynamoDB クライアントを
`jest.mock` でモック)を踏襲する。

| 対象 | 検証すること |
|---|---|
| 個別ページのパーサー | 5銘柄の実 HTML を固定データとして、グループ数・最小株数・保有月数が実測値と一致する。第一興商が200株、ノジマが300株になること |
| 導出ロジック | 条件なしのみ→`none`、混在→`bonus`、全条件付き→`required`、0グループ→`unknown` |
| 警告検出 | 0グループ・重複グループ・全 `valueYen` null・バッジ不一致のそれぞれで警告が立つ |
| `yutai-detail-sync-batch` | `codePrefix` で対象が絞られる。`maxFetches` で打ち切る。`conditionCheckedAt` が新しい行を飛ばす。`tickers` 指定が他の条件を上書きする |
| 逆日歩の集計 | `cost = avgRate × days × requiredShares`。`requiredShares` が `null` なら `unitShares` で計算し `basedOnUnitShares: true` |
| `yutai-risk-precompute-batch` | `unitShares` を書かない。`requiredShares` があればそれを使って最大逆日歩を計算する |
| API | 新しい絞り込みが効く。範囲指定時に `null` 行が除外される |
| CDK | Step Functions の Map が `maxConcurrency: 1` であること。9バケットあること |

実 HTML はパーサーテストの固定データとして `test/fixtures/` に置く
(ネットワークに触れるテストは作らない)。

---

## 移行手順

1. `yutai-master-sync-batch` に `detailUrl`/`listBadge` を追加して手動実行
   (全1,642銘柄に `detailUrl` が入る)
2. `yutai-detail-sync-batch` をデプロイ、Step Functions を手動起動
   (9バケット直列、約33分)
3. `benefitParseWarning` が立った銘柄の件数を確認し、パーサーの取りこぼしを評価する
4. `yutai-risk-precompute-batch` を新版に切り替える(`unitShares` の上書き停止、
   前回逆日歩の集計開始)
5. `estimateRequiredShares` を削除する

手順4より前に API と画面を出すと、`requiredShares` が未設定の行が大量に
「—」表示になる。手順3の確認を経てから画面を出す。

---

## 対象外

- 個別ページの重複グループ(中間/期末)の厳密な区別。`benefitParseWarning` で
  可視化するにとどめる
- 選択式優待(`【下記から1点を選択】`)の選択肢の構造化。先頭の金額のみ採用する
- 優待利回りの再計算。既存の `value` の扱いは変えない
- 株数段階に応じた最適なクロス株数の提案(価値/コスト比の最大化)。
  データが揃ってから別途検討する
