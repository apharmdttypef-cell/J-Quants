# 貸借区分のtaisyaku.jp移行 設計書

貸借区分(`JQuantsYutaiMaster.marginName`)の取得元を、J-Quants `/equities/master`の`MrgnNm`から、信用残バッチが毎日取得しているtaisyaku.jp一括CSVの`貸借区分`列に切り替える。

## 背景・目的

- J-Quantsの無料プラン化に向けて、有料プランに依存する箇所を一つずつ外している。信用残(`2026-10-24-margin-balance-taisyaku-design.md`)に続き、本設計は貸借区分を担当する。
- `/equities/master`がFreeプランで最新状態を返すかは未確認(J-Quantsのドキュメントページが取得できず検証できていない)。
- 信用残バッチは基準日ごとにtaisyaku.jpの全銘柄CSV(14列、CP932)を取得しており、その`貸借区分`列(`貸借`/`貸借融資`/`非貸借`)で同じ判定ができる。追加のリクエストは不要。
- 移行後にJ-Quantsへ残る依存は株価(`price-batch`)と財務(`financial-summary-batch`)の2つになる。

本アプリは個人用。YAGNIで進める。

## 実データでの対応確認(2026-10-27)

優待マスタ1,637銘柄の現在の`marginName`(J-Quants)と、taisyaku.jp CSV(申込日2026-10-23)の`貸借区分`を突き合わせた:

| J-Quants `MrgnNm` | taisyaku.jp `貸借区分` | 件数 |
|---|---|---|
| 貸借 | 貸借(東証行) | 1,044 |
| 信用 | 貸借融資(東証行) | 550 |
| その他 | 貸借融資 / 非貸借(東証行) | 2 |
| null(J-Quantsの上場一覧に無い) | 東証行なし、名証・福証・札証の行のみ | 38 |
| null | CSVに無し | 3 |

東証の行で判定する限り、全銘柄で判定結果(`貸借`か否か、区分不明か否か)は現在と同じ。

## 方針(決定事項)

1. **更新するのは信用残バッチ(`MarginBalanceBatchFunction`)**。その実行で取得できたCSVのうち**最新の申込日のもの**から、優待銘柄の東証行の`貸借区分`を読み、マスタの`marginName`と異なる銘柄だけ更新する
2. **東証の行だけを見る**。東証行の無い銘柄(地方市場のみ上場、CSVに無い)は`marginName = null`(区分不明=対象外)。信用残・現在需給予測も東証行だけを使っているので整合する
3. **値はtaisyaku.jpの表記をそのまま保存する**(`'貸借' | '貸借融資' | '非貸借'`)。判定は`marginName === '貸借'`と`null`かどうかしか見ていないため、J-Quantsの表記(`信用`/`その他`)への変換はしない
4. `marginName`を書くのは信用残バッチだけにする。`YutaiRiskPrecomputeBatchFunction`は書かずに読むだけにする
5. 反映は1日遅れ(貸借判定UTC 09:20 → 信用残UTC 10:15の順のため)。区分の変更は稀なので許容する

## コンポーネント

### `lambda/margin-balance-batch/data-source.ts`

- 純粋関数`parseTaisyakuMarginNames(csvText: string): Map<string, string>`を追加する。東証行の`銘柄コード → 貸借区分`を返す。ヘッダー検証は`parseTaisyakuBalanceCsv`と同じ定数・同じ例外(`TaisyakuCsvFormatError`)を使う。`貸借区分`が空の行は含めない
- 既存の`parseTaisyakuBalanceCsv`は変更しない

### `lambda/margin-balance-batch/index.ts`

- マスタのScanで`ticker`に加えて`marginName`も読む
- 日付ループで、CSVを取得・パースできた日のうち最新の申込日のCSVテキスト(または区分マップ)を保持する。0件(休場日・未公表)の日は対象外
- ループ後、保持したCSVがあれば区分マップを作り、優待銘柄ごとに新しい値(マップに無ければ`null`)を求め、現在の値と異なる銘柄だけ`UpdateCommand`(`SET marginName = :v`)で更新する
- その実行でCSVが1件も取れなかった場合は区分を更新しない(前回の値を使い続ける)
- 更新に失敗した銘柄があっても信用残の処理は最後まで行い、最後に例外を投げる(2日連続失敗の通知に乗せる)
- サマリーログに区分の更新件数を出す

