# 信用残データソースのtaisyaku.jp移行 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `MarginBalanceBatchFunction`の信用残取得元をJ-Quants Standard専用エンドポイントからtaisyaku.jp(日証金)の全銘柄一括CSVに切り替え、現在需給予測・信用残トレンド・貸借判定をStandardプランに依存しない形にする。

**Architecture:** 基準日ごとに`GET /app/stock`→`POST /app/stock/search`→`GET /app/stock/csv`の3リクエストで全銘柄のCSV(CP932)を取り、`市場区分`=`東証`かつ優待マスタにある銘柄だけを`JQuantsMarginBalance`へ`source`=`taisyaku`でupsertする。差分取得の状態は同テーブルの管理行(`ticker`=`__cursor__`)に持つ。読む側(現在需給予測・`margin-trend`・予測APIの`latest`)は`source`=`taisyaku`の行だけを使い、`tseMarginFeatures`フラグは削除して常時有効にする。貸借判定は既存の`marginName`を使う。

**Tech Stack:** AWS CDK (TypeScript), Lambda Node.js 22, DynamoDB DocumentClient, jest + ts-jest(ルート), CloudWatch Alarm + SNS, React 19 + recharts 3(フロント、テスト基盤なし)

設計書: [docs/superpowers/specs/2026-10-24-margin-balance-taisyaku-design.md](../specs/2026-10-24-margin-balance-taisyaku-design.md)(「実装前レビューでの変更(2026-10-24)」節が最優先)
Task 0調査: [docs/superpowers/notes/2026-08-13-taisyaku-csv-format.md](../notes/2026-08-13-taisyaku-csv-format.md)の末尾「追記(2026-10-24…)」

## Global Constraints

全タスクを縛る値。各タスクはこの節を暗黙の要件として含む。

**taisyaku.jp取得**
- 取得URL(3ステップ、同じセッションCookieを使い回す):
  1. `GET https://www.taisyaku.jp/app/stock` → `Set-Cookie`と`<input name="csrf_test_name" value="...">`
  2. `POST https://www.taisyaku.jp/app/stock/search`、`Content-Type: application/x-www-form-urlencoded`、ボディは`csrf_test_name`と`mkYmd`(`"YYYY / MM / DD"`)の**2項目だけ**
  3. `GET https://www.taisyaku.jp/app/stock/csv`
- User-Agentは既存の`'Mozilla/5.0 (compatible; JQuantsYutaiBot/1.0)'`
- `REQUEST_INTERVAL_MS`=`1000`(既定値も1000)。3リクエストの各間と、日付と日付の間に空ける
- CSVはCP932。`new TextDecoder('shift_jis')`でデコードする(UTF-8フォールバックはしない)
- CSVヘッダー(14列、全角括弧、完全一致で検証):
  `"銘柄コード","銘柄名","市場区分","貸借区分","基準日","制限措置等","融資残高（株）","貸株残高（株）","差引残高（株）","最高料率（円）","最低料率（円）","品貸料率（円）","品貸料率（年率換算/％）","応札ランク"`
- 改行は`\r\n`と`\n`が混在しうる(実サンプルはヘッダー行だけ`\r\n`)。`/\r?\n/`で分割する
- 使う行は`市場区分`=`東証`だけ。行の日付は**検索に使った`mkYmd`**(CSVの`基準日`は次の権利基準日なので使わない)
- 融資残高・貸株残高が`-`・空・非整数の行は保存しない(0として保存しない)
- 検索結果ページに`検索結果&nbsp;0件`(正規表現`/検索結果(?:&nbsp;|\s)*0件/`)が出たら、CSVを取らずに「0件」とする

**DynamoDB**
- 保存する行: `{ ticker, date: 'YYYY-MM-DD', financingBalance: number, lendingBalance: number, source: 'taisyaku' }`。`ticker`はCSVの`銘柄コード`(4文字、`130A`のような英字入りもある)と優待マスタの`ticker`の完全一致
- カーソル行のキー: `{ ticker: '__cursor__', date: 'taisyaku' }`。属性は`lastFetchedDate: 'YYYY-MM-DD'`と`updatedAt: ISO 8601`
- `source`と`date`はDynamoDBの予約語なので式では`#source`/`#date`を使う
- 旧データの`source`は`'weekly'`と`'daily-alert'`

**差分取得**
- 「今日」はJST(`new Date(now + 9h).toISOString().slice(0, 10)`)
- 対象日は`getLocalTradingCalendar(from, today)`の営業日(`isTradingDay`)だけ、昇順
- 初回(カーソル無し): `from = today − 1095日`(3年 = `3 × 365` = 1095日。2026-10-23基準で2023-10-24〜、営業日738日)
- 通常: `from = lastFetchedDate`(**カーソルの日自体も毎回取り直す**)
- 1回の上限`MAX_DATES_PER_RUN`=`40`(既定値も40)。古い日から順に処理する
- 0件の日: その日が`today`なら「未公表」としてカーソルを進めずに打ち切る。`today`より前なら「休場日(ローカル祝日計算に無い12/31等)または公開範囲外」とみなして警告ログを出し、カーソルを進めて続行する(後述「判断」参照)
- 取得失敗(HTTPエラー・CSRF取得失敗・DynamoDB書き込み失敗): ログを出してその回の取得を打ち切る(カーソルは最後に成功した日のまま)
- CSVヘッダー不一致: `TaisyakuCsvFormatError`を投げてバッチを失敗させる
- 1件も成功せず失敗が1件以上ならhandlerの最後に例外を投げる。成功した日があるのに優待マスタの銘柄に1件もマッチしなかった場合も例外

**CDK**
- `MarginBalanceBatchSchedule`: `events.Schedule.cron({ minute: '15', hour: '10', weekDay: 'MON-FRI' })` = `cron(15 10 ? * MON-FRI *)` = JST平日19:15。フラグに関係なく常に作る
- `MarginBalanceBatchFunction`: タイムアウト14分(840秒)のまま、メモリ256MBのまま。環境変数は`YUTAI_MASTER_TABLE_NAME`・`MARGIN_BALANCE_TABLE_NAME`・`REQUEST_INTERVAL_MS: '1000'`・`MAX_DATES_PER_RUN: '40'`の4つだけ(`SECRET_ARN`は削除、シークレット読み取り権限も削除)。権限は優待マスタ読み取り・信用残テーブル読み書き
- SNSトピック: construct ID `JQuantsBatchAlarmTopic`(スタック内で1つ)、`EmailSubscription(ALERT_EMAIL)`
- CloudWatchアラーム(construct ID `MarginBalanceBatchErrorsAlarm`): `marginBalanceBatchFn.metricErrors({ period: Duration.days(1), statistic: 'Sum' })`、`threshold: 1`、`comparisonOperator: GREATER_THAN_OR_EQUAL_TO_THRESHOLD`、`evaluationPeriods: 2`、`datapointsToAlarm: 2`、`treatMissingData: NOT_BREACHING`、アクションは上記トピック
- `ALERT_EMAIL`はスタックのコンストラクタ冒頭で`process.env.ALERT_EMAIL`から読み、未設定・空文字なら`throw new Error('ALERT_EMAIL is required ...')`
- 削除するもの: `tseMarginFeatures`コンテキスト(コードと`cdk.json`の`"tseMarginFeatures": false`)、`TSE_MARGIN_FEATURES_ENABLED`(予測バッチ・reference-api)、`features.tseMargin`(API応答とフロントの型)、`YutaiRiskPrecomputeBatchFunction`の`MARGIN_BALANCE_TABLE_NAME`と信用残テーブル読み取り権限

**文言**
- 画面・ツールチップの「東証信用残」「東証貸株残」は「日証金の貸借取引残高」「日証金の貸株残」に、「スタンダードプラン限定の情報です。」は削除
- グラフ注記: 「日本証券金融の貸借取引残高(融資残・貸株残)。取引所公表の信用残とは異なります」
- `scenario`値`'current-tse'`・属性名`tseForecast`・`_POOL_TSE_`・`financingBalance`/`lendingBalance`は**改名しない**

