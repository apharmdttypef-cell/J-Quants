# 株主優待クロス 逆日歩リスク可視化 設計書

## 背景・目的

株主優待クロス取り(現物買い+信用売りで優待だけを取得する手法)において、信用売りにかかる「逆日歩」のリスクを事前に可視化する。

参考サイト https://96ut.com/yuutai/list.php (優待リスト出力機。最大逆日歩・貸借情報等を一覧表示)は広告視聴ゲートがあり自動スクレイピング不可と確認済みのため、J-Quants APIのデータを元に自前で同等の機能を実装する。

本アプリは個人用(利用者は本設計の相談相手のみ)。過度な汎用化・将来対応は避け、YAGNIで進める。

## スコープ

- 既存4画面(`/`, `/tickers/:ticker`, `/screening`, `/watchlist`)には変更を加えない。
- 優待実施銘柄を対象とした新規スクリーニング画面(`/yutai`系)を追加する。
- 優待マスタ(銘柄・優待内容・権利日等)の収集方法(手動 or スクレイピング)は本スコープでは決定しない。登録はユーザーが手動でモーダルから行う前提とし、DBスキーマと計算ロジックを先に固める。
- J-Quants・TDnet・四季報等に優待データを直接取得できる正規APIが存在しないことは確認済み。

## フェーズ分け方針(ダミーAPI→本番API)

J-Quants Standardプランへのアップグレードは月額課金が発生するため、**画面と画面遷移の動作確認が終わるまでアップグレードを遅らせる**。

- **フェーズ1(本設計書のスコープ)**: AWS上に実際にデプロイし、DynamoDB・API Gateway・Lambda・フロントは本番と同一構成で動かす。ただし信用残データの取得元(`mkt-margin-int` / `mkt-margin-alert`、要Standardプラン)とTDnetの適時開示監視だけを、ダミーデータを生成する実装に差し替える。
- **フェーズ2(別スコープ、本設計書には含めない)**: J-Quants Standardプランへアップグレードした後、ダミー実装を本番のJ-Quants API呼び出しに差し替える。

この分割が成立するのは、ダミー/本番の差分を「データソースモジュール」に閉じ込め、DynamoDBスキーマ・API・逆日歩計算ロジック・フロントは一切変更不要にする設計にするため。取引カレンダー(権利確定日→受渡日の日数算出)はFreeプランでも取得可能なため、フェーズ1から本番APIをそのまま使う。

### データソースモジュールの境界

- `lambda/margin-batch/data-source.ts`: `fetchWeeklyBalances(ticker, from, to)` / `fetchDailyAlertBalances(tickers, date)` を export。呼び出し元(`MarginBalanceBatchFunction`)はこの関数がダミーか本番かを意識しない。
  - フェーズ1(ダミー): ticker+日付から決定的に生成した擬似乱数(単純なハッシュシード)でランダムウォーク型の融資残・貸株残を生成する。日次バッチが同じ日付に対して毎回同じ値を返す必要がある(実行のたびに値が変わるとトレンドグラフが毎日ジャンプしてしまうため)。
  - フェーズ2(本番): 同じ関数シグネチャのまま中身をJ-Quants `mkt-margin-int` / `mkt-margin-alert` 呼び出しに差し替える。
- `lambda/tdnet-monitor/data-source.ts`: `fetchDisclosures(date)` を export。
  - フェーズ1(ダミー): 常に空を返すのではなく、UIの`pendingReview`バッジ状態を確認できるよう、ticker+日付から決定的に約15%の確率で該当銘柄を「開示あり」として返す(みなしの優待関連キーワードマッチ扱い)。
  - フェーズ2(本番): 同じ関数シグネチャのままTDnet `td-list` 呼び出しに差し替える。

## アーキテクチャ概要

既存の単一`JQuantsStack`(`lib/j-quants-stack.ts`)に機能追加する。Palworldのような永続/使い捨てスタック分離の動機はここにはないため、スタックは分割しない。

