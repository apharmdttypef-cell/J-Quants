# financial-summary-batch 継続更新の一括日付取得への切り替え 設計書

`lambda/financial-summary-batch`を、既存銘柄の継続更新について銘柄ごとにJ-Quants APIを呼ぶ現行方式から、新規銘柄の初回バックフィルと既存銘柄の継続更新を分離し、継続更新はprice-batch/margin-balance-batchと同じ「日付だけ指定して全上場銘柄分を1回で取得する」方式に切り替える。[GitHub Issue #2](https://github.com/apharmdttypef-cell/J-Quants/issues/2)を解消する。

## 背景・目的

`FinancialSummaryBatchFunction`は銘柄ごとに`/fins/summary?code=X`(全期間分)を直列で呼ぶ設計のまま、優待実施銘柄が1,700件超に増えた現在、**実際に本番でタイムアウトしていることを確認した**(2026-09-03: `Duration: 840000.00ms`、`Status: timeout`、189銘柄のみ処理)。`getTargetTickers()`の返す順序は実行のたびに大きく変わらないため、同じ先頭銘柄群だけが毎週更新され、残りの1,500件超が実質的に取り残されているおそれがある(margin-balance-batchで実際に踏んだのと同じstarvationパターン)。

## エンドポイント調査結果

J-Quantsドキュメント(https://jpx-jquants.com/ja/spec/fin-summary)で確認した`/fins/summary`のパラメータ組み合わせ:

| code | date | 結果 |
|---|---|---|
| ✓ | – | 指定銘柄の全期間分の財務情報データ |
| ✓ | ✓ | 指定銘柄の指定日付の財務情報データ |
| – | ✓ | **全上場銘柄について指定日付に開示された財務情報データ**(一括取得) |

`from`/`to`のような期間範囲パラメータは存在しない。つまり**一括取得(`date`指定)で拾えるのは「その日に開示された分」のみ**であり、過去の四半期決算を遡って取得する用途(新規銘柄の初回バックフィル)には使えない。

また、更新タイミング(https://jpx-jquants.com/ja/spec/data-update)によると、財務情報APIはPremiumプラン以外は日次更新(18:00頃速報、24:30頃確報)。本APIには個別のレートリミットがある(Standardプランでは60req/分、価格・信用残高等の一般エンドポイントの120req/分とは別枠)。

## スコープ

**含む**:
- `lambda/financial-summary-batch/index.ts`: 新規銘柄の初回バックフィル(`code`指定、全期間分)と既存銘柄の継続更新(`date`指定、一括取得)の2モードに分離
- 初回バックフィルは1回の実行あたり上限を設け(`MAX_BACKFILL_TICKERS_PER_RUN`、デフォルト150、margin-balance-batchの旧設計と同じ値)、残りは次回実行に自然に持ち越す
- DynamoDB書き込みのバッチ化(`BatchWriteCommand`、25件ずつ、`UnprocessedItems`リトライ)。margin-balance-batchで実装した同種のロジックを`lambda/shared/dynamodb-batch.ts`(新規)に切り出して両バッチで共有する(同じ非自明なリトライロジックを2箇所で独立に実装するリスクを避けるため。このプロジェクトは通常similar-but-independentな小ロジックの重複を許容する方針だが、`UnprocessedItems`リトライは間違えやすく実害も大きいため今回は共有化する)
- `REQUEST_INTERVAL_MS`のデフォルトを13000→1000に変更(Standardプランの決算系エンドポイント専用レート制限60req/分に合わせる。旧デフォルトはFreeプラン5req/分の想定のまま残っていた)
- CDK(`lib/j-quants-stack.ts`): `FinancialSummaryBatchFunction`に`financialSummaryTable.grantReadData`を追加(新規銘柄判定のクエリに必要。現状は`grantWriteData`のみ)
- `test/financial-summary-batch.test.ts`の全面書き換え

**含まない(方針決定済み)**:
- 初回バックフィル自体を一括取得に変える対応。`date`一括取得では「その日開示分」しか取れず、過去の全期間分を取得する代替手段が無いため、`code`指定の現行ロジックをそのまま使う
- Lambdaの実行スケジュール変更(週次のまま。四半期更新のデータなので変更不要)
- `financial-summary-batch`以外のバッチへの`dynamodb-batch.ts`共通化の遡及適用(margin-balance-batchの`batchUpsert`は今回のスコープ外。将来的に3箇所目が出た時点で検討)

## コンポーネント詳細

### `lambda/shared/dynamodb-batch.ts`(新規)

margin-balance-batchの`batchUpsert`をそのまま切り出す:

```ts
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// DynamoDBのBatchWriteItemは25件までしか受け付けず、スロットリング時はUnprocessedItemsに
// 未処理分を積んで200番台で返す(エラーにはならない)。ここでリトライしないと、書き込みが
// エラーなく黙って欠落する(margin-balance-batchのテーブル一括パージ作業で実際に踏んだ不具合と同じ)。
export async function batchUpsert(
  ddbDocClient: DynamoDBDocumentClient,
  tableName: string,
  items: Record<string, unknown>[],
): Promise<void> {
  for (let i = 0; i < items.length; i += 25) {
    let pending: { PutRequest: { Item: Record<string, unknown> } }[] = items
      .slice(i, i + 25)
      .map((Item) => ({ PutRequest: { Item } }));
    let attempt = 0;

    while (pending.length > 0) {
      const result = await ddbDocClient.send(new BatchWriteCommand({ RequestItems: { [tableName]: pending } }));
      const unprocessed = (result.UnprocessedItems?.[tableName] ?? []) as typeof pending;
      if (unprocessed.length === 0) break;

      attempt += 1;
      if (attempt > 10) {
        throw new Error(`batchUpsert: too many retries, ${unprocessed.length} items still unprocessed`);
      }
      await sleep(Math.min(2000, 100 * 2 ** attempt));
      pending = unprocessed;
    }
  }
}
```

`lambda/margin-balance-batch/index.ts`はこの関数をimportして使うように変更する(既存のprivate関数を削除し、置き換える)。

### `lambda/financial-summary-batch/index.ts`

```ts
const FINANCIAL_TABLE_NAME = process.env.FINANCIAL_TABLE_NAME!;
const WATCHLIST_TABLE_NAME = process.env.WATCHLIST_TABLE_NAME!;
const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
const SECRET_ARN = process.env.SECRET_ARN!;
const REQUEST_INTERVAL_MS = Number(process.env.REQUEST_INTERVAL_MS ?? '1000');
const MAX_RETRIES = 5;
// 新規銘柄1件の初回バックフィルは全期間分の逐次書き込みを伴うため、YutaiMasterへの
// 一括追加(kabuyutai優待抽出の改善による再取得等)直後は対象銘柄が一気に膨らみ、
// 14分のタイムアウト内に完走できなくなる。新規バックフィルの件数だけ実行あたりに
// 上限を設け、残りは次回実行に持ち越す(継続更新は一括取得で軽いので上限の対象外)。
const MAX_BACKFILL_TICKERS_PER_RUN = Number(process.env.MAX_BACKFILL_TICKERS_PER_RUN ?? '150');
// 決算発表は不定期に集中するため、週次実行(7日間隔)に対して2倍のバッファを持たせる。
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? '14');
```

処理の流れ:
1. `getTargetTickers()`(既存のまま)で対象銘柄一覧を取得
2. 各銘柄について`hasExistingSummary(ticker)`(`FINANCIAL_TABLE_NAME`をticker+`Limit:1`でクエリ、margin-balance-batchの`hasMarginBalance`と同じパターン)で「新規(バックフィル要)」か「継続更新」かを判定
3. 新規銘柄について、`MAX_BACKFILL_TICKERS_PER_RUN`件を上限に`code`指定(全期間分)で取得・バッチ書き込み。上限超過分はログに件数を出して次回に持ち越す
4. 直近`LOOKBACK_DAYS`日間の暦日それぞれについて`date`指定の一括取得を行い、対象銘柄でフィルタ(price-batchの`resolveTargetBars`と同じ4桁prefix/5桁完全一致・普通株式優先ロジックをこのファイル内に複製)してバッチ書き込み。**新規銘柄もこのループの対象に含める**(バックフィルの順番待ち中でも直近の開示だけは早く反映されるため、除外する理由がない)
5. 集計ログ(バックフィル件数、継続更新で一致した日付ごとの件数、上限到達による持ち越し件数)を出力

### `lib/j-quants-stack.ts`

`FinancialSummaryBatchFunction`に`this.financialSummaryTable.grantReadData(financialSummaryBatchFn);`を追加(新規銘柄判定のクエリに必要)。スケジュール(週次)・タイムアウト(14分)は変更しない。

## テスト方針

### `test/financial-summary-batch.test.ts`(全面書き換え)

- 新規銘柄(`hasExistingSummary`がfalse)は`code`指定で全期間分を取得すること
- 既存銘柄(`hasExistingSummary`がtrue)は`code`指定の呼び出しをスキップし、`date`一括取得の対象になること
- `date`一括取得が`LOOKBACK_DAYS`日分(暦日)呼ばれ、対象銘柄でフィルタされた分だけ書き込まれること(対象外銘柄のデータが書き込まれない)
- 新規銘柄が`MAX_BACKFILL_TICKERS_PER_RUN`を超える場合、超過分がバックフィルされず次回に持ち越されること(既存データがある銘柄は上限と無関係に継続更新される)
- `BatchWriteCommand`が`UnprocessedItems`を返した場合にリトライすること

### `test/dynamodb-batch.test.ts`(新規)

`batchUpsert`単体のテスト(25件区切り、`UnprocessedItems`リトライ、10回超過時の例外)。

### `test/margin-balance-batch.test.ts`

`batchUpsert`のimport元が変わるだけで、テスト内容(モックの`BatchWriteCommand`呼び出し検証)は変更不要。

## 移行時の注意

- 環境変数: `REQUEST_INTERVAL_MS`のデフォルトが13000→1000に変わる。CDK側で明示的にこの環境変数を設定していないことを確認済み(コード側のデフォルト値のみに依存)
- 初回デプロイ後、当面は毎週150件ずつ新規銘柄のバックフィルが進む。現在推定300件超が「新規」判定になる見込み(kabuyutai優待抽出の改善で今後増える`JQuantsYutaiMaster`の銘柄のうち`JQuantsFinancialSummary`に未反映のもの)のため、フル反映まで2〜3週間かかる見込み。急ぐ場合は`MAX_BACKFILL_TICKERS_PER_RUN`を一時的に引き上げるか、手動実行を複数回行う