**テスト・コミット**
- テストは該当ファイルだけ実行する: `npx jest test/xxx.test.ts`。全体は最後のTaskで1回だけ `NODE_OPTIONS=--max-old-space-size=4096 npx jest -i`(PowerShellなら`$env:NODE_OPTIONS='--max-old-space-size=4096'; npx jest -i`)
- テストファイルはトップレベルに`import`か`export {};`を持つ(TS2451の衝突回避、既存ルール)
- フロントはテストを書かない。`cd frontend; npm run build`(`tsc -b && vite build`)と`npm run lint`を通す
- コミットはタスクごとに1つ。メッセージは英語、動詞始まりの1文(既存git logの文体)。末尾に`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## 判断(計画で決めたこと)

1. **`MAX_DATES_PER_RUN`=40**。1日分の所要時間の見積り: リクエスト間隔 1秒×3(2ステップ間+日付間) ≒ 3秒、HTTP 3回(HTML 40KB・75KB、CSV 約470KB) ≒ 1〜3秒、DynamoDB書き込み(優待マスタ1,642銘柄のうち東証行にマッチする約1,500件 ÷ 25件 = 約60回のBatchWrite) ≒ 2〜3秒、合計 約8秒、悪い側で12秒。40日 × 12秒 = 480秒で、タイムアウト840秒に対し4割以上の余裕がある。60日だと720秒で余裕が1割強しかないため40にする
2. **バックフィルの所要**: 3年分の営業日は738日(2026-10-23基準、ローカル祝日計算)。1回あたり新規39日(40日のうち1日はカーソル日の取り直し)なので19回。定期実行だけなら平日19回 ≒ 約4週間。README(Task 10)に、デプロイ直後は手動で同期invokeを繰り返して当日中(1回7〜8分 × 19回 ≒ 2.5時間)に追いつく手順を書く。同時実行はカーソルが競合するので、前の実行の完了を待ってから次を呼ぶ
3. **0件の日の扱い**(設計書「実装前レビュー」2の補足): 設計書は「営業日なのに0件なら未公表としてカーソルを進めずに終える」だが、ローカル祝日計算(`getLocalTradingCalendar`)は東証の休場日12/31を営業日として返す(1/2・1/3も平日なら同様)。この規則のままだと毎年12/31でカーソルが止まり、例外も出ないためアラームにも乗らない。Task 0で前営業日分は翌朝には取得できていたので、(ユーザー承認済み、2026-10-24)「0件で未公表とみなすのは`today`だけ、それより前の0件は休場日とみなして進める」とする。3年より古い日(公開範囲外)を指定した場合も同じ扱いで前に進む
4. **「最終保存日が最新の場合」**: 設計書テスト方針の「取得なし」は「毎回直近1営業日は取り直す」と矛盾するので、「カーソル日の取り直し1日だけ」を期待値にする
5. **取得失敗時は打ち切り**: カーソルを連続した最後の成功日で表すため、失敗した日を飛ばして先へ進まない。次回の実行で失敗した日から取り直す
6. **信用残バッチは平日UTC 10:15(JST 19:15)に実行する**(ユーザー承認済み、2026-10-24): 予測バッチ`GyakuhibuForecastBatchSchedule`(UTC 10:40、変更しない)より前に終わらせ、現在需給予測が当日公表分までの残高で計算されるようにする。同じtaisyaku.jpを叩く`GyakuhibuHistoryBatchSchedule`(UTC 10:00)と開始をずらす。19:15に当日分が未公表なら(0件=today)翌営業日の実行で拾われる
7. **J-Quants削除のタイミング**: Task 1〜3は新しい関数を`data-source.ts`等に**追加**するだけにし、J-Quants呼び出しの削除はhandlerの切り替えと同じTask 4のコミットで行う(コミットメッセージに`margin-balance-jquants-final`を記載。タグは作成済み)
8. **デプロイ順**: 新しいフロントは`features`を読まないので、旧APIに対しても動く。逆に旧フロントは新APIの応答に`features`が無いと`listState.data?.features.tseMargin`で例外になる。したがって**フロント(S3 sync + CloudFront invalidation)を先に、`cdk deploy`を後に**行う(Task 10でREADMEに書く)

## File Structure

| ファイル | 責務 |
|---|---|
| `test/fixtures/taisyaku/stock-20261023.cp932.csv`(新) | 実CSVのサンプル(CP932バイナリ、ヘッダー+5行) |
| `lambda/margin-balance-batch/data-source.ts`(変更) | `parseTaisyakuBalanceCsv`・`fetchTaisyakuBalanceCsv`・`TaisyakuCsvFormatError`。J-Quants呼び出しはTask 4で削除 |
| `lambda/gyakuhibu-history-batch/taisyaku-client.ts`(変更) | `toSlashDate`・`cookieHeaderFrom`・`USER_AGENT`・`TAISYAKU_BASE_URL`に`export`を付けるだけ |
| `lambda/margin-balance-batch/fetch-plan.ts`(新) | 差分取得の対象日算出(純粋関数)・JSTの今日・カーソルのキー定数 |
| `lambda/margin-balance-batch/index.ts`(変更) | handler(カーソル読み書き・日付ループ・upsert・失敗判定) |
| `lambda/yutai-risk-precompute-batch/index.ts`(変更) | `hasMarginBalance`を`marginName === '貸借'`に置き換え |
| `lambda/gyakuhibu-forecast-batch/{index.ts,tse-forecast.ts}`(変更) | フラグ削除・`source`=`taisyaku`だけ読む |
| `lambda/shared/gyakuhibu-forecast.ts`(変更) | コメントの文言だけ |
| `lambda/reference-api/index.ts`(変更) | フラグと`features`削除、`margin-trend`と`latest`の日付範囲+`source`フィルタ、`lendingRatio` |
| `lib/j-quants-stack.ts`・`cdk.json`(変更) | スケジュール・環境変数・権限・SNS・アラーム・`ALERT_EMAIL`・フラグ削除 |
| `frontend/src/api/types.ts`・`components/YutaiForecastSections.tsx`・`pages/YutaiListPage.tsx`(変更) | `features`削除、文言、貸借倍率の第2軸と基準線・注記 |
| `lambda/shared/dynamodb-batch.ts`(変更) | `batchDelete`の追加 |
| `scripts/lib/legacy-margin-balance.ts`・`scripts/cleanup-legacy-margin-balance.ts`(新) | 旧データ削除スクリプト(実行はしない) |
| `README.md`(変更) | 構成図・Lambda表・フラグ節の削除・デプロイ/バックフィル/旧データ削除の手順 |

---

## Task 1: taisyaku.jp一括CSVのパーサーとフィクスチャ

**目的:** 全銘柄一括CSVを`MarginBalancePoint[]`にする純粋関数を、実CSVのフィクスチャで固める。

**Files:**
- Create: `test/fixtures/taisyaku/stock-20261023.cp932.csv`(コピー)
- Modify: `lambda/margin-balance-batch/data-source.ts`(追加のみ。J-Quants関数はまだ残す)
- Create: `test/margin-balance-taisyaku-parse.test.ts`

**Interfaces:**
- Consumes: `splitCsvLine(line: string): string[]`(`lambda/gyakuhibu-history-batch/taisyaku-client.ts`、export済み。前後のダブルクォート除去込み)
- Produces:
```ts
export interface MarginBalancePoint {
  code: string;
  date: string;
  financingBalance: number | null; // taisyaku行は常にnumber。J-Quants関数の削除(Task 4)までは型を広いまま残す
  lendingBalance: number | null;
  source: 'weekly' | 'daily-alert' | 'taisyaku';
}
export const TAISYAKU_BALANCE_CSV_HEADER: readonly string[]; // Global Constraintsの14列(クォート無し)
export class TaisyakuCsvFormatError extends Error {}
export function parseTaisyakuBalanceCsv(csvText: string, date: string): MarginBalancePoint[];
```

- [ ] **Step 1: フィクスチャをコピーする**

```bash
mkdir -p test/fixtures/taisyaku
cp "C:/Users/あーる/AppData/Local/Temp/claude/c--workspaces-J-Quants/f78bc4ef-2cea-47d1-87d0-29fa1d3a356d/scratchpad/tj/sample-20261023.cp932.csv" test/fixtures/taisyaku/stock-20261023.cp932.csv
```

内容(UTF-8に直した場合。ヘッダー行だけ末尾`\r\n`、データ行は`\n`):
```
"銘柄コード",...,"応札ランク"
"1301","極洋","東証","貸借","20270331","","7200","7200","0","9.20","0.00","*****","*****","-"
"3197","すかいらーくＨＤ","東証","貸借","20261231","","12900","138400","-125500","7.20","0.00","0.20","2.07","F"
"7203","トヨタ自動車","東証","貸借","20270331","","639600","800","638800","6.20","0.00","-","-","-"
"7203","トヨタ自動車","名証","貸借","20270331","","0","0","0","6.20","0.00","-","-","-"
"9418","ＵＮＥＸＴ","東証","貸借","20270228","","81900","81900","0","3.80","0.00","*****","*****","-"
```
(銘柄名はUTF-8変換後の表示例。テストでは銘柄名を検証しない)

**バイナリのままgitに入れる**こと。`.gitattributes`が無いので通常は問題ないが、`git diff --stat`で改行変換されていないこと(707バイトのまま)を確認する。

- [ ] **Step 2: 失敗するテストを書く** (`test/margin-balance-taisyaku-parse.test.ts`)

フィクスチャの読み込み:
```ts
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseTaisyakuBalanceCsv, TaisyakuCsvFormatError, TAISYAKU_BALANCE_CSV_HEADER } from '../lambda/margin-balance-batch/data-source';

