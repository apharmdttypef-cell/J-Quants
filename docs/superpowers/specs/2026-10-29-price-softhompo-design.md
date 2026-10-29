# 株価のSoftHompo移行・財務サマリー廃止 設計書

株価(`JQuantsStockPrices`)の取得元を、J-Quants `/equities/bars/daily`からSoftHompoの日次株価データ(東証「株式相場表」由来のCSV)に切り替える。財務サマリー(`JQuantsFinancialSummary`)は取得・表示ともに廃止する。これでJ-Quantsを呼ぶ処理が無くなる。

## 背景・目的

- J-Quantsの無料プラン化に向けて、有料プランに依存する箇所を外している。信用残(`2026-10-24-margin-balance-taisyaku-design.md`)、貸借区分(`2026-10-27-margin-name-taisyaku-design.md`)に続き、最後の2つ(株価・財務)を扱う。
- Freeプランの株価・財務は「12週間前〜2年12週間前」しか取れず、直近の値が必要な用途には使えない。
- 残す機能(ユーザー決定、2026-10-29): 逆日歩上限・必要資金の計算、終値の表示、ローソク足チャート。財務サマリー表示(売上・営業利益・純利益・EPS)と、EPSから計算しているPERは廃止する。

本アプリは個人用。YAGNIで進める。

## SoftHompoのデータ(実データで確認、2026-10-29)

- ページ: `https://softhompo.a.la9.jp/Data/StockData.html`
- 日次ファイル: `https://softhompo.a.la9.jp/Data/stock/thisMonth/stq_YYYYMMDD.zip`(当月分)。休場日は404。
- 月次ファイル: `https://softhompo.a.la9.jp/Data/stock/pastMonth/YYYYMM.zip`(2021年10月〜前月)。中身はその月の`stq_YYYYMMDD.csv`の集まり。前月分は翌月第2営業日ごろに月次へ移る(2026年9月分は10/2 08:32付け)。
- 公表は翌営業日の朝(10/28分は10/29 08:32付け)。
- CSVはBOM付きUTF-8。`"!`で始まる行はコメント(1〜3行目が見出し、4行目が日付)。データ行は17列:
  `コード, フラグ, 売買単位, 銘柄名, 午前の始値・高値・安値・終値, 午後の始値・高値・安値・終値, 最終気配, 前日比, 売買高加重平均価格, 売買高(千株), 売買代金(千円)`
- 取引の無かった場の値は`"－"`(全角ハイフン)。10/28は4,437行のうち361行で午後の終値が無かった。
- 東証の全銘柄が入っている。優待マスタ1,637銘柄のうち、ファイルに無いのは41銘柄で、いずれも東証以外(名証・福証・札証)のみに上場する銘柄(taisyaku.jpの東証行が無い41銘柄と同じ)。
- 10/28の終値はJ-Quantsと一致した(2301学情 1,673円、2923サトウ食品 7,210円)。
- 利用規約・ライセンスの記載は無い。記載は「無料で公開」「東証の公表PDFから加工」「誤りによる損失の責任は負わない」のみ。本アプリは個人利用に限る(`project_data_licensing`の方針どおり)。

## 方針(決定事項)

1. **`price-batch`を置き換える**。書き先の`JQuantsStockPrices`とその行の形(`ticker`, `date`, `open`, `high`, `low`, `close`, `volume`, `updated_at`)は変えない。読む側(`yutai-risk-precompute-batch`、`gyakuhibu-forecast-validation`、`reference-api`)は変更しない
2. **実行は平日 09:30 JST(UTC 00:30)**。直近7日分の日付それぞれについてファイルを取る(既にある日は上書き。訂正を拾う)
3. 対象は優待マスタの銘柄だけ(現在と同じ)
4. 財務サマリーは取得・API・表示をすべて削除する。テーブル`JQuantsFinancialSummary`は消さずに残す(`RemovalPolicy.RETAIN`のまま、スタックにも残す)
5. J-QuantsのAPIキー(シークレット`JQuantsApiKey`)をスタックから削除する。使う処理が無くなるため
6. 終値の反映は1日遅れになる(夜の貸借判定バッチが使うのは前営業日の終値)。逆日歩の上限は投資金額1万円刻みで決まるので、実際の影響はほぼ無い。許容する

## コンポーネント

### `lambda/price-batch/softhompo.ts`(新規)

- `parseSoftHompoCsv(csvText: string): Map<string, PriceBar>` — 純粋関数。銘柄コード → `{ open, high, low, close, volume }`。
  - BOMを除き、`"!`で始まる行を読み飛ばす。データ行は17列。
  - 見出し行(`"! コード"`で始まる行)の列名が想定と違えば`SoftHompoCsvFormatError`を投げる。
  - 値の変換:
    - `open` = 午前の始値。無ければ午後の始値
    - `high` = 午前・午後の高値の大きい方(片方だけならその値)
    - `low` = 午前・午後の安値の小さい方(片方だけならその値)
    - `close` = 午後の終値。無ければ午前の終値
    - `volume` = 売買高(千株) × 1000(株)。整数に丸める
  - 午前・午後とも終値が無い行(終日取引なし)は含めない。
- `fetchSoftHompoDay(date: string): Promise<string | null>` — 指定日のCSVテキストを返す。
  - まず日次ファイル(`thisMonth/stq_YYYYMMDD.zip`)を取る。404なら、その日付の月の月次ファイル(`pastMonth/YYYYMM.zip`)から`stq_YYYYMMDD.csv`を探す。月次ファイルが404、または中に無ければ`null`(休場日・未公表)。
  - 同じ実行の中で月次ファイルは1回だけ取る(キャッシュ)。
  - 404以外のHTTPエラーは例外。
