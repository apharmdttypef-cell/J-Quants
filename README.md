# J-Quants株価ビューア

J-Quants API(Freeプラン)で取得した株価・財務データを蓄積し、Webで閲覧するための個人用アプリ。
CDK(TypeScript)でインフラを定義し、フロントはVite + React + TypeScriptのSPA。

## アーキテクチャ

```
EventBridge(毎日 JST18:00)
  → PriceBatchFunction(Lambda)
      - JQuantsWatchlist ∪ JQuantsYutaiMasterテーブルを読んで対象銘柄を取得
      - J-Quants API(x-api-keyヘッダー認証)から、日付ごとに東証全銘柄分の四本値を1回で取得し
        (対象銘柄でフィルタしてupsert)、5req/分のレート制限を守るため呼び出しごとに13秒待機
      - 株価は日次更新が適切
      → JQuantsStockPrices に upsert

EventBridge(毎週月曜 JST20:00)
  → FinancialSummaryBatchFunction(Lambda)
      - JQuantsWatchlist ∪ JQuantsYutaiMasterテーブルを読んで対象銘柄を取得
      - J-Quants API(x-api-keyヘッダー認証)から決算サマリを取得
        (5req/分のレート制限を守るため呼び出しごとに13秒待機)
      - 決算サマリは四半期ごとにしか更新されないため週次で十分
      → JQuantsFinancialSummary に upsert

EventBridge(毎営業日 JST17:30、直近14日分を取り直す。2026-09-28からmargin-interestも日次配信。`tseMarginFeatures`無効時はスケジュール無し)
  → MarginBalanceBatchFunction(Lambda)
      - JQuantsYutaiMasterの全銘柄の信用残を取得(mkt-margin-int/mkt-margin-alert、下記参照)
      → JQuantsMarginBalance に upsert

EventBridge(毎日 JST19:00)
  → GyakuhibuHistoryBatchFunction(Lambda)
      - JQuantsYutaiMasterの`rightsMonths`(権利確定月)から過去の権利日を計算し(`rightsDateForMonth`)、
        JQuantsGyakuhibuActual未取得のものについてtaisyaku.jpから実績逆日歩を取得(1回の実行につき最大200件、
        `MAX_GYAKUHIBU_FETCHES_PER_RUN`)
      → JQuantsGyakuhibuActual に upsert

(手動invokeのみ、EventBridgeスケジュールなし)
  → YutaiMasterSyncBatchFunction(Lambda)
      - kabuyutai.comの月別優待銘柄一覧ページ(1〜12月)を全ページ取得し、優待実施銘柄を一括抽出
      - 単元株数は2018年10月の東証売買単位統一以降一律100株固定のため取得不要
      → JQuantsYutaiMaster に upsert(初回・追加銘柄の一括バックフィル用)

EventBridge(毎週月曜 JST21:00)
  → YutaiTdnetWatchBatchFunction(Lambda)
      - TDnet(適時開示情報閲覧サービス)の直近7日分の開示一覧から「株主優待」を含む開示を検知
      - 該当銘柄をkabuyutai.comで再取得(新設・変更・廃止を反映)
      → JQuantsYutaiMaster に upsert

EventBridge(毎日 JST18:20)
  → YutaiRiskPrecomputeBatchFunction(Lambda)
      - JQuantsYutaiMasterを全件スキャンし、銘柄ごとに逆日歩リスク(信用残の有無・前日終値ベース)を計算
      → JQuantsYutaiMaster に riskStatus/maxGyakuhibu/maxRate/days を書き戻す

EventBridge(毎日 JST19:40、YutaiRiskPrecomputeBatchFunctionの後)
  → GyakuhibuForecastBatchFunction(Lambda)
      - JQuantsYutaiMaster・JQuantsGyakuhibuActual(全件)・JQuantsMarginBalance(直近値)を読み、
        貸株超過率→充足率の実績分布(全銘柄プール+銘柄別)から次回権利日の予測逆日歩を算出
      → JQuantsGyakuhibuForecast に upsert(銘柄行 + 全銘柄横断のプール曲線行`_POOL_`、`tseMarginFeatures`有効時は東証超過率ベースの`tseForecast`行`_POOL_TSE_`も追加)

ブラウザ
  → CloudFront(Basic認証: CloudFront Function)
      → S3(静的ホスティング、React SPA)
  → API Gateway(HTTP API, Lambdaオーソライザーで x-app-password ヘッダー検証)
      → ReferenceApiFunction(Lambda)
          → DynamoDB(読み書き)
```

## スタック構成(`lib/j-quants-stack.ts`、単一スタック)

### データ(すべて `RemovalPolicy.RETAIN` + PITR、オンデマンド課金)