const fixtureText = new TextDecoder('shift_jis').decode(
  readFileSync(join(__dirname, 'fixtures', 'taisyaku', 'stock-20261023.cp932.csv')),
);
const HEADER_LINE = TAISYAKU_BALANCE_CSV_HEADER.map((h) => `"${h}"`).join(',');
```

テストケース:
1. 実CSV(CP932→デコード)から東証行だけを、検索日を日付にして返す:
   `parseTaisyakuBalanceCsv(fixtureText, '2026-10-23')` が
   ```ts
   [
     { code: '1301', date: '2026-10-23', financingBalance: 7200, lendingBalance: 7200, source: 'taisyaku' },
     { code: '3197', date: '2026-10-23', financingBalance: 12900, lendingBalance: 138400, source: 'taisyaku' },
     { code: '7203', date: '2026-10-23', financingBalance: 639600, lendingBalance: 800, source: 'taisyaku' },
     { code: '9418', date: '2026-10-23', financingBalance: 81900, lendingBalance: 81900, source: 'taisyaku' },
   ]
   ```
   と`toEqual`(7203の名証行は含まない。`基準日`20270331は使わない。ヘッダー行末の`\r`があっても通る)
2. 融資残高が`-`の行、貸株残高が空の行は捨てる: `HEADER_LINE`+`"1111","A","東証","貸借","20270331","","-","100","0","1.00","0.00","-","-","-"`+`"2222","B","東証","貸借","20270331","","100","","0","1.00","0.00","-","-","-"`+`"3333","C","東証","貸借","20270331","","10","20","-10","1.00","0.00","-","-","-"` → `[{ code: '3333', ..., financingBalance: 10, lendingBalance: 20 }]`のみ
3. 桁区切りのある値(防御): `"4444","D","東証","貸借","20270331","","1,234","5,678","-4,444",...` → `financingBalance: 1234, lendingBalance: 5678`
4. 英字入りコードはそのまま: `"130A",...,"東証",...,"500","600",...` → `code: '130A'`
5. ヘッダーのみ → `[]`。空文字`''` → `[]`
6. 列数が14でない行は警告ログを出して捨て、他の行は返す(`jest.spyOn(console, 'warn')`で1回呼ばれたことを確認)
7. ヘッダー不一致で例外: `'融資残高（株）'`を`'融資残高'`に置き換えたヘッダー → `toThrow(TaisyakuCsvFormatError)`。列を1つ削ったヘッダーも同様。HTML(`'<html><body>error</body></html>'`)も同様
8. `TAISYAKU_BALANCE_CSV_HEADER`の長さが14で、7番目(index 6)が`'融資残高（株）'`、8番目が`'貸株残高（株）'`

- [ ] **Step 3: 失敗を確認する**

Run: `npx jest test/margin-balance-taisyaku-parse.test.ts`
Expected: FAIL(`parseTaisyakuBalanceCsv`がexportされていない)

- [ ] **Step 4: 実装する** (`data-source.ts`に追加)

要点:
- `import { splitCsvLine } from '../gyakuhibu-history-batch/taisyaku-client';`
- `MarginBalancePoint.source`の型に`'taisyaku'`を足す
- `csvText.split(/\r?\n/)`。先頭行を`splitCsvLine`し、`TAISYAKU_BALANCE_CSV_HEADER`と長さ・各要素が完全一致しなければ`TaisyakuCsvFormatError`(`message`に実際のヘッダー先頭200文字を含める)。ただし`csvText.trim() === ''`なら`[]`
- 列の位置は`TAISYAKU_BALANCE_CSV_HEADER.indexOf('銘柄コード' | '市場区分' | '融資残高（株）' | '貸株残高（株）')`で引く
- 数値変換は「カンマ除去後に`/^-?\d+$/`に一致すれば`Number`、それ以外は`null`」(`Number('')`が0になる罠を避ける)。どちらかが`null`の行は捨てる
- 空行はスキップ。列数不一致は`console.warn`してスキップ
- コメントに「CSVに申込日の列は無く、`基準日`は次の権利基準日。行の日付は検索した`mkYmd`」「同じ銘柄に市場区分ごとの行があるので東証だけ」を残す

- [ ] **Step 5: 成功を確認する**

Run: `npx jest test/margin-balance-taisyaku-parse.test.ts test/margin-balance-batch-data-source.test.ts`
Expected: PASS(既存のJ-Quants関数のテストも壊れていない)

- [ ] **Step 6: Commit**

```bash
git add test/fixtures/taisyaku/stock-20261023.cp932.csv lambda/margin-balance-batch/data-source.ts test/margin-balance-taisyaku-parse.test.ts
git commit -m "Parse the taisyaku.jp all-stock balance CSV into margin balance points"
```

## Task 2: taisyaku.jp一括CSVの取得(3ステップ)

**目的:** 基準日1日分のCSVテキストを取ってくる関数を作る。0件の日はCSVを取らずに`null`を返す。

**Files:**
- Modify: `lambda/gyakuhibu-history-batch/taisyaku-client.ts`(`TAISYAKU_BASE_URL`・`USER_AGENT`・`toSlashDate`・`cookieHeaderFrom`に`export`を付けるだけ。挙動は変えない)
- Modify: `lambda/margin-balance-batch/data-source.ts`(追加)
- Create: `test/margin-balance-taisyaku-fetch.test.ts`

**Interfaces:**
- Consumes: `extractCsrfToken(html)`・`toSlashDate(iso)`・`cookieHeaderFrom(setCookies)`・`TAISYAKU_BASE_URL`・`USER_AGENT`(taisyaku-client.ts)
- Produces:
```ts
// 基準日dateの全銘柄CSV(デコード済みテキスト)。検索結果が0件ならnull。
// intervalMsは3リクエストの各間に空ける待ち時間(テストでは0)。
export async function fetchTaisyakuBalanceCsv(date: string, intervalMs: number): Promise<string | null>;
```

- [ ] **Step 1: 失敗するテストを書く** (`test/margin-balance-taisyaku-fetch.test.ts`)

`global.fetch`をjest.fnで差し替える(`test/taisyaku-client.test.ts`の132〜135行目と同じ方法)。レスポンスのモック:
```ts
const pageResponse = {
  ok: true,
  headers: { getSetCookie: () => ['ci_session=abc123; Path=/; HttpOnly'] },
  text: async () => '<form><input type="hidden" name="csrf_test_name" value="tok123"></form>',
};
const searchResponse = (html: string) => ({ ok: true, headers: { getSetCookie: () => [] }, text: async () => html });
const fixtureBytes = readFileSync(join(__dirname, 'fixtures', 'taisyaku', 'stock-20261023.cp932.csv'));
const csvResponse = {
  ok: true,
  headers: { getSetCookie: () => [], get: () => 'application/octet-stream' },
  arrayBuffer: async () => fixtureBytes.buffer.slice(fixtureBytes.byteOffset, fixtureBytes.byteOffset + fixtureBytes.byteLength),
};
```

テストケース:
1. 3ステップを順に呼び、CP932をデコードして返す: `fetchTaisyakuBalanceCsv('2026-10-23', 0)`
   - `fetch`が3回。1回目`'https://www.taisyaku.jp/app/stock'`(User-Agentヘッダーあり)
   - 2回目`'https://www.taisyaku.jp/app/stock/search'`、`method: 'POST'`、`Content-Type: 'application/x-www-form-urlencoded'`、`Cookie: 'ci_session=abc123'`。`new URLSearchParams(body)`のキーが`['csrf_test_name', 'mkYmd']`だけで、`get('csrf_test_name') === 'tok123'`、`get('mkYmd') === '2026 / 10 / 23'`
   - 3回目`'https://www.taisyaku.jp/app/stock/csv'`、`Cookie: 'ci_session=abc123'`
   - 戻り値が`'"銘柄コード","銘柄名","市場区分"'`で始まり、`'"7203","トヨタ自動車","東証"'`を含む
   - 検索結果HTMLは`'<p>検索結果&nbsp;4756件</p>'`
2. 検索結果が0件ならCSVを取らずに`null`: 検索HTMLが`'<p>検索結果&nbsp;0件</p><p>ご指定の条件に該当するデータはありません。</p>'` → `null`、`fetch`は2回だけ
3. `'検索結果&nbsp;10件'`のように0で始まらない件数は0件扱いしない(`fetch`3回、文字列を返す)。※正規表現は`/検索結果(?:&nbsp;|\s)*0件/`だと`10件`にも`0件`部分一致しない(直前が`&nbsp;`か空白であることが必要)ことをこのテストで固定する
4. 1回目が`ok: false, status: 503` → `rejects.toThrow('503')`
5. 2回目が`ok: false, status: 500` → `rejects.toThrow('500')`、`fetch`は2回
6. 3回目が`ok: false, status: 404` → `rejects.toThrow('404')`
7. ページにCSRFトークンが無い → `rejects.toThrow('csrf_test_name')`

- [ ] **Step 2: 失敗を確認する**

Run: `npx jest test/margin-balance-taisyaku-fetch.test.ts`
Expected: FAIL(`fetchTaisyakuBalanceCsv`が無い)

- [ ] **Step 3: 実装する**

要点:
- taisyaku-client.tsの4つに`export`を付ける(関数本体は変えない)
- `sleep(ms)`はdata-source.ts内のローカル関数(`ms <= 0`なら即resolve)
- 1回目の後と2回目の後に`await sleep(intervalMs)`
- HTTPエラーは`taisyaku.jp error ${status} fetching ${url}`(既存`fetchTaisyakuCsv`と同じ書式)
- 検索結果HTMLを`/検索結果(?:&nbsp;|\s)*0件/`で判定し、一致すれば`null`
- CSVは`arrayBuffer()`→`new TextDecoder('shift_jis').decode(buffer)`。ヘッダーの検証はパーサー(Task 1)に任せる
- `fetchTaisyakuCsv`(銘柄詳細ページ版)は変更しない

- [ ] **Step 4: 成功を確認する**

Run: `npx jest test/margin-balance-taisyaku-fetch.test.ts test/taisyaku-client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lambda/gyakuhibu-history-batch/taisyaku-client.ts lambda/margin-balance-batch/data-source.ts test/margin-balance-taisyaku-fetch.test.ts
git commit -m "Fetch the taisyaku.jp all-stock balance CSV for one application date"
```

## Task 3: 差分取得の対象日を決める純粋関数

**目的:** カーソル・今日・上限から、その回に取る日付の列を決める。

**Files:**
- Create: `lambda/margin-balance-batch/fetch-plan.ts`
- Create: `test/margin-balance-fetch-plan.test.ts`

**Interfaces:**
- Consumes: `getLocalTradingCalendar(from, to)`・`isTradingDay(day)`(`lambda/shared/trading-calendar.ts`)、`shiftIsoDate(iso, days)`(`lambda/shared/gyakuhibu-forecast.ts`)
- Produces:
```ts
export const CURSOR_KEY = { ticker: '__cursor__', date: 'taisyaku' } as const;
export const BACKFILL_DAYS = 3 * 365; // 1095
export function todayJst(now: number): string;
export function planFetchDates(args: {
  today: string;
  lastFetchedDate: string | null;
  maxDates: number;
  backfillDays?: number; // 既定 BACKFILL_DAYS
}): string[]; // 昇順、最大maxDates件
```

- [ ] **Step 1: 失敗するテストを書く** (`test/margin-balance-fetch-plan.test.ts`)

日付の確認済み事実: 2026-10-23(金)、2026-10-24(土)、2026-10-26(月)、2026-11-03(火・文化の日)、2026-09-01(火)、2023-10-24(火)。

1. `todayJst(Date.parse('2026-10-23T11:00:00Z'))` → `'2026-10-23'`(JST 20:00)
2. `todayJst(Date.parse('2026-10-23T15:30:00Z'))` → `'2026-10-24'`(JST 0:30に日付が変わる)
3. 初回(カーソル無し)は3年前から: `planFetchDates({ today: '2026-10-23', lastFetchedDate: null, maxDates: 40 })` → 長さ40、`[0] === '2023-10-24'`、`[1] === '2023-10-25'`、昇順、土日を含まない
4. 初回で上限を十分大きくすると今日まで: `maxDates: 10000` → 長さ738、最後が`'2026-10-23'`
5. 通常(カーソル日を取り直す): `{ today: '2026-10-23', lastFetchedDate: '2026-10-21', maxDates: 40 }` → `['2026-10-21', '2026-10-22', '2026-10-23']`
6. 週末を跨ぐ: `{ today: '2026-10-26', lastFetchedDate: '2026-10-23' }` → `['2026-10-23', '2026-10-26']`
7. 祝日を飛ばす: `{ today: '2026-11-04', lastFetchedDate: '2026-11-02' }` → `['2026-11-02', '2026-11-04']`
8. 追いつき中は上限で切る(古い日から): `{ today: '2026-10-23', lastFetchedDate: '2026-09-01', maxDates: 3 }` → `['2026-09-01', '2026-09-02', '2026-09-03']`
9. 最新まで取得済みならカーソル日の取り直しだけ: `{ today: '2026-10-24', lastFetchedDate: '2026-10-23' }` → `['2026-10-23']`。`{ today: '2026-10-23', lastFetchedDate: '2026-10-23' }` → `['2026-10-23']`
10. カーソルが今日より未来(時計のずれ等) → `[]`: `{ today: '2026-10-23', lastFetchedDate: '2026-10-26' }`
11. `backfillDays`を渡せば初回の起点が変わる: `{ today: '2026-10-23', lastFetchedDate: null, maxDates: 40, backfillDays: 2 }` → `['2026-10-21', '2026-10-22', '2026-10-23']`
12. `CURSOR_KEY`が`{ ticker: '__cursor__', date: 'taisyaku' }`、`BACKFILL_DAYS === 1095`

(maxDatesを省略している例は`maxDates: 40`を渡す)

- [ ] **Step 2: 失敗を確認する**

Run: `npx jest test/margin-balance-fetch-plan.test.ts`
Expected: FAIL(モジュールが無い)

- [ ] **Step 3: 実装する**

要点:
- `from = lastFetchedDate ?? shiftIsoDate(today, -(backfillDays ?? BACKFILL_DAYS))`。`from > today`なら`[]`
- `getLocalTradingCalendar(from, today).filter(isTradingDay).map((d) => d.date).slice(0, maxDates)`(`getLocalTradingCalendar`は昇順で返す)
- `todayJst(now) = new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)`
- コメントに判断3・4・5(Global Constraintsと冒頭の「判断」)の理由を短く書く

- [ ] **Step 4: 成功を確認する**

Run: `npx jest test/margin-balance-fetch-plan.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lambda/margin-balance-batch/fetch-plan.ts test/margin-balance-fetch-plan.test.ts
git commit -m "Plan which taisyaku.jp application dates the margin balance batch fetches next"
```

## Task 4: 信用残バッチのhandlerをtaisyaku.jpに切り替え、J-Quants呼び出しを削除

**目的:** handlerをカーソル方式の日次取得にし、J-Quants(`/markets/margin-interest`・`/markets/margin-alert`)と`SECRET_ARN`への依存を消す。

**Files:**
- Modify: `lambda/margin-balance-batch/index.ts`(全面書き換え)
- Modify: `lambda/margin-balance-batch/data-source.ts`(J-Quants関数・型・`fetchWithRetry`/`normalizeDate`のimport・`API_BASE_URL`を削除。`MarginBalancePoint`の`financingBalance`/`lendingBalance`を`number`に絞る)
- Modify: `test/margin-balance-batch.test.ts`(全面書き換え)
- Delete: `test/margin-balance-batch-data-source.test.ts`(J-Quants関数のテスト)

**Interfaces:**
- Consumes: Task 1〜3の`parseTaisyakuBalanceCsv`・`TaisyakuCsvFormatError`・`fetchTaisyakuBalanceCsv`・`planFetchDates`・`todayJst`・`CURSOR_KEY`、`batchUpsert`(`lambda/shared/dynamodb-batch.ts`)
- Produces: `handler(): Promise<void>`。環境変数`YUTAI_MASTER_TABLE_NAME`・`MARGIN_BALANCE_TABLE_NAME`・`REQUEST_INTERVAL_MS`(既定`'1000'`)・`MAX_DATES_PER_RUN`(既定`'40'`)。両数値はモジュール読み込み時に検証し、有限の非負整数(`MAX_DATES_PER_RUN`は1以上)でなければ`throw`

- [ ] **Step 1: 失敗するテストを書く** (`test/margin-balance-batch.test.ts`を書き換え)

モック:
```ts
export {};
const mockSend = jest.fn();
const mockFetchCsv = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  ScanCommand: jest.fn((input: unknown) => ({ ...(input as object), __type: 'Scan' })),
  GetCommand: jest.fn((input: unknown) => ({ ...(input as object), __type: 'Get' })),
  PutCommand: jest.fn((input: unknown) => ({ ...(input as object), __type: 'Put' })),
  BatchWriteCommand: jest.fn((input: unknown) => ({ ...(input as object), __type: 'BatchWrite' })),
}));
// 取得(HTTP)だけ差し替え、パース(ヘッダー検証を含む)は本物を使う
jest.mock('../lambda/margin-balance-batch/data-source', () => ({
  ...jest.requireActual('../lambda/margin-balance-batch/data-source'),
  fetchTaisyakuBalanceCsv: (...args: unknown[]) => mockFetchCsv(...args),
}));
process.env.YUTAI_MASTER_TABLE_NAME = 'JQuantsYutaiMaster';
process.env.MARGIN_BALANCE_TABLE_NAME = 'JQuantsMarginBalance';
process.env.REQUEST_INTERVAL_MS = '0';
process.env.MAX_DATES_PER_RUN = '3';
```
ヘルパー:
- `csvFor(rows: Array<[code: string, market: string, financing: string, lending: string]>)`: `TAISYAKU_BALANCE_CSV_HEADER`(requireActualで取得)+各行を14列のクォート付きで組み立てる
- `mockTables({ master: string[]; cursor?: string })`: `mockSend.mockImplementation`で`__type`ごとに応答(Scan→`{ Items: master.map((ticker) => ({ ticker })) }`、Get→`cursor ? { Item: { ...CURSOR_KEY, lastFetchedDate: cursor } } : {}`、Put/BatchWrite→`{}`)
- `cursorWrites()`: Putのうち`Item.ticker === '__cursor__'`の`Item.lastFetchedDate`の配列
- `putItems()`: BatchWriteの`RequestItems.JQuantsMarginBalance[].PutRequest.Item`を平らにした配列
- `beforeEach`: `jest.useFakeTimers({ doNotFake: [...既存と同じ] }).setSystemTime(new Date('2026-10-23T11:00:00Z'))`(JST 2026-10-23 20:00)、`mockFetchCsv.mockReset()`

テストケース:
1. 初回は3年前から上限件数だけ取る: `mockTables({ master: ['7203'] })`、`mockFetchCsv.mockResolvedValue(csvFor([['7203','東証','100','50']]))` → `mockFetchCsv`の第1引数が`['2023-10-24', '2023-10-25', '2023-10-26']`、第2引数が`0`、`cursorWrites()`が`['2023-10-24', '2023-10-25', '2023-10-26']`
2. 通常はカーソル日から今日まで取り、優待マスタの東証行だけを`source: 'taisyaku'`で書く: `mockTables({ master: ['7203', '3197'], cursor: '2026-10-21' })`、各日`csvFor([['7203','東証','639600','800'], ['7203','名証','0','0'], ['3197','東証','12900','138400'], ['1301','東証','7200','7200']])` → 取得日`['2026-10-21','2026-10-22','2026-10-23']`、`putItems()`に`{ ticker: '7203', date: '2026-10-22', financingBalance: 639600, lendingBalance: 800, source: 'taisyaku' }`を含み、`ticker: '1301'`を含まず、`financingBalance: 0`の行(名証)を含まない。件数は2銘柄×3日=6
3. カーソル行のキーと属性: 最後のPutの`Item`が`{ ticker: '__cursor__', date: 'taisyaku', lastFetchedDate: '2026-10-23', updatedAt: expect.any(String) }`、`TableName: 'JQuantsMarginBalance'`。Getの`Key`が`{ ticker: '__cursor__', date: 'taisyaku' }`
4. 今日が0件(未公表)ならカーソルを進めずに終える: cursor`'2026-10-21'`、`mockFetchCsv`が10-21・10-22はCSV、10-23は`null` → `cursorWrites()`が`['2026-10-21','2026-10-22']`、例外なし
5. 今日より前の0件は休場日とみなして進める: cursor`'2026-10-21'`、10-22だけ`null` → 取得日は3日全部、`cursorWrites()`が`['2026-10-21','2026-10-22','2026-10-23']`、`console.warn`に`'2026-10-22'`を含むメッセージ
6. ヘッダーのみのCSV(パース結果0件)も`null`と同じ扱い: 10-23がヘッダーだけ → 4と同じ結果
7. 取得失敗はその回を打ち切る(部分失敗では例外なし): cursor`'2026-10-21'`、10-22で`mockFetchCsv.mockRejectedValueOnce(new Error('taisyaku.jp error 503'))` → 10-23は取得しない(`mockFetchCsv`呼び出し2回)、`cursorWrites()`が`['2026-10-21']`、`handler()`はresolve、`console.error`が呼ばれる
8. DynamoDB書き込み失敗も同じく打ち切り: BatchWriteを1回目だけreject → カーソルは書かれず、2日目以降を取得しない。1日目で失敗したので9と同じく例外
9. 全件失敗なら例外: 1日目から`mockRejectedValue(new Error('boom'))` → `rejects.toThrow('margin-balance-batch: all fetches failed')`
10. ヘッダー不一致は即失敗(後続も取らない): 10-21のCSVのヘッダーを`'"銘柄コード","銘柄名"'`だけにする → `rejects.toThrow(TaisyakuCsvFormatError)`(requireActualで取得したクラス)、`cursorWrites()`が`[]`
11. 成功したのに1件もマッチしなければ例外: master`['9999']`、CSVは`7203`だけ → `rejects.toThrow('0 points matched')`
12. 優待マスタが空なら何もしない: `mockTables({ master: [] })` → `mockFetchCsv`未呼び出し、Getも未呼び出し
13. 取得済みが最新なら取り直しの1日だけ: cursor`'2026-10-23'` → `mockFetchCsv`の呼び出しが`'2026-10-23'`の1回
14. J-Quantsに触れない: `jest.mock('../lambda/shared/jquants-batch-client', ...)`は置かない。代わりに`lambda/margin-balance-batch/index.ts`と`data-source.ts`のソースを`readFileSync`で読み、`'jquants-batch-client'`・`'SECRET_ARN'`・`'getApiKey'`の文字列が含まれないことを確認する(コメント中の「J-Quants」という語は許す)

- [ ] **Step 2: 失敗を確認する**

Run: `npx jest test/margin-balance-batch.test.ts`
Expected: FAIL(旧handlerはJ-Quantsを呼ぶ)

- [ ] **Step 3: 実装する**

`index.ts`の流れ:
1. `getYutaiTickers()`(既存のScanをそのまま使う)。空なら`console.warn`して`return`
2. `GetCommand({ TableName, Key: CURSOR_KEY })`の`Item?.lastFetchedDate`(文字列でなければ`null`)
3. `today = todayJst(Date.now())`、`dates = planFetchDates({ today, lastFetchedDate, maxDates: MAX_DATES_PER_RUN })`
4. 各日付(2件目以降は前に`sleep(REQUEST_INTERVAL_MS)`):
   - `try { csv = await fetchTaisyakuBalanceCsv(date, REQUEST_INTERVAL_MS) } catch { failed++; console.error(...); break; }`
   - `points = csv === null ? [] : parseTaisyakuBalanceCsv(csv, date)`(**tryの外**。`TaisyakuCsvFormatError`はそのまま投げる)
   - `points.length === 0`: `date === today`なら`console.log('未公表')`して`break`。それ以外は`console.warn`して`writeCursor(date)`し`continue`
   - `items = points.filter((p) => targetTickers.has(p.code)).map((p) => ({ ticker: p.code, date: p.date, financingBalance: p.financingBalance, lendingBalance: p.lendingBalance, source: p.source }))`
   - `try { await batchUpsert(...); await writeCursor(date) } catch { failed++; console.error(...); break; }`、成功なら`succeeded++`、`upserted += items.length`
5. `console.log`で`dates.length`・`succeeded`・`failed`・`upserted`・最終カーソルを出す
6. `if (succeeded === 0 && failed > 0) throw new Error('margin-balance-batch: all fetches failed ...')`、`if (succeeded > 0 && upserted === 0) throw new Error('margin-balance-batch: 0 points matched ...')`

`writeCursor(date)`: `PutCommand({ TableName, Item: { ...CURSOR_KEY, lastFetchedDate: date, updatedAt: new Date().toISOString() } })`。
旧コードの`resolveTargetPoints`(5桁コード対応)・`listFridays`・`FORCE_FULL_BACKFILL`・`LOOKBACK_DAYS`は削除(taisyaku.jpのコードは4文字で、優待マスタのtickerと完全一致)。`removeUndefinedValues`の設定は残してよい。

`data-source.ts`: J-Quants関数・型を削除し、`MarginBalancePoint`を
```ts
export interface MarginBalancePoint {
  code: string;
  date: string;
  financingBalance: number;
  lendingBalance: number;
  source: 'taisyaku';
}
```
にする(旧データの`'weekly'`/`'daily-alert'`はもう書かないので型から外す。設計書の「union型に追加」は、書き込み側がtaisyakuだけになった時点で不要)。ファイル冒頭のコメントをtaisyaku.jpの説明に書き換える。

- [ ] **Step 4: 成功を確認する**

Run: `npx jest test/margin-balance-batch.test.ts test/margin-balance-taisyaku-parse.test.ts test/margin-balance-taisyaku-fetch.test.ts test/margin-balance-fetch-plan.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lambda/margin-balance-batch/index.ts lambda/margin-balance-batch/data-source.ts test/margin-balance-batch.test.ts
git rm test/margin-balance-batch-data-source.test.ts
git commit -m "Switch the margin balance batch to taisyaku.jp and drop the J-Quants calls (last J-Quants version: tag margin-balance-jquants-final)" -m "The batch now fetches the taisyaku.jp all-stock balance CSV once per application date, keeps its progress in a __cursor__ row, and no longer reads the J-Quants API key. The removed J-Quants margin-interest/margin-alert code is preserved at tag margin-balance-jquants-final."
```

## Task 5: 貸借判定を`marginName`に切り替え

**目的:** `YutaiRiskPrecomputeBatchFunction`の`na`判定から信用残テーブルへの依存を外す。

**Files:**
- Modify: `lambda/yutai-risk-precompute-batch/index.ts`
- Modify: `test/yutai-risk-precompute-batch.test.ts`

**Interfaces:**
- Consumes: `MasterRow.marginName`(既存)、`isGeneralMarginOnly`(既存)
- Produces: `calcRisk(ticker: string, marginName: string | null, shares, rightsDate, calendarCache)`。`marginName !== '貸借'`なら`NA_RISK`。`MARGIN_BALANCE_TABLE_NAME`は読まない

- [ ] **Step 1: テストを先に直す・足す**

- `beforeEach`の既定を「主要なテスト銘柄は貸借」にする: `mockFetchMarginNames.mockResolvedValue(new Map(['1234', '9001', '7458', '1111', '2222'].map((t) => [t, '貸借'])))`。コメントも「既定は貸借(最大逆日歩を計算する経路)」に直す
- 全テストのモック列から「margin balance presence」のQuery応答(`{ Items: [{ ticker: ..., date: ... }] }`・`{ Items: [] } // margin balance なし`)の行を削除する
- `'writes null risk amounts when there is no margin balance data for the ticker'`を`'writes null risk amounts when the margin classification is unknown (not in the J-Quants listing)'`に変える: 銘柄`'9942'`(既定のMapに無い)、モックは`scan → actuals { Items: [] }`、`:maxGyakuhibu`等が`null`、株価Queryを呼ばない(`mockSend`が scan・actuals・update の3回)
- `'still aggregates the actual history when maxGyakuhibu cannot be computed'`は銘柄を`'9942'`にし、margin行のモックを消す(`:lastGyakuhibu.cost === 200`のまま)
- `'treats a ticker missing from the J-Quants listing ...'`からmargin行のモックを消す
- 新規: `'never queries the margin balance table'`: 貸借の`'1234'`(scan → close `{ Items: [{ close: 500 }] }` → actuals → update)で、どの呼び出しにも`TableName: 'JQuantsMarginBalance'`が無い。`:maxGyakuhibu`は数値
- 新規: `'uses the stored 貸借 classification when the J-Quants fetch fails'`: `mockFetchMarginNames.mockRejectedValue(...)`、行に`marginName: '貸借'`、scan → close → actuals → update、`:maxGyakuhibu`が数値
- `process.env.MARGIN_BALANCE_TABLE_NAME`の設定行を削除

