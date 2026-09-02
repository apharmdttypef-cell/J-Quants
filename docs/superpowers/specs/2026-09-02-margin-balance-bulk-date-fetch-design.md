# margin-balance-batch 全銘柄一括日付取得への切り替え 設計書

`lambda/margin-balance-batch`を、銘柄ごとにJ-Quants APIを呼ぶ現行方式から、price-batchと同じ「日付だけ指定して全上場銘柄分を1回で取得する」方式に切り替える。あわせてDynamoDBへの書き込みをバッチ化する。

## 背景・目的

2026-09-02にmargin-balance-batchを実API(`mkt-margin-int`/`mkt-margin-alert`)化し、本番デプロイ・DynamoDBテーブルの初期パージ・手動バックフィルを実施した。その過程で、銘柄ごとにAPIを呼ぶ現行方式には実行時間が銘柄数に比例して増え続ける構造的な問題があることが実測で確認された。

- 差分更新(既に実データがある銘柄への直近14日分の更新)は`MAX_BACKFILL_TICKERS_PER_RUN`の上限対象外のため、実データを持つ銘柄が増えるほど**必ず**処理される銘柄数が増える
- 手動実行を重ねた結果、実データ保有銘柄が443件に達した時点で13分15秒(14分の上限まで45秒)、583件相当の処理量で14分の上限に達し実際にタイムアウトした(`Sandbox.Timedout`)
- 全1,240銘柄に実データが揃った定常状態を単純計算すると、差分更新だけで約28分かかり、**恒常的にタイムアウトする**。しかもタイムアウトは銘柄リストの同じ順序の途中で毎回発生するため、リスト後半の銘柄群が恒久的に更新されないまま取り残される

この問題を、price-batchで`/equities/bars/daily`に対して既に採用している「日付のみ指定して全上場銘柄分を1回のリクエストで取得し、対象銘柄でフィルタする」方式に倣って解消する。

## 検証済みの前提

- `mkt-margin-int`(`/markets/margin-interest`)・`mkt-margin-alert`(`/markets/margin-alert`)とも、`code`を省略し`date`のみ指定すると「全上場銘柄について指定日のデータ」が1回のリクエストで返る(J-Quantsドキュメントで確認済み)
- 上記の切り替えだけではAPI呼び出し回数は劇的に減る(1,240銘柄×2回/銘柄 → 日付の数だけ)が、**DynamoDBへの書き込み件数は減らない**。特に大量の銘柄が同時に未カバーの状態(現在の状況)では、1件ずつ`PutCommand`で書き込む現行方式のままだと書き込み側がボトルネックになりタイムアウトしうる。試算: 1,240銘柄×約104週分 ≈ 129,000件を1件ずつ(仮に10ms/件)書き込むと約21分。バッチ書き込み(25件/回)にすれば約5,160回のリクエストで数分に収まる
- 上記2点を踏まえると、「新規銘柄かどうかを判定してバックフィル/差分更新を出し分ける」現行のロジック自体が不要になる。日付一括取得+バッチ書き込みにより、**過去2年分を毎回丸ごと取得・書き込みしても数分で完走する**ため、判定ロジックを削除してシンプルにする(ユーザー承認済み)

## スコープ

**含む**:
- `lambda/margin-balance-batch/data-source.ts`: 銘柄別関数(`fetchWeeklyBalances`/`fetchDailyAlertBalances`)を削除し、日付別の全銘柄一括取得関数に置き換える
- `lambda/margin-balance-batch/index.ts`: 銘柄ループ→日付ループへ全面書き換え。`hasExistingBalance`・`MAX_BACKFILL_TICKERS_PER_RUN`・バックフィル/差分更新の区別を削除。DynamoDB書き込みを`BatchWriteCommand`(25件区切り、`UnprocessedItems`が返った場合の指数バックオフ付きリトライ)に変更
- `test/margin-balance-batch-data-source.test.ts`・`test/margin-balance-batch.test.ts`の全面書き換え

**含まない(方針決定済み)**:
- 金曜日の列挙は単純な曜日計算のみ(祝日等でその金曜のデータが存在しない週はAPIが空配列を返すだけで、取りこぼしを許容する。ユーザー承認済み)
- `mkt-margin-int`の2026-09-28仕様変更(日次配信化)への追加対応。株数系フィールド名は新旧で変わらない前提を維持(既存の設計書のとおり)
- 既に投入済みの実データの整合性チェックやクリーンアップ。全て冪等な`upsert`のため、再取得・再書き込みしても害はない

## コンポーネント詳細

### `lambda/margin-balance-batch/data-source.ts`

`MarginBalancePoint`に`code`フィールドを追加する(1回のレスポンスに複数銘柄分が混在するため、呼び出し元でのフィルタに必要):

```ts
export interface MarginBalancePoint {
  code: string;
  date: string;
  financingBalance: number;
  lendingBalance: number;
  source: 'weekly' | 'daily-alert';
}
```

既存の`fetchWeeklyBalances(ticker, from, to)`・`fetchDailyAlertBalances(tickers, date)`を削除し、以下に置き換える:

```ts
export async function fetchAllWeeklyBalancesForDate(date: string, apiKey: string): Promise<MarginBalancePoint[]>
export async function fetchAllDailyAlertBalancesForDate(date: string, apiKey: string): Promise<MarginBalancePoint[]>
```

