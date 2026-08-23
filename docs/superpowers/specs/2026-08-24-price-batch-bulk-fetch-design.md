# price-batch 一括日付取得への切り替え 設計書

`lambda/price-batch/index.ts`が銘柄ごとに直列でJ-Quants APIを叩いている構造を、日付ごとの一括取得に切り替え、優待銘柄1233件のうち約46件しか株価データがカバーできていない問題を解消する。

## 背景・目的

`GET /yutai`一覧のリスク判定(`yutai-risk-precompute-batch`)は、信用残データに加えて`JQuantsStockPrices`の直近終値(`latestClose`)が無いと`na`になる。信用残データはmargin-balance-batchの手動連続実行で全1233銘柄分を埋めたが、株価データは`JQuantsStockPrices`に47銘柄分(うち優待銘柄は46件)しか無く、これがボトルネックになっていることが確認できた。

原因は`price-batch`の実装: `getTargetTickers`はウォッチリスト∪YutaiMaster(1233件)を対象にしているが、銘柄ごとに`/equities/bars/daily?code=...`を13秒間隔(J-Quants Freeプランの5req/分制約)で叩いており、14分のLambdaタイムアウト内では約64銘柄しか処理できない。しかも`for (const ticker of tickers)`にカーソル/巡回ロジックが無く、毎回同じ並び順の先頭から処理するため、上限を超えた銘柄には何日経っても永遠に到達しない(サブプロジェクトC設計時に既知の課題として文書化・先送りされていたもの)。

J-Quants APIのドキュメントと実機検証により、`/equities/bars/daily`は`code`を省略し`date`のみ指定すると**その日の東証全銘柄分を1リクエストで返す**モードがあり(2026-05-26〜28で実測: 4,446〜4,453件、pagination_keyなしで1レスポンスに収まる)、Freeプランでも制限なく利用できることを確認した。これを使えば1233銘柄→1233回のリクエストが、日付単位(現状のLOOKBACK_DAYS=7なら7回)まで減らせる。

## スコープ

**含む**:
- `price-batch`の取得方式を銘柄ループから日付ループへ変更し、カバレッジ上限(約64銘柄)を解消して1233銘柄全てを対象にする

**含まない(方針決定済み)**:
- 価格データが無い銘柄への12週間分バックフィル(新規銘柄のチャートは従来通り日々の蓄積で約84日かけて埋まる、という既存の仕様のまま変更しない)
- `financial-summary-batch`など他バッチへの同様の対応(同種の課題を抱えている可能性はあるが、別途検討する)
- J-Quants Standardプランへの移行(今回の変更でFreeプランのまま解消できるため不要)

## アーキテクチャ

### `lambda/price-batch/index.ts`の変更

**Before**: 銘柄ごとに`fetchDailyBars(ticker, apiKey, from, to)`を呼び、そのticker用の全期間分(from〜to)を1〜複数リクエストで取得 → `upsertBars(ticker, bars)`。

**After**:
```
tickers = getTargetTickers(...)  // 対象銘柄の集合(Set化してO(1)判定)
apiKey = getApiKey(...)
from, to は現行通り DELIVERY_DELAY_DAYS / LOOKBACK_DAYS から算出

for date in [from, to] (1日ずつ):
  bars = fetchAllBarsForDate(date, apiKey)  // codeを付けず date のみ指定
  matched = resolveTargetBars(bars, targetTickerSet)  // 後述
  for (ticker, bar) in matched:
    upsertBar(ticker, bar)
```

`fetchAllBarsForDate`は既存の`fetchDailyBars`と同じ`pagination_key`ページング処理を残す(実測では発生しなかったが、取引日によって件数が変動する可能性に備える)。日付のループ自体は非取引日(土日祝)も含めて単純にfrom〜toを1日ずつ回す(その日は0件近いレスポンスが返るだけで、既存コードもトレーディングカレンダーを参照していないため踏襲)。

### 銘柄コードの突き合わせ(`resolveTargetBars`)

一括レスポンスの`Code`は5桁(例: `13010`)。アプリ内の4桁ticker(例: `1301`)と突き合わせるため、`code.slice(0, 4)`で変換する(`yutai-tdnet-watch-batch/index.ts`の`toTicker()`と同じ変換)。

普通株式・優先株式等が両方上場している銘柄では、同じ4桁prefixに複数の5桁`Code`(例: `13010`と`13011`)が存在しうる。従来は`code=1301`のようにAPIへ4桁で問い合わせることでAPI側が自動的に普通株式のみを返していたが、一括取得ではこの自動選択が効かないため、自前で「5桁目が`0`のレコードを優先する」ロジックを入れて同じ結果になるようにする。同じ4桁prefixに対して5桁目`0`のレコードが無い場合は、見つかった最初のレコードを使う。

## コンポーネント詳細

### 型・関数の変更

- `DailyBar`インターフェースに`Code: string`を追加(すでにJ-Quantsレスポンス由来のフィールドとして存在するが、現状は`ticker`を呼び出し側から渡していたため未使用だった)
- `fetchDailyBars(ticker, apiKey, from, to)` → `fetchAllBarsForDate(date, apiKey)`に置き換え。URLパラメータは`code`を外し`date`のみ
- `upsertBars(ticker, bars)` → `upsertBar(ticker, bar)`に変更(日付ループの中で1件ずつ書き込むため配列を受け取る必要がなくなる)
- 新規: `resolveTargetBars(bars: DailyBar[], targetTickers: Set<string>): Map<string, DailyBar>`(4桁ticker → 採用するDailyBarのマップを構築。普通株式優先ロジックを含む)

### レート制御

`REQUEST_INTERVAL_MS`(13秒)・`MAX_RETRIES`・`fetchWithRetry`は変更しない。呼び出し回数がLOOKBACK_DAYS+1回程度(現状8回: from〜to境界の日数分)まで減るため、実行時間は現状の途中打ち切り状態から数分程度に短縮される見込み。

## テスト方針

`test/price-batch.test.ts`を全面的に書き直す。既存テストは「銘柄ごとにfetchWithRetryが呼ばれる」ことを検証しているが、新しい実装では「日付ごとにfetchWithRetryが呼ばれ、URLに`date=`パラメータが含まれ`code=`は含まれない」ことと、「レスポンス中の対象外銘柄は無視され、対象銘柄のみDynamoDBにupsertされる」こと、「同一4桁prefixで複数レコードがある場合に5桁目`0`のレコードが優先される」ことを検証する。TDD(RED→GREEN)で実装する。