- [ ] **Step 2: 失敗を確認する**

Run: `npx jest test/yutai-risk-precompute-batch.test.ts`
Expected: FAIL(モック列がずれる/`JQuantsMarginBalance`へのQueryが残っている)

- [ ] **Step 3: 実装する**

- `hasMarginBalance`と`MARGIN_BALANCE_TABLE_NAME`を削除
- `calcRisk`の2つ目の早期returnを`if (marginName !== '貸借') return NA_RISK;`にする(`marginName`がnull=区分不明もここで`na`)。呼び出し側は`calcRisk(row.ticker, marginName, shares, rightsDate, calendarCache)`
- コメント「信用残が無く最大逆日歩が出せない銘柄でも」を「貸借区分が不明で最大逆日歩が出せない銘柄でも」に直す

- [ ] **Step 4: 成功を確認する**

Run: `npx jest test/yutai-risk-precompute-batch.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lambda/yutai-risk-precompute-batch/index.ts test/yutai-risk-precompute-batch.test.ts
git commit -m "Judge 貸借 tickers by marginName instead of the presence of margin balance rows"
```

## Task 6: 現在需給予測を常時有効にし、taisyaku.jpの行だけを読む

**目的:** `TSE_MARGIN_FEATURES_ENABLED`を削除し、`scanMarginSnapshots`を`source`=`taisyaku`だけにする。