- どちらも`code`を付けず`date`のみでクエリし(`pagination_key`はページング処理を残す)、`ShrtStdVol`/`LongStdVol`(または`ShrtStdOut`/`LongStdOut`)を制度信用分として使うのは現行のまま
- 日付は`normalizeDate()`で正規化して`MarginBalancePoint.date`に入れる(現行のまま)
- `fetchAllDailyAlertBalancesForDate`は常に`today`一日分のみ呼ぶ(履歴バックフィルはしない。現行のふるまいを維持)

### `lambda/margin-balance-batch/index.ts`

```ts
const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
const MARGIN_BALANCE_TABLE_NAME = process.env.MARGIN_BALANCE_TABLE_NAME!;
const SECRET_ARN = process.env.SECRET_ARN!;
// 週次データを何日分遡って取得するか。2年分(price-batchのLOOKBACK_DAYSとは無関係の別Lambda環境変数)。
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? String(2 * 365));
```

処理の流れ:
1. `getYutaiTickers()`(既存のまま)で対象銘柄一覧を取得し`Set`化
2. `getApiKey(SECRET_ARN)`を一度だけ呼ぶ(`../shared/jquants-batch-client`)
3. 直近`LOOKBACK_DAYS`日間の毎週金曜日の日付リストを曜日計算で生成(`getUTCDay() === 5`)
4. 各金曜日について: `fetchAllWeeklyBalancesForDate` → 対象銘柄でフィルタ(price-batchの`resolveTargetBars`と同じ4桁prefix/5桁完全一致・普通株式優先ロジックをこのファイル内に複製) → `BatchWriteCommand`でバッチ書き込み
5. `today`について: `fetchAllDailyAlertBalancesForDate` → 同様にフィルタ・バッチ書き込み
6. 日付ごと・全体の集計を`console.log`に出力(処理した日付数、書き込んだ件数)

`hasExistingBalance`・`MAX_BACKFILL_TICKERS_PER_RUN`・`BACKFILL_DAYS`・`DIFF_LOOKBACK_DAYS`は削除する。

### DynamoDBバッチ書き込み

```ts
async function batchUpsert(items: Record<string, unknown>[]): Promise<void> {
  for (let i = 0; i < items.length; i += 25) {
    let pending = items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } }));
    let attempt = 0;
    while (pending.length > 0) {
      const result = await ddbDocClient.send(
        new BatchWriteCommand({ RequestItems: { [MARGIN_BALANCE_TABLE_NAME]: pending } }),
      );
      const unprocessed = result.UnprocessedItems?.[MARGIN_BALANCE_TABLE_NAME] ?? [];
      if (unprocessed.length === 0) break;
      attempt += 1;
      if (attempt > 10) throw new Error(`batchUpsert: too many retries, ${unprocessed.length} items still unprocessed`);
      await sleep(Math.min(2000, 100 * 2 ** attempt));
      pending = unprocessed as typeof pending;
    }
  }
}
```

`UnprocessedItems`のリトライを省略すると、DynamoDBのスロットリング時に書き込みが黙って欠落する(今回のテーブルパージ作業で実際に踏んだ不具合と同じ)。本番コードでは必ずリトライを実装する。

## テスト方針

### `test/margin-balance-batch-data-source.test.ts`(全面書き換え)

- `fetchAllWeeklyBalancesForDate`が`code`なし・`date`ありでURLを組み立てること
- `pagination_key`が返る場合に次ページへ引き継がれること
- `ShrtStdVol`/`LongStdVol`→`lendingBalance`/`financingBalance`、`Code`→`code`、`Date`→`date`(normalizeDate適用)のマッピング
- `fetchAllDailyAlertBalancesForDate`も同様に`AppDate`(`PubDate`ではない)を使うことを含めて検証
- 該当データが無い場合(`data: []`)、空配列を返す

### `test/margin-balance-batch.test.ts`(全面書き換え)

- 金曜日の日付リストが正しく生成されること(曜日フィルタ)
- 各日付について`fetchAllWeeklyBalancesForDate`が呼ばれ、対象銘柄でフィルタされた分だけ`BatchWriteCommand`で書き込まれること
- 対象外銘柄のデータが書き込まれないこと
- `today`について`fetchAllDailyAlertBalancesForDate`が1回だけ呼ばれること
- `BatchWriteCommand`が`UnprocessedItems`を返した場合にリトライすること

## 移行時の注意

- 環境変数: `BACKFILL_DAYS`・`DIFF_LOOKBACK_DAYS`・`MAX_BACKFILL_TICKERS_PER_RUN`を廃止し、`LOOKBACK_DAYS`(デフォルト730)に統一する。CDK(`lib/j-quants-stack.ts`)の`MarginBalanceBatchFunction`定義はこれらの環境変数を個別に設定していない(コード側のデフォルト値のみに依存)ため、CDK側の変更は不要(確認済み)
- 既に投入済みの実データ(パージ後の手動バックフィルで入った分)はそのまま活きる。今回の切り替え後の初回実行で冪等に上書きされるだけで、データ消失や不整合は発生しない
- 週次スケジュール(月曜JST18:30)はそのまま。実行時間は銘柄数に依存せず数分程度に短縮される見込み
