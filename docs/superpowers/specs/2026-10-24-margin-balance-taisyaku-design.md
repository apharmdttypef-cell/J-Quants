# 信用残データソースのtaisyaku.jp移行 設計書

`MarginBalanceBatchFunction`の信用残取得元を、J-Quants Standardプラン専用エンドポイント(`/markets/margin-interest`・`/markets/margin-alert`)から、日本証券金融公式サイト taisyaku.jp の貸借取引残高(融資残・貸株残)に切り替える。あわせて貸借銘柄判定を「信用残データの有無」から J-Quants `/equities/master` の貸借信用区分に切り替える。

## 背景・目的

- J-Quants Standardプラン(¥3,300/月)は利用に対してコストが重いため、無料プラン化に向けて依存箇所を一つずつ外している。本設計はそのうち「信用残」を担当する。
- 信用残の用途は **信用残トレンドグラフの表示** と **貸借銘柄判定(`riskStatus`の`na`判定)** のみで、逆日歩の見積り計算(最高料率ベース)には使っていない(`lib/j-quants-stack.ts`の`marginBalanceTable`コメント参照)。したがってJ-Quantsの信用残は代替可能。
- 逆日歩は **日証金の貸株残が融資残を上回る(貸株超過)** ことで発生するため、取引所の制度信用残よりも日証金の貸借取引残高のほうがリスク判定の目的に直結する。
- taisyaku.jpはJ-Quantsと無関係の無料公式データソースで、`GyakuhibuHistoryBatchFunction`で既に取得実績がある(CSRF+セッションCookieの3ステップ取得方式、`parseTaisyakuCsv`)。

本アプリは個人用。YAGNIで進める。

## 実装前レビューでの変更(2026-10-24、本節が以下の各節より優先する)

実装前にコードとtaisyaku.jpの実データを確認し、以下を決めた。Task 0の結果は`docs/superpowers/notes/2026-08-13-taisyaku-csv-format.md`の末尾に追記済み。

1. **取得方式は方式A(基準日ごとの全銘柄一括CSV)に確定。** `GET /app/stock`→`POST /app/stock/search`(`csrf_test_name`+`mkYmd`のみ)→`GET /app/stock/csv`。CSVはCP932、14列、**申込日の列が無い**(`基準日`は次の権利基準日)ので行の日付は検索した`mkYmd`を使う。同じ銘柄に市場区分ごとの行があるので`市場区分`=`東証`の行だけを使う。方式Bと`lambda/shared/`への取得処理の共通化は行わない
2. **差分取得の状態**は`JQuantsMarginBalance`の管理行(`ticker`=`__cursor__`)で持つ。対象日は営業日カレンダー(`lambda/shared/trading-calendar.ts`)の営業日だけにする。営業日なのに0件の場合は未公表とみなし、カーソルを進めずにその回の取得を終える。遅れて公表された分や訂正を拾うため、毎回直近1営業日は取り直す
3. **バックフィルは3年分**(taisyaku.jpの公開範囲いっぱい)。下記4の現在需給予測が過去の権利日の前のスナップショットを必要とするため。`MAX_DATES_PER_RUN`で1回あたりの日数を絞り、数日かけて追いつく
4. **逆日歩予測の現在需給予測(`current-tse`/`tseForecast`/`_POOL_TSE_`/貸株残4週前比)もtaisyaku.jpのデータに切り替える。** `scanMarginSnapshots`は`source`=`taisyaku`の行だけを使う(旧データと混ぜない)。プールは日証金の残高で自動的に作り直される。画面・ツールチップの「東証信用残」「スタンダードプラン限定」の文言は「日証金の貸借取引残高」に改める。設計書「含まない」の逆日歩予測機能側の変更のうち、この入力の切り替えだけは本設計に含める
5. **貸借銘柄判定は既存の`marginName`を使う。** `JQuantsYutaiMaster.marginName`(J-Quants `/equities/master`の`MrgnNm`)は`YutaiRiskPrecomputeBatchFunction`が既に毎回更新している。新属性`marginType`/`marginTypeUpdatedAt`は作らず、`MarginBalanceBatchFunction`から`/equities/master`も呼ばない。変更は`YutaiRiskPrecomputeBatchFunction`の`hasMarginBalance`(信用残データの有無)を`marginName === '貸借'`に置き換えることだけ。`ReferenceApiFunction`は`na`判定に信用残を使っていないので変更不要
6. 上記5により`MarginBalanceBatchFunction`はJ-Quantsを一切呼ばなくなるため、**`SECRET_ARN`の環境変数と読み取り権限は削除する**。`JQuantsYutaiMaster`への書き込み権限も追加しない(読み取りのみ)
7. **`tseMarginFeatures`フラグ**: 信用残はStandardプラン依存ではなくなるので、`MarginBalanceBatchSchedule`はフラグに関係なく常に作る。現在需給予測(上記4)もStandard依存ではなくなるため、フラグとそれに連動する`TSE_MARGIN_FEATURES_ENABLED`・`features.tseMargin`は削除し、常に有効とする
8. スケジュールは現状すでに平日毎日(JST 17:30)。これを**平日JST 20:00**(UTC 11:00、MON-FRI)に変える。タイムアウトは現状の14分のまま
9. `ALERT_EMAIL`は未設定なら合成時にエラーにする(設計書どおり)。`APP_PASSWORD`は既に廃止済みなので、既存テストの「環境変数なしで合成できる」前提は「`ALERT_EMAIL`だけ設定すれば合成できる」に改める
10. `GET /yutai/{ticker}/margin-trend`と予測API(`GET /yutai/{ticker}/forecast`)の`marginTrend.latest`は、DynamoDBのQueryでLimitがフィルタより先に効くため、`source`フィルタを付けるなら日付範囲のKeyCondition(直近365日)で取る形にする。`latest`も`source`=`taisyaku`の最新行を返す
11. `/yutai`一覧のダミーデータ注意バナーは既に存在しないので対応不要