**Files:**
- Modify: `lambda/gyakuhibu-forecast-batch/index.ts`
- Modify: `lambda/gyakuhibu-forecast-batch/tse-forecast.ts`
- Modify: `lambda/shared/gyakuhibu-forecast.ts`(91行目・246〜248行目付近のコメントのみ)
- Modify: `test/gyakuhibu-forecast-batch.test.ts`

**Interfaces:**
- Produces: `scanMarginSnapshots(ddbDocClient, tableName): Promise<Map<string, MarginSnapshot[]>>`(シグネチャは同じ。Scan入力に`FilterExpression: '#source = :source'`・`ExpressionAttributeNames: { '#source': 'source' }`・`ExpressionAttributeValues: { ':source': 'taisyaku' }`を付け、JS側でも`item.source === 'taisyaku'`以外を捨てる)

- [ ] **Step 1: テストを先に直す・足す**

ファイル全体のモックを、呼び出し順に依存しないテーブル名ルーティングに変える(TSEが常時有効になると全テストのモック列に「信用残Scan」と「`_POOL_TSE_` put」が挟まるため):
```ts
function mockTables(t: { master: unknown[]; actual: unknown[]; margin?: unknown[]; failPutFor?: string }) {
  mockSend.mockImplementation(async (cmd: Record<string, unknown>) => {
    if ('Item' in cmd) {
      if (t.failPutFor && (cmd.Item as { ticker: string }).ticker === t.failPutFor) throw new Error('DynamoDB error');
      return {};
    }
    if (cmd.TableName === 'JQuantsYutaiMaster') return { Items: t.master };
    if (cmd.TableName === 'JQuantsGyakuhibuActual') return { Items: t.actual };
    if (cmd.TableName === 'JQuantsMarginBalance') return { Items: t.margin ?? [] };
    return {};
  });
}
```
- 既存テストをすべて`mockTables`に置き換える。`putCalls()`の添字・件数は`_POOL_`・`_POOL_TSE_`・銘柄…の順になるので、`puts[1]`で銘柄行を見ていた箇所は`find`でticker指定に変える。`'writes the _POOL_ row before any ticker row'`は`['_POOL_', '_POOL_TSE_', '1234']`の順を確認する
- `process.env.TSE_MARGIN_FEATURES_ENABLED`の設定行、`withTseEnabled`、`'skips the TSE step entirely when the flag is off ...'`を削除
- 既存TSEテストの信用残行の`source: 'weekly'`を`source: 'taisyaku'`に変える(期待値は変えない: `snapshotDate '2026-07-31'`・`lagDays 27`・`bin '融資超過'`・`forecastP50 5000`・`lendingGrowth4w ≈ 2`)
- `'marks a ticker that cannot be shorted ...'`に「`8798`の行の`tseForecast`が`null`」を足す
- `'does not fall back to current-tse: ... never queries the margin table'`は、信用残テーブルをScanするようになったので名前を`'... and never issues a per-ticker margin Query'`に変える(検証内容=`KeyConditionExpression`を持つ呼び出しが無いこと、は同じ)
- 新規: `'reads only taisyaku rows from the margin table, ignoring legacy J-Quants rows and the cursor row'`:
  - master `[{ ticker: '1234', value: 1000, unitShares: 100, rightsMonths: [8], maxGyakuhibu: 5000 }]`、actual `[]`
  - margin `[{ ticker: '1234', date: '2026-07-31', financingBalance: 100, lendingBalance: 999, source: 'weekly' }, { ticker: '1234', date: '2026-07-31', financingBalance: 100, lendingBalance: 50, source: 'taisyaku' }, { ticker: '1234', date: '2026-07-30', financingBalance: 1, lendingBalance: 1, source: 'daily-alert' }, { ticker: '__cursor__', date: 'taisyaku', lastFetchedDate: '2026-07-31' }]`
  - 銘柄行の`tseForecast.snapshotDate === '2026-07-31'`、`tseForecast.lendingBalance === 50`
  - 信用残テーブルへのScan入力が`FilterExpression: '#source = :source'`、`ExpressionAttributeValues: { ':source': 'taisyaku' }`
- 新規: `'gives tseForecast: null when the margin table has only legacy rows'`: margin`[{ ..., date: '2026-07-31', source: 'weekly' }]` → `tseForecast`が`null`

- [ ] **Step 2: 失敗を確認する**

Run: `npx jest test/gyakuhibu-forecast-batch.test.ts`
Expected: FAIL(フラグ未設定だとTSEが走らない/weekly行を使ってしまう)

- [ ] **Step 3: 実装する**