| テーブル | キー | 用途 |
|---|---|---|
| `JQuantsStockPrices` | PK `ticker` / SK `date` | 四本値・出来高 |
| `JQuantsFinancialSummary` | PK `ticker` / SK `discDate` | 決算サマリ(売上・利益・EPS等) |
| `JQuantsWatchlist` | PK `ticker` | 取得対象銘柄の正本。フロントの「ウォッチリスト管理」画面から追加/削除 |
| `JQuantsYutaiMaster` | PK `ticker` | 優待マスタ本体(`companyName` / `content` / `value` / `unitShares` / `rightsMonths`〔権利確定月の配列、例`[3, 9]`〕)。`YutaiMasterSyncBatchFunction`(初回・手動)がkabuyutai.comから一括バックフィルし、`YutaiTdnetWatchBatchFunction`(週次)がTDnet開示をトリガーに継続更新する。**自動投入テーブル**(旧: アプリ外から手動投入する読み取り専用テーブルだったが自動化済み) |
| `JQuantsMarginBalance` | PK `ticker` / SK `date` | 信用残時系列(`financingBalance`融資残・`lendingBalance`貸株残・`source`=`weekly`\|`daily-alert`) |
| `JQuantsGyakuhibuActual` | PK `ticker` / SK `rightsDate` | taisyaku.jpから取得した権利日ごとの実績逆日歩(`totalAmount` / `days` / `avgRate`)。直近3年分のみ存在しうる。2026-09-05以降、逆日歩予測機能のため残高・レート・措置列(`financingBalance`/`lendingBalance`/`lendingPrice`/`maxRateActual`/`bidRank`/`restriction`/`emergencyMeasure`)と取得済みフラグ`enriched`を追加。拡張前からの既存行は`GyakuhibuHistoryBatchFunction`が`enriched`無しの行として検知し順次バックフィルする |
| `JQuantsGyakuhibuForecast` | PK `ticker` | 逆日歩予測(貸株超過率→充足率の実績分布ベース)の日次事前計算結果。銘柄ごとの予測分布・判定(`forecastStatus`)に加え、全銘柄横断の統計曲線を持つ特殊行(`ticker`=`_POOL_`)。`GyakuhibuForecastBatchFunction`が毎日全件洗い替えする派生データ |

`cdk destroy` してもこの7テーブルは残る。次シーズンまたデプロイすれば同じデータから再開できる。

### シークレット

| シークレット名 | 内容 | 投入方法 |
|---|---|---|
| `JQuantsApiKey` | J-Quants APIキー(V2) | `cdk deploy`後に手動: `aws secretsmanager put-secret-value --secret-id JQuantsApiKey --secret-string <APIキー>` |
| `JQuantsAppPassword` | フロント/APIの共有パスワード | `cdk deploy`時の`APP_PASSWORD`環境変数の値がそのまま入る(手動投入不要) |

### J-Quants Freeプランの実際の挙動(実機で判明)

要件定義段階では「直近12週間分のみ取得可能」と想定していたが、実際に接続して判明した正しい仕様は次の通り:

- **過去2年分のデータを、12週間遅延で配信**する(直近12週間分だけが取得できない、が正しい)。
- `/equities/bars/daily`に配信対象外の日付(=直近12週間以内)を含む`from`/`to`を指定すると、部分的に返るのではなく**HTTP 400**(`Your subscription covers the following dates: ...`)で全体が失敗する。
- そのため`PriceBatchFunction`は当初、取得対象の日付範囲を"今日"ではなく"今日-12週間-1日(バッファ)"を基準に計算していた(`lambda/price-batch/index.ts`の`DELIVERY_DELAY_DAYS`)。Standardプラン移行後にこのオフセットが不要になった経緯は後述の「Standardプランへの移行に向けた準備メモ」を参照。
- 同じ理由で`ReferenceApiFunction`の価格取得も"今日からN日前"という日付フィルタではなく、保存済みの最新N件をそのまま返す方式にしている(バッチが保存する日付は常に配信遅延分だけ過去になるため)。
- **`/markets/calendar`(取引カレンダー)にも同じ12週間遅延が適用される**ことが本番運用中に判明した(直近の営業日を要求すると`/equities/bars/daily`と同様にHTTP 400になる)。優待クロス機能は「今日〜近い未来」の営業日を常に必要とするため、この制約を回避できず、`lambda/shared/trading-calendar.ts`の`getLocalTradingCalendar`/`isJpHoliday`で日本の祝日(振替休日・国民の休日を含む)をJ-Quantsに頼らずローカル計算する方式に切り替えた(`fetchTradingCalendar`はJ-Quants呼び出し版として残置。Standardプランへ移行しこの制約が無くなっているか再確認する用)。

### J-Quants Standardプランへの移行に向けた準備メモ

`PriceBatchFunction`は当初、Freeプランの5req/分制限を前提にした銘柄ごとの直列取得(呼び出しごとに13秒待機)だったため、優待実施銘柄が1,000件規模まで増えると14分のLambdaタイムアウト内に収まらなくなる問題があったが、`date`のみ指定すると東証全銘柄分を1リクエストで取得できることが判明し、この方式に切り替えたことで解消済み(2026-08-24、`docs/superpowers/specs/2026-08-24-price-batch-bulk-fetch-design.md`参照)。レート制限の観点では`PriceBatchFunction`単体としてStandardプランへの移行は不要だったが、別途`DELIVERY_DELAY_DAYS`(Freeプランの配信12週間遅延を回避するための固定オフセット、デフォルト85日)がハードコードされたままだと、Standardプラン移行後もダミーの遅延で株価が85日古いまま取得され続ける問題があった(2026-09-03発見、実際に`/ticker/{code}`の前日終値が3か月前の値のままになっていた)。株価四本値は当日16:30頃に配信されるため、Standardプラン移行後は`DELIVERY_DELAY_DAYS=0`に変更し、当日分をそのまま取得するようにした。

