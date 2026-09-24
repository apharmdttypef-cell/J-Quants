# 逆日歩予測 精度検証(2026-09-28 権利付き最終日)設計書

> **For agentic workers:** 既存の逆日歩予測(`docs/superpowers/specs/2026-09-05-gyakuhibu-forecast-design.md`)の出力を、2026年9月末権利の実績と突き合わせて検証する。TDDで進める。**日付が固定のタスクがあるため、下記「タイムライン」の締切を最優先すること。**

## 目的

- 充足率予測(shrinkage K=4、貸株超過率6bin、P50/P90)と status(`safe` / `caution` / `danger`)の精度を、**事前に凍結した予測**と**事後に取得した実績**の比較で検証する。
- 後出しにならないよう、予測は**売買可能な時点**で凍結し、書き換えられない形で保存する。
- 合格基準は**9/28寄付より前に凍結**する(後から基準を動かさない)。

## 前提となる事実(検証済み・既存ドキュメント参照)

- 対象日: 権利付き最終日 **2026-09-28(月)**。受渡9/30→翌営業日10/1で**品貸日数=1**。
- 最高料率 = `calcMaxRate(貸借値段, 単元株数)` × `RIGHTS_DAY_RATE_MULTIPLIER`(=4)× 品貸日数。9/28申込分の貸借値段は**9/25終値**。
- taisyaku.jp の「品貸料率」「最高料率」列は**1株あたり・品貸日数分**の値(`docs/superpowers/notes/2026-08-13-taisyaku-csv-format.md`)。「-」は逆日歩0円。
- 日証金の公表サイクル: 申込日当日18時半過ぎに**速報**、翌営業日8:30〜10:00の翌朝訂正を経て11:30〜16:00頃に**確報**(品貸料確定)。
- 8倍・10倍の臨時措置は事前予測不能(`docs/superpowers/notes/2026-09-03-taisyaku-rights-day-rate-multiplier.md`)。

**前提確認(実装者がまず確認すること):** 逆日歩予測機能(`2026-09-05-gyakuhibu-forecast-plan.md`)の予測ロジックが純粋関数として呼び出せる状態であること。未完了の場合は、予測ロジック部分だけを先に完成させる必要がある旨をユーザーに報告して指示を仰ぐ。

## タイムライン(締切固定)

| 日時(JST) | 内容 | 締切 |
|---|---|---|
| 9/24(木)中 | Task 1: S3バケット(Object Lock)デプロイ | 9/25 12:00 |
| 9/25(金)日中 | Task 0 事前確認 + リハーサル実行(`rehearsal/`プレフィックス) | 9/25 18:00 |
| 9/25(金)20:00 | **スナップショットA(本命)** 自動実行 | 9/28 09:00 |
| 9/28(月)09:00前 | 合格基準 `validation-criteria.json` 凍結 | 9/28 09:00 |
| 9/28(月)15:00 | **スナップショットB(参考)** 自動実行 | 9/28 15:30 |
| 9/29(火)20:00 | 実績取得(1回目) | — |
| 10/2(金)20:00 | 実績再取得(確報修正・再現性の確認) | — |
| 10/2以降 | 評価レポート生成、walk-forwardバックテスト | — |

## 2つのスナップショット

| ID | asof | 位置づけ | 入力 |
|---|---|---|---|
| A | `2026-09-25T2000JST` | 実運用の判断ポイント(**本命**) | 貸借値段=9/25終値。貸株超過率は2バリアント: `final`=9/24確報(**正式**)、`prelim`=9/25速報(参考) |
| B | `2026-09-28T1500JST` | 売買可能時間内の最良値(参考上限) | 貸借値段=9/25終値。貸株超過率=9/25確報(15:00時点で出ていれば)、無ければ9/25速報。銘柄ごとに `dataStatus` を記録 |

- スナップショットAの正式バリアントは `final`(9/24確報)。manifestに `primaryVariant: "final"` と明記する。
- 最高料率はA・Bとも9/25終値で確定計算できる(予測誤差は充足率部分のみ)。

### 再実行ルール

- 失敗時は別キーで再実行する(`run=1`, `run=2`, …)。途中で失敗したrunも削除しない。
- **正式版 = 締切より前に完了した最後のrun**(A: 9/28 09:00、B: 9/28 15:30)。manifestの `completedAt` で判定する。

## Task 0: 事前確認(9/25日中、コード変更なし・結果をnotesに記録)

調査結果は `docs/superpowers/notes/2026-09-25-validation-preflight.md` に残す。

