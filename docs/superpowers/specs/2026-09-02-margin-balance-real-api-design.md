# margin-balance-batch 実API化(フェーズ2) 設計書

`lambda/margin-balance-batch/data-source.ts`のダミー信用残高生成を、J-Quants Standardプランの`mkt-margin-int`/`mkt-margin-alert`エンドポイントへの実呼び出しに差し替える。J-Quantsのプラン変更に先行して着手する。

## 背景・目的

`margin-balance-batch/data-source.ts`は現状(フェーズ1)、信用残データをticker+日付から決定的な擬似乱数で生成するダミー実装になっている(J-Quants Standardプラン移行前の課金を遅らせるため)。設計時点から「フェーズ2ではこのファイルの中身だけをmkt-margin-int/mkt-margin-alert呼び出しに差し替える」方針が決まっていた。ユーザーがまもなくStandardプランへ移行するため、移行前に着手できる部分(コード実装・テスト)を先に完了させる。

## スコープ

**含む**:
- `data-source.ts`のダミー生成を実API呼び出しに差し替え
- CDK(`lib/j-quants-stack.ts`)の`MarginBalanceBatchFunction`にJ-QuantsのAPIキー(`SECRET_ARN`)へのアクセス権限を追加(現状権限が無く、追加しないと動作しない)
- `test/margin-balance-batch-data-source.test.ts`の全面書き換え(実APIをモックする形に)

**含まない(方針決定済み)**:
- `margin-balance-batch/index.ts`の銘柄ごと直列ループの変更。ダミー生成はAPI呼び出しコストが無かったため問題にならなかったが、実APIになるとレート制限がかかる。price-batchで直面したのと同種のタイムアウトリスクが理論上あるが、実際にStandardプランで動かして様子を見てから別途判断する
- `mkt-margin-int`の2026-09-28仕様変更への特別対応。株数系フィールド名(`ShrtStdVol`/`LongStdVol`等)は新旧仕様で同じであることをJ-Quantsドキュメントで確認済みのため、コード側の対応は不要

## エンドポイント調査結果

J-Quantsドキュメント(MCP経由)で実際の仕様を確認した。

### `GET /v2/markets/margin-interest`(週末信用残高、`fetchWeeklyBalances`が呼ぶ)

- `code`+`from`+`to`で指定銘柄の期間分を取得可能(既存の関数シグネチャとそのまま対応する)
- `code`省略+`date`指定で全上場銘柄について指定日のデータを1回で取得可能(ドキュメントで確認済み)。今回は実装しないが、タイムアウト対策時にはこのモードへの切り替えが選択肢になる
- レスポンスの`ShrtStdVol`(制度信用売残高)/`LongStdVol`(制度信用買残高)を使う。`ShrtVol`/`LongVol`(一般信用込みの合計)は使わない — 逆日歩は制度信用固有の仕組みのため
- 2026-09-28に日次配信へ仕様変更予定(現状は週次)。金額系フィールド(`ShrtVal`等)が新規追加されるが未使用。株数系フィールド名は変更されないため、この変更を跨いでコード変更なしで動作する

### `GET /v2/markets/margin-alert`(日々公表信用取引残高、`fetchDailyAlertBalances`が呼ぶ)

- 「日々公表銘柄」に指定された銘柄のみが対象の、`mkt-margin-int`とは別の独立したデータソース
- `code`+`date`で指定銘柄・指定日のデータを取得(`date`パラメータは公表日ベース)
- `code`省略+`date`指定で全上場銘柄について指定日のデータを1回で取得可能(ドキュメントで確認済み)。こちらも同様にタイムアウト対策時の選択肢になる
- レスポンスの`ShrtStdOut`(制度信用売残高)/`LongStdOut`(制度信用買残高)を使う
- `AppDate`(申込日、残高が示す基準日)を`MarginBalancePoint.date`として使う(`PubDate`=公表日ではなく、`fetchWeeklyBalances`の`Date`と意味を揃える)
- 対象外銘柄・対象日にデータが無い場合は空配列が返る(エラーではない)。呼び出し元(`index.ts`)は既存のまま何もしないので変更不要

## コンポーネント詳細

### `lambda/margin-balance-batch/data-source.ts`

`lambda/shared/jquants-batch-client.ts`の`getApiKey`・`fetchWithRetry`を再利用する(price-batch/financial-summary-batchと同じパターン)。

