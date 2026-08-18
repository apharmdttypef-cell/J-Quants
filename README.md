# J-Quants株価ビューア

J-Quants API(Freeプラン)で取得した株価・財務データを蓄積し、Webで閲覧するための個人用アプリ。
CDK(TypeScript)でインフラを定義し、フロントはVite + React + TypeScriptのSPA。

## アーキテクチャ

```
EventBridge(毎日 JST18:00)
  → BatchFetchFunction(Lambda)
      - JQuantsWatchlist ∪ JQuantsYutaiMasterテーブルを読んで対象銘柄を取得
      - J-Quants API(x-api-keyヘッダー認証)から四本値・財務サマリを取得
        (5req/分のレート制限を守るため呼び出しごとに13秒待機)
      → JQuantsStockPrices / JQuantsFinancialSummary に upsert

EventBridge(毎日 JST18:30)
  → MarginBalanceBatchFunction(Lambda)
      - JQuantsYutaiMasterの全銘柄の信用残を取得(現在はダミーデータ、下記参照)
      → JQuantsMarginBalance に upsert

EventBridge(毎日 JST19:00)
  → GyakuhibuHistoryBatchFunction(Lambda)
      - JQuantsYutaiRightsDateの未取得の権利日についてtaisyaku.jpから実績逆日歩を取得
      → JQuantsGyakuhibuActual に upsert

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
| `JQuantsYutaiMaster` | PK `ticker` | 優待マスタ本体(`companyName` / `content` / `value` / `unitShares`)。書き込みはアプリ外(手動スクリプト等でDynamoDBへ直接投入)で行う前提の**読み取り専用**テーブル |
| `JQuantsYutaiRightsDate` | PK `ticker` / SK `rightsDate` | 銘柄ごとの**権利付き最終日**(1行1権利日、年複数回にも対応)。こちらもアプリ外から投入。**権利確定日(月末等の基準日)そのものではなく、そこから2営業日前(買付最終日T)を入れる**。逆日歩の計算・taisyaku.jp実績照合はいずれも`rightsDate`をTとしてT+2(受渡日=権利確定日)を自動算出する前提のため、月末日をそのまま入れると全て2営業日分ずれる |
| `JQuantsMarginBalance` | PK `ticker` / SK `date` | 信用残時系列(`financingBalance`融資残・`lendingBalance`貸株残・`source`=`weekly`\|`daily-alert`) |
| `JQuantsGyakuhibuActual` | PK `ticker` / SK `rightsDate` | taisyaku.jpから取得した権利日ごとの実績逆日歩(`totalAmount` / `days` / `avgRate`)。直近3年分のみ存在しうる |

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
- そのため`BatchFetchFunction`は`to`を"今日"ではなく"今日-12週間-1日(バッファ)"を基準に計算している(`lambda/batch-fetch/index.ts`の`DELIVERY_DELAY_DAYS`)。
- 同じ理由で`ReferenceApiFunction`の価格取得も"今日からN日前"という日付フィルタではなく、保存済みの最新N件をそのまま返す方式にしている(バッチが保存する日付は常に配信遅延分だけ過去になるため)。

### 優待クロス逆日歩リスク可視化(`/yutai`系)

株主優待クロス取り(現物買い+信用売りで優待だけを取得する手法)における「逆日歩(品貸料)」のリスクを事前に可視化する機能。詳細設計は`docs/superpowers/specs/2026-08-13-yutai-cross-risk-design.md`。

**フェーズ分け(ダミーAPI→本番API)**: 逆日歩見積りの計算には信用残(融資残・貸株残)データが必要だが、これを取得するJ-Quants `mkt-margin-int` / `mkt-margin-alert` はStandardプラン(有料)専用。画面・遷移の動作確認が終わるまで課金を遅らせるため、現状(フェーズ1)は`lambda/margin-balance-batch/data-source.ts`が信用残を**ticker+日付から決定的な擬似乱数で生成したダミーデータ**で返している(同じ入力には常に同じ値を返すため、日々のトレンドグラフが実行のたびにジャンプすることはない)。したがって**現在デプロイされている`/yutai`画面の信用残トレンド・貸借銘柄判定はすべてダミー値**であり、実際の逆日歩リスクの参考にはならない。フェーズ2でStandardプランへアップグレードした際は、このモジュールの中身だけをJ-Quants呼び出しに差し替える設計になっており、DynamoDBスキーマ・API・逆日歩計算ロジック・フロントは変更不要。なお取引カレンダー(権利日→受渡日の日数算出)と実績逆日歩(taisyaku.jp)はJ-QuantsのFreeプラン/無料サイトでそれぞれ取得できるため、フェーズ1から本番のデータを使っている。

優待マスタ(`JQuantsYutaiMaster` / `JQuantsYutaiRightsDate`)への新規銘柄追加・内容更新は本アプリのUIでは行わない。別途手動スクリプト等でDynamoDBへ直接投入する前提で、アプリ側は常にマスタが最新状態であることを仮定した検索・計算・表示のみを担う。

**最大逆日歩(見積り)の計算式**(`lambda/shared/gyakuhibu-calc.ts`): 逆日歩(品貸料率)は日々の品貸入札で決まる変動相場で、貸株超過株数から一意に決まる固定表は存在しない。一方、入札の上限である**最高料率**は「貸借値段(株価)×売買単位」から一意に決まる公開ルールなので、この上限値を「最大逆日歩」として見積もる。

```
投資単位(円) = 貸借値段(前日終値) × 単元株数
品貸料の上限(円、投資単位あたり・1日分) =
  投資単位 <= 50,000円: 100円
  投資単位 >  50,000円: 100円 + ceil((投資単位 - 50,000) / 10,000) × 20円