## 用語・数値の意味の変更(重要)

| 項目 | 変更前(J-Quants) | 変更後(taisyaku.jp) |
|---|---|---|
| 意味 | 取引所集計の制度信用残。投資家の建玉合計 | 日証金の貸借取引残高。証券会社が社内対当・自己融資/自己貸株で賄えず日証金から借りた分 |
| `financingBalance` | 制度信用買残(`LongStdVol`/`LongStdOut`) | 融資残高 |
| `lendingBalance` | 制度信用売残(`ShrtStdVol`/`ShrtStdOut`) | 貸株残高 |
| 更新頻度 | 週次(+日々公表銘柄のみ日次) | 日次(申込日ごと) |
| 主な指標 | 取組比率(買残÷売残) | 貸借倍率(融資残÷貸株残)。1未満=貸株超過=逆日歩発生の可能性 |

関係: `制度信用残 − 社内対当 − 自己融資/自己貸株 ≒ 貸借取引残高`。同じ銘柄でも絶対値は変更前より大幅に小さくなる。**既存データと新データを同じグラフ上で連続させてはならない。**

なお、属性名`financingBalance`(融資残)/`lendingBalance`(貸株残)は変更後のほうが本来の意味に一致する。属性名は変更しない。

## スコープ

**含む**:
- `lambda/margin-balance-batch/data-source.ts`をtaisyaku.jp取得に差し替え
- `MarginBalanceBatchFunction`の取得ロジック(差分取得・1回あたりの上限)とスケジュール変更
- 貸借銘柄判定を`/equities/master`の貸借信用区分に切り替え(`JQuantsYutaiMaster`に属性追加)
- `YutaiRiskPrecomputeBatchFunction`・`ReferenceApiFunction`の`na`判定の切り替え
- `GET /yutai/{ticker}/margin-trend`のレスポンスへの`source`フィルタ・貸借倍率の追加
- フロントの信用残トレンドグラフのラベル・指標変更
- CDKの権限・環境変数・スケジュール変更
- 旧データ(`source`=`weekly`/`daily-alert`)の扱い

**含まない**:
- J-Quantsプランの実際のダウングレード作業(他の無料プラン化課題の完了後に別途実施)
- 株価のYahoo切り替え、financial-summary-batchの日付一括取得化(別設計書)
- 逆日歩予測機能(`2026-09-05-gyakuhibu-forecast-design.md`)側の変更。ただしTask 0のCSV調査は本設計と共有できる(下記)
- 取引所ベースの信用残(JPX公表のPDF/Excel)の取得

