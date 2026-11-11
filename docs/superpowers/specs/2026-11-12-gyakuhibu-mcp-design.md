# 逆日歩予測MCP(claude.aiカスタムコネクタ) 設計

## 背景・目的

銘柄別の逆日歩予測を claude.ai(Web・スマホ)から会話で引けるようにする。
既存のHTTP APIと同じAWSスタックに、リモートMCPサーバーを追加する。

## スコープ

- ツールは**銘柄別の逆日歩予測1本**(`get_gyakuhibu_forecast`)だけ。
- 対象外: 月別の予測一覧(当初案にあったが、作業量に比べて使う見込みが低いため外した)、過去実績単体の照会、予測精度の検証結果。

## データ規約上の前提

J-Quants・日証金・kabuyutai.comの規約により、このアプリは個人利用に限る(`project_data_licensing`)。
MCPのエンドポイントは**自分のCognitoアカウントの`sub`だけ**を通し、URLを知っていても他人は使えないようにする。
claude.aiが自分の分析のために読むことは私的利用の範囲とみなす。

## 1. ツール

`get_gyakuhibu_forecast`

- 入力: `{ ticker: string }`(4桁の銘柄コード。前後の空白は除く)
- 出力(テキストのJSON): `GET /yutai/{ticker}/forecast`と同じ値を元に、会話で使う項目に絞る。
  - 銘柄: `ticker`, `companyName`, `content`, `value`, `requiredShares`, `unitShares`, `rightsDate`, `closePrice`, `maxGyakuhibu`
  - 廃止予告: `abolitionNotice`(`2026-11-12-yutai-change-apply-design.md`。無ければ`null`)。
    予測APIのレスポンスには無い項目なので、共有モジュールが読む優待マスタ行から取り出して足す
  - 予測: `forecast`(判定・発生確率・P50/P90/平均・期待損益・サンプル数)、`tseForecast`(現在需給ベース)
  - 実績: `history`は新しい順に**直近10件**まで。`marginTrend.latest`
  - 含めない: `poolBins`(画面のグラフ用で、会話には不要かつ大きい)
- ツールの説明文に、各項目の意味と単位(金額は必要株数あたりの円、確率は0〜1)、`forecastStatus`の値の意味を書く。
- 優待マスタに無い銘柄: `isError: true`で「優待マスタに無い銘柄です」と返す。
- 制度信用で売れない銘柄(`forecastStatus: 'general-only'`): 通常の結果として返し、説明文で意味を伝える。

## 2. 構成

- **共有モジュール** `lambda/shared/yutai-forecast-detail.ts`:
  `reference-api`の`getYutaiForecast`から、DynamoDBを読んでレスポンスを組み立てる部分を
  `loadYutaiForecastDetail(ticker): Promise<YutaiForecastDetail | null>`として移す。
  reference-apiはこれを呼んで`jsonResponse`で包むだけにする。APIとMCPは同じ結果を返す。
  切り出し前後でAPIのレスポンスが変わらないことをテストで確認する。
- **MCP Lambda** `lambda/mcp-server/index.ts`: Streamable HTTPのステートレス方式(セッションIDを発行しない、
  レスポンスは常に`application/json`で返しSSEは使わない)。
  - 扱うメソッド: `initialize`, `notifications/initialized`(202で空応答), `tools/list`, `tools/call`, `ping`。
    それ以外は JSON-RPC の`-32601`。
  - JSON-RPCの処理は自前で書く(公式SDKのTransportはNodeのreq/resを前提にしていて、Lambdaに載せると継ぎはぎが多いため)。
  - `GET /mcp`は405(SSEストリームを提供しない)。
- **ルート**(既存の`JQuantsApi`に追加、**オーソライザーなし**。認証はLambda内で行う):
  - `POST /mcp`, `GET /mcp`
  - `GET /.well-known/oauth-protected-resource`(RFC 9728。`resource`=`{apiEndpoint}/mcp`、`authorization_servers`=`[apiEndpoint]`)
  - `GET /.well-known/oauth-authorization-server`(RFC 8414。Cognitoの`authorization_endpoint`/`token_endpoint`/
    `revocation_endpoint`/`jwks_uri`等を案内し、`code_challenge_methods_supported: ['S256']`を含める)
  - API GatewayのJWTオーソライザーは、MCPのOAuth検出に必要な`WWW-Authenticate`ヘッダーを付けられないため使わない。
- CORSは変更しない(claude.aiはサーバー側から接続するため)。

## 3. 認証と利用者の制限

- Cognitoにclaude.ai専用のアプリクライアント`JQuantsClaudeMcpClient`を追加する。
  シークレットあり、認可コードフロー、スコープ`openid email`、コールバック`https://claude.ai/api/mcp/auth_callback`。
  トークン有効期限は既存Webクライアントと同じ(アクセス1時間、リフレッシュ7日)。
- Lambda内で`aws-jwt-verify`の`CognitoJwtVerifier`(`tokenUse: 'access'`、`clientId`=MCPクライアント)で、
  署名・有効期限・client_idを検証する。
- 検証後、`sub`が環境変数`MCP_ALLOWED_SUBS`(カンマ区切り)に無ければ403。空なら全員403(フェイルクローズ)。
- トークンが無い/無効なら401と`WWW-Authenticate: Bearer resource_metadata="{apiEndpoint}/.well-known/oauth-protected-resource"`。
- 呼び出しは既存APIと同じく`sub`とメソッド名・ツール名をCloudWatch Logsに出す(メールアドレスは出さない)。
- claude.ai側はコネクタの詳細設定にクライアントIDとシークレットを入力する(CognitoはDynamic Client Registration非対応)。
  シークレットの取り出し手順(`aws cognito-idp describe-user-pool-client`)と`MCP_ALLOWED_SUBS`の設定方法をREADMEに書く。

## 4. 進め方

1. **接続の検証(最初に行う)**: 認証まわり+ダミーツール(固定文字列を返す)だけをデプロイし、claude.aiから
   コネクタ追加 → Cognitoのログイン画面 → トークン取得 → ツール呼び出しまで通るかを確かめる。
   通らなければ、原因(メタデータの検出・issuerの不一致・トークン交換の認証方式など)を調べ、
   必要ならOAuthの仲介エンドポイントを自前で足す方針に切り替えて設計書を更新する。
2. 共有モジュールへの切り出し(API側の回帰テスト込み)。
3. 本物のツールに差し替え、claude.aiから実際の銘柄で確認する。

## テスト

- MCP Lambda: 各JSON-RPCメソッドの応答、未知メソッド、`notifications/initialized`の202、`GET /mcp`の405。
- 認証: トークン無し(401+ヘッダー)、署名不正・期限切れ、別クライアントのトークン、許可リスト外の`sub`(403)、
  `MCP_ALLOWED_SUBS`が空(403)。
- ツール: 正常、マスタに無い銘柄、`general-only`、`history`が10件に切られること、`poolBins`を含まないこと。
- 共有モジュール: 切り出し前後で`GET /yutai/{ticker}/forecast`のレスポンスが同じこと(既存テストを流用)。
- CDK: `/mcp`と`/.well-known/*`だけがオーソライザー無しで、既存ルートは従来どおりJWTオーソライザー付きであること。
  MCPクライアントのコールバックURL。

## 依存

`2026-11-12-yutai-change-apply-design.md`(`abolitionNotice`)を先に実装する。