最高料率(円、1株・1日あたり) = 品貸料の上限 ÷ 単元株数 を10銭単位で切り上げ(ただし1円以下なら1円)
最大逆日歩(円) = 最高料率 × 単元株数 × 品貸日数(受渡日(権利付き最終日のT+2)〜その翌営業日の暦日数、取引カレンダーから自動算出)
```

出典: [株式 最高料率早見表(1日・1株当り)](https://www.taisyaku.jp/media/about-hayamihyo.pdf)(日本証券金融公式PDF。実際の早見表の数値と一致することを確認済み)。旧要件定義にあった固定「×4倍ルール」は、品貸日数を実日数で計算することで自然に織り込まれるため採用していない(3連休を挟むと自動的に日数が増える)。

### taisyaku.jp(日本証券金融)からの実績逆日歩取得(実機で判明)

過去の権利日ごとの**実績**逆日歩(上記は見積り上限であり、実際に発生した金額とは別)は、日本証券金融公式サイト(https://www.taisyaku.jp/、広告ゲート・robots.txt無し)がCSVで公開している(直近3年分のみ)。ただし要件定義段階で想定していた「単純なGETリクエストでCSVが取れる」という前提は誤りで、実際にHARキャプチャして判明した正しい手順は次の通り(`lambda/gyakuhibu-history-batch/taisyaku-client.ts`):

1. **`GET /app/stock/detail/{code}-01`**(銘柄詳細ページ)でHTMLを取得し、`Set-Cookie`のセッションCookieと、ページ内`<input name="csrf_test_name">`のCSRFトークン(ページ読み込みのたびに変わる)を抽出する。
2. **`POST /app/stock/detail/{code}/search`** に`csrf_test_name`(手順1で取得)・`orgMgrCd`・期間(`mkYmdFrom`/`mkYmdTo`、`"YYYY / MM / DD"`形式)などをフォームエンコードで送信(手順1のCookieを付与)。これがサーバー側のセッション状態に検索条件をセットする。
3. **`GET /app/stock/detail/{code}/csv`**(同じCookie付き)でCSVをダウンロード。URLにクエリパラメータは無く、直前のPOSTで確立したセッション状態がそのままCSV化される。

CSRFトークン+セッションCookieが必須で、無状態の1回のリクエストでは取得できない(GETだけ、あるいはCookie無しでは失敗する)。

CSVの値の単位にも要件定義段階の想定との食い違いがあった。「品貸料率(品貸日数分/円)」列は**1株あたり・品貸日数分の合計額**であり(1,000株あたりではない)、上記の最高料率計算式と実データで完全一致することを確認済み(例: 貸借値段2,985円・単元100株で最高料率6.00円/株/日、品貸日数3日なら列の値は18.00円=6.00×3)。そのため実績総額は`列の値 × 単元株数`だけで求まる(÷1000等の換算は不要)。また同列が`-`(空)の日は取得失敗ではなく「その日は実際に品薄が発生せず逆日歩が0円だった」ことを意味する。詳細な調査ログは`docs/superpowers/notes/2026-08-13-taisyaku-csv-format.md`。

### Lambda

| 関数 | トリガー | 役割 |
|---|---|---|
| `BatchFetchFunction` | EventBridge(`cron(0 9 * * ? *)` = JST 18:00 毎日) | 対象銘柄(`JQuantsWatchlist` ∪ `JQuantsYutaiMaster`、重複排除)の四本値・財務サマリを取得しDynamoDBへ |
| `MarginBalanceBatchFunction` | EventBridge(`cron(30 9 * * ? *)` = JST 18:30 毎日) | `JQuantsYutaiMaster`の全銘柄の信用残(融資残・貸株残)を取得し`JQuantsMarginBalance`へupsert。新規銘柄はバックフィルモード、既存銘柄は日次差分取得。現在は`data-source.ts`がダミーデータを生成(上記「優待クロス逆日歩リスク可視化」参照、フェーズ2で`mkt-margin-int`/`mkt-margin-alert`に差し替え予定) |
| `GyakuhibuHistoryBatchFunction` | EventBridge(`cron(0 10 * * ? *)` = JST 19:00 毎日) | `JQuantsYutaiRightsDate`の過去の権利日のうち`JQuantsGyakuhibuActual`未取得のものについて、taisyaku.jpから実績逆日歩を取得しupsert |
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

デザイン: 日本市場の慣例に合わせ**上昇=赤/下落=緑**(米国式とは逆)。数値は`JetBrains Mono`のtabular-numsで統一表示。

### スコープを絞った点

- ウォッチリスト管理の「会社名検索」は、コード追加時に`/equities/master`を1回だけ呼んで会社名を保存する方式に限定。J-Quants APIに会社名での検索パラメータがなく、全銘柄(数千件)をDynamoDBに同期しない限り真の名前検索はできないため、費用対効果を考えて見送った。
- `GET /tickers/{ticker}/summary`はバッチが一度もその銘柄の決算を取得できていない場合404を返す(データを捏造しない)。

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

## コスト目安

- 稼働中: 月$1程度(内訳はほぼ`JQuantsApiKey` / `JQuantsAppPassword`の固定費 $0.40×2)。DynamoDB・Lambda・API Gateway・CloudFrontはこの利用規模ではほぼ無料枠内。
- `cdk destroy`後: DynamoDB(RETAIN)のストレージ代のみでほぼ$0。ただしシークレット2つは既定で最大30日「削除保留」状態のまま$0.80/月が発生し続ける。即ゼロにしたい場合:
  ```bash
  aws secretsmanager delete-secret --secret-id JQuantsApiKey --force-delete-without-recovery
  aws secretsmanager delete-secret --secret-id JQuantsAppPassword --force-delete-without-recovery
  ```
