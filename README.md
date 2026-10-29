# J-Quants株価ビューア

株価をSoftHompo、信用残・逆日歩・貸借区分をtaisyaku.jpから取得して蓄積し、Webで閲覧するための個人用アプリ。
CDK(TypeScript)でインフラを定義し、フロントはVite + React + TypeScriptのSPA。

## アーキテクチャ

```
EventBridge(平日 JST09:30)
  → PriceBatchFunction(Lambda)
      - JQuantsYutaiMasterテーブルを読んで対象銘柄を取得
      - SoftHompoの日次株価ファイル(東証全銘柄、前営業日分が翌朝公表)を直近7日分取得
        (当月分は日次zip、前月以前は月次zip)し、対象銘柄の四本値・出来高をupsert
      → JQuantsStockPrices に upsert

EventBridge(平日 JST19:15)
  → MarginBalanceBatchFunction(Lambda)
      - taisyaku.jpの全銘柄一括CSV(基準日ごと3リクエスト)を、カーソル行の日から最大40日分取得
      → JQuantsMarginBalance に `source`=`taisyaku` でupsert
      - 取れたCSVのうち最新の申込日のものから、東証行の`貸借区分`(`貸借`/`貸借融資`/`非貸借`)を読む
      → JQuantsYutaiMaster の`marginName`を値が変わった銘柄だけ更新(東証行が無ければnull、CSVが1件も取れなかった実行では前回の値のまま)

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
      - JQuantsYutaiMasterを全件スキャンし、`marginName`(信用残バッチが書く貸借区分)が`貸借`の銘柄だけ前日終値ベースで最大逆日歩・最高料率・品貸日数を計算(信用残テーブルは読まない)
      → JQuantsYutaiMaster に maxGyakuhibu/maxRate/days を書き戻す(判定は逆日歩予測側のforecastStatusが持つ)

EventBridge(毎日 JST19:40、YutaiRiskPrecomputeBatchFunctionの後)
  → GyakuhibuForecastBatchFunction(Lambda)
      - JQuantsYutaiMaster・JQuantsGyakuhibuActual(全件)・JQuantsMarginBalance(直近値)を読み、
        貸株超過率→充足率の実績分布(全銘柄プール+銘柄別)から次回権利日の予測逆日歩を算出
      → JQuantsGyakuhibuForecast に upsert(銘柄行 + 全銘柄横断のプール曲線行`_POOL_`、日証金の貸借取引残高ベースの`tseForecast`行`_POOL_TSE_`も常に追加)

ブラウザ
  → CloudFront(静的ファイルは公開配信)
      → S3(静的ホスティング、React SPA)
  → Cognito User Pool(Managed Loginでログイン、認可コード+PKCE)
  → API Gateway(HTTP API, Cognito JWT authorizerでアクセストークン検証)
      → ReferenceApiFunction(Lambda)
          → DynamoDB(読み書き)
```

## スタック構成(`lib/j-quants-stack.ts`、単一スタック)

### データ(すべて `RemovalPolicy.RETAIN` + PITR、オンデマンド課金)

| テーブル | キー | 用途 |
|---|---|---|
| `JQuantsStockPrices` | PK `ticker` / SK `date` | 四本値・出来高 |
| `JQuantsFinancialSummary` | PK `ticker` / SK `discDate` | 決算サマリ(売上・利益・EPS等)。2026-10に財務サマリーは廃止。テーブルはデータを残したまま使っていない |
| `JQuantsYutaiMaster` | PK `ticker` | 優待マスタ本体(`companyName` / `content` / `value` / `unitShares` / `rightsMonths`〔権利確定月の配列、例`[3, 9]`〕)。`YutaiMasterSyncBatchFunction`(初回・手動)がkabuyutai.comから一括バックフィルし、`YutaiTdnetWatchBatchFunction`(週次)がTDnet開示をトリガーに継続更新する。**自動投入テーブル**(旧: アプリ外から手動投入する読み取り専用テーブルだったが自動化済み) |
| `JQuantsMarginBalance` | PK `ticker` / SK `date` | 信用残時系列(`financingBalance`融資残・`lendingBalance`貸株残・`source`=`weekly`\|`daily-alert`) |
| `JQuantsGyakuhibuActual` | PK `ticker` / SK `rightsDate` | taisyaku.jpから取得した権利日ごとの実績逆日歩(`totalAmount` / `days` / `avgRate`)。直近3年分のみ存在しうる。2026-09-05以降、逆日歩予測機能のため残高・レート・措置列(`financingBalance`/`lendingBalance`/`lendingPrice`/`maxRateActual`/`bidRank`/`restriction`/`emergencyMeasure`)と取得済みフラグ`enriched`を追加。拡張前からの既存行は`GyakuhibuHistoryBatchFunction`が`enriched`無しの行として検知し順次バックフィルする |
| `JQuantsGyakuhibuForecast` | PK `ticker` | 逆日歩予測(貸株超過率→充足率の実績分布ベース)の日次事前計算結果。銘柄ごとの予測分布・判定(`forecastStatus`)に加え、全銘柄横断の統計曲線を持つ特殊行(`ticker`=`_POOL_`)。`GyakuhibuForecastBatchFunction`が毎日全件洗い替えする派生データ |
| `JQuantsYutaiTdnetEvent` | PK `pk` / SK `eventId` | TDnet開示から検知した優待関連イベント(新設・変更・廃止)。`YutaiTdnetWatchBatchFunction`が記録し、`GET /yutai/tdnet-events`が読み取り |