- `SECRET_ARN`・`API_BASE_URL`(デフォルト`https://api.jquants.com/v2`)・`REQUEST_INTERVAL_MS`(デフォルト500ms。このエンドポイント自体がStandardプラン専用のため、Freeプラン向けの13秒デフォルトは不要)・`MAX_RETRIES`(5)を環境変数から読む定数として追加
- `fetchWeeklyBalances`/`fetchDailyAlertBalances`とも、`pagination_key`を追跡するdo-whileループで全ページ取得する(他バッチと同じパターン)
- `fetchDailyAlertBalances(tickers, date)`は配列内の各tickerについて`code`+`date`のクエリを個別に呼ぶ(現状の呼び出し元が`[ticker]`という1件配列でしか呼んでいないが、関数自体は複数件でも正しく動くようにしておく)
- `MarginBalancePoint`インターフェース(`date`/`financingBalance`/`lendingBalance`/`source`)は変更しない

### `lib/j-quants-stack.ts`

`MarginBalanceBatchFunction`に以下を追加(他のJ-Quants呼び出し系バッチと同じパターン):
```ts
environment: {
  YUTAI_MASTER_TABLE_NAME: this.yutaiMasterTable.tableName,
  MARGIN_BALANCE_TABLE_NAME: this.marginBalanceTable.tableName,
  SECRET_ARN: this.apiKeySecret.secretArn,
},
```
```ts
this.apiKeySecret.grantRead(marginBalanceBatchFn);
```

### `test/margin-balance-batch-data-source.test.ts`

全面書き換え。`getApiKey`/`fetchWithRetry`をモックし(`test/price-batch.test.ts`と同じモック構成)、以下を検証する:
- `fetchWeeklyBalances`が正しいURL(`/markets/margin-interest`)・パラメータ(`code`/`from`/`to`)で呼ばれ、`ShrtStdVol`/`LongStdVol`が`lendingBalance`/`financingBalance`に、`Date`が`date`に、`source: 'weekly'`に正しくマッピングされる
- `fetchDailyAlertBalances`が正しいURL(`/markets/margin-alert`)・パラメータ(`code`/`date`)で呼ばれ、`ShrtStdOut`/`LongStdOut`が`lendingBalance`/`financingBalance`に、`AppDate`が`date`に、`source: 'daily-alert'`に正しくマッピングされる
- `pagination_key`が返る場合に2回目のリクエストへ引き継がれる
- 該当データが無い場合(`data: []`)、空配列を返す(エラーにしない)

## 移行後の確認事項

Standardプラン移行・本番デプロイ前後に、以下を順に実施すること(最終レビューで発見)。

1. **`JQuantsMarginBalance`テーブルを空にする(デプロイ前、必須)**: フェーズ1のダミーデータが既に全銘柄分書き込まれている。`hasExistingBalance`判定により、既存データがあるとみなされて実データへの2年分バックフィルが走らず、直近14日分の差分更新にしかならない。さらにダミーデータの日付(`listMondays`が生成していた月曜日付)と実データの週次残高の日付(`Date`項目、通常は金曜日付)は異なるため、同じ週でも別レコードとして共存し、実データが古いダミー値を上書きしない。テーブルを空にすれば`hasExistingBalance`がfalseを返し、通常のbackfillフローで実データに置き換わる。なお`MAX_BACKFILL_TICKERS_PER_RUN`(デフォルト150)により新規バックフィルは1回の実行で150銘柄までしか進まないため、優待実施銘柄が1,000件規模だと全銘柄の実データ復元には週次実行で約7回(≈7週間)かかる。急ぎたい場合は環境変数を一時的に引き上げるか、手動実行を複数回連続で行う。
2. **デプロイ後、手動実行して結果を確認する**: ログの`backfilled`/`diffUpdated`/`deferred`/`failed`件数を確認する。
3. **レート制限によるタイムアウトを確認する(既知のリスクあり)**: `fetchWithRetry`は`REQUEST_INTERVAL_MS`(デフォルト500ms)分スリープするため、1銘柄あたりweekly+daily-alertの2回呼び出しで約1.3〜1.6秒。優待実施銘柄が1,000件規模の場合、単純計算で約23〜25分かかり14分のLambdaタイムアウトを超える可能性が高い(financial-summary-batchで同種の計算が既に文書化済み: `docs/superpowers/specs/2026-08-21-yutai-batch-scale-out-design.md`)。特に`fetchDailyAlertBalances`は「日々公表銘柄」(全銘柄のごく一部)以外にも全銘柄分呼び出しており、その大半が空配列を返すだけの無駄な呼び出しになっている。タイムアウトが発生する場合は、price-batchと同様に`date`のみ指定した一括取得方式(両エンドポイントとも`code`省略+`date`指定で全上場銘柄分を1回で取得可能、ドキュメントで確認済み)への切り替えを検討する。
4. **フロントのダミーデータ注記を外す**: `frontend/src/pages/YutaiListPage.tsx`・`YutaiDetailPage.tsx`の「信用残・貸借判定はダミーデータです」バナーは実データ移行後は不要になる。
