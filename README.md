# J-Quants株価ビューア

J-Quants API(Freeプラン)で取得した株価・財務データを蓄積し、Webで閲覧するための個人用アプリ。
CDK(TypeScript)でインフラを定義し、フロントはVite + React + TypeScriptのSPA。

## アーキテクチャ

```
EventBridge(毎日 JST18:00)
  → BatchFetchFunction(Lambda)
      - JQuantsWatchlistテーブルを読んで対象銘柄を取得
      - J-Quants API(x-api-keyヘッダー認証)から四本値・財務サマリを取得
        (5req/分のレート制限を守るため呼び出しごとに13秒待機)
      → JQuantsStockPrices / JQuantsFinancialSummary に upsert

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

`cdk destroy` してもこの3テーブルは残る。次シーズンまたデプロイすれば同じデータから再開できる。

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

### Lambda

| 関数 | トリガー | 役割 |
|---|---|---|
| `BatchFetchFunction` | EventBridge(`cron(0 9 * * ? *)` = JST 18:00 毎日) | ウォッチリスト銘柄の四本値・財務サマリを取得しDynamoDBへ |
| `ReferenceApiFunction` | API Gateway(HTTP API) | `/tickers` 系エンドポイントの実処理 |
| `AuthorizerFunction` | API GatewayのLambdaオーソライザー | `x-app-password` ヘッダーを `JQuantsAppPassword` と照合(結果は5分キャッシュ) |

### API(HTTP API、全ルートに`AuthorizerFunction`が既定で適用される)

| メソッド/パス | 内容 |
|---|---|
| `GET /tickers` | ウォッチリスト一覧 |
| `POST /tickers` | 銘柄コードを追加(`/equities/master`で会社名を1回だけ引き当てて保存) |
| `DELETE /tickers/{ticker}` | ウォッチリストから削除(価格・財務の蓄積データ自体は残る) |
| `GET /tickers/{ticker}/prices?range=12w` | 保存済みデータのうち直近12週間分(≈60営業日)の四本値・出来高。日付フィルタではなく最新N件取得なので、配信遅延で古い日付になっていても正しく返る |
| `GET /tickers/{ticker}/summary` | 直近の決算サマリ。バッチが1度も取得していなければ404 |

CORSの`allowOrigins`はCloudFrontの配信ドメインと`http://localhost:5173`(ローカル開発用)のみ。

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