`cdk destroy` してもこの7テーブルは残る。次シーズンまたデプロイすれば同じデータから再開できる。
なお、本節に挙げた7テーブルとは別に、廃止した`JQuantsWatchlist`テーブルの実体はCDK管理外のままAWSアカウント内に残っている(`RemovalPolicy.RETAIN`のため)。不要であれば`aws dynamodb delete-table --table-name JQuantsWatchlist`で手動削除できる。

### J-Quants Freeプランの実際の挙動(実機で判明)

(2026-10の移行でJ-Quantsは使わなくなった。以下は経緯の記録)

要件定義段階では「直近12週間分のみ取得可能」と想定していたが、実際に接続して判明した正しい仕様は次の通り:

- **過去2年分のデータを、12週間遅延で配信**する(直近12週間分だけが取得できない、が正しい)。
- `/equities/bars/daily`に配信対象外の日付(=直近12週間以内)を含む`from`/`to`を指定すると、部分的に返るのではなく**HTTP 400**(`Your subscription covers the following dates: ...`)で全体が失敗する。
- そのため`PriceBatchFunction`は当初、取得対象の日付範囲を"今日"ではなく"今日-12週間-1日(バッファ)"を基準に計算していた(`lambda/price-batch/index.ts`の`DELIVERY_DELAY_DAYS`)。Standardプラン移行後にこのオフセットが不要になった経緯は後述の「Standardプランへの移行に向けた準備メモ」を参照。
- 同じ理由で`ReferenceApiFunction`の価格取得も"今日からN日前"という日付フィルタではなく、保存済みの最新N件をそのまま返す方式にしている(バッチが保存する日付は常に配信遅延分だけ過去になるため)。
- **`/markets/calendar`(取引カレンダー)にも同じ12週間遅延が適用される**ことが本番運用中に判明した(直近の営業日を要求すると`/equities/bars/daily`と同様にHTTP 400になる)。優待クロス機能は「今日〜近い未来」の営業日を常に必要とするため、この制約を回避できず、`lambda/shared/trading-calendar.ts`の`getLocalTradingCalendar`/`isJpHoliday`で日本の祝日(振替休日・国民の休日を含む)をJ-Quantsに頼らずローカル計算する方式に切り替えた(`fetchTradingCalendar`はJ-Quants呼び出し版として残置。Standardプランへ移行しこの制約が無くなっているか再確認する用)。

### J-Quants Standardプランへの移行に向けた準備メモ

(2026-10の移行でJ-Quantsは使わなくなった。以下は経緯の記録)

`PriceBatchFunction`は当初、Freeプランの5req/分制限を前提にした銘柄ごとの直列取得(呼び出しごとに13秒待機)だったため、優待実施銘柄が1,000件規模まで増えると14分のLambdaタイムアウト内に収まらなくなる問題があったが、`date`のみ指定すると東証全銘柄分を1リクエストで取得できることが判明し、この方式に切り替えたことで解消済み(2026-08-24、`docs/superpowers/specs/2026-08-24-price-batch-bulk-fetch-design.md`参照)。レート制限の観点では`PriceBatchFunction`単体としてStandardプランへの移行は不要だったが、別途`DELIVERY_DELAY_DAYS`(Freeプランの配信12週間遅延を回避するための固定オフセット、デフォルト85日)がハードコードされたままだと、Standardプラン移行後もダミーの遅延で株価が85日古いまま取得され続ける問題があった(2026-09-03発見、実際に`/ticker/{code}`の前日終値が3か月前の値のままになっていた)。株価四本値は当日16:30頃に配信されるため、Standardプラン移行後は`DELIVERY_DELAY_DAYS=0`に変更し、当日分をそのまま取得するようにした。