### `lambda/yutai-risk-precompute-batch/index.ts`

- `loadMarginNames`(J-Quants `/equities/master`の呼び出し)を削除し、マスタの`row.marginName`をそのまま使う
- `UpdateCommand`から`marginName = :marginName`を外す(書き込みは信用残バッチに一本化)
- `SECRET_ARN`・`getApiKey`の参照を削除する

### `lambda/gyakuhibu-forecast-validation/target-tickers.ts`

- `fetchMarginEligibleTickers`(J-Quants `/equities/master`)を削除し、マスタのScanで`marginName === '貸借'`の銘柄に絞る
- `SECRET_ARN`・`API_BASE_URL`・`EQUITIES_MASTER_REQUEST_INTERVAL_MS`の参照を削除する

### `lambda/shared/margin-name.ts`

- `fetchMarginNames`・`pickMarginNames`・`EquityMasterRecord`を削除し、`isGeneralMarginOnly`だけ残す
- 冒頭コメントを、値がtaisyaku.jpの`貸借区分`(`貸借`/`貸借融資`/`非貸借`)であることに改める。`isGeneralMarginOnly`の判定(`null`でなく`'貸借'`でない)は変えない

### CDK(`lib/j-quants-stack.ts`)

- `MarginBalanceBatchFunction`: `JQuantsYutaiMaster`を読み取りのみ → 読み書きに変更
- `YutaiRiskPrecomputeBatchFunction`: `SECRET_ARN`環境変数とシークレットの読み取り権限を削除
- 逆日歩予測の検証用Lambda(`lambda/gyakuhibu-forecast-validation`): `SECRET_ARN`環境変数とシークレットの読み取り権限を削除(他にJ-Quantsを呼んでいないことを実装時に確認する)

### README

- Lambda表・データフロー図の貸借区分の取得元をtaisyaku.jpに改める
- J-Quantsに残る依存が株価と財務だけになったことを書く

## エラーハンドリング

- CSVのヘッダー不一致: 既存どおり`TaisyakuCsvFormatError`でバッチを失敗させる(区分のパースも同じ検証を通る)
- マスタ更新の失敗: 信用残の処理を終えてから例外を投げる
- CSVが1件も取れなかった実行: 区分は更新しない

## テスト方針(TDD)

- `parseTaisyakuMarginNames`: 既存フィクスチャ(`test/fixtures/taisyaku/stock-20261023.cp932.csv`)で東証行だけを返すこと(7203の名証行を無視)、`貸借区分`が空の行を含めないこと、ヘッダー不一致で例外
- 信用残バッチ: 複数日を取得した実行で最新日のCSVの区分を使うこと、値が変わった銘柄だけ更新すること、東証行が無い銘柄は`null`に更新されること(既に`null`なら更新しない)、CSVが1件も取れない実行では更新しないこと、更新失敗時に信用残の処理を終えてから例外を投げること
- 貸借判定バッチ: J-Quants(`fetch`/`getApiKey`)を呼ばないこと、マスタの`marginName`で判定すること、`marginName`を書き込まないこと
- 検証用Lambda: マスタの`marginName === '貸借'`で絞ること、J-Quantsを呼ばないこと
- スタック合成テスト: 上記の権限・環境変数

## 移行

- デプロイ後、最初に信用残バッチが動くまではマスタにJ-Quantsの値(`信用`/`その他`)が残るが、判定は`=== '貸借'`と`null`しか見ないので結果は変わらない。手作業の移行は不要
- 初回実行後、マスタの`marginName`の分布が`貸借`約1,044・`貸借融資`約552・`非貸借`約1・`null`約41になっていることを確認する