- `index.ts`: `tseMarginFeaturesEnabled()`を削除し、`tse`を常に計算する(`const snapshots = await scanMarginSnapshots(...)`…)。`if (tse)`の分岐を外し、`_POOL_TSE_`は常に書く。`generalMarginOnly`なら`item.tseForecast = null`、それ以外は`computeTseForecast`。冒頭コメント・159行目・201行目のコメントから「フラグ」「スタンダードプラン依存」「東証信用残」を除き「日証金の貸借取引残高(taisyaku.jp)」に直す
- `tse-forecast.ts`: Scanに上記FilterExpressionを付け、ループで`item.source !== 'taisyaku'`を`continue`。daily-alert優先のロジック(`existing`/`source`の保持)を削除して`Map<string, MarginSnapshot>`にする。冒頭コメントを「日証金の貸借取引残高(`JQuantsMarginBalance`の`source`=`taisyaku`、旧J-Quants行は混ぜない)」に書き換え、`TSE_MARGIN_FEATURES_ENABLED`への言及を消す
- `gyakuhibu-forecast.ts`: 91行目のコメントを`// --- 日証金の貸借取引残高(JQuantsMarginBalanceのsource=taisyaku)ベースの「現在需給」予測用 ---`に、246〜248行目の「東証信用残(mkt-margin-int)」を「信用残テーブル」に直す(コードは変えない)

- [ ] **Step 4: 成功を確認する**

Run: `npx jest test/gyakuhibu-forecast-batch.test.ts test/gyakuhibu-forecast.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lambda/gyakuhibu-forecast-batch/index.ts lambda/gyakuhibu-forecast-batch/tse-forecast.ts lambda/shared/gyakuhibu-forecast.ts test/gyakuhibu-forecast-batch.test.ts
git commit -m "Always run the current-supply forecast and feed it only taisyaku.jp margin rows"
```

## Task 7: reference-apiのフラグ削除と`margin-trend`の`source`フィルタ・貸借倍率

**目的:** `features`と`TSE_MARGIN_FEATURES_ENABLED`を消し、`margin-trend`と予測APIの`marginTrend.latest`をtaisyaku.jpの行だけにする。

**Files:**
- Modify: `lambda/reference-api/index.ts`
- Modify: `test/reference-api.test.ts`

**Interfaces:**
- Consumes: `shiftIsoDate`(`lambda/shared/gyakuhibu-forecast.ts`、既存importに追加)
- Produces:
  - `GET /yutai/{ticker}/margin-trend` → `{ ticker, range: '1y', points: Array<{ date: string; financingBalance: number; lendingBalance: number; lendingRatio: number | null }> }`(日付昇順)
  - `GET /yutai/forecast`・`GET /yutai/{ticker}`・`GET /yutai/{ticker}/forecast`の応答から`features`キーを削除。`tseForecast`は常に`buildTseForecast`の結果
  - 共通のQuery入力(`margin-trend`は昇順、`latest`は降順):
```ts
{
  TableName: MARGIN_BALANCE_TABLE_NAME,
  KeyConditionExpression: 'ticker = :ticker AND #date >= :from',
  FilterExpression: '#source = :source',
  ExpressionAttributeNames: { '#date': 'date', '#source': 'source' },
  ExpressionAttributeValues: { ':ticker': ticker, ':from': shiftIsoDate(today, -365), ':source': 'taisyaku' },
  ScanIndexForward: true | false,
  ExclusiveStartKey, // LastEvaluatedKeyがある間は続けて取る
}
```
  (`today = new Date().toISOString().slice(0, 10)`。`Limit`は付けない。`Limit`はフィルタより先に効くため)

- [ ] **Step 1: テストを先に直す・足す**

- `process.env.TSE_MARGIN_FEATURES_ENABLED`の行を削除
- `margin-trend`の既存テストを書き換え(`jest.useFakeTimers({ doNotFake: [...] }).setSystemTime(new Date('2026-10-23T00:00:00Z'))`):
  - モック`{ Items: [{ ticker: '1234', date: '2026-08-04', financingBalance: 90, lendingBalance: 180, source: 'taisyaku' }, { ticker: '1234', date: '2026-08-05', financingBalance: 100, lendingBalance: 0, source: 'taisyaku' }, { ticker: '1234', date: '2026-08-05', financingBalance: 5, lendingBalance: 5, source: 'weekly' }] }`(最後の行はFilterをすり抜けた想定。JS側でも捨てる)
  - 応答`points`が`[{ date: '2026-08-04', financingBalance: 90, lendingBalance: 180, lendingRatio: 0.5 }, { date: '2026-08-05', financingBalance: 100, lendingBalance: 0, lendingRatio: null }]`
  - Query入力が`KeyConditionExpression: 'ticker = :ticker AND #date >= :from'`、`ExpressionAttributeValues: { ':ticker': '1234', ':from': '2025-10-23', ':source': 'taisyaku' }`、`FilterExpression: '#source = :source'`、`ScanIndexForward: true`、`Limit`が無い
- 新規: `'GET /yutai/{ticker}/margin-trend follows LastEvaluatedKey'`: 1回目`{ Items: [行A], LastEvaluatedKey: { ticker: '1234', date: '2026-08-04' } }`、2回目`{ Items: [行B] }` → `points`が2件、2回目の入力に`ExclusiveStartKey`
- 予測APIの`latest`: `'GET /yutai/{ticker}/forecast returns the latest taisyaku row as marginTrend.latest'`: 信用残Query応答`{ Items: [{ date: '2026-10-23', financingBalance: 10, lendingBalance: 20, source: 'taisyaku' }, { date: '2026-10-22', ..., source: 'taisyaku' }] }` → `marginTrend.latest`が`{ date: '2026-10-23', financingBalance: 10, lendingBalance: 20 }`、そのQuery入力が`ScanIndexForward: false`・`FilterExpression: '#source = :source'`・`Limit`無し。taisyaku行が無ければ`{ latest: null }`(既存テストの`{ Items: [] }`で確認)
- フラグ関連: `'... includes tseForecast and features.tseMargin=true when the flag is on'`は名前を`'GET /yutai/forecast includes tseForecast'`にし、`features`の期待を`expect(parsed).not.toHaveProperty('features')`に置き換える。`'... nulls tseForecast and reports features.tseMargin=false when the flag is off'`は削除。`'GET /yutai/{ticker}/forecast includes tseForecast and features'`は`features`が無いことの確認に変える
- `GET /yutai/{ticker}`の既存テスト(303行目付近)に`expect(parsed).not.toHaveProperty('features')`を1つ足す

- [ ] **Step 2: 失敗を確認する**

Run: `npx jest test/reference-api.test.ts`
Expected: FAIL(`lendingRatio`が無い/`features`がある/Query入力が旧形式)

- [ ] **Step 3: 実装する**

- `tseMarginEnabled()`と281〜283行目のコメントを削除。`buildTseForecast`の`if (!tseMarginEnabled()) return null;`を削除し、コメントを「属性無し・nullのいずれもnull」に
- 3か所の`features: { tseMargin: tseMarginEnabled() }`を削除
- `queryTaisyakuMarginRows(ticker: string, ascending: boolean): Promise<Record<string, unknown>[]>`を作り、上記入力でページングしながら集め、`item.source === 'taisyaku'`だけを返す。`getMarginTrend`(昇順)と`getYutaiForecast`の`latest`(降順、先頭1件)で使う
- `lendingRatio = typeof f === 'number' && typeof l === 'number' && l !== 0 ? f / l : null`
- `MARGIN_TREND_RANGE_DAYS = 365`は「日付範囲(暦日)」の意味に変わるのでコメントを直す
- `getYutaiForecast`のコメント「呼び出し順はテストのmockResolvedValueOnce順…margin query」はそのまま(順番は変えない)

- [ ] **Step 4: 成功を確認する**

Run: `npx jest test/reference-api.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lambda/reference-api/index.ts test/reference-api.test.ts
git commit -m "Serve only taisyaku.jp rows in the margin trend with a lending ratio, and drop the tseMargin feature flag from the API"
```

## Task 8: CDK(スケジュール・権限・環境変数・SNS・アラーム・フラグ削除)

**目的:** スタックを新しいバッチに合わせ、2日連続失敗のメール通知を足し、`tseMarginFeatures`を消す。

**Files:**
- Modify: `lib/j-quants-stack.ts`
- Modify: `cdk.json`(`"tseMarginFeatures": false,`の行を削除)
- Modify: `test/j-quants.test.ts`

**Interfaces:**
- Produces: `public readonly batchAlarmTopic: sns.Topic`(construct ID `JQuantsBatchAlarmTopic`)。コンストラクタは`process.env.ALERT_EMAIL`必須

- [ ] **Step 1: テストを先に直す・足す**

- ファイル冒頭: `delete process.env.APP_PASSWORD;`とコメントを、「`APP_PASSWORD`は廃止済み。合成に必要な環境変数は`ALERT_EMAIL`だけ」に変え、`process.env.ALERT_EMAIL = 'alerts@example.com';`を置く
- `'creates the margin balance batch Lambda ...'`を書き換え:
  - `AWS::Lambda::Function`に`Timeout: 840`、`Environment.Variables: Match.exact({ YUTAI_MASTER_TABLE_NAME: Match.anyValue(), MARGIN_BALANCE_TABLE_NAME: Match.anyValue(), REQUEST_INTERVAL_MS: '1000', MAX_DATES_PER_RUN: '40' })`
  - `AWS::Events::Rule`に`ScheduleExpression: 'cron(15 10 ? * MON-FRI *)'`、`State: 'ENABLED'`
  - 全Ruleの`ScheduleExpression`に`'cron(30 8 ? * MON-FRI *)'`が無い
  - ポリシー名に`MarginBalanceBatch`を含むIAMポリシーの全Statementについて: `secretsmanager:GetSecretValue`が無い。`YutaiMaster`を含むResourceのActionに`PutItem`/`UpdateItem`/`DeleteItem`/`BatchWriteItem`が無い。`MarginBalance`を含むResourceのActionに`BatchWriteItem`と`PutItem`と`GetItem`がある(既存の`hasStatement`風ヘルパーを流用)
- 新規: `'notifies by email when the margin balance batch fails two days in a row'`:
  - `template.resourceCountIs('AWS::SNS::Topic', 1)`
  - `AWS::SNS::Subscription`に`{ Protocol: 'email', Endpoint: 'alerts@example.com' }`
  - `AWS::CloudWatch::Alarm`に`{ Namespace: 'AWS/Lambda', MetricName: 'Errors', Statistic: 'Sum', Period: 86400, EvaluationPeriods: 2, DatapointsToAlarm: 2, Threshold: 1, ComparisonOperator: 'GreaterThanOrEqualToThreshold', TreatMissingData: 'notBreaching', AlarmActions: [{ Ref: Match.stringLikeRegexp('JQuantsBatchAlarmTopic') }], Dimensions: [{ Name: 'FunctionName', Value: { Ref: Match.stringLikeRegexp('MarginBalanceBatchFunction') } }] }`