`FinancialSummaryBatchFunction`は今回のPriceBatchFunctionの変更の対象外で、引き続き銘柄ごとの直列取得のままである。当初は「Standardプラン移行時に`REQUEST_INTERVAL_MS`を短くするだけで対応でき、コード変更は不要」と想定していたが、これは誤りだった。銘柄数が1,700件超に増えた2026-09-04時点で**実際に本番でタイムアウトしていることを確認した**(直近実行: 840秒でタイムアウト、189銘柄のみ処理、残りは未処理のまま)。`scanTickerColumn()`の返す順序が実行のたびに大きく変わらないため、同じ先頭銘柄群だけが毎回更新され、後方の銘柄群が実質的に取り残されているおそれがある(margin-balance-batchで踏んだのと同じstarvationパターン)。`/fins/summary`にも`code`省略+`date`指定で全上場銘柄の指定日開示分を一括取得できるモードがあることを確認済みで、修正方針の詳細は[GitHub Issue #2](https://github.com/apharmdttypef-cell/J-Quants/issues/2)に記録している(決算データは価格・信用残高と違い企業ごと不定期開示のため、新規銘柄の初回バックフィルと既存銘柄の継続更新を分けて設計する必要があり、単純な置き換えでは済まない)。

### 優待クロス逆日歩リスク可視化(`/yutai`系)

株主優待クロス取り(現物買い+信用売りで優待だけを取得する手法)における「逆日歩(品貸料)」のリスクを事前に可視化する機能。詳細設計は`docs/superpowers/specs/2026-08-13-yutai-cross-risk-design.md`。

**フェーズ分け(ダミーAPI→本番API)**: 逆日歩見積りの計算には信用残(融資残・貸株残)データが必要だが、これを取得するJ-Quants `mkt-margin-int` / `mkt-margin-alert` はStandardプラン(有料)専用。画面・遷移の動作確認が終わるまで課金を遅らせるため、当初(フェーズ1)は`lambda/margin-balance-batch/data-source.ts`が信用残を**ticker+日付から決定的な擬似乱数で生成したダミーデータ**で返していた(同じ入力には常に同じ値を返すため、日々のトレンドグラフが実行のたびにジャンプすることはない)。Standardプランへの移行に伴い、フェーズ2として`data-source.ts`を`mkt-margin-int`/`mkt-margin-alert`への実呼び出しに差し替え済み(DynamoDBスキーマ・API・逆日歩計算ロジック・フロントは変更不要)。なお取引カレンダー(権利日→受渡日の日数算出)と実績逆日歩(taisyaku.jp)はJ-QuantsのFreeプラン/無料サイトでそれぞれ取得できるため、フェーズ1から本番のデータを使っている。

**フェーズ3(2026-09-02): 全銘柄一括日付取得への切り替え**: 銘柄ごとの直列取得は実データ保有銘柄が増えるほど実行時間が伸び続ける問題があり(`hasExistingBalance`による差分更新の対象が上限なしに毎回全件処理されるため)、実際に本番で14分のLambdaタイムアウトに達することを確認した。price-batchと同じ「日付のみ指定して全上場銘柄分を1回で取得」方式に切り替え、DynamoDB書き込みもバッチ化した(詳細: `docs/superpowers/specs/2026-09-02-margin-balance-bulk-date-fetch-design.md`)。`hasExistingBalance`・`MAX_BACKFILL_TICKERS_PER_RUN`は廃止され、デプロイ前のテーブルパージは不要になった(冪等upsertで既存データを上書きするのみ)。

**リスク判定の事前計算**: 優待クロス一覧(`GET /yutai/forecast`)・`GET /yutai/{ticker}`が返す`maxGyakuhibu`/`maxRate`/`days`は、`reference-api`がリクエストのたびに計算するのではなく、`YutaiRiskPrecomputeBatchFunction`(毎日JST18:20、`PriceBatchFunction`の20分後)が`JQuantsYutaiMaster`を全件スキャンして銘柄ごとに計算し、同テーブルに書き戻す方式になっている。`reference-api`側は事前計算済みの値を読むだけ。優待実施銘柄が1,000件規模に増えると、銘柄ごとに信用残・前日終値をDynamoDBへ逐次クエリする従来方式では一覧が`ReferenceApiFunction`の10秒タイムアウトを超えてしまうため、その計算をバッチ側へ移してAPIリクエストをテーブル読み取りだけで完結させる設計にしている。判定は`JQuantsGyakuhibuForecast`の`forecastStatus`(下記の逆日歩予測の判定)だけを正本とし、一覧・詳細とも予測APIの値を表示する(2026-10-08以前は事前計算バッチが「優待価値 > 最大逆日歩なら安全」の二値で`riskStatus`を判定していた。2026-10に旧一覧API`GET /yutai`と`riskStatus`を削除)。

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

**逆日歩予測(貸株超過率→実績逆日歩、`GET /yutai/forecast`系)**: 上記の「最大逆日歩」はあくまで入札の上限であり、実際に付く金額は毎日の入札で決まる変動相場(流動性の高い銘柄では権利日でも0円のことが多い)。この機能は`GyakuhibuHistoryBatchFunction`が蓄積した権利日ごとの残高・実績逆日歩の履歴から、貸株超過率(`(貸株残高-融資残高)/融資残高`)を6段階のビン(`融資超過`/`0〜0.5`/`0.5〜1`/`1〜2`/`2〜5`/`5以上`)に分け、ビンごとの充足率(実績逆日歩÷最高料率の実値、0〜1)の経験分布を全銘柄横断で作る(`lambda/shared/gyakuhibu-forecast.ts`)。**充足率の分母はこのアプリが自前計算する最高料率ではなく、taisyaku.jp CSVの「最高料率」列の実値(倍率適用済み)を使う** — 自前計算値は権利付き最終日の4倍ルール等の例外を全て正確に再現できるとは限らないため、実際に日証金が公開した値をそのまま使う方が正確。銘柄ごとの実績(直近の権利日、件数`n_t`)と全銘柄プール(該当ビンの件数`n_p`)を`w = n_t / (n_t + 4)`(縮小推定、`SHRINKAGE_K=4`)で加重ブレンドし、発生確率・充足率の中央値/P90を求める。次回権利日の超過率シナリオは「同銘柄・同月の直近実績」→「同銘柄の直近実績(月不問)」→「実績なし(対象外)」の優先順で選ぶ(2026-09-09に東証信用残フォールバックを撤去。東証超過率でtaisyaku.jp基準のビン表を引くとリスクを過小評価するため — `docs/superpowers/notes/2026-09-09-tse-margin-balance-backtest.md`)。予測逆日歩(P50/P90)は充足率×最大逆日歩(上限)で金額化する。判定`forecastStatus`は充足率のP90(=想定逆日歩(最悪)÷最大逆日歩)だけで決める: 50%以上なら`danger`、20%以上なら`caution`、それ未満なら`safe`、サンプルが1件も無ければ`na`(`fillRatioStatus`)。優待価値・最大逆日歩の金額には依存しないので、優待価値が抽出できない銘柄も判定できる(2026-10-08に「優待価値と想定逆日歩の比較」から変更。しきい値は2026-10-07時点の実データ分布から決めた)。P50ではなくP90を使うのは、発生確率が50%未満の区分では充足率の中央値が0になり、ほとんどの銘柄が安全に倒れてしまうため。貸借区分(`marginName`)が`貸借`以外(`貸借融資`・`非貸借`)の銘柄は制度信用で売れず逆日歩が発生しえないため、予測せずに`general-only`(画面表示は「制度信用不可」)とし、最大逆日歩・前回逆日歩も出さない(必要資金は出す)。分かっているのは制度信用で売れないことだけで、一般信用の売り在庫の有無(証券会社ごとに異なる)は把握していないため、「一般信用ならクロスできる」とは表示しない。taisyaku.jpのCSVに東証行が無い銘柄(名証・福証・札証の単独上場など)は区分不明として従来どおり扱う。設計の詳細は`docs/superpowers/specs/2026-09-05-gyakuhibu-forecast-design.md`。

**現在需給ベース予測(日証金の貸借取引残高)**: 上記とは別に、直近の日証金の貸借取引残高(taisyaku.jpの融資残・貸株残、`JQuantsMarginBalance`)から求めた貸株超過率で同じ統計モデルを走らせた予測を`tseForecast`として並列に持つ。このデータは日証金から借りた分だけの残高なので、取引所公表の制度信用残より小さい値になり、貸借倍率(融資残÷貸株残)が1未満なら貸株超過(貸株残が融資残を上回る。上記の貸株超過率が正)という意味になる。プールは現在需給の超過率で別途キャリブレーションし(`_POOL_TSE_`行)、スナップショット日→権利日の日数で`0-7`/`8-21`/`22+`日の3バケットに分ける(直前ほど予測力が高く、4週前では融資超過でも54%が発生するため)。貸株残の4週前比(`lendingGrowth4w`)も併せて保存する。一覧の「想定逆日歩(現在需給)」「貸株残(4週前比)」列と詳細の「現在需給ベース」カードに表示し、判定・デフォルトソートは過去実績ベースのまま。設計は`docs/superpowers/specs/2026-09-09-tse-margin-forecast-design.md`。

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
| `PriceBatchFunction` | EventBridge(`cron(30 0 ? * MON-FRI *)` = JST平日 09:30) | SoftHompo(`https://softhompo.a.la9.jp/Data/StockData.html`)の日次株価ファイルを直近7日分取得し、対象銘柄(`JQuantsYutaiMaster`)の四本値・出来高を`JQuantsStockPrices`へupsert。午後に取引の無い銘柄は午前の値、終日取引の無い銘柄は書かない。取得・解析に失敗した日があれば最後に実行エラーにし、2日連続で失敗するとSNS経由でメール通知 |
| `MarginBalanceBatchFunction` | EventBridge(`cron(15 10 ? * MON-FRI *)` = JST平日 19:15) | taisyaku.jpの全銘柄一括CSVを基準日ごとに取得し(検索→CSV取得の3リクエスト、各間と日付間に`REQUEST_INTERVAL_MS`=1000ms)、`JQuantsYutaiMaster`の銘柄の東証行の融資残・貸株残を`JQuantsMarginBalance`へ`source`=`taisyaku`でupsert(冪等)。カーソル行(`ticker`=`__cursor__`, `date`=`taisyaku`)の`lastFetchedDate`の日から最大`MAX_DATES_PER_RUN`=40日分(初回は3年前から)を古い順に処理し、カーソルの日自体も毎回取り直す。0件の日は、当日なら「未公表」としてカーソルを進めずに打ち切り、当日より前なら休場日または公開範囲外とみなして警告ログを出し先へ進む。取得失敗はその回の取得を打ち切る(カーソルは最後の成功日のまま)。失敗があり、カーソルが開始時の日より先へ進まなかった回(カーソル日の取り直しだけ成功し次の日が失敗する等)は実行エラーにする。取れたCSVのうち最新の申込日のものから、優待マスタの`marginName`(東証行の`貸借区分`)も値が変わった銘柄だけ更新する(更新に失敗した銘柄があれば、信用残の処理を終えてから実行エラーにする)。2日連続で失敗(Errors≧1が2日)するとSNS経由でメール通知 |
| `GyakuhibuHistoryBatchFunction` | EventBridge(`cron(0 10 * * ? *)` = JST 19:00 毎日) | `JQuantsYutaiMaster`の`rightsMonths`から過去の権利日を計算し(`rightsDateForMonth`)、そのうち`JQuantsGyakuhibuActual`未取得のものについて、taisyaku.jpから実績逆日歩を取得しupsert。1回の実行で実際に取得する件数は`MAX_GYAKUHIBU_FETCHES_PER_RUN`(既定200件)で上限を設け、超過分は翌日以降に自然と持ち越す |
| `YutaiMasterSyncBatchFunction` | 手動invokeのみ(EventBridgeスケジュールなし) | kabuyutai.comの月別一覧ページ(1〜12月)から優待実施銘柄を一括取得し`JQuantsYutaiMaster`へupsert。初回導入時・大量の追加銘柄バックフィル用 |
| `YutaiTdnetWatchBatchFunction` | EventBridge(`cron(0 12 ? * MON *)` = 毎週月曜 JST 21:00) | TDnetの直近7日分の開示から「株主優待」関連のキーワードを含む開示(新設・変更・廃止)を検知し、該当銘柄をkabuyutai.comで再取得して`JQuantsYutaiMaster`へupsert。開示ごとに`JQuantsYutaiTdnetEvent`へイベント(`start`/`update`/`abolition`)を記録する(マスタが実際に変わらなかった場合は記録しない)。廃止検知による`JQuantsYutaiMaster`からの削除は、`PriceBatchFunction`の対象銘柄取得も`ReferenceApiFunction`の`isKnownTicker`判定も同テーブルを参照する設計のため、その銘柄の株価収集を止め、`GET /tickers/{ticker}/prices`も404にする(意図した副作用だが、単一の削除操作が複数の挙動に波及する点に注意) |
| `YutaiRiskPrecomputeBatchFunction` | EventBridge(`cron(20 9 * * ? *)` = JST 18:20 毎日) | `JQuantsYutaiMaster`を全件スキャンし最大逆日歩などを事前計算・書き戻し。一覧API(`GET /yutai/forecast`)が銘柄数に比例した逐次DynamoDBクエリを行わずに済むようにするため。貸借判定はマスタの`marginName`(信用残バッチが書く)で行い、J-Quantsは呼ばない |
| `GyakuhibuForecastBatchFunction` | EventBridge(`cron(40 10 * * ? *)` = JST 19:40 毎日、逆日歩実績・信用残バッチの後) | `JQuantsYutaiMaster`・`JQuantsGyakuhibuActual`を読み、貸株超過率のビン別充足率分布から次回権利日の予測逆日歩(過去実績ベース)を算出し`JQuantsGyakuhibuForecast`へupsert。`JQuantsMarginBalance`も読み、日証金の貸借取引残高ベースの現在需給予測(`tseForecast`属性・`_POOL_TSE_`行)も併せて書く。信用残バッチ(JST19:15)の後に走るので当日公表分までの残高を使う。ただしtaisyaku.jpの公表時刻は未検証で、19:15時点で当日分が未公表なら前営業日までの残高で予測する(当日分は翌営業日の信用残バッチで取り込まれる) |
| `ReferenceApiFunction` | API Gateway(HTTP API) | `/tickers` 系・`/yutai` 系エンドポイントの実処理。呼び出し元(`sub`)と`routeKey`を構造化ログに出す |
| `PreTokenGenerationFunction` | Cognito User PoolのPre Token Generationトリガー(V2) | アクセストークンに`email`クレームを足す |

### API(HTTP API、全ルートにCognito JWT authorizerが既定で適用される)

| メソッド/パス | 内容 |
|---|---|
| `GET /tickers/{ticker}/prices?range=12w` | 保存済みデータのうち直近12週間分(≈60営業日)の四本値・出来高。日付フィルタではなく最新N件取得なので、配信遅延で古い日付になっていても正しく返る |
| `GET /yutai/{ticker}` | 優待マスタ情報 + 銘柄基本情報(前日終値・出来高)+ 最大逆日歩の計算結果(最高料率・最大逆日歩額・品貸日数、次回権利日ベース。判定は`GET /yutai/{ticker}/forecast`)+ `rightsHistory`(過去の権利日ごとの実績逆日歩、taisyaku.jp直近3年分) |
| `GET /yutai/{ticker}/margin-trend` | 信用残(日証金の融資残・貸株残)の時系列。`source`=`taisyaku`の直近365日、各点に`lendingRatio`(融資残÷貸株残) |
| `GET /yutai/forecast?rightsDateFrom=&rightsDateTo=&keyword=&forecastStatus=` | 優待クロス一覧(予測付き)。各銘柄の「次回の権利日」・キーワード(会社名・優待内容の部分一致)・株価/必要資金の範囲・長期保有(`crossEligible`)で絞り込み、`forecastStatus`(`safe`\|`caution`\|`danger`\|`general-only`\|`na`\|`all`、省略時`all`)でも絞り込み可能。`currentMonthLastTradableDate`(当月の権利付き最終日)を含む。各行に予測分布(発生確率・予測逆日歩P50/P90・判定・根拠件数)を含む。各アイテムに`tseForecast`(現在需給ベース予測、残高が無ければnull) |
| `GET /yutai/{ticker}/forecast` | 銘柄別の予測詳細。予測分布・過去権利日ごとの実績(残高・超過率・充足率・応札・措置)・全銘柄プールのビン別統計・信用残トレンド直近値をまとめて返す。`tseForecast`を含む |
| `GET /yutai/tdnet-events` | TDnet監視で検知した優待関連イベント(開始/変更/廃止)の一覧。開示日降順、全件返却(ページネーション無し) |

APIは全ルートがGET(書き込み系は無い)。CORSの`allowOrigins`はCloudFrontの配信ドメインと`http://localhost:5173`(ローカル開発用)のみ、`allowHeaders`は`Content-Type`・`Authorization`。

### フロント配信

- S3(`BlockPublicAccess.BLOCK_ALL`、CloudFrontからのみOAC経由でアクセス可)+ CloudFront(SPA用に403/404を`index.html`にフォールバック)。
- 静的ファイルは認証なしで配信する(バンドルに秘密情報は無く、データは全てAPI側で守っている)。

## 認証モデル

管理者が招待したユーザーだけが使えるベータ。Cognito User Pool(機能プランEssentials、セルフサインアップ無効)でユーザーごとにログインし、ユーザー単位でアクセスを止められる。設計は`docs/superpowers/specs/2026-10-07-cognito-auth-design.md`。

- ログイン: Cognito Managed Login(`https://jquants-beta-vqvfk.auth.ap-northeast-1.amazoncognito.com`)。認可コード+PKCE、クライアントシークレットなし。初回ログインで招待時の仮パスワードを変更、パスワードリセットもManaged Loginの画面で行う。
- フロント: `oidc-client-ts` + `react-oidc-context`。`AuthGate`が未ログインならログイン画面へ送り、ログイン後は元のページへ戻す(戻り先は`/`で始まり`//`で始まらない相対パスだけを許可。外部URLへのオープンリダイレクト防止)。トークンは`sessionStorage`(タブごと)に置き、リフレッシュトークン(7日)でアクセストークン(1時間)を自動更新する。ログアウトはCognitoの`/logout`へ遷移する。
- API: HTTP APIのJWT authorizer(`HttpUserPoolAuthorizer`)がアクセストークンの署名・有効期限・`client_id`を全ルートで検証する。アクセストークンには既定で`email`が入らないため、Pre Token Generationトリガー(`PreTokenGenerationFunction`、V2)で足している。`ReferenceApiFunction`は検証済みクレームから`getCaller`で`{ sub, email }`を取り出し(ユーザー別データのキーには変わらない`sub`を使う)、`sub`と`routeKey`を構造化ログ(`event: 'api-access'`)に出す。クレームが無ければ401。
- 権限の差は無い(全ルートがGET)。

### ユーザー管理(AWS CLI)

`<id>`はCfnOutputの`UserPoolId`。

| 操作 | コマンド | 効果 |
|---|---|---|
| 招待 | `aws cognito-idp admin-create-user --user-pool-id <id> --username <email> --user-attributes Name=email,Value=<email> Name=email_verified,Value=true --desired-delivery-mediums EMAIL` | 仮パスワード付きの招待メールが届く。初回ログイン時にパスワード変更 |
| 一時停止 | `aws cognito-idp admin-disable-user --user-pool-id <id> --username <email>` → `aws cognito-idp admin-user-global-sign-out --user-pool-id <id> --username <email>` | 新規ログインとトークン更新が止まる。発行済みアクセストークンは最大1時間有効 |
| 再開 | `aws cognito-idp admin-enable-user --user-pool-id <id> --username <email>` | ログインできる状態に戻る |
| 削除 | `aws cognito-idp admin-delete-user --user-pool-id <id> --username <email>` | ユーザーを完全に削除 |
| 一覧 | `aws cognito-idp list-users --user-pool-id <id>` | 招待済みユーザーと状態の確認 |

招待メールはCognito既定の送信元を使う(1日あたりの送信数に上限があるが、数名の招待には十分)。User Poolは削除保護+`RETAIN`なので、スタックを作り直しても招待済みユーザーは残る。

### 既知の残存リスク(許容範囲と判断)

- WAF・API Gatewayのスロットリング設定なし(ログイン画面の総当たりはCognito側のロックアウトで抑止される)。
- 停止したユーザーも、発行済みアクセストークンの有効期限(最大1時間)まではAPIを使える。
- コスト監視はAWS Budgetsの日次メール通知で代替(個人運用で許容範囲と判断)。

## フロントエンド(`frontend/`)

Vite + React + TypeScript(SPA)。`react-router-dom`でルーティング、`recharts`でチャート描画(ローソク足はRecharts標準にないため`Bar`のカスタム`shape`で自作)。

| パス | 画面 |
|---|---|
| `/` | `/yutai`へリダイレクト |
| `/tickers/:ticker` | 個別銘柄詳細(ローソク足・出来高棒グラフ) |
| `/yutai` | 優待クロス一覧(読み取り専用、旧「優待クロス」と旧「逆日歩予測」を統合)。権利日範囲(デフォルト当月1日〜末日)・キーワード・株価/必要資金・長期保有・判定(危険/注意/安全/制度信用不可/対象外のチェックボックス、既定は危険以外)で絞り込み、判定→期待値差の順でデフォルトソート。列は「基本」(銘柄・優待内容・権利日・判定・想定逆日歩(最悪)・長期保有・必要資金・前回逆日歩)と「詳細」(想定逆日歩・発生確率・最大逆日歩・前日株価・優待価値・必要株数を追加)を切り替え(ブラウザに記憶)。詳細表示に「想定逆日歩(現在需給)」「貸株残(4週前比)」 |
| `/yutai/:ticker` | 銘柄詳細(旧2つの詳細を統合)。`GET /yutai/{ticker}`と`GET /yutai/{ticker}/forecast`を並行取得し、判定サマリ(判定・発生確率・想定逆日歩・最大逆日歩)→優待内容→株数段階別の優待条件→銘柄基本情報→予測の根拠(貸株超過率と充足率のグラフ・感度表・過去権利日)→現在需給ベース・信用残トレンド、の順 |
| `/yutai/forecast`・`/yutai/:ticker/forecast` | 旧URL。それぞれ`/yutai`・`/yutai/:ticker`へリダイレクト |
| `/yutai/tdnet-events` | 優待変更履歴(読み取り専用)。開示日 / 銘柄コード / 会社名 / 種別バッジ(開始・変更・廃止) / 開示タイトルの一覧。ナビゲーションから直接遷移 |

デザイン: 日本市場の慣例に合わせ**上昇=赤/下落=緑**(米国式とは逆)。数値は`JetBrains Mono`のtabular-numsで統一表示。

### 逆日歩予測機能のバックフィル状況(2026-09-05時点、デプロイ前)

`JQuantsGyakuhibuActual`の既存行(残高列拡張前)は約5,000件と見込まれ、`MAX_GYAKUHIBU_FETCHES_PER_RUN`の既定値(200件/回)のままだと約25日かかる計算のため、デプロイ直後は一時的に引き上げてバックフィルを加速する運用を想定している(コード変更不要、CDK環境変数のみ)。ただし`GyakuhibuHistoryBatchFunction`の14分タイムアウト内では、1件あたり3回のHTTPラウンドトリップ+`TAISYAKU_REQUEST_INTERVAL_MS`(既定1000ms)の待機がかかるため、実際に完走できる上限は300〜400件程度が目安(800まで上げてもタイムアウトで打ち切られ、EventBridgeの自動リトライで逆にtaisyaku.jpへの負荷が増える)。実際にバックフィルへ要した日数、`GyakuhibuForecastBatchFunction`が算出したビン別サンプル数(`_POOL_`行の`bins[].n`)の実測、`MAX_GYAKUHIBU_FETCHES_PER_RUN`を既定値へ戻した日付は、デプロイ・バックフィル完了後にこの節へ追記する。

## 主要コマンド

```bash
# バックエンド(ルート)
npm run build          # tsc
npm test               # jest(スタック合成テスト + Lambda単体テスト)
npx cdk synth          # 合成確認
npx cdk deploy         # デプロイ

# フロントエンド(frontend/)
cd frontend
cp .env.example .env   # VITE_API_BASE_URL・VITE_COGNITO_* に CfnOutput の値を設定(.env.example参照)
npm run dev            # ローカル開発サーバー
npm run build           # 本番ビルド(dist/)
npm run lint            # oxlint

# フロントのデプロイ(ビルド後)
aws s3 sync dist/ s3://<FrontendBucketName> --delete
aws cloudfront create-invalidation --distribution-id <DistributionId> --paths '/*'
```

`FrontendBucketName` / `DistributionId` / `ApiEndpoint` / `FrontendUrl` は `cdk deploy` の出力(CfnOutput)で確認できる。

バックエンドのルート削除・改名を伴う変更(今回の`/tickers`系CRUDルート削除など)をデプロイする際は、フロント(`aws s3 sync` + CloudFront invalidation)を先に、`cdk deploy`を後に実行すること。新しいフロントのビルド成果物は削除済みルートを一切呼ばないため旧・新どちらのバックエンドに対しても安全に動作するが、逆に`cdk deploy`を先に実行すると、まだ古いフロントが配信されている間、その旧ticker一覧/screening/watchlist画面が(既に無くなった`/tickers`系CRUDルートを呼び続けて)一時的に404を受け取る。

### 信用残(taisyaku.jp)への移行手順

信用残のデータ源をJ-Quants(スタンダードプラン)からtaisyaku.jp(日証金の貸借取引残高、認証不要)へ移した。J-Quants版の最終状態はタグ`margin-balance-jquants-final`。本番は2026-10-01からライトプランで`tseMarginFeatures=false`(信用残バッチのスケジュール無し・現在需給予測無し)のまま動いているため、この移行のデプロイで信用残バッチのスケジュールと現在需給予測が初めて有効になる。

1. 2日連続失敗の通知先メールアドレスはSSM Parameter Store(`/j-quants/alert-email`、String、ap-northeast-1)から`cdk deploy`時に読む。環境変数は不要で、`npx cdk deploy`だけでよい。パラメータが無いとデプロイは失敗する。
   - 初回の設定と変更(同じコマンド): `aws ssm put-parameter --name /j-quants/alert-email --type String --value you@example.com --overwrite`のあと`npx cdk deploy`
   - Git Bashでは`/j-quants/...`がパス変換されるので先頭に`MSYS_NO_PATHCONV=1`を付ける
2. デプロイ順はフロント(`aws s3 sync` + CloudFront invalidation)が先、`cdk deploy`が後。新しいAPIは`features`を返さず、旧フロントは`features`が無いと(`listState.data?.features.tseMargin`で)例外になるため。
3. 初回デプロイ後(通知先を変えて購読が作り直されたときも)、SNSの確認メール(`JQuantsBatchAlarmTopic`)のリンクを踏む。踏むまで通知は届かない。
4. バックフィル(3年=738営業日、1回あたり新規39日なので19回分): 定期実行だけなら約4週間。早めるなら、前の実行が終わってから次を呼ぶ(カーソルが競合するので同時に走らせない):
   ```
   aws lambda invoke --function-name <MarginBalanceBatchFunctionの名前> --cli-read-timeout 900 out.json
   ```
   進み具合は信用残テーブルのカーソル行(`ticker`=`__cursor__`, `date`=`taisyaku`)の`lastFetchedDate`で確認する。バックフィル後、信用残テーブルは約1.1M行になるため、`GyakuhibuForecastBatchFunction`(全件Scanする)の実行時間とピークメモリを一度確認する。
5. 数銘柄で、taisyaku.jpの画面の値とグラフの値が一致することを確認する。
6. バックフィル完了を確認してから、`scripts/cleanup-legacy-margin-balance.ts`をドライラン(`npx ts-node scripts/cleanup-legacy-margin-balance.ts`)→`--execute`の順に手動で実行し、旧`source`(`weekly`/`daily-alert`)の行を消す。テーブルはPITR有効なので誤削除は復旧できる。
7. J-Quantsのダウングレード(解約・プラン変更)は、他の無料プラン化課題が済んでから行う。

貸借区分(`marginName`)も、J-Quants `/equities/master`の`MrgnNm`からtaisyaku.jpの全銘柄一括CSVの`貸借区分`(東証行)へ移した(`docs/superpowers/specs/2026-10-27-margin-name-taisyaku-design.md`)。値はtaisyaku.jpの表記(`貸借`/`貸借融資`/`非貸借`)のまま保存する。デプロイ後、最初に信用残バッチが動くまではJ-Quantsの値(`信用`/`その他`)が残るが、判定は`貸借`かどうかと`null`かどうかしか見ないので結果は変わらない。これでJ-Quantsに残る依存は株価(`PriceBatchFunction`)と財務(`FinancialSummaryBatchFunction`)だけになった。

株価もJ-Quants `/equities/bars/daily`からSoftHompoの日次株価ファイルへ移し、財務サマリー(取得・API・画面表示)とPERの表示は廃止した(`docs/superpowers/specs/2026-10-29-price-softhompo-design.md`)。これでJ-Quantsを呼ぶ処理は無くなり、APIキーのシークレット`JQuantsApiKey`もスタックから削除した。J-QuantsはFreeプランへの変更・解約ができる。SoftHompoは前営業日分を翌営業日の朝に公表するため、夜の貸借判定バッチ(JST 18:20)が使う終値は前営業日のものになる。SoftHompoは個人のサイトで利用規約の記載が無い(本アプリは個人利用に限る)。デプロイはフロント(`aws s3 sync` + CloudFront invalidation)が先、`cdk deploy`が後(旧フロントは`/tickers/{ticker}/summary`が無いとエラー表示になるため)。

## コスト目安

- 稼働中: 月$1未満。DynamoDB・Lambda・API Gateway・CloudFront・Cognito(Essentialsの無料枠内)はこの利用規模ではほぼ無料。
- `cdk destroy`後: DynamoDB・User Pool(RETAIN)のストレージ代のみでほぼ$0。
