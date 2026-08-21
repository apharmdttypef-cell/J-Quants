# 優待クロス機能スケール対応(サブプロジェクトC) 設計書

全体のロードマップは`docs/superpowers/specs/2026-08-18-yutai-scale-out-roadmap.md`を参照。サブプロジェクトA(バッチ鮮度別分離)・B(優待マスタ自動化)はいずれも実装・デプロイ・マージ済み。本書はサブプロジェクトBの最終ブランチ全体レビューで見つかり、明示的に別スコープとして先送りされた2件のスケール課題への対応。

## 背景・目的

サブプロジェクトBの最終レビューで、`yutai-master-sync-batch`(kabuyutai.comからの一括バックフィル)を実際に実行して`JQuantsYutaiMaster`が1,000銘柄規模になった場合に、既存コードが以下の2点で問題を起こすことが判明した:

1. **`GET /yutai`一覧APIのタイムアウト**: `listYutai`が全銘柄スキャン後、銘柄ごとに`calcRisk`(信用残の有無・前日終値の2回の逐次DynamoDBクエリ)を呼んでおり、1,000銘柄なら約2,000回の逐次クエリになる。`ReferenceApiFunction`のLambdaタイムアウトは10秒しかなく、確実にタイムアウトする。J-Quantsのプランとは無関係(DynamoDBアクセス方式の問題)。
2. **`price-batch`/`financial-summary-batch`のスループット不足**: 現在の`REQUEST_INTERVAL_MS`(Freeプランの5req/分を想定した13秒間隔)のままでは、14分のLambdaタイムアウト内で処理できるのは約64銘柄/回のみ。1,000銘柄のうち大半が価格・決算データを永遠に取得できない。

`yutai-master-sync-batch`を本番で実行する前に、これら2点への対応方針を確定させる必要がある。

## スコープ

**含む**:
- `GET /yutai`一覧APIのタイムアウト対応(新規バッチによる事前計算方式への切り替え)
- `reference-api`内の重複クエリ解消(`getYutaiDetail`の`latestPricePoint`/`calcRisk`内`latestClose`が同じテーブルに重複クエリしている、以前のサブプロジェクトBレビューでParkされていたMinor指摘)
- J-Quants Standardプラン移行に向けた準備(コード変更は不要な想定だが、想定値の確認と設計書への明記)

**含まない(方針決定済み)**:
- `price-batch`/`financial-summary-batch`のカーソルベース分割処理。Standardプランへの移行で解決する前提とし、実装しない。移行タイミングは「事前対応が完了してから」とし、本サブプロジェクトの完了後にユーザー自身が判断する
- `financial-summary-batch`がStandardプラン移行後も決算系エンドポイント固有の60req/分上限により1,000銘柄すべてには届かない可能性がある点は許容する(四半期更新データのため数週間かけて巡回されれば実害は小さいと判断。対応が必要になった場合は別途検討)

## 調査結果: 他に同様のN件フォールアウトパターンは無いか

`lambda/reference-api/index.ts`の全ルートを確認した結果、DynamoDBへの逐次クエリがリクエストごとの対象件数に比例して増える箇所は`listYutai`の`calcRisk`呼び出しのみだった。他のエンドポイント(`GET /tickers`、`GET /tickers/{ticker}/prices`、`GET /tickers/{ticker}/summary`、`GET /yutai/{ticker}`、`GET /yutai/{ticker}/margin-trend`)はいずれも単一銘柄または単一テーブルの1回のスキャン/クエリで完結しており、`JQuantsYutaiMaster`の件数が増えてもスケール問題にはならない。フロントの「簡易スクリーニング」画面もAPIルートが存在せず、フロント側でウォッチリスト(ユーザーが手動追加する少数件数)のデータを使って計算しており対象外。

## アーキテクチャ

```
lambda/
  yutai-risk-precompute-batch/  (新規、日次、PriceBatchFunctionの後)
  reference-api/                 (既存、簡略化)
```

## コンポーネント詳細

### `lambda/yutai-risk-precompute-batch/index.ts`(新規)