- 新規: `'fails to synthesize without ALERT_EMAIL'`: `const saved = process.env.ALERT_EMAIL; delete process.env.ALERT_EMAIL; try { expect(() => new JQuantsStack(new cdk.App(), 'NoAlertStack')).toThrow(/ALERT_EMAIL/); } finally { process.env.ALERT_EMAIL = saved; }`。空文字`''`でも同様に失敗すること
- `'creates the yutai-risk-precompute-batch Lambda ...'`: `Match.exact`から`MARGIN_BALANCE_TABLE_NAME`を外し、`hasMarginStockReadAccess`の判定を`StockPrices`だけにする。さらに`YutaiRiskPrecompute`のポリシーのどのResourceにも`MarginBalance`が含まれないことを足す
- `'creates the gyakuhibu-forecast-batch Lambda ...'`: `Match.exact`から`TSE_MARGIN_FEATURES_ENABLED`を外す
- `'passes TSE_MARGIN_FEATURES_ENABLED=true to the reference API by default'`を`'does not pass TSE_MARGIN_FEATURES_ENABLED to any Lambda'`に変える: 全`AWS::Lambda::Function`の`Environment.Variables`に`TSE_MARGIN_FEATURES_ENABLED`キーが無い
- `'tseMarginFeatures=false drops ...'`と`'tseMarginFeatures passed as the string "false" ...'`を削除
- 新規(1行で済む確認): `cdk.json`を`readFileSync`+`JSON.parse`し、`context.tseMarginFeatures`が`undefined`

- [ ] **Step 2: 失敗を確認する**

Run: `npx jest test/j-quants.test.ts`
Expected: FAIL(スケジュールが`cron(30 8 ...)`のまま、SNS/アラームが無い等)。合成は全Lambdaをesbuildで束ねるので数分かかる

- [ ] **Step 3: 実装する**

- import追加: `aws-cdk-lib/aws-sns`・`aws-cdk-lib/aws-sns-subscriptions`・`aws-cdk-lib/aws-cloudwatch`・`aws-cdk-lib/aws-cloudwatch-actions`
- コンストラクタ冒頭(`super`直後、テーブル作成より前): `ALERT_EMAIL`の読み取りと`throw new Error('ALERT_EMAIL is required: set it when running cdk (e.g. ALERT_EMAIL=you@example.com npx cdk deploy)')`。45〜50行目の`tseMarginFeatures`ブロックを削除
- `this.batchAlarmTopic = new sns.Topic(this, 'JQuantsBatchAlarmTopic')`、`addSubscription(new subscriptions.EmailSubscription(alertEmail))`。コメントに「他のバッチの連続失敗通知にも使い回す」「初回デプロイ後に届く確認メールのリンクを踏むまで通知は届かない」
- `MarginBalanceBatchFunction`: `environment`を4つにし、`this.apiKeySecret.grantRead(marginBalanceBatchFn)`を削除。`grantReadData`(優待マスタ)・`grantReadWriteData`(信用残)はそのまま
- スケジュール: `if (tseMarginFeatures)`を外して`cron({ minute: '15', hour: '10', weekDay: 'MON-FRI' })`。コメントは「taisyaku.jpの公表時刻は未確定(Task 0)。JST平日19:15 = UTC 10:15。毎回カーソル日を取り直して遅れた公表・訂正を拾う。GyakuhibuHistoryBatchSchedule(UTC 10:00、同じtaisyaku.jpを叩く)と重ならず、GyakuhibuForecastBatchSchedule(UTC 10:40)より前に終わる時刻(タイムアウト14分で最遅10:29)」
- アラーム: `new cloudwatch.Alarm(this, 'MarginBalanceBatchErrorsAlarm', { metric: marginBalanceBatchFn.metricErrors({ period: cdk.Duration.days(1), statistic: 'Sum' }), threshold: 1, comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD, evaluationPeriods: 2, datapointsToAlarm: 2, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING, alarmDescription: '...2日連続で失敗' })`、`.addAlarmAction(new cloudwatch_actions.SnsAction(this.batchAlarmTopic))`
- `YutaiRiskPrecomputeBatchFunction`: `MARGIN_BALANCE_TABLE_NAME`と`this.marginBalanceTable.grantReadData(yutaiRiskPrecomputeBatchFn)`を削除
- 予測バッチ・reference-apiの`TSE_MARGIN_FEATURES_ENABLED`を削除
- 古くなったコメントを直す: 84〜85行目(信用残テーブル: 「日証金の貸借取引残高(taisyaku.jp)。トレンドグラフと現在需給予測に使う。貸借判定は`marginName`」)、298行目付近(`MarginBalanceBatchSchedule: 平日10:15 UTC`)、432〜433行目(予測バッチ(UTC 10:40)は信用残バッチ(UTC 10:15)の後に走るので当日までの残高を使う)
- `cdk.json`から`"tseMarginFeatures": false,`を削除

- [ ] **Step 4: 成功を確認する**

Run: `npx jest test/j-quants.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/j-quants-stack.ts cdk.json test/j-quants.test.ts
git commit -m "Run the margin balance batch on weekday evenings without the J-Quants secret, alert by email after two failed days, and remove the tseMarginFeatures flag"
```

## Task 9: フロント(フラグ削除・文言・貸借倍率グラフ)

**目的:** `features.tseMargin`に依存しない画面にし、文言を日証金に改め、信用残トレンドに貸借倍率(第2軸、1.0の基準線)と注記を足す。

**Files:**
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/components/YutaiForecastSections.tsx`
- Modify: `frontend/src/pages/YutaiListPage.tsx`
- (`frontend/src/pages/YutaiDetailPage.tsx`・`frontend/src/api/client.ts`は型エラーが出た場合だけ直す)

**Interfaces:**
- Consumes: Task 7の`margin-trend`応答
- Produces(types.ts):
```ts
export interface MarginTrendPoint {
  date: string;
  financingBalance: number;
  lendingBalance: number;
  // 貸借倍率 = 融資残 ÷ 貸株残。貸株残0ならnull。1未満 = 貸株超過(逆日歩が付きうる)
  lendingRatio: number | null;
}
```
  `YutaiFeatures`型と、`YutaiDetail`・`YutaiForecastListResponse`・`YutaiForecastDetail`の`features`プロパティを削除

- [ ] **Step 1: 型を変える**(テストの代わりに型チェックで漏れを洗い出す)

types.tsを上記に変え、155行目のコメントを「日証金の貸借取引残高ベースの現在需給予測。予測が無ければnull」に、`MarginTrendPoint`の旧コメント(J-Quants側のデータ欠落)を削除する。

- [ ] **Step 2: 型エラーを確認する**

Run: `cd frontend; npx tsc -b`
Expected: FAIL(`features`を参照している`YutaiForecastSections.tsx`の176・348行目、`YutaiListPage.tsx`の427行目)

- [ ] **Step 3: 実装する**

`YutaiForecastSections.tsx`:
- 81行目: `'日証金の貸借取引残高ベース(参考)'`
- 173〜176行目: コメントを「日証金の貸借取引残高ベースの現在需給予測。予測が無ければ何も出さない」、条件を`if (!tse) return null;`
- 180行目: `現在需給ベース(日証金の貸借取引残高 {tse.snapshotDate} 時点、権利日{tse.lagDays}日前)`
- `MarginTrendSection`: フラグ判定を削除してそのまま`<MarginTrendChart ... />`を返す。コメントは「信用残(日証金の貸借取引残高)トレンド」
- `MarginTrendChart`:
  - 見出し`貸借取引残高トレンド(過去1年)`、空のときの文言`まだ貸借取引残高データがありません(取得中です)。`
  - 左軸`<YAxis yAxisId="balance" ... />`、右軸`<YAxis yAxisId="ratio" orientation="right" width={40} tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />`
  - `貸株残`・`融資残`の`<Line>`に`yAxisId="balance"`、権利日の`<ReferenceLine x=...>`にも`yAxisId="balance"`(軸を複数にするとyAxisIdが必須になる)
  - `<Line yAxisId="ratio" type="monotone" dataKey="lendingRatio" stroke="var(--up)" strokeDasharray="4 2" dot={false} name="貸借倍率" connectNulls={false} />`
  - `<ReferenceLine yAxisId="ratio" y={1} stroke="var(--text-muted)" strokeDasharray="2 2" label={{ value: '1.0', position: 'right', fontSize: 10, fill: 'var(--text-muted)' }} />`
  - カードの下に`<p className="note">日本証券金融の貸借取引残高(融資残・貸株残)。取引所公表の信用残とは異なります。貸借倍率(融資残÷貸株残)が1.0を下回ると貸株超過で、逆日歩が付く可能性があります。</p>`(既存に注記用クラスがあればそれを使う。無ければ`style={{ fontSize: 12, color: 'var(--text-muted)' }}`)
  - 色は既存のCSS変数(`--accent`・`--text-muted`・`--up`・`--border`)だけを使う

`YutaiListPage.tsx`:
- 130行目: `日証金の貸借取引残高 {tse.snapshotDate} 時点(権利日{tse.lagDays}日前)`
- 149行目のtooltip: `直近の日証金の貸借取引残高(融資残・貸株残)から求めた貸株超過率をもとに、過去の類似ケースの分布から算出した逆日歩の目安。過去実績ベースよりリスクが高い区分に入っていれば↑。`
- 171行目のtooltip: `直近の日証金の貸株残が4週間前の何倍か。権利日に向けた空売りの積み上がりペースで、3倍以上の急増は逆日歩発生の先行シグナルです。`
- `buildColumns(tseEnabled: boolean)`を`buildColumns()`にし、`tseColumns`を常に含める。427〜428行目は`const columns = useMemo(() => buildColumns(), []);`

最後に`grep -rn "tseMargin\|東証信用残\|東証貸株残\|スタンダードプラン" frontend/src`が0件であることを確認する。

- [ ] **Step 4: ビルドとlintを通す**

Run: `cd frontend; npm run build; npm run lint`
Expected: どちらもエラーなし

手動確認(テストは書かない方針。デプロイ後またはローカルのdevサーバーで): `/yutai`一覧の「想定逆日歩(現在需給)」「貸株残(4週前比)」列が常に出る、ツールチップの文言、`/yutai/:ticker`の現在需給カードの見出し、貸借取引残高トレンドに右軸の貸借倍率と1.0の点線・注記が出る。必要なら`reference_ui_verification`メモのplaywright-core+Edgeの手順で確認する。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/components/YutaiForecastSections.tsx frontend/src/pages/YutaiListPage.tsx
git commit -m "Show the taisyaku.jp balances with a lending ratio axis and stop gating the current-supply columns on a feature flag"
```