```
EventBridge(毎日)
  → MarginBalanceBatchFunction(Lambda, 新規)
      - JQuantsYutaiMasterから登録銘柄を取得
      - data-source経由で信用残(週次mkt-margin-int + 規制銘柄日次mkt-margin-alert相当)を取得
        (5req/分のレート制限想定で13秒間隔。本番切替後に有効)
      → JQuantsMarginBalance に upsert

EventBridge(毎日)
  → TdnetMonitorFunction(Lambda, 新規)
      - data-source経由で前日分の適時開示相当を取得
      - 登録銘柄×優待関連キーワードでマッチしたら pendingReview=true
      → JQuantsYutaiMaster を更新

ブラウザ
  → 既存CloudFront/S3/API Gateway経由で /yutai 系エンドポイントを追加
```

## データモデル(DynamoDB、新規2テーブル)

| テーブル | キー | 属性 | 用途 |
|---|---|---|---|
| `JQuantsYutaiMaster` | PK `ticker` | `companyName`, `content`(優待内容), `value`(優待価値・円), `rightsDate`(権利日), `unitShares`(単元株数), `pendingReview`(bool) | 優待マスタ |
| `JQuantsMarginBalance` | PK `ticker` / SK `date` | `financingBalance`(融資残), `lendingBalance`(貸株残), `source`(`weekly` \| `daily-alert`) | 信用残時系列。`daily-alert`が存在する日はそちらを優先して逆日歩計算に使う |

既存3テーブル同様 `RemovalPolicy.RETAIN` + PITR、オンデマンド課金。

## 逆日歩計算ロジック

```
貸株超過株数 = 貸株残 - 融資残  (直近のJQuantsMarginBalance値。同日にdaily-alertがあればそちらを優先)
措置率 = 措置率表[貸株超過株数の該当区分]   ※日証金公開PDFをコード内定数テーブル化(フェーズ1・2共通、J-Quants API非依存)
最大逆日歩(円) = 単元株数 × 措置率 × 4(権利付き最終日の4倍ルール) × 日数
```

「日数」は権利確定日〜受渡日をJ-Quantsの取引カレンダー(Freeプランで取得可、フェーズ1から本番API使用)から自動算出する。96ut.comは手入力だが、ここでは自動化する。

一覧のリスクバッジ判定:
- 信用残データが存在しない(貸借銘柄でない): `対象外`
- 優待価値 > 最大逆日歩コスト: `安全`
- 優待価値 ≤ 最大逆日歩コスト: `危険`

この計算は純粋関数として切り出し、データソースがダミーか本番かに関わらず同一のロジックが動く。

## Lambda(新規2本)

| 関数 | トリガー | 役割 |
|---|---|---|
| `MarginBalanceBatchFunction` | EventBridge毎日 | 登録銘柄の信用残を取得・upsert。登録直後は`POST /yutai`から`InvocationType: Event`(非同期)で1〜2年分バックフィルモードとしてもキックされる。登録銘柄数が増えるとバッチ時間が線形に伸びる制約あり(既存`BatchFetchFunction`同様13秒間隔想定) |
| `TdnetMonitorFunction` | EventBridge毎日 | 前日分の適時開示相当を取得し、登録銘柄×優待関連キーワードでマッチしたら`pendingReview=true`。PDF内容の自動解析はしない(人間が確認する前提) |

### バックフィルの非同期実行

既存`BatchFetchFunction`はレート制限待ちのためLambdaタイムアウト14分(`lib/j-quants-stack.ts:108`)。`POST /yutai`で1〜2年分をその場で取得しようとするとAPI Gatewayの同期タイムアウト(最大29秒)を超えるため同期処理は不可能。

`POST /yutai`ハンドラは優待マスタのレコード保存のみ同期的に行いレスポンスを即座に返す。バックフィル自体は`MarginBalanceBatchFunction`を`InvocationType: Event`で非同期キックし、引数で「新規登録直後の1〜2年バックフィル」か「通常の日次差分取得」かを分岐させる。フロントは`JQuantsMarginBalance`にレコードが無い状態を「取得中」として表示する(専用の進捗フラグは持たない)。

## API設計

| メソッド/パス | 内容 |
|---|---|
| `GET /yutai` | 優待マスタ一覧 + 各銘柄の最新信用残から算出したリスクバッジ(`safe` / `danger` / `対象外`) |
| `POST /yutai` | 優待銘柄を新規登録(ticker, 優待内容, 優待価値, 権利日, 単元株数)。登録後、信用残の過去1〜2年バックフィルを非同期でキック |
| `PUT /yutai/{ticker}` | 優待マスタの内容を編集。保存時に`pendingReview`をfalseに戻す |
| `DELETE /yutai/{ticker}` | 優待マスタから削除。既存`/tickers`同様、蓄積済み`JQuantsMarginBalance`データ自体は残す |
| `GET /yutai/{ticker}` | 優待マスタ情報 + 最新信用残 + 逆日歩リスク計算結果(措置率・最大逆日歩額・日数) |
| `GET /yutai/{ticker}/margin-trend?range=1y` | 信用残(融資残・貸株残)の時系列。既存`?range=12w`パターンを踏襲し`1y`をデフォルト(バックフィル期間と一致) |