## Task 0: taisyaku.jpデータの事前調査(実装前に必須)

既存調査(`docs/superpowers/notes/2026-08-13-taisyaku-csv-format.md`)で以下は確定済み:

- 銘柄詳細ページのCSV(`GET /app/stock/detail/{code}-01` → `POST /app/stock/detail/{code}/search` → `GET /app/stock/detail/{code}/csv`)は申込日ごとの行を持ち、`貸借取引残高(株・口)`の`融資`/`貸株`それぞれの`残高`列を含む
- 公開範囲は直近3年分

以下を実データで確認し、結果を上記notesに追記すること:

1. **詳細ページCSVが全営業日の行を含むか**(逆日歩が発生しなかった日も行が存在し、融資残・貸株残が入っているか)。品貸料率列が`-`の日も行がある前提だが、残高列についても確認する
2. **融資残・貸株残の列名とCSV上のヘッダー**(`parseTaisyakuCsv`が現在捨てている列。逆日歩予測のTask 0と同じ調査なので共通化する)
3. **検索結果ページ(基準日指定・全銘柄一覧)のCSVが使えるか**。1回目の調査で検索結果テーブルに`銘柄コード / 基準日 / 融資残高（株） / 貸株残高（株） / 差引残高（株）…`の列があることは確認済み。基準日を指定して全貸借銘柄を1回で取得できるなら、銘柄数に依存しない一括取得方式(下記「方式A」)を採用する
4. データの公表タイミング(当日夕方の速報か、翌営業日の確報か)。バッチの実行時刻と「どの申込日まで取るか」を決めるため
5. `/equities/master`(V2)の貸借信用区分のフィールド名と値の定義(V1の`MarginCode`相当: 信用/貸借/その他)。Freeプランで最新状態が取得できること(12週間遅延の影響を受けないこと)

## コンポーネント詳細

### 取得方式

Task 0の結果で方式を決める。

**方式A(優先): 基準日ごとの全銘柄一括取得**
- 検索結果ページを基準日指定で検索→CSV取得(1日あたり3リクエスト程度)
- 取得結果を`JQuantsYutaiMaster`の銘柄でフィルタしてupsert
- 銘柄数に依存しないため、タイムアウトの心配が無い

**方式B(フォールバック): 銘柄ごとの詳細ページCSV**
- 既存の`GyakuhibuHistoryBatchFunction`と同じ3ステップ取得を流用(取得処理は`lambda/shared/`に共通化する)
- 1銘柄あたり3リクエストのため、`MAX_MARGIN_FETCHES_PER_RUN`(既定値はTask 0後に決定、目安100銘柄)で1回あたりの処理銘柄数に上限を設け、超過分は翌日以降に持ち越す(`MAX_GYAKUHIBU_FETCHES_PER_RUN`と同じパターン)
- 処理順は「最終取得日が古い銘柄から」とし、全銘柄が公平に更新されるようにする

両方式とも、taisyaku.jpへの負荷を抑えるためリクエスト間隔を`REQUEST_INTERVAL_MS`(既定1000ms)空ける。

### 差分取得

固定期間ではなく **「最終保存日の翌日〜取得可能な最新申込日」** を取得する。バッチが失敗した日があっても次回の実行で自動的に追いつく。

- 方式A: 処理状態として最終取得済み基準日を保持する(`JQuantsMarginBalance`に`ticker`=`__cursor__`の管理行を置くか、SSM Parameter Storeを使う。実装時に簡単なほうを選んでよい)。1回あたりの処理日数に上限(`MAX_DATES_PER_RUN`、目安20日)を設ける
- 方式B: 銘柄ごとに`JQuantsMarginBalance`の`source`=`taisyaku`の最新`date`を参照する
- `source`=`taisyaku`のデータが1件も無い銘柄(初回)は、過去1年分をバックフィル対象とする(`margin-trend`が直近1年固定のため。taisyaku.jpの公開範囲3年以内に収まる)

### `lambda/margin-balance-batch/data-source.ts`

