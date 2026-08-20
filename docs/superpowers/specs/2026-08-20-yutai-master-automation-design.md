# 優待マスタ自動化(サブプロジェクトB) 設計書

全体のロードマップは`docs/superpowers/specs/2026-08-18-yutai-scale-out-roadmap.md`を参照。本書はそのサブプロジェクトB(全銘柄優待マスタの自動化)の詳細設計。サブプロジェクトA(`docs/superpowers/specs/2026-08-18-yutai-batch-freshness-split-design.md`、実装・デプロイ・マージ済み)の上に乗る。

## 背景・目的

現状、`JQuantsYutaiMaster`/`JQuantsYutaiRightsDate`は手動でDynamoDBへ1件ずつ投入する運用で、数銘柄規模を前提にしていた。将来的に株主優待を実施している銘柄すべて(1,000社超)を`/yutai`で扱えるようにするため、優待マスタの投入を自動化する。

J-Quants APIには「優待を実施しているか」「優待内容」「権利確定月」に相当する情報が存在しない(`/listed/info`のフィールドはCompanyName/Sector17Code/Sector33Code/MarketCode/MarginCode等のみで、単元株数・発行済株式数すら含まれない)。そのため優待固有の情報は外部サイトのスクレイピングに頼らざるを得ない。

## スコープ

**含む**:
- kabuyutai.comの月別一覧ページからの銘柄コード・優待内容・権利確定月の一括取得(初回構築)
- 無料公開TDnetサイトの週次ポーリングによる、以後の新設・変更・廃止の検知と反映
- `JQuantsYutaiRightsDate`テーブルの廃止と、`JQuantsYutaiMaster`への`rightsMonths`追加
- 上記データモデル変更に伴う`reference-api`・`gyakuhibu-history-batch`の改修
- 既存の手動投入データ(9861等)の削除・新方式での再投入

**含まない(将来対応)**:
- 優待内容の階層的な詳細(保有株数・継続保有期間別の段階的な価値)。`value`は引き続き最低単元(通常100株)保有時点の価値のみを保持する(サブプロジェクトA以前から合意済みのYAGNI判断)
- 信用残(融資残・貸株残)の本番API切り替え(J-Quants Standardプラン移行、別スコープ)
- kabuyutai.com以外の情報源の追加検討(四季報オンラインは有料会員限定・認証必須のため見送り。立花証券e-SHITEN APIは優待情報自体を扱っておらず対象外と判断済み)

## データ収集方針

### 収集する項目と取得元

| 項目 | 取得元 | 備考 |
|---|---|---|
| 銘柄コード | kabuyutai.com 月別一覧ページ | 「どの銘柄が優待を実施しているか」自体がJ-Quantsに無いため、この一覧が発見の起点 |
| 優待内容(`content`) | 同上(一覧ページの要約テキスト) | 個別詳細ページ(`/kobetu/xxx.html`)は使わない。要約テキストで足りると判断(下記参照) |
| 権利確定月(`rightsMonths`) | 同上 | 「2月・8月」のような表記をそのまま配列化。各社独自の制度でJ-Quantsの決算期とは必ずしも一致しないため、この情報源に依存せざるを得ない |
| 優待価値(`value`) | 同上、`content`内の正規表現抽出 | 優待内容のテキストに「(XXX円相当〜)」という形式で最低単元の価値が埋め込まれている(実データで確認済み、例: コシダカHD「優待利用割引券(2,000円相当〜)」)。`/(\d[\d,]*)\s*円相当/`相当のパターンで抽出する想定(実装時に実データのバリエーションを見て調整)。マッチしない場合はログに警告を出し、その銘柄は投入をスキップする |
| 企業名(`companyName`) | J-Quants `/listed/info` | スクレイピング対象外。既存のウォッチリスト追加フローと同じ取得方法に統一し、表記のブレを避ける |
| 単元株数(`unitShares`) | 一律`100`固定 | 2018年10月1日付で東証上場の内国株は単元株数100株に統一済みで、有価証券上場規程第427条の2により100株以外への変更が認められていない(規則上の裏付けあり)。スクレイピング不要 |