- zipの展開には`fflate`(`unzipSync`)を使う(依存追加。esbuildでバンドルされる)。

### `lambda/price-batch/index.ts`(書き換え)

- J-Quants関連(`getApiKey`、`fetchAllBarsForDate`、`resolveTargetBars`、`SECRET_ARN`、`API_BASE_URL`、`DELIVERY_DELAY_DAYS`、`REQUEST_INTERVAL_MS`)を削除する。
- 優待マスタの`ticker`を読み、直近7日の各日付について`fetchSoftHompoDay` → `parseSoftHompoCsv` → 対象銘柄だけ`PutCommand`で書く。
- ファイルを取るたびに1秒空ける。
- 日付ごとのログ: `{date}: wrote N of M target tickers ({rows} rows in file)` / ファイルが無い日は`{date}: no file (holiday or not yet published)`。
- 取得・解析に失敗した日があれば、全日付を処理したあとに例外を投げる(アラーム用)。

### `lambda/financial-summary-batch/`(削除)

- ディレクトリごと削除する。

### `lambda/shared/jquants-batch-client.ts`(削除)

- 使う処理が無くなるので削除する(テストも)。

### `lambda/reference-api/index.ts`

- `GET /tickers/{ticker}/summary`(`getSummary`)を削除する。
- `getYutaiDetail`の`basicInfo`から`per`・`sales`・`operatingProfit`・`netProfit`・`eps`を削除する(`latestFinancialSummary`も削除)。`closePrice`・`volume`は残す。
- `FINANCIAL_TABLE_NAME`の参照を削除する。

### フロントエンド

- `TickerDetailPage`: 財務サマリーの取得(`fetchSummary`)と表示(売上高・営業利益・当期純利益・EPS)を削除する。チャートは残す。
- `YutaiDetailPage`: 基本情報から「PER」「決算サマリ」を削除する。「前日終値」「出来高」は残す。
- `api/client.ts`・`api/types.ts`: `fetchSummary`・`FinancialSummary`と、`basicInfo`の削除した項目を削除する。

### CDK(`lib/j-quants-stack.ts`)

- `PriceBatchFunction`: `SECRET_ARN`環境変数とシークレットの読み取り権限を削除する。スケジュールを`cron(30 0 ? * MON-FRI *)`(平日 09:30 JST)に変更する。
- `PriceBatchErrorsAlarm`を追加する(信用残バッチのアラームと同じ形: `Errors`、評価2期間・2回で発報、SNS `JQuantsBatchAlarmTopic`へ。説明「株価バッチ(SoftHompo)が2日連続で失敗」)。
- `FinancialSummaryBatchFunction`とそのスケジュールを削除する。
- API Lambdaから`FINANCIAL_TABLE_NAME`と財務テーブルの読み取り権限を削除し、`GET /tickers/{ticker}/summary`のルートを削除する。
- `JQuantsApiKeySecret`を削除する(削除後は復元期間を経て消える。キー自体はJ-Quants側で再発行できる)。
- `JQuantsFinancialSummaryTable`は残す。

### README

- データフロー図・Lambda表の株価の取得元をSoftHompoに改める。財務サマリーの記述を削除する。
- 移行の節に、J-Quantsへの依存が無くなったこと(Freeプランへの変更・解約が可能)を書く。

## エラーハンドリング

- ファイルが無い日(休場日・未公表): `null`として飛ばす。エラーにしない
- 見出しの不一致: `SoftHompoCsvFormatError`。その日は書かず、最後に例外を投げる
- HTTPエラー(404以外)・zipの破損: その日は書かず、最後に例外を投げる
- 2日連続で失敗したらメール通知(`PriceBatchErrorsAlarm`)

## テスト方針(TDD)

- `parseSoftHompoCsv`: 実ファイル(10/28分)から切り出したフィクスチャ`test/fixtures/softhompo/stq_20261028.csv`で、
  - 午前・午後とも取引ありの行(2301: 始値1,694・高値1,700・安値1,672・終値1,673・出来高553,500)
  - 午後の終値が無い行は午前の値を使うこと、午前が無い行は午後の値を使うこと
  - 終日取引なしの行を含めないこと
  - 見出し不一致で例外
- `fetchSoftHompoDay`(`fetch`をモック): 日次ファイルを優先すること、404で月次ファイルにフォールバックすること、どちらにも無ければ`null`、月次ファイルを1実行で1回だけ取ること、404以外で例外
- `price-batch`ハンドラー: 対象銘柄だけ書くこと、ファイルが無い日を飛ばすこと、失敗した日があっても他の日を処理してから例外を投げること、J-Quants(シークレット)を読まないこと
- `reference-api`: `/summary`ルートが無いこと、`basicInfo`に財務項目が無いこと
- スタック合成テスト: 財務バッチ・シークレットが無いこと、株価バッチの環境変数・スケジュール・アラーム
- フロント: 財務サマリー・PERが表示されないこと

## 移行

- 既存の`JQuantsStockPrices`にはJ-Quantsの株価が残っているので、バックフィルは不要。
- デプロイは新フロント → `npx cdk deploy`の順(旧フロントは`/summary`が無いとエラー表示になるため)。
- デプロイ翌朝の実行後、10/29分などの終値がJ-Quantsで取っていた値と一致することを数銘柄で確認する。
- その後、J-QuantsをFreeプランへ変更(または解約)するのはユーザーが行う。