CORS・認証(`x-app-password`ヘッダー、Lambdaオーソライザー)は既存ルートと共通の設定をそのまま適用する。

## 画面構成・遷移

- 新規 `/yutai`: 優待クロス スクリーニング一覧。権利日フィルタ+コスト比較バッジ。`pendingReview=true`の銘柄には確認要のバッジを表示し、クリックで編集モーダルを開く
- 新規 `/yutai/:ticker`: 詳細画面。信用残トレンドグラフ+優待内容+既存`/tickers/:ticker`への相互リンク
- 優待マスタの登録・編集は**モーダル方式**(専用ルートに切らない。既存`/watchlist`のインライン編集パターンを踏襲)
- グローバルナビに「優待クロス」リンクを追加し`/yutai`への入口とする

### 優待マスタ登録/編集モーダル

`/yutai`画面右上の「+ 銘柄を登録」ボタン、または一覧行の「編集」から開く。

```
┌─ 優待銘柄を登録 ──────────────────────── ✕ ┐
│  銘柄コード *        [ 1234        ]        │
│  会社名(自動取得)     ○○ホールディングス     │
│                       (/equities/masterで1回引当て)
│  優待内容 *           [ QUOカード1000円分  ] │
│  優待価値(円) *       [ 1000         ]      │
│  権利日 *              [ 2026-09-30 📅 ]     │
│  単元株数 *            [ 100          ]      │
│  ─────────────────────────────────────      │
│  [ 削除 ](編集時のみ)      [キャンセル][登録]│
└──────────────────────────────────────────────┘
```

- 新規登録: 「登録」→`POST /yutai`→モーダルを閉じ一覧を再取得(バックフィルは裏で非同期進行、`JQuantsMarginBalance`未取得の間は該当行を「取得中」表示)
- 編集: ボタンが「保存」に変わり`PUT /yutai/{ticker}`。「削除」は確認ダイアログを挟んで`DELETE /yutai/{ticker}`
- バリデーションは必須項目(*)のみ。優待価値・単元株数は正の整数。サーバー側エラーは既存`/watchlist`同様モーダル内にインライン表示

## エラーハンドリング方針

- **貸借銘柄でない場合**(信用取引データが存在しない): リスクバッジを`対象外`とし、逆日歩計算自体をスキップする
- **TDnet取得失敗時**: ログのみに残し`pendingReview`は更新しない。翌日のバッチで再試行される想定のため通知等は行わない
- **バックフィル失敗時**(`MarginBalanceBatchFunction`初回実行): 途中まで保存されたデータはそのまま残し、以降は通常の日次差分取得に合流させる(全体ロールバックはしない)
- **J-Quants APIレート制限**(フェーズ2で有効化): 既存`BatchFetchFunction`と同じく13秒間隔待機で基本発生しない設計。万一発生した場合は当該銘柄をスキップしログに記録する(既存踏襲、新規の再試行機構は作らない)

## テスト方針

- 既存同様Jestでスタック合成テスト(新規テーブル・Lambda・APIルートが定義通り生成されるか)
- 逆日歩計算ロジック(措置率表参照・4倍ルール・日数算出)は純粋関数として切り出し、境界値を含むユニットテストを重点的に書く
- `MarginBalanceBatchFunction` / `TdnetMonitorFunction`はdata-sourceモジュールをモックしたLambda単体テスト。フェーズ1・フェーズ2いずれのdata-source実装も同じテストで検証できるようにする
- フロントは既存同様、自動テストなし・手動確認(既存4画面もフロントの自動テストは無いため踏襲)

## スコープ外(保留事項)

- 優待マスタへの銘柄登録手段(手動入力のみ確定。TDnet等からの自動候補提示は本設計に含まない)
- J-Quants Standardプランへの実際のアップグレード作業とdata-sourceのフェーズ2差し替え実装(別スコープ)