- `MarginBalancePoint`の`source`型に`'taisyaku'`を追加: `'weekly' | 'daily-alert' | 'taisyaku'`
- J-Quants呼び出し(`fetchAllWeeklyBalancesForDate`/`fetchAllDailyAlertBalancesForDate`等)は削除する。Standardに戻す可能性は低いため残さない
  - 削除コミットの**直前**のコミットに注釈付きタグを打ち、J-Quants版の最終状態をすぐ参照できるようにする:
    `git tag -a margin-balance-jquants-final -m "J-Quants Standard版 信用残取得の最終状態(taisyaku.jp移行前)"` → `git push origin margin-balance-jquants-final`
  - 削除コミットのメッセージにタグ名を記載する
- CSVのパースは純粋関数として切り出す(`parseTaisyakuBalanceCsv`)。全フィールドがダブルクォートで囲まれている既知の仕様に対応するため、既存の`stripQuotes`ヘルパーを使う(過去にクォート未除去で`NaN`になったバグあり)
- `date`は申込日(`YYYY-MM-DD`に正規化)を使う
- 残高が`-`や空の場合はその日のデータを保存しない(0として保存しない)

### 貸借銘柄判定

- `JQuantsYutaiMaster`に属性`marginType`(`'taisyaku'`=貸借銘柄 / `'shinyo'`=信用銘柄 / `'other'`)と`marginTypeUpdatedAt`を追加
- `MarginBalanceBatchFunction`の冒頭で`/equities/master`を`code`省略で1回呼び(全上場銘柄、ページングあり)、`JQuantsYutaiMaster`の各銘柄の`marginType`を更新する。値に変化がある銘柄だけ書き込む
- J-Quants APIキー(`SECRET_ARN`)は引き続きこの用途で必要。Freeプランのレート制限(5req/分)に合わせて13秒間隔で呼ぶ(ページング数ページ程度の想定)

### `YutaiRiskPrecomputeBatchFunction` / `ReferenceApiFunction`

- `riskStatus`の`na`判定条件のうち「信用残データ無し=貸借銘柄でない」を「`marginType !== 'taisyaku'`」に置き換える
- `marginType`が未設定(バッチ未実行)の銘柄は従来どおり`na`とする
- その他の`na`条件(次回権利日無し・前日終値未記録)は変更しない

### `GET /yutai/{ticker}/margin-trend`

- `source`=`taisyaku`のデータのみを返す(旧データと混在させないため)
- 各ポイントに`lendingRatio`(貸借倍率 = `financingBalance / lendingBalance`。`lendingBalance`が0の場合は`null`)を追加する
- 直近1年分(365件)固定は維持

### 旧データ(`source`=`weekly`/`daily-alert`)の扱い

- APIでフィルタするため、残っていても表示には影響しない
- 同じ`date`のtaisyaku.jpデータで上書きされた行は自然に置き換わる(PK `ticker` / SK `date`が同じため)
- 残った旧データの削除は一回限りのスクリプト(`scripts/cleanup-legacy-margin-balance.ts`)で行う。バックフィル完了の確認後に手動実行する。テーブルにはPITRが有効なので誤削除からの復旧は可能

### フロント(信用残トレンドグラフ)

- 系列ラベルを「融資残」「貸株残」に変更(変更前は内部的に買残・売残を表示していた)
- 貸借倍率を第2軸または別グラフで表示し、**1.0の位置に基準線**を引く(1未満=貸株超過)
- グラフ下部に注記: 「日本証券金融の貸借取引残高(融資残・貸株残)。取引所公表の信用残とは異なります」
- `/yutai`一覧にダミーデータの注意バナー(「現在、信用残・貸借判定はダミーデータです」)が残っていれば削除する

### CDK(`lib/j-quants-stack.ts`)

- `MarginBalanceBatchFunction`のスケジュールを毎週月曜から **毎日** に変更(実行時刻はTask 0の公表タイミング調査で決定。目安 JST 20:00)
- 環境変数: `REQUEST_INTERVAL_MS`(既定1000)、方式に応じて`MAX_DATES_PER_RUN`または`MAX_MARGIN_FETCHES_PER_RUN`
- Lambdaのタイムアウトは15分のまま
- `SECRET_ARN`の読み取り権限は`/equities/master`呼び出しのため維持する
- `JQuantsYutaiMaster`への書き込み権限を追加(`marginType`更新のため)
- SNSトピック`JQuantsBatchAlarmTopic`+メールサブスクリプション(`ALERT_EMAIL`、未設定なら`APP_PASSWORD`同様に合成時エラー)、および上記CloudWatchアラームを追加