1. 9/28権利付き最終日に該当する対象銘柄数(`JQuantsYutaiMaster` の `rightsMonths` に9を含み、貸借銘柄のもの)。
2. taisyaku.jp の取得経路で、**当日分の速報行**が当日夜に取得できるか。取得できる場合、速報と確報を区別できる項目があるか。9/24分(9/25昼に確報)と9/25分(9/25夜に速報)で確認する。
3. 全対象銘柄の取得所要時間の見積り。Lambdaの15分制限を超えるなら分割実行(Step Functions Map、または銘柄チャンクごとの並列invoke)を採用する。既存の `MAX_GYAKUHIBU_FETCHES_PER_RUN` の上限とは独立に動かすこと。
4. 検索ページ(`/app/stock/search`、`mkYmd` 指定)の1日分スナップショットCSVで、複数銘柄を一括取得できるか。できれば詳細ページを銘柄ごとに取得するより優先する。
5. `JQuantsStockPrices` に9/25終値が20:00時点で入っていること(`PriceBatchFunction` は18:00実行)。

## Task 1: 凍結用S3バケット(CDK)

- 新規バケット `GyakuhibuValidationBucket` を作成する。設定: `objectLockEnabled: true`、デフォルト保持 **Governanceモード・2026-12-31まで**、バージョニング有効、`RemovalPolicy.RETAIN`、パブリックアクセスブロック、SSE-S3。
- Lambdaの実行ロールは `s3:PutObject` / `s3:GetObject` / `s3:ListBucket` のみ。`s3:BypassGovernanceRetention` は付与しない。
- テスト: スタック合成テストで上記プロパティを検証する。
- デプロイ後、テストオブジェクトを書き込んで、上書きと削除が拒否されることを手動で確認する。

## Task 2: スナップショットLambda `ForecastSnapshotFunction`

入力イベント: `{ rightsDate, asofLabel, runId, prefix? }`(`prefix` はリハーサル時に `rehearsal/`)

処理:

1. 対象銘柄を確定する(9/28が権利付き最終日かつ貸借銘柄)。この銘柄リストが以後の評価母集団になる。
2. 銘柄ごとに、taisyaku.jpの最新データ(確報・速報)と9/25終値を取得する。
3. 予測ロジック(既存の純粋関数)にバリアントごとの入力を渡して予測を出す。
4. S3に書き込み、最後にmanifestを書く(manifestの存在 = runの完了)。

S3キー: `forecast-snapshots/rightsDate=2026-09-28/asof={asofLabel}/run={runId}/`

- `inputs/`: 取得した生CSV(加工しない)
- `forecast.json`: 銘柄ごとのレコード(下記)
- `manifest.json`: `startedAt`, `completedAt`, `gitCommit`, モデルパラメータ(`K`, bin境界), `primaryVariant`, 銘柄数の内訳(`ok` / `fetch_error`、`final` / `prelim` 件数), 各ファイルのsha256

`forecast.json` の1レコード:

```json
{
  "ticker": "9418",
  "variant": "final",
  "inputAsOf": "2026-09-24",
  "dataStatus": "final",
  "closePrice": 1752,
  "pricedAt": "2026-09-25",
  "requiredShares": 100,
  "maxRatePerShare": 14.4,
  "days": 1,
  "financingBalance": 0,
  "lendingBalance": 0,
  "lendingExcessRatio": 0,
  "bin": 0,
  "tickerSampleCount": 0,
  "shrinkageWeight": 0,
  "fillRatioP50": 0,
  "fillRatioP90": 0,
  "costP50": 0,
  "costP90": 0,
  "yutaiValue": 0,
  "status": "safe",
  "fetchStatus": "ok"
}
```

注意:

- 取得に失敗した銘柄は `fetchStatus: "fetch_error"` として記録する。**古いデータへの暗黙のフォールバックは禁止**。
- 保有株数(`requiredShares`)は予測時のstatus判定と同じものを使う。

テスト(Jest、taisyaku・DynamoDB・S3はモック):

- バリアント別の入力選択(確報あり/なし)
- 取得失敗時にフォールバックせず `fetch_error` になること
- manifestが最後に書かれること
- sha256の計算

## Task 3: スケジュール(EventBridge Scheduler、1回限り)

すべて `scheduleExpressionTimezone: "Asia/Tokyo"`。

- `at(2026-09-25T20:00:00)` → `ForecastSnapshotFunction`(A, `run=1`)
- `at(2026-09-28T15:00:00)` → `ForecastSnapshotFunction`(B, `run=1`)
- `at(2026-09-29T20:00:00)` → `ForecastActualsFunction`(1回目)
- `at(2026-10-02T20:00:00)` → `ForecastActualsFunction`(再取得)

リハーサル(9/25日中)は手動invokeで `prefix: "rehearsal/"` を指定する。リハーサルでは9/24申込分を対象に、パイプライン全体を通しで確認する。

## Task 4: 実績取得Lambda `ForecastActualsFunction`

- 評価母集団は**スナップショットAの銘柄リスト**に固定する(後から銘柄を追加しない)。
- 銘柄ごとに9/28申込日の行を取得し、下記の項目を記録する。
- S3キー: `actuals/rightsDate=2026-09-28/fetchedAt={label}/`(`inputs/` の生CSV、`actuals.json`、`manifest.json`)

1レコード:

```json
{
  "ticker": "9418",
  "fetchStatus": "ok",
  "lendingFeeTotal": 0,
  "days": 1,
  "maxRateActual": 0,
  "minRateActual": 0,
  "financingBalance": 0,
  "lendingBalance": 0,
  "bidRank": "",
  "measures": [],
  "fillRatioActual": 0,
  "multiplierActual": 4,
  "specialMultiplier": false,
  "costActual": 0,
  "statusActual": "safe",
  "excessGroup": "excess"
}
```

- `fetchStatus`: `ok` / `no_row`(ページは取れたが9/28行が無い)/ `fetch_error`。**`no_row` と `fetch_error` を0円扱いにしない**。0円扱いにするのは、品貸料率が「-」の場合だけ。
- `fillRatioActual` = `lendingFeeTotal / maxRateActual`(どちらも品貸日数分なので日数は約分される)。
- `multiplierActual` = `maxRateActual / (calcMaxRate(9/25終値, 単元株数) × days)`。4以外なら `specialMultiplier: true`。
- `costActual` = `lendingFeeTotal × requiredShares`(逆日歩のみ。貸株料・手数料は含めない)。
- `statusActual`: 予測と**同じstatus判定関数**に実績コストを入れて算出する。
- `excessGroup`: 実績の確報残高で `excess`(貸株残 > 融資残)と `no_excess` に分ける。

テスト: `-` → 0円、行欠損 → `no_row`、クォート付きの値のパース(`stripQuotes` の既存バグの再発防止)、倍率の判定。

照合(レポートに記載):

- 既存 `JQuantsGyakuhibuActual` の9/28分との不一致一覧。事前に `totalAmount` / `avgRate` の定義が今回の正解値と一致するかを確認する。
- 10/2の再取得との差分(ゼロであること)。

## Task 5: 評価スクリプト `scripts/evaluate-forecast.ts`

入力: スナップショット(A正式、A-prelim、B)と実績。出力: `evaluations/rightsDate=2026-09-28/report.md` と `metrics.json`(S3とリポジトリの `docs/superpowers/notes/` の両方)。

集計の区分:

- **本命集計**: スナップショットAの `final` × `excessGroup = excess` × `specialMultiplier = false` × `fetchStatus = ok`。
- `no_excess` 群、特殊倍率群、取得失敗は件数だけ別記する。

指標(純粋関数として実装し、ユニットテストを付ける):

1. **分位点カバレッジ**: 実績充足率 ≤ P50 の割合、≤ P90 の割合。
2. **pinball loss**: P50(τ=0.5)とP90(τ=0.9)。
3. **発生有無**: 予測上の発生と実績の発生(逆日歩 > 0)の混同行列、bin別の発生率。
4. **statusの混同行列**: 予測3クラス × 実績。**safe予測のうち実績で損失になった銘柄**は全件を一覧化する(銘柄、入力、予測、実績)。
5. **bin別の内訳**: 6binそれぞれの件数、カバレッジ、pinball loss。
6. **ベースライン比較**(同じ母集団でのpinball loss): (a) pooledのみ、(b) per-tickerのみ、(c) 充足率100%(最大逆日歩)。
7. **スナップショット間の比較**: A-final、A-prelim、Bの各指標の差分。statusが入れ替わった銘柄の一覧と、どちらが正しかったか。

## Task 6: 合格基準の凍結(9/28 09:00まで)

`validation-criteria.json` をS3の `criteria/rightsDate=2026-09-28/` に書き込む(Object Lockで保持)。**以下は初期値。ユーザー確認後に凍結すること。**

| 基準 | 条件(本命集計) |
|---|---|
| P90カバレッジ | 80%以上、97%以下 |
| P50カバレッジ | 35%以上、65%以下 |
| safeの見逃し | safe予測のうち実績損失の割合が5%以下 |
| ベースライン優位 | P50・P90のpinball lossが、ベースライン(a)(b)の両方以下 |
| 最低サンプル数 | 本命集計が30銘柄未満なら「判定保留」 |

判定は「合格 / 不合格 / 判定保留」の3値とし、レポートの冒頭に記載する。

## Task 7: walk-forwardバックテスト(10/2以降、9/28判定の補助)

同じ日の銘柄同士は需給ショックを共有しており、独立なサンプルではない。9/28の1回の結果だけで結論を出さないために実施する。

- taisyaku.jpの直近3年分の過去の権利付き最終日について、**その日より前のサンプルだけ**で学習し、予測を出す。
- 同じ指標を権利日ごとに算出し、分布(最小・中央値・最大)を出す。
- レポートには、9/28の結果がその分布のどこに位置するかを記載する。
- 過去データには事前凍結が無いため、入力は「権利付き最終日の2営業日前の確報」を使ってスナップショットAの条件を再現する。

## スコープ外

- 予測モデル自体の改善(検証結果を見てから別スペックで扱う)
- 8倍・10倍の臨時措置の予測
- 一般信用クロス(逆日歩が発生しないため)
- 画面への検証結果の表示
