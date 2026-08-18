# バッチ鮮度別分離(サブプロジェクトA) 設計書

全体のロードマップは`docs/superpowers/specs/2026-08-18-yutai-scale-out-roadmap.md`を参照。本書はそのサブプロジェクトA(既存追跡銘柄向けのバッチ鮮度分離)の詳細設計。

## 背景・目的

現状の3バッチ(`BatchFetchFunction`/`MarginBalanceBatchFunction`/`GyakuhibuHistoryBatchFunction`)は、データ種別ごとの実際の更新頻度を無視してすべて日次実行になっている。特に`BatchFetchFunction`は株価(日次が適切)と決算サマリ(四半期ごとしか変わらない)を同じ日次バッチ内で銘柄ごとに2回API呼び出ししており、J-Quants Freeプランのレート制限(5req/分)下では無駄が大きい。また信用残(`MarginBalanceBatchFunction`)も本来は週次更新のデータを日次で取得している(現状はダミーデータのため実害はないが、本番API切替時にズレが顕在化する)。

本サブプロジェクトは、銘柄数を増やす前提(サブプロジェクトB)に入る前段階として、今のウォッチリスト規模のままデータ種別ごとに適切な頻度でバッチを分離し、無駄なAPI呼び出しを無くす。

## スコープ

**含む**:
- `BatchFetchFunction`を株価専用の`PriceBatchFunction`にリネーム・縮小
- 決算サマリ専用の`FinancialSummaryBatchFunction`を新規追加(週次)
- `MarginBalanceBatchFunction`のスケジュールを日次→週次に変更(コード変更なし)
- 上記2バッチが共有するインフラ処理(APIキー取得・対象銘柄取得・レート制限付きfetch・日付正規化)を`lambda/shared/jquants-batch-client.ts`に共通化

**含まない(将来対応)**:
- 信用残の「日々公表銘柄(規制銘柄)は日次」という例外処理。実際のJ-Quants `mkt-margin-alert`のレスポンス形状がStandardプラン移行前の現時点では不明なため対象外とし、今回は信用残を一律週次にする。Standardプラン移行後、実際のレスポンスを見てから別途対応を検討する
- サブプロジェクトB(全銘柄優待マスタの自動収集)全般
- 決算発表予定日(J-Quants `/fins/announcement`等)を使ったイベント駆動化。存在・仕様が未確認のため、まずは単純な週次ポーリングとする

## データ種別ごとの鮮度と変更後の頻度

| データ | 実際の更新頻度 | 変更前 | 変更後 |
|---|---|---|---|
| 株価・出来高(日足) | 取引日ごと | 日次 | 日次(変更なし) |
| 決算サマリ | 四半期ごと | 日次 | **週次** |
| 信用残(融資残・貸株残) | 週次 | 日次 | **週次** |
| 逆日歩実績(taisyaku.jp) | 権利日ごとに1回確定 | 日次スキャン(取得済みはスキップ) | 変更なし |

## アーキテクチャ

```
lambda/
  shared/
    jquants-batch-client.ts   (新規: 共通ヘルパー)
    trading-calendar.ts        (既存、変更なし)
    gyakuhibu-calc.ts          (既存、変更なし)
  price-batch/                 (batch-fetchからリネーム)
    index.ts
  financial-summary-batch/     (新規)
    index.ts
  margin-balance-batch/        (既存、コード変更なし)
  gyakuhibu-history-batch/     (既存、変更なし)
```

## コンポーネント詳細

### `lambda/shared/jquants-batch-client.ts`(新規)

現行`lambda/batch-fetch/index.ts`から以下を移設する(ロジックはそのまま、コピーではなく移動):

- `getApiKey(secretArn): Promise<string>` — Secrets Managerからのキー取得(キャッシュ付き)
- `scanTickerColumn(tableName): Promise<string[]>`
- `getTargetTickers(watchlistTable, yutaiMasterTable): Promise<string[]>` — ウォッチリスト∪優待マスタの和集合
- `fetchWithRetry(url, apiKey, attempt?): Promise<Response>` — 429時の指数バックオフ込み
- `formatDate(date): string` / `normalizeDate(raw): string`