## エラーハンドリング

- taisyaku.jpの取得失敗(CSRF取得失敗・HTTPエラー・CSVフォーマット不正): その日付/銘柄をスキップしてログに残す。差分取得のため次回自動的に再試行される
- CSVのヘッダーが想定と異なる場合: 例外を投げてバッチを失敗させる(黙って空データを保存しない)。フォーマット変更に早く気付けるようにする
- `/equities/master`の取得失敗: `marginType`の更新をスキップし、信用残の取得は続行する(前回の`marginType`がそのまま使われる)
- 連続失敗の検知: **2日連続で失敗したらメールで通知する**
  - CloudWatchアラーム: `MarginBalanceBatchFunction`の`Errors`メトリクス、統計`Sum`、期間1日、閾値`>= 1`、評価期間2・アラームに必要なデータポイント2(=2日連続)。`treatMissingData`は`notBreaching`
  - 通知先: SNSトピック(`JQuantsBatchAlarmTopic`)にメールサブスクリプションを追加し、アラームのアクションに設定する。将来ほかのバッチ(株価のYahoo取得など)の連続失敗通知にも同じトピックを使い回せるよう、トピックはスタック内で共通の1つとする
  - 宛先メールアドレスは`APP_PASSWORD`と同じく`cdk deploy`時の環境変数`ALERT_EMAIL`で必須入力とする(コードに直書きしない)
  - 初回デプロイ後、SNSから届く確認メールのリンクを踏むまで通知は届かない(README・移行手順に明記する)
  - ログ上で失敗が分かるだけでは不十分。部分失敗(スキップのみで例外なし)はアラームに乗らないため、1回の実行で全件失敗した場合(取得件数0かつスキップ件数>0)は最後に例外を投げてLambdaのエラーとして計上する

## テスト方針(TDD)

- `parseTaisyakuBalanceCsv`: 実際のCSVを元にしたフィクスチャ(ダブルクォート付き)で、残高の抽出・日付の正規化・`-`/空の行のスキップ・ヘッダー不一致時の例外を検証
- 差分取得の対象期間の算出(純粋関数): 初回(1年分バックフィル)・通常(最終保存日の翌日から)・追いつき時の上限適用・最終保存日が最新の場合(取得なし)を検証
- 方式Bの場合: 処理順(最終取得日が古い順)と上限の適用を検証
- `marginType`の判定とマッピング(`/equities/master`のレスポンスをモック): 貸借/信用/その他・対象外銘柄の無視・変化がある銘柄だけ書き込むことを検証
- `riskStatus`の`na`判定: `marginType`ごと・未設定の場合を既存テストに追加
- `margin-trend`: `source`フィルタと`lendingRatio`(0除算で`null`)を検証
- 全件失敗時に例外を投げること(部分失敗では投げないこと)を検証
- スタック合成テスト: スケジュールが日次になっていること、権限・環境変数、SNSトピックとメールサブスクリプション、アラームの設定値(期間1日・評価期間2・`notBreaching`)、`ALERT_EMAIL`未設定時に合成が失敗すること
- フロントは既存方針どおり手動確認

## 移行手順

1. Task 0を実施し、取得方式(A/B)と公表タイミングを決定してnotesに記録
2. 現在のmainにタグ`margin-balance-jquants-final`を打ってpushする
3. 実装・テスト(J-Quants Standard契約中に行う)
4. `ALERT_EMAIL=xxx APP_PASSWORD=xxx npx cdk deploy`でデプロイし、SNSの確認メールのリンクを踏む
5. 初回バックフィル(過去1年分)の完了を確認。方式Bの場合は上限により数日かかる
6. 数銘柄で、taisyaku.jpの画面表示とグラフの値が一致することを手動確認
7. 旧データ削除スクリプトを実行
8. 他の無料プラン化課題(株価のYahoo切り替え、financial-summary-batchの日付一括取得化)の完了後に、J-Quantsをダウングレードする