### 検討したが採用しなかった情報源

- **優待利回り×必要投資金額での`value`逆算**: 実データで試算した結果(例: コシダカHD 102,200円×3.91%≈3,996円 vs 実際の最低単元価値2,000円)、優待利回りは別の基準(複数階層合算等)で計算されており、`value`算出には使えないことを確認した。
- **四季報オンライン**: 優待銘柄の絞り込み検索がベーシック会員以上(有料、プレミアムは月額5,500円)限定。認証必須の会員制サービスであり、個人アプリのコスト方針・スクレイピングの利用規約リスクの両面で見送り。
- **立花証券 e-SHITEN API**: 銘柄マスタ(`CLMIssueMstKabu`)で企業名・単元株数は取得できるが、株主優待に関する情報自体を扱うエンドポイントが無い。認証トークン・証券口座開設が必要な点も含め、今回の核心(優待実施銘柄の発見・優待内容・権利確定月)には使えないため見送り。

## アーキテクチャ

```
lambda/
  shared/
    kabuyutai-client.ts        (新規: kabuyutai.com一覧ページのパース)
  yutai-master-sync-batch/     (新規、EventBridgeスケジュールなし・手動invokeのみ)
  yutai-tdnet-watch-batch/     (新規、週次)
```

## コンポーネント詳細

### `lambda/shared/kabuyutai-client.ts`(新規)

kabuyutai.comの月別一覧ページ(`https://www.kabuyutai.com/yutai/<month>.html`、ページネーションあり)をパースし、掲載銘柄ごとに`{ ticker, content, rightsMonths }`を返す関数を提供する。`value`は`content`から正規表現(`/(\d[\d,]*)円相当/`相当)で抽出するヘルパーも含む。個別詳細ページ用のスクレイパーは実装しない(一覧ページのみで完結する設計のため)。

実データ調査済み(`docs/superpowers/notes/2026-08-20-kabuyutai-list-page-format.md`): Bot対策・CSRF・セッションCookie無しの素のGETで200が返る。1ページ20銘柄、`<!-- ▼ランキング_ブロック -->`〜`<!-- ▲ランキング_ブロック -->`のHTMLコメントで銘柄ごとのブロックに分割してから各項目を正規表現抽出する(ページ全体への直接regexは、ブロック外の同名クラスに誤マッチする恐れがあるため避ける)。ページネーションは月ごとに件数が異なり(実測: 8月は7ページ)、`pagination`ブロックの次ページリンクが無くなるまで順に辿る方式で実装する。あわせて、kabuyutai.comに銘柄コードでの直接検索機能(`/tool/`ページ)があるかどうかも実装時に確認する(あれば`yutai-tdnet-watch-batch`が該当銘柄1件だけを引き直す際に該当月の一覧ページ全体を再走査せずに済む)。

### `lambda/yutai-master-sync-batch/index.ts`(新規)

**EventBridgeスケジュールを持たない**。デプロイはするが、初回構築時と、取りこぼしに気づいた際の手動再実行(`aws lambda invoke`)のみを想定する。

処理内容: 月別一覧ページ(12ヶ月分、各月ページネーションを次ページリンクが無くなるまで辿る。月ごとの件数は不定で、実測では8月だけで7ページ=最大140銘柄程度)をすべて走査 → 掲載銘柄ごとに`kabuyutai-client.ts`で`{ ticker, content, rightsMonths }`を抽出 → `value`を`content`から抽出(失敗時はログ警告してスキップ)→ J-Quants `/listed/info`で`companyName`を取得 → `unitShares: 100`固定 → `JQuantsYutaiMaster`へupsert。

### `lambda/yutai-tdnet-watch-batch/index.ts`(新規)

週次(曜日・時刻は実装時に決定。既存バッチの週次スケジュールと重ならない時間帯を選ぶ)。無料公開TDnetサイト(直近31日分閲覧可能)から直近の開示一覧を取得し、タイトルに株主優待関連キーワード(新設・変更・廃止等)を含むものを抽出する。該当銘柄について:

- `JQuantsYutaiMaster`に既存 → kabuyutai.comで最新情報を引き直し、内容が変わっていれば更新
- `JQuantsYutaiMaster`に未登録 → 新規上場・新規優待開始とみなし、kabuyutai.comで情報を取得して新規登録

`kabuyutai-client.ts`を共用する(個別銘柄の再取得は一覧ページの該当月ページを再走査する形になる想定。銘柄コード直接検索が使えるなら実装時にそちらへ切り替える)。

実データ調査済み(`docs/superpowers/notes/2026-08-20-tdnet-list-page-format.md`): kabuyutai.com同様Bot対策・CSRF無しの素のGETで200が返る。`https://www.release.tdnet.info/inbs/I_list_00{page}_{YYYYMMDD}.html`という日付・ページ番号ベースのURLを直接構築でき、JS/dropdown操作は不要。開示1件が1行(`<tr>`)で、`kjTime`/`kjCode`/`kjName`/`kjTitle`という共通クラス名を持つセルに機械的に分解できる。ただし証券コードが5桁(例: `24670`)で出現し、`JQuantsYutaiMaster`の4桁tickerとの変換ルールは実装時に複数実例で検証する。優待関連キーワードの実際の表記ゆれ(「株主優待制度の新設/一部変更/廃止に関するお知らせ」等)も、実例が取得できていないため実装時に確認する。

## データモデル変更

- `JQuantsYutaiRightsDate`テーブルを**廃止**。
- `JQuantsYutaiMaster`に`rightsMonths: number[]`(例: `[2, 8]`)を追加。
- 既存の手動投入データ(9861含む全件)は削除し、`yutai-master-sync-batch`の初回実行で作り直す。

## 既存コードへの影響(改修が必要な箇所)

### `lambda/reference-api/index.ts`

「次回の権利日」の計算(`nextRightsDate`相当)を、`JQuantsYutaiRightsDate`へのクエリから、`rightsMonths`を起点にした計算(`getLocalTradingCalendar`で該当月の最終営業日を求め、そこから2営業日前を権利付き最終日とする、サブプロジェクトAで整備済みのロジックを再利用)に変更する。`calcRisk`が受け取る`rightsDate`の算出元が変わるだけで、リスク計算ロジック自体(`gyakuhibu-calc.ts`)は変更不要。

### `lambda/gyakuhibu-history-batch/index.ts`

「過去の未取得権利日」の列挙(`listPastRightsDates`相当)を、`JQuantsYutaiRightsDate`のテーブルスキャンから、`JQuantsYutaiMaster`の全銘柄について`rightsMonths`×過去3年分(taisyaku.jpの公開範囲)の権利日を計算する方式に変更する。銘柄数が1,000規模に増えるため、taisyaku.jpへの取得もサブプロジェクトAの`yutai-master-sync-batch`と同様、Lambdaの実行時間内に収まるよう上限件数付きの処理に変更する(未処理分は`JQuantsGyakuhibuActual`に存在しないため翌日以降に自然と持ち越される、既存の`alreadyFetched`と同じ考え方)。

### `lambda/price-batch/`・`lambda/financial-summary-batch/`・`lambda/margin-balance-batch/`

変更不要。`getTargetTickers`(ウォッチリスト∪優待マスタの和集合)がそのまま銘柄数の増加に対応する。サブプロジェクトAで整備した鮮度別スケジュール分離が、まさにこの規模拡大のために効いてくる。

## エラーハンドリング・テスト方針

既存バッチと同じパターンを踏襲する: 銘柄ごとにtry/catchしログして継続、全体を止めない。TDD。kabuyutai.com・TDnetサイトの正確なHTTP的な取得手順はtaisyaku.jpの実装時と同様、実装時に実機検証しながら仕上げる方針とし、本設計書ではロジックの形(何を抽出し、どこに書き込むか)を確定させることを優先する。