## Task 10: 旧データ削除スクリプト・README・全体検証

**目的:** 旧`source`(`weekly`/`daily-alert`)の行を消す一回限りのスクリプトを用意し(実行はしない)、READMEを実態に合わせ、全体テストを1回通す。

**Files:**
- Modify: `lambda/shared/dynamodb-batch.ts`(`batchDelete`追加)
- Modify: `test/dynamodb-batch.test.ts`
- Create: `scripts/lib/legacy-margin-balance.ts`
- Create: `scripts/cleanup-legacy-margin-balance.ts`
- Create: `test/legacy-margin-balance.test.ts`
- Modify: `README.md`

**Interfaces:**
```ts
// lambda/shared/dynamodb-batch.ts
export async function batchDelete(
  ddbDocClient: DynamoDBDocumentClient,
  tableName: string,
  keys: Record<string, unknown>[],
): Promise<void>; // 25件ずつDeleteRequest、UnprocessedItemsはbatchUpsertと同じ再試行
// scripts/lib/legacy-margin-balance.ts
export const LEGACY_MARGIN_SOURCES = ['weekly', 'daily-alert'] as const;
export function isLegacyMarginRow(item: Record<string, unknown>): boolean;
export async function findLegacyMarginKeys(
  ddbDocClient: DynamoDBDocumentClient,
  tableName: string,
): Promise<{ keys: Array<{ ticker: string; date: string }>; countsBySource: Record<string, number> }>;
```

- [ ] **Step 1: 失敗するテストを書く**

`test/dynamodb-batch.test.ts`に追加(既存の`batchUpsert`テストと同じモック):
1. 30件 → `BatchWriteCommand`2回(25件+5件)、各要素が`{ DeleteRequest: { Key: {...} } }`
2. 1回目が`UnprocessedItems: { T: [最初の1件] }`を返す → 再送される(呼び出し3回)
3. 空配列 → 呼ばない

`test/legacy-margin-balance.test.ts`(`@aws-sdk/lib-dynamodb`をモック、`ScanCommand`は入力をそのまま返す):
1. `isLegacyMarginRow`: `{ source: 'weekly' }`→true、`{ source: 'daily-alert' }`→true、`{ source: 'taisyaku' }`→false、`{ ticker: '__cursor__', date: 'taisyaku', lastFetchedDate: '2026-10-23' }`→false、`{}`→false
2. `findLegacyMarginKeys`: Scan 2ページ(1ページ目に`LastEvaluatedKey`)で、weekly 2件・daily-alert 1件・taisyaku 1件・cursor 1件 → `keys`が旧3件の`{ ticker, date }`だけ、`countsBySource`が`{ weekly: 2, 'daily-alert': 1 }`、2回目のScan入力に`ExclusiveStartKey`、Scan入力に`FilterExpression: '#source IN (:weekly, :dailyAlert)'`・`ProjectionExpression: 'ticker, #date, #source'`・`ExpressionAttributeNames: { '#date': 'date', '#source': 'source' }`

- [ ] **Step 2: 失敗を確認する**

Run: `npx jest test/dynamodb-batch.test.ts test/legacy-margin-balance.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

- `batchDelete`: `batchUpsert`と同じループ構造(25件ずつ、`UnprocessedItems`を最大10回・指数バックオフで再試行)
- `scripts/lib/legacy-margin-balance.ts`: 上記Scan入力で全ページを読み、JS側でも`isLegacyMarginRow`で絞る
- `scripts/cleanup-legacy-margin-balance.ts`(`scripts/evaluate-forecast.ts`と同じ書き方: 冒頭コメントに目的と実行例、`async function main()`、`main().catch((error) => { console.error(error); process.exitCode = 1; })`):
  - 冒頭コメント: 「J-Quants版の信用残(`source`=`weekly`/`daily-alert`)を`JQuantsMarginBalance`から消す一回限りのスクリプト。taisyaku.jpのバックフィル完了(カーソル行`lastFetchedDate`が直近の営業日)を確認してから手動で実行する。PITRが有効なので誤削除は復旧できる。実行例: `npx ts-node scripts/cleanup-legacy-margin-balance.ts`(件数の表示だけ)、`npx ts-node scripts/cleanup-legacy-margin-balance.ts --execute`(削除)」
  - テーブル名は`process.env.MARGIN_BALANCE_TABLE_NAME ?? 'JQuantsMarginBalance'`
  - 既定はドライラン(`countsBySource`と先頭5件のキーを表示)。`--execute`があるときだけ`batchDelete`し、削除件数を表示
  - カーソル行(`ticker`=`__cursor__`)とtaisyaku行は消さない(`isLegacyMarginRow`で保証)
  - **このスクリプトは実行しない**
- README.md:
  - 25〜28行目のEventBridge→MarginBalanceBatchFunctionの図: 「EventBridge(平日 JST19:15)→ taisyaku.jpの全銘柄一括CSV(基準日ごと3リクエスト)を、カーソル行の日から最大40日分取得 → `JQuantsMarginBalance`に`source`=`taisyaku`でupsert」
  - 59行目: 「`tseMarginFeatures`有効時は」を削除(`tseForecast`・`_POOL_TSE_`は常に書く)
  - 113行目付近と138行目の「現在需給ベース予測(東証信用残、スタンダードプラン依存)」を「現在需給ベース予測(日証金の貸借取引残高)」にし、データの意味の違い(設計書「用語・数値の意味の変更」の表の要点: 日証金から借りた分だけで制度信用残より小さい。貸借倍率1未満=貸株超過)を1〜2文で書く
  - Lambda表の`MarginBalanceBatchFunction`行: トリガー`cron(15 10 ? * MON-FRI *)` = JST平日19:15、役割(カーソル`__cursor__`、`MAX_DATES_PER_RUN`=40、`REQUEST_INTERVAL_MS`=1000、0件の日の扱い、2日連続失敗でメール)。`YutaiRiskPrecomputeBatchFunction`行に「貸借判定は`marginName`」、`GyakuhibuForecastBatchFunction`行から`TSE_MARGIN_FEATURES_ENABLED`の記述を削除し「信用残バッチの後に走るので当日公表分までの残高を使う」
  - API表の`GET /yutai/{ticker}/margin-trend`: 「`source`=`taisyaku`の直近365日、各点に`lendingRatio`」
  - 273〜283行目の「スタンダードプラン依存機能のON/OFF(`tseMarginFeatures`)」節を削除し、代わりに「信用残(taisyaku.jp)への移行手順」節を置く:
    1. `ALERT_EMAIL`は`cdk synth`/`deploy`/テスト合成で必須(bash: `ALERT_EMAIL=you@example.com npx cdk deploy`、PowerShell: `$env:ALERT_EMAIL='you@example.com'; npx cdk deploy`)
    2. デプロイ順はフロント(`aws s3 sync` + CloudFront invalidation)が先、`cdk deploy`が後(旧フロントは`features`が無いと落ちるため)
    3. 初回デプロイ後、SNSの確認メールのリンクを踏む(踏むまで通知は届かない)
    4. バックフィル(3年=738営業日、19回分): 定期実行だけなら約4週間。早めるなら`aws lambda invoke --function-name <MarginBalanceBatchFunctionの名前> --cli-read-timeout 900 out.json`を、前の実行が終わってから繰り返す(同時に走らせない)。カーソル行(`ticker`=`__cursor__`, `date`=`taisyaku`)の`lastFetchedDate`で進み具合を確認
    5. 数銘柄でtaisyaku.jpの画面とグラフの値が一致することを確認
    6. `scripts/cleanup-legacy-margin-balance.ts`をドライラン→`--execute`
    7. J-Quantsのダウングレードは他の無料プラン化課題の後
    8. J-Quants版の最終状態はタグ`margin-balance-jquants-final`

- [ ] **Step 4: 成功を確認する**

Run: `npx jest test/dynamodb-batch.test.ts test/legacy-margin-balance.test.ts`
Expected: PASS

- [ ] **Step 5: 全体検証(この計画で1回だけ)**

```bash
npx tsc --noEmit
NODE_OPTIONS=--max-old-space-size=4096 npx jest -i
cd frontend && npm run build && npm run lint
```
(PowerShell: `npx tsc --noEmit; $env:NODE_OPTIONS='--max-old-space-size=4096'; npx jest -i`)
Expected: すべて成功。`npx jest -i`は15分ほどかかる。残りの参照確認として`grep -rn "tseMargin\|TSE_MARGIN\|fetchAllWeeklyBalancesForDate\|fetchAllDailyAlertBalancesForDate" lambda lib bin frontend/src test scripts cdk.json`が0件

- [ ] **Step 6: Commit**

```bash
git add lambda/shared/dynamodb-batch.ts test/dynamodb-batch.test.ts scripts/lib/legacy-margin-balance.ts scripts/cleanup-legacy-margin-balance.ts test/legacy-margin-balance.test.ts README.md
git commit -m "Add a one-off script to delete the legacy J-Quants margin rows and document the taisyaku.jp migration"
```

---

## Self-Review(計画作成時に確認済み)

- 設計書「実装前レビュー」1〜11: 1→Task 1・2、2→Task 3・4、3→Task 3(1095日)、4→Task 6・9、5→Task 5、6→Task 4・8、7→Task 6・7・8・9、8→Task 8、9→Task 8、10→Task 7、11→対応不要
- テスト方針: パーサー(Task 1)、対象期間(Task 3)、方式Bは対象外、`marginType`は不採用のため`marginName`の判定(Task 5)、`margin-trend`の`source`と`lendingRatio`(Task 7)、全件失敗時の例外と部分失敗(Task 4)、スタック合成(Task 8)、フロントは手動(Task 9)
- 設計書の本文(「実装前レビュー」より後の節)にあって採用しないもの: 方式B、`marginType`/`marginTypeUpdatedAt`、`/equities/master`呼び出し、`SECRET_ARN`の維持、`JQuantsYutaiMaster`への書き込み権限、「過去1年分のバックフィル」、タイムアウト15分(実際は14分のまま)、`APP_PASSWORD`と同様の扱い(廃止済み)