`JQuantsYutaiMaster`を全件スキャンし、銘柄ごとに現行`reference-api`の`calcRisk`と同じロジック(`hasMarginBalance`・`latestClose`の2回のDynamoDBクエリ+`calcMaxRate`/`calcMaxGyakuhibu`による計算)を実行し、結果を`UpdateCommand`で`JQuantsYutaiMaster`の該当行へ書き戻す(`companyName`/`content`/`value`/`unitShares`/`rightsMonths`等の他フィールドは上書きしない)。

書き込むフィールド: `riskStatus`(`safe`\|`danger`\|`na`)・`maxGyakuhibu`(number\|null)・`maxRate`(number\|null)・`days`(number\|null)。`rightsDate`自体は書き込まない(軽量なローカル計算のため、reference-api側で引き続きリクエスト時に計算する。下記参照)。

`calcRisk`・`hasMarginBalance`・`latestClose`・`fetchTradingCalendarCached`・`NA_RISK`・`RiskCalcResult`・`RiskStatus`は`lambda/reference-api/index.ts`からこのバッチへ移動する(reference-api側はもう使わないため)。`nextRightsDate`は`lambda/shared/trading-calendar.ts`へ移動し、reference-api・本バッチ両方から共有する(DB非依存の軽量な計算のため、移動先はどちらでもよいが、カレンダー計算の他関数と同じ場所に置くのが自然)。

1,000銘柄×2クエリでも数秒〜十数秒程度で完了する見込みで、14分のタイムアウトに十分収まる。

**スケジュール**: 日次、`PriceBatchFunction`(`cron(0 9 * * ? *)`)の後。JST 18:20 = UTC 09:20とし、`PriceBatchFunction`が確実に完了しているとは厳密には保証されない(EventBridgeは実行完了を待って次を起動するわけではない)が、既存の全バッチも同様に時間オフセットだけで順序を担保している(明示的な依存関係チェーンは組んでいない、個人アプリのためこの割り切りで十分)。

### `lambda/reference-api/index.ts`(簡略化)

- `listYutai`: `scanYutaiMaster`で取得した各行から、事前計算済みの`riskStatus`/`maxGyakuhibu`/`maxRate`/`days`をそのまま読む。`calcRisk`呼び出し・その中の逐次DynamoDBクエリは無くなる。`rightsDate`は引き続き`nextRightsDate`でリクエスト時に計算(フィルタ条件`rightsDateFrom`/`rightsDateTo`に使うため)。
- `getYutaiDetail`: 同様に事前計算済みの`risk`フィールドをそのまま返す。`latestPricePoint`(表示用の`basicInfo.closePrice`/`volume`)は引き続きリクエスト時に取得するが、`calcRisk`内で別途行っていた`latestClose`の重複クエリは無くなる(事前計算済みの値を使うため)。

### データモデル変更

`JQuantsYutaiMaster`に`riskStatus`・`maxGyakuhibu`・`maxRate`・`days`を追加(新規行・未計算行では未設定 = `undefined`のままで、`reference-api`側は`item.riskStatus ?? 'na'`等のフォールバックで扱う。初回の`yutai-risk-precompute-batch`実行前に`GET /yutai`が呼ばれた場合の安全策)。

## Standardプラン移行への準備

コード変更は不要(`price-batch`/`financial-summary-batch`とも既に`REQUEST_INTERVAL_MS`が環境変数化済み)。移行時にCDKの環境変数を短縮するだけでよい:

- `price-batch`: Standardプランの120req/分 → 1,000銘柄を約8.3分で処理でき、14分タイムアウトに十分収まる。`REQUEST_INTERVAL_MS`を500ms程度に短縮する。
- `financial-summary-batch`: 決算系エンドポイント固有の60req/分上限(プラン共通)により、1,000銘柄×1秒≈16.7分で14分タイムアウトを超える可能性がある。カーソル対応はスコープ外とする方針のため、この状態のまま許容する(決算サマリは四半期更新のため、巡回しきれない一部銘柄が数週間遅れることの実害は小さいと判断)。

移行後は`docs/superpowers/notes/`配下に実測値の記録を残すこと(このアプリの既存の流儀に倣う)。

## エラーハンドリング・テスト方針

`yutai-risk-precompute-batch`は既存バッチと同じパターン(銘柄ごとにtry/catchしログして継続、TDD)。`reference-api`側の変更はテストの簡略化(モックする`calcRisk`関連の逐次クエリが無くなる)が中心。