`FinancialSummaryBatchFunction`は今回のPriceBatchFunctionの変更の対象外で、引き続き銘柄ごとの直列取得のままである。当初は「Standardプラン移行時に`REQUEST_INTERVAL_MS`を短くするだけで対応でき、コード変更は不要」と想定していたが、これは誤りだった。銘柄数が1,700件超に増えた2026-09-04時点で**実際に本番でタイムアウトしていることを確認した**(直近実行: 840秒でタイムアウト、189銘柄のみ処理、残りは未処理のまま)。`getTargetTickers()`の返す順序が実行のたびに大きく変わらないため、同じ先頭銘柄群だけが毎回更新され、後方の銘柄群が実質的に取り残されているおそれがある(margin-balance-batchで踏んだのと同じstarvationパターン)。`/fins/summary`にも`code`省略+`date`指定で全上場銘柄の指定日開示分を一括取得できるモードがあることを確認済みで、修正方針の詳細は[GitHub Issue #2](https://github.com/apharmdttypef-cell/J-Quants/issues/2)に記録している(決算データは価格・信用残高と違い企業ごと不定期開示のため、新規銘柄の初回バックフィルと既存銘柄の継続更新を分けて設計する必要があり、単純な置き換えでは済まない)。

### 優待クロス逆日歩リスク可視化(`/yutai`系)

株主優待クロス取り(現物買い+信用売りで優待だけを取得する手法)における「逆日歩(品貸料)」のリスクを事前に可視化する機能。詳細設計は`docs/superpowers/specs/2026-08-13-yutai-cross-risk-design.md`。

**フェーズ分け(ダミーAPI→本番API)**: 逆日歩見積りの計算には信用残(融資残・貸株残)データが必要だが、これを取得するJ-Quants `mkt-margin-int` / `mkt-margin-alert` はStandardプラン(有料)専用。画面・遷移の動作確認が終わるまで課金を遅らせるため、当初(フェーズ1)は`lambda/margin-balance-batch/data-source.ts`が信用残を**ticker+日付から決定的な擬似乱数で生成したダミーデータ**で返していた(同じ入力には常に同じ値を返すため、日々のトレンドグラフが実行のたびにジャンプすることはない)。Standardプランへの移行に伴い、フェーズ2として`data-source.ts`を`mkt-margin-int`/`mkt-margin-alert`への実呼び出しに差し替え済み(DynamoDBスキーマ・API・逆日歩計算ロジック・フロントは変更不要)。なお取引カレンダー(権利日→受渡日の日数算出)と実績逆日歩(taisyaku.jp)はJ-QuantsのFreeプラン/無料サイトでそれぞれ取得できるため、フェーズ1から本番のデータを使っている。

**フェーズ3(2026-09-02): 全銘柄一括日付取得への切り替え**: 銘柄ごとの直列取得は実データ保有銘柄が増えるほど実行時間が伸び続ける問題があり(`hasExistingBalance`による差分更新の対象が上限なしに毎回全件処理されるため)、実際に本番で14分のLambdaタイムアウトに達することを確認した。price-batchと同じ「日付のみ指定して全上場銘柄分を1回で取得」方式に切り替え、DynamoDB書き込みもバッチ化した(詳細: `docs/superpowers/specs/2026-09-02-margin-balance-bulk-date-fetch-design.md`)。`hasExistingBalance`・`MAX_BACKFILL_TICKERS_PER_RUN`は廃止され、デプロイ前のテーブルパージは不要になった(冪等upsertで既存データを上書きするのみ)。

**リスク判定の事前計算**: `GET /yutai`一覧・`GET /yutai/{ticker}`が返す`riskStatus`/`maxGyakuhibu`/`maxRate`/`days`は、`reference-api`がリクエストのたびに計算するのではなく、`YutaiRiskPrecomputeBatchFunction`(毎日JST18:20、`PriceBatchFunction`の20分後)が`JQuantsYutaiMaster`を全件スキャンして銘柄ごとに計算し、同テーブルに書き戻す方式になっている。`reference-api`側は事前計算済みの値を読むだけ。優待実施銘柄が1,000件規模に増えると、銘柄ごとに信用残・前日終値をDynamoDBへ逐次クエリする従来方式では`GET /yutai`一覧が`ReferenceApiFunction`の10秒タイムアウトを超えてしまうため、その計算をバッチ側へ移してAPIリクエストをテーブル読み取りだけで完結させる設計にしている。

優待マスタ(`JQuantsYutaiMaster`)への新規銘柄追加・内容更新は本アプリのUIでは行わない代わりに、自動バッチが担う。初回・大量追加時は`YutaiMasterSyncBatchFunction`(手動invoke)がkabuyutai.com(`lambda/shared/kabuyutai-client.ts`)の月別優待銘柄一覧ページを1〜12月すべて取得して一括投入する。単元株数(売買単位)は2018年10月の東証売買単位統一(有価証券上場規程第427条の2)以降、内国株は原則100株固定のためスクレイピングせず一律100を`unitShares`に設定している。ただし優待の権利獲得に必要な実際の株数は単元株数と一致するとは限らない(例: 第一興商(7458)は単元100株だが優待には200株必要、2026-09-04発見: `docs/superpowers/notes/2026-09-04-kabuyutai-required-shares-mismatch.md`参照)。そのため一覧ページの「必要投資金額」も`minInvestment`として保存し、`YutaiRiskPrecomputeBatchFunction`が現在株価と突き合わせて実際の必要株数を逆算し、`unitShares`を上書きする(逆算できない場合はデフォルトの100のまま)。逆日歩見積り計算はこの補正後の`unitShares`を使う。会社名もJ-Quants `/equities/master`ではなくkabuyutai.comの掲載名をそのまま使う(数千銘柄規模で1件ずつJ-Quantsに問い合わせるとレート制限に抵触するため。詳細な検討は`docs/superpowers/specs/2026-08-20-yutai-master-automation-design.md`)。継続的な変更検知は`YutaiTdnetWatchBatchFunction`(週次)がTDnet(適時開示情報閲覧サービス、無料公開サイト)の直近開示から「株主優待」関連のキーワードを含む開示を検知し、該当銘柄をkabuyutai.comで再取得して新設・変更・廃止を反映する。旧`JQuantsYutaiRightsDate`(権利日を1行ずつ手動投入するテーブル)は廃止され、代わりに`JQuantsYutaiMaster`が持つ`rightsMonths`(権利確定月の配列)から、実際の権利付き最終日を`lambda/shared/trading-calendar.ts`の`rightsDateForMonth`で都度計算する方式に変わった。アプリ側は常にマスタが最新状態であることを仮定した検索・計算・表示のみを担う点は変わらない。

**最大逆日歩(見積り)の計算式**(`lambda/shared/gyakuhibu-calc.ts`): 逆日歩(品貸料率)は日々の品貸入札で決まる変動相場で、貸株超過株数から一意に決まる固定表は存在しない。一方、入札の上限である**最高料率**は「貸借値段(株価)×売買単位」から一意に決まる公開ルールなので、この上限値を「最大逆日歩」として見積もる。

```
投資単位(円) = 貸借値段(前日終値) × 単元株数
品貸料の上限(円、投資単位あたり・1日分) =
  投資単位 <= 50,000円: 100円
  投資単位 >  50,000円: 100円 + ceil((投資単位 - 50,000) / 10,000) × 20円
最高料率(円、1株・1日あたり) = 品貸料の上限 ÷ 単元株数 を10銭単位で切り上げ(ただし1円以下なら1円)
最大逆日歩(円) = 最高料率 × 単元株数 × 品貸日数(受渡日(権利付き最終日のT+2)〜その翌営業日の暦日数、取引カレンダーから自動算出) × 4(下記の権利付き最終日倍率)
```

出典: [株式 最高料率早見表(1日・1株当り)](https://www.taisyaku.jp/media/about-hayamihyo.pdf)(日本証券金融公式PDF。実際の早見表の数値と一致することを確認済み)。

**権利付き最終日の4倍ルール**(`RIGHTS_DAY_RATE_MULTIPLIER`、2026-09-03追加): taisyaku.jpは「倍率適用」規定により、配当・新株引受権等の権利付銘柄について権利落日の前営業日(=権利付き最終日そのもの)の最高料率を通常の4倍に引き上げる(詳細: `docs/superpowers/notes/2026-09-03-taisyaku-rights-day-rate-multiplier.md`)。このアプリの見積りは常に権利付き最終日を評価するため、倍率は条件分岐なく常に4倍を掛ける。旧要件定義では「品貸日数を実日数で計算すれば自然に織り込まれるため4倍ルールは不要」と判断し未採用だったが、これは誤りだったとU-NEXT HD(9418)の実データ検証(2026-09-03)で判明した — 品貸日数の実日数計算と、taisyaku.jp側の倍率適用は独立した別のメカニズムであり、前者だけでは後者を捕捉できない。なお倍率適用には権利日以外の要因(注意喚起銘柄・申込制限銘柄・異常な貸株超過状態)による2倍・8倍・10倍もあるが、これらは日証金が個別銘柄ごとに随時指定するもので事前の計算式では予測不可能なため未実装(現状の見積りは実際の上限を下回る可能性が残る保守的な下限)。

**逆日歩予測(貸株超過率→実績逆日歩、`/yutai/forecast`系)**: 上記の「最大逆日歩」はあくまで入札の上限であり、実際に付く金額は毎日の入札で決まる変動相場(流動性の高い銘柄では権利日でも0円のことが多い)。この機能は`GyakuhibuHistoryBatchFunction`が蓄積した権利日ごとの残高・実績逆日歩の履歴から、貸株超過率(`(貸株残高-融資残高)/融資残高`)を6段階のビン(`融資超過`/`0〜0.5`/`0.5〜1`/`1〜2`/`2〜5`/`5以上`)に分け、ビンごとの充足率(実績逆日歩÷最高料率の実値、0〜1)の経験分布を全銘柄横断で作る(`lambda/shared/gyakuhibu-forecast.ts`)。**充足率の分母はこのアプリが自前計算する最高料率ではなく、taisyaku.jp CSVの「最高料率」列の実値(倍率適用済み)を使う** — 自前計算値は権利付き最終日の4倍ルール等の例外を全て正確に再現できるとは限らないため、実際に日証金が公開した値をそのまま使う方が正確。銘柄ごとの実績(直近の権利日、件数`n_t`)と全銘柄プール(該当ビンの件数`n_p`)を`w = n_t / (n_t + 4)`(縮小推定、`SHRINKAGE_K=4`)で加重ブレンドし、発生確率・充足率の中央値/P90を求める。次回権利日の超過率シナリオは「同銘柄・同月の直近実績」→「同銘柄の直近実績(月不問)」→「実績なし(対象外)」の優先順で選ぶ(2026-09-09に東証信用残フォールバックを撤去。東証超過率でtaisyaku.jp基準のビン表を引くとリスクを過小評価するため — `docs/superpowers/notes/2026-09-09-tse-margin-balance-backtest.md`)。予測逆日歩(P50/P90)は充足率×最大逆日歩(上限)で金額化し、優待価値と比較して`forecastStatus`(`safe`/`caution`/`danger`/`na`)を判定する(価値がP90を上回れば`safe`、P50〜P90なら`caution`、P50以下なら`danger`)。既存の`riskStatus`(最大逆日歩=上限ベースの二値判定)とは別フィールドとして共存し、既存の意味は変更しない。設計の詳細は`docs/superpowers/specs/2026-09-05-gyakuhibu-forecast-design.md`。

**現在需給ベース予測(東証信用残、スタンダードプラン依存)**: 上記とは別に、直近の東証信用残(`JQuantsMarginBalance`)から求めた貸株超過率で同じ統計モデルを走らせた予測を`tseForecast`として並列に持つ。プールは東証超過率で別途キャリブレーションし(`_POOL_TSE_`行)、スナップショット日→権利日の日数で`0-7`/`8-21`/`22+`日の3バケットに分ける(直前ほど予測力が高く、4週前では融資超過でも54%が発生するため)。貸株残の4週前比(`lendingGrowth4w`)も併せて保存する。一覧の「想定逆日歩(現在需給)」「貸株残(4週前比)」列と詳細の「現在需給ベース」カードに表示し、判定・デフォルトソートは過去実績ベースのまま。設計は`docs/superpowers/specs/2026-09-09-tse-margin-forecast-design.md`。

### taisyaku.jp(日本証券金融)からの実績逆日歩取得(実機で判明)

過去の権利日ごとの**実績**逆日歩(上記は見積り上限であり、実際に発生した金額とは別)は、日本証券金融公式サイト(https://www.taisyaku.jp/、広告ゲート・robots.txt無し)がCSVで公開している(直近3年分のみ)。ただし要件定義段階で想定していた「単純なGETリクエストでCSVが取れる」という前提は誤りで、実際にHARキャプチャして判明した正しい手順は次の通り(`lambda/gyakuhibu-history-batch/taisyaku-client.ts`):

1. **`GET /app/stock/detail/{code}-01`**(銘柄詳細ページ)でHTMLを取得し、`Set-Cookie`のセッションCookieと、ページ内`<input name="csrf_test_name">`のCSRFトークン(ページ読み込みのたびに変わる)を抽出する。
2. **`POST /app/stock/detail/{code}/search`** に`csrf_test_name`(手順1で取得)・`orgMgrCd`・期間(`mkYmdFrom`/`mkYmdTo`、`"YYYY / MM / DD"`形式)などをフォームエンコードで送信(手順1のCookieを付与)。これがサーバー側のセッション状態に検索条件をセットする。
3. **`GET /app/stock/detail/{code}/csv`**(同じCookie付き)でCSVをダウンロード。URLにクエリパラメータは無く、直前のPOSTで確立したセッション状態がそのままCSV化される。

CSRFトークン+セッションCookieが必須で、無状態の1回のリクエストでは取得できない(GETだけ、あるいはCookie無しでは失敗する)。

CSVの値の単位にも要件定義段階の想定との食い違いがあった。「品貸料率(品貸日数分/円)」列は**1株あたり・品貸日数分の合計額**であり(1,000株あたりではない)、上記の最高料率計算式と実データで完全一致することを確認済み(例: 貸借値段2,985円・単元100株で最高料率6.00円/株/日、品貸日数3日なら列の値は18.00円=6.00×3)。そのため実績総額は`列の値 × 単元株数`だけで求まる(÷1000等の換算は不要)。また同列が`-`(空)の日は取得失敗ではなく「その日は実際に品薄が発生せず逆日歩が0円だった」ことを意味する。詳細な調査ログは`docs/superpowers/notes/2026-08-13-taisyaku-csv-format.md`。

実際のtaisyaku.jp CSVは全フィールドがダブルクォートで囲まれている(例: `"2026-08-26","18.00","3"`)。本番投入後に発覚したバグとして、`parseTaisyakuCsv`が空白のみtrimしてクォートを除去していなかったため、`Number('"18.00"')`が`NaN`になり実際に逆日歩が発生していた日も常に「実績なし」と誤判定していた(申込日の一致判定は数字以外を除去する実装だったためクォートの影響を受けず、この不整合には気づきにくかった)。修正済み(`stripQuotes`ヘルパーで前後のクォートを除去してから数値変換する)。

2026-09-05、上記の逆日歩予測機能のため`parseTaisyakuCsv`を拡張し、残高(`融資残高`/`貸株残高`)・貸借値段・最高料率・応札ランク・制限措置・臨時措置の各列も取得するようにした。実機確認(`docs/superpowers/notes/2026-09-05-taisyaku-csv-balance-columns.md`)で、実際のCSVはヘッダーが27列(想定していた11列程度より多い)で、桁区切りカンマは観測されず、品貸料率列には`-`以外に`*****`という想定外の非数値マーカーも存在する(差引残高がちょうど0になる境界日にのみ出現)ことが判明した。`occurred`(その日に実際の品薄が発生したか)の判定は文字列`'-'`との比較ではなく「数値としてparseできるか」に一本化し、`*****`を含む未知のマーカーにも耐えるようにしている。

### Lambda

| 関数 | トリガー | 役割 |
|---|---|---|
| `PriceBatchFunction` | EventBridge(`cron(0 9 * * ? *)` = JST 18:00 毎日) | 対象銘柄(`JQuantsWatchlist` ∪ `JQuantsYutaiMaster`、重複排除)の四本値を取得し`JQuantsStockPrices`へupsert |
| `FinancialSummaryBatchFunction` | EventBridge(`cron(0 11 ? * MON *)` = 毎週月曜 JST 20:00) | 対象銘柄(`JQuantsWatchlist` ∪ `JQuantsYutaiMaster`、重複排除)の決算サマリを取得し`JQuantsFinancialSummary`へupsert。四半期ごとの更新なので週次取得で十分 |
| `MarginBalanceBatchFunction` | EventBridge(`cron(30 8 ? * MON-FRI *)` = JST平日 17:30、`tseMarginFeatures`有効時のみ) | `JQuantsYutaiMaster`の全銘柄の信用残(融資残・貸株残)を、直近14日分の各日付について`mkt-margin-int`/`mkt-margin-alert`両方から取得し`JQuantsMarginBalance`へupsert(冪等)。2年分の金曜バックフィルはUTC月曜、または環境変数`FORCE_FULL_BACKFILL=true`のときのみ。`source`は`weekly`(=margin-interest由来、日次配信化後も同じ値)と`daily-alert` |
| `GyakuhibuHistoryBatchFunction` | EventBridge(`cron(0 10 * * ? *)` = JST 19:00 毎日) | `JQuantsYutaiMaster`の`rightsMonths`から過去の権利日を計算し(`rightsDateForMonth`)、そのうち`JQuantsGyakuhibuActual`未取得のものについて、taisyaku.jpから実績逆日歩を取得しupsert。1回の実行で実際に取得する件数は`MAX_GYAKUHIBU_FETCHES_PER_RUN`(既定200件)で上限を設け、超過分は翌日以降に自然と持ち越す |
| `YutaiMasterSyncBatchFunction` | 手動invokeのみ(EventBridgeスケジュールなし) | kabuyutai.comの月別一覧ページ(1〜12月)から優待実施銘柄を一括取得し`JQuantsYutaiMaster`へupsert。初回導入時・大量の追加銘柄バックフィル用 |
| `YutaiTdnetWatchBatchFunction` | EventBridge(`cron(0 12 ? * MON *)` = 毎週月曜 JST 21:00) | TDnetの直近7日分の開示から「株主優待」関連のキーワードを含む開示(新設・変更・廃止)を検知し、該当銘柄をkabuyutai.comで再取得して`JQuantsYutaiMaster`へupsert。開示ごとに`JQuantsYutaiTdnetEvent`へイベント(`start`/`update`/`abolition`)を記録する(マスタが実際に変わらなかった場合は記録しない) |
| `YutaiRiskPrecomputeBatchFunction` | EventBridge(`cron(20 9 * * ? *)` = JST 18:20 毎日) | `JQuantsYutaiMaster`を全件スキャンし逆日歩リスクを事前計算・書き戻し。`GET /yutai`一覧APIが銘柄数に比例した逐次DynamoDBクエリを行わずに済むようにするため |
| `GyakuhibuForecastBatchFunction` | EventBridge(`cron(40 10 * * ? *)` = JST 19:40 毎日、逆日歩実績・信用残バッチの後) | `JQuantsYutaiMaster`・`JQuantsGyakuhibuActual`を読み、貸株超過率のビン別充足率分布から次回権利日の予測逆日歩(過去実績ベース)を算出し`JQuantsGyakuhibuForecast`へupsert。`TSE_MARGIN_FEATURES_ENABLED=true`のときは`JQuantsMarginBalance`も読み、東証信用残ベースの現在需給予測(`tseForecast`属性・`_POOL_TSE_`行)も併せて書く |
| `ReferenceApiFunction` | API Gateway(HTTP API) | `/tickers` 系・`/yutai` 系エンドポイントの実処理 |
| `AuthorizerFunction` | API GatewayのLambdaオーソライザー | `x-app-password` ヘッダーを `JQuantsAppPassword` と照合(結果は5分キャッシュ) |

### API(HTTP API、全ルートに`AuthorizerFunction`が既定で適用される)

| メソッド/パス | 内容 |
|---|---|
| `GET /tickers` | ウォッチリスト一覧 |
| `POST /tickers` | 銘柄コードを追加(`/equities/master`で会社名を1回だけ引き当てて保存) |
| `DELETE /tickers/{ticker}` | ウォッチリストから削除(価格・財務の蓄積データ自体は残る) |
| `GET /tickers/{ticker}/prices?range=12w` | 保存済みデータのうち直近12週間分(≈60営業日)の四本値・出来高。日付フィルタではなく最新N件取得なので、配信遅延で古い日付になっていても正しく返る |
| `GET /tickers/{ticker}/summary` | 直近の決算サマリ。バッチが1度も取得していなければ404 |
| `GET /yutai?rightsDateFrom=&rightsDateTo=&keyword=&riskStatus=` | 優待実施銘柄の一覧(各銘柄の「次回の権利日」で絞り込み)+ 前日終値・単元株数から算出したリスクバッジ(`safe`/`danger`/`na`。`na`になるのは、信用残データ無し=貸借銘柄でない場合・次回の権利日が無い場合・前日終値がまだ記録されていない場合、のいずれか)+ `currentMonthLastTradableDate`(当月の権利付き最終日、一覧全体で1つ)。`keyword`は会社名・優待内容の部分一致、`riskStatus`は`safe`\|`danger`\|`na`\|`all`(省略時`all`) |
| `GET /yutai/{ticker}` | 優待マスタ情報 + 銘柄基本情報(前日終値・出来高・PER・決算サマリ主要項目)+ 逆日歩リスク計算結果(最高料率・最大逆日歩額・品貸日数・`riskStatus`〔`safe`/`danger`/`na`、詳細画面のバッジ表示に使用〕、次回権利日ベース)+ `rightsHistory`(過去の権利日ごとの実績逆日歩、taisyaku.jp直近3年分) |
| `GET /yutai/{ticker}/margin-trend` | 信用残(融資残・貸株残)の時系列。直近1年分(365件)固定 |
| `GET /yutai/forecast?rightsDateFrom=&rightsDateTo=&keyword=&forecastStatus=` | 予測付き優待銘柄一覧。`GET /yutai`と同じ絞り込みに加え、`forecastStatus`(`safe`\|`caution`\|`danger`\|`na`\|`all`、省略時`all`)でも絞り込み可能。各行に予測分布(発生確率・予測逆日歩P50/P90・判定・根拠件数)を含む。各アイテムに`tseForecast`(現在需給ベース予測、フラグ無効時null)、レスポンスに`features.tseMargin` |
| `GET /yutai/{ticker}/forecast` | 銘柄別の予測詳細。予測分布・過去権利日ごとの実績(残高・超過率・充足率・応札・措置)・全銘柄プールのビン別統計・信用残トレンド直近値をまとめて返す。`tseForecast`と`features`を含む |
| `GET /yutai/tdnet-events` | TDnet監視で検知した優待関連イベント(開始/変更/廃止)の一覧。開示日降順、全件返却(ページネーション無し) |

書き込み系(POST/PUT/DELETE)は`/yutai`系には無い(読み取り専用画面のため)。CORSの`allowOrigins`はCloudFrontの配信ドメインと`http://localhost:5173`(ローカル開発用)のみ。

### フロント配信

- S3(`BlockPublicAccess.BLOCK_ALL`、CloudFrontからのみOAC経由でアクセス可)+ CloudFront(SPA用に403/404を`index.html`にフォールバック)。
- CloudFront FunctionでBasic認証(ユーザー名`jquants`固定、パスワードは`APP_PASSWORD`をsynth時に埋め込み)。

## 認証モデル

フロント・APIとも未認証で公開しないよう、**`APP_PASSWORD`という1つの共有パスワードで両方を保護**している。

- フロント: CloudFront FunctionによるBasic認証(ブラウザ標準のログインダイアログ)。
- API: `x-app-password`ヘッダーをLambdaオーソライザーが`JQuantsAppPassword`シークレットと照合。CORSはブラウザ制約に過ぎずサーバー側のアクセス制御にはならないため、API単体でも認証を必須にしている。
- フロント側は`PasswordGate`コンポーネントがsessionStorageにパスワードを保持し、API呼び出し全てに自動付与。401が返れば保存値をクリアして再入力を促す。

`cdk deploy`時に`APP_PASSWORD`未設定だとsynthの時点でエラーになり、無認証でのデプロイは構造上できない。

### 既知の残存リスク(許容範囲と判断)

- Basic認証・APIパスワードとも総当たり対策(レート制限/ロックアウト)なし。
- WAF・API Gatewayのスロットリング設定なし。
- ただしCloudFront/API Gatewayのドメインはランダムな英数字IDで実質推測不可能なため、発見されにくい。仮に叩かれても1リクエストあたりの課金は極小でAWS既定のスロットリング上限もあり、被害は頭打ちになる。
- コスト監視はAWS Budgetsの日次メール通知で代替(個人運用で許容範囲と判断)。

## フロントエンド(`frontend/`)

Vite + React + TypeScript(SPA)。`react-router-dom`でルーティング、`recharts`でチャート描画(ローソク足はRecharts標準にないため`Bar`のカスタム`shape`で自作)。

| パス | 画面 |
|---|---|
| `/` | 銘柄一覧(カード表示、直近終値・12週騰落率・出来高スパークライン) |
| `/tickers/:ticker` | 個別銘柄詳細(ローソク足・出来高棒グラフ・決算サマリ) |
| `/screening` | 簡易スクリーニング(騰落率ソート・出来高急増フィルタ) |
| `/watchlist` | ウォッチリスト管理(銘柄コードで追加/削除) |
| `/yutai` | 優待クロス スクリーニング一覧(読み取り専用)。権利日範囲(デフォルト当月1日〜末日)・キーワード・リスク判定で絞り込み、当月の権利付き最終日をバナー表示 |
| `/yutai/:ticker` | 優待クロス詳細画面。ページ上部(タイトル横)に`/tickers/:ticker`への相互リンク → 銘柄基本情報 → 優待内容 → 逆日歩リスク計算(最大逆日歩にホバーすると実績逆日歩履歴のツールチップ) → 信用残トレンドグラフ、の順 |
| `/yutai/forecast` | 逆日歩予測 一覧(読み取り専用)。`/yutai`と同じ絞り込みに加え判定(危険/注意/安全/対象外)でも絞り込み、判定→期待値差の順でデフォルトソート。`features.tseMargin`が有効なら「想定逆日歩(現在需給)」(過去実績より悪化していれば↑)と「貸株残(4週前比)」の列を表示 |
| `/yutai/:ticker/forecast` | 逆日歩予測 詳細。サマリカード(発生確率・予測中央値・予測P90・優待価値との差)→貸株超過率と充足率の曲線グラフ(全銘柄プール+自銘柄実績の重ね書き)→感度表→過去権利日テーブル→信用残トレンド、の順。最大逆日歩カードの後に「現在需給ベース」カード群(フラグ有効かつ予測ありのとき)。信用残トレンドはフラグ有効時のみ。既存の`/yutai/:ticker`から相互リンク |
| `/yutai/tdnet-events` | 優待変更履歴(読み取り専用)。開示日 / 銘柄コード / 会社名 / 種別バッジ(開始・変更・廃止) / 開示タイトルの一覧。ナビゲーションから直接遷移 |

デザイン: 日本市場の慣例に合わせ**上昇=赤/下落=緑**(米国式とは逆)。数値は`JetBrains Mono`のtabular-numsで統一表示。

### スコープを絞った点

- ウォッチリスト管理の「会社名検索」は、コード追加時に`/equities/master`を1回だけ呼んで会社名を保存する方式に限定。J-Quants APIに会社名での検索パラメータがなく、全銘柄(数千件)をDynamoDBに同期しない限り真の名前検索はできないため、費用対効果を考えて見送った。
- `GET /tickers/{ticker}/summary`はバッチが一度もその銘柄の決算を取得できていない場合404を返す(データを捏造しない)。

### 逆日歩予測機能のバックフィル状況(2026-09-05時点、デプロイ前)

`JQuantsGyakuhibuActual`の既存行(残高列拡張前)は約5,000件と見込まれ、`MAX_GYAKUHIBU_FETCHES_PER_RUN`の既定値(200件/回)のままだと約25日かかる計算のため、デプロイ直後は一時的に引き上げてバックフィルを加速する運用を想定している(コード変更不要、CDK環境変数のみ)。ただし`GyakuhibuHistoryBatchFunction`の14分タイムアウト内では、1件あたり3回のHTTPラウンドトリップ+`TAISYAKU_REQUEST_INTERVAL_MS`(既定1000ms)の待機がかかるため、実際に完走できる上限は300〜400件程度が目安(800まで上げてもタイムアウトで打ち切られ、EventBridgeの自動リトライで逆にtaisyaku.jpへの負荷が増える)。実際にバックフィルへ要した日数、`GyakuhibuForecastBatchFunction`が算出したビン別サンプル数(`_POOL_`行の`bins[].n`)の実測、`MAX_GYAKUHIBU_FETCHES_PER_RUN`を既定値へ戻した日付は、デプロイ・バックフィル完了後にこの節へ追記する。

## 主要コマンド

事前に仮想環境変数として`APP_PASSWORD`(共有パスワード)と、deploy後に`JQuantsApiKey`へ投入するJ-Quants APIキーが必要。

```bash
# バックエンド(ルート)
npm run build          # tsc
npm test               # jest(スタック合成テスト + Lambda単体テスト)
APP_PASSWORD=xxxxx npx cdk synth    # 合成確認
APP_PASSWORD=xxxxx npx cdk deploy   # デプロイ

# デプロイ後、J-Quants APIキーを投入(初回のみ)
aws secretsmanager put-secret-value \
  --secret-id JQuantsApiKey --secret-string <APIキー>

# フロントエンド(frontend/)
cd frontend
cp .env.example .env   # VITE_API_BASE_URL に CfnOutput ApiEndpoint の値を設定
npm run dev            # ローカル開発サーバー
npm run build           # 本番ビルド(dist/)
npm run lint            # oxlint

# フロントのデプロイ(ビルド後)
aws s3 sync dist/ s3://<FrontendBucketName> --delete
aws cloudfront create-invalidation --distribution-id <DistributionId> --paths '/*'
```

`FrontendBucketName` / `DistributionId` / `ApiEndpoint` / `FrontendUrl` は `cdk deploy` の出力(CfnOutput)で確認できる。

### スタンダードプラン依存機能のON/OFF(`tseMarginFeatures`)

J-Quantsの`mkt-margin-int`/`mkt-margin-alert`はスタンダードプラン以上でしか使えない。これらに依存する機能(信用残バッチ・現在需給ベース予測・一覧の現在需給列・詳細の現在需給カードと信用残トレンド)はCDKコンテキスト値`tseMarginFeatures`(`cdk.json`で既定`true`)でまとめて切り替える。

ライトプラン等へ落とす場合:

```
APP_PASSWORD=xxxxx npx cdk deploy -c tseMarginFeatures=false
```

この1回で、`MarginBalanceBatchSchedule`が削除され(Lambdaは残る)、`GyakuhibuForecastBatchFunction`は現在需給予測をスキップし、`ReferenceApiFunction`は`features.tseMargin: false`と`tseForecast: null`を返し、フロントはそれを見て列・カード・信用残トレンドを非表示にする(フロントの再ビルドは不要)。テーブルとデータは残るので、`-c tseMarginFeatures=true`(または指定なし)で再デプロイすれば元に戻る。過去実績ベース予測(判定・想定逆日歩)はこのフラグの影響を受けない。

## コスト目安

- 稼働中: 月$1程度(内訳はほぼ`JQuantsApiKey` / `JQuantsAppPassword`の固定費 $0.40×2)。DynamoDB・Lambda・API Gateway・CloudFrontはこの利用規模ではほぼ無料枠内。
- `cdk destroy`後: DynamoDB(RETAIN)のストレージ代のみでほぼ$0。ただしシークレット2つは既定で最大30日「削除保留」状態のまま$0.80/月が発生し続ける。即ゼロにしたい場合:
  ```bash
  aws secretsmanager delete-secret --secret-id JQuantsApiKey --force-delete-without-recovery
  aws secretsmanager delete-secret --secret-id JQuantsAppPassword --force-delete-without-recovery
  ```