`REQUEST_INTERVAL_MS`・`MAX_RETRIES`は呼び出し側(各Lambda)が環境変数経由で`fetchWithRetry`に渡せるよう、関数の引数化する(現状はモジュールスコープの定数なので、共通化にあたり引数化が必要)。`PriceBatchFunction`と`FinancialSummaryBatchFunction`は同じJ-Quants APIキー(=同じレート制限枠)を使うため、両方とも`REQUEST_INTERVAL_MS`のデフォルト値(13000ms)は変えない。スケジュールが重ならない(日次9:00と週次月11:00)ため、通常は競合しない。

### `lambda/price-batch/index.ts`(`batch-fetch`からリネーム)

現行の`fetchDailyBars`・`upsertBars`・`handler`のうち株価部分のみを残す。`fetchFinancialSummaries`・`upsertFinancialSummaries`・`FINANCIAL_TABLE_NAME`は削除し、`financial-summary-batch`に移す。`handler`は`getTargetTickers`→`fetchDailyBars`→`upsertBars`のみのシンプルなループになる。

### `lambda/financial-summary-batch/index.ts`(新規)

現行`batch-fetch`の`fetchFinancialSummaries`・`upsertFinancialSummaries`をそのまま移設。`handler`は`getTargetTickers`→`fetchFinancialSummaries`→`upsertFinancialSummaries`のループ。

### CDKスタック(`lib/j-quants-stack.ts`)変更

- `BatchFetchFunction`構築子を`PriceBatchFunction`にリネーム(`entry`を`lambda/price-batch/index.ts`に変更、`FINANCIAL_TABLE_NAME`環境変数を削除)
- `FinancialSummaryBatchFunction`を新規追加(`entry: lambda/financial-summary-batch/index.ts`、`TABLE_NAME`不要・`FINANCIAL_TABLE_NAME`/`WATCHLIST_TABLE_NAME`/`YUTAI_MASTER_TABLE_NAME`/`SECRET_ARN`が必要。IAM: financial summaryテーブルへの書き込み権限、watchlist/yutaiMasterテーブルへの読み取り権限、Secretsの読み取り権限)
- `BatchFetchSchedule` → `PriceBatchSchedule`にリネーム、cronは`{ minute: '0', hour: '9' }`のまま
- `FinancialSummaryBatchSchedule`を新規追加: `events.Schedule.cron({ minute: '0', hour: '11', weekDay: 'MON' })`
- `MarginBalanceBatchSchedule`のcronを`{ minute: '30', hour: '9' }`(日次)から`{ minute: '30', hour: '9', weekDay: 'MON' }`(週次)に変更。Lambda本体・IAM権限は変更なし

## データフロー

変更なし(既存の「ウォッチリスト∪優待マスタをスキャン→銘柄ごとにJ-Quants API呼び出し→DynamoDBへupsert」という流れを2つのLambdaに分けるだけ)。

## エラーハンドリング

既存パターンを踏襲: 銘柄ごとにtry/catchし、失敗をログして次の銘柄へ継続する。全体を止めない。変更なし。

## テスト

- `test/batch-fetch.test.ts`を分割:
  - `test/price-batch.test.ts`: 株価取得・upsertのテスト(既存の該当ケースを移設)
  - `test/financial-summary-batch.test.ts`: 決算サマリ取得・upsertのテスト(既存の該当ケースを移設)
- `test/jquants-batch-client.test.ts`(新規): 共通ヘルパー(`getTargetTickers`の和集合・重複排除、`fetchWithRetry`の429リトライ、`formatDate`/`normalizeDate`)の単体テスト
- `test/margin-balance-batch.test.ts`: コード変更がないため既存のまま(スケジュール変更はCDKコードのみの変更でありLambdaロジックのテストには影響しない)

## 移行時の注意

- `PriceBatchFunction`へのリネームによりCloudFormationは新しい論理ID・Lambda関数名で作り直す(旧`BatchFetchFunction`は削除される)。CloudWatch Logsのロググループ名も変わるが、保存済みDynamoDBデータには影響しない
- `FINANCIAL_TABLE_NAME`環境変数を`PriceBatchFunction`から削除するため、デプロイ後は決算サマリの更新が`FinancialSummaryBatchFunction`の週次スケジュール(初回は最大1週間後)を待つ形になる。デプロイ直後に最新化したい場合は手動invokeで対応する
