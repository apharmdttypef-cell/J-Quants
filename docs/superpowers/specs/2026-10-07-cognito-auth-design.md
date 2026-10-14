# j-quants ユーザー別認証（Cognito）設計

Oct 7, 2026 · @ryo

## 実装前レビューでの変更(2026-10-14)

起票後に実装が変わった点と、レビューで決めた点。本文は以下を反映済み。

- ウォッチリストの変更ルート(`POST /tickers`・`DELETE /tickers/{ticker}`)と`JQuantsWatchlist`は起票前のリファクタで削除済みで、現在のAPIは全ルートがGET。守る対象が無いため、`admin`グループと403判定は作らない(次に作るユーザー別データの機能で必要になった時点で入れる)
- ユーザー識別は`sub`を使う(メールアドレスは変更されうる)。`getCaller`は将来DynamoDBのパーティションキーに使える前提で`{ sub, email }`を返す
- Cognitoのアクセストークンには既定で`email`が入らないため、Pre Token Generationトリガー(V2、Essentials以上)でアクセストークンに`email`クレームを足す(`lambda/pre-token-generation/`)。APIに送るのは引き続きアクセストークン
- ログイン後は元のページに戻す。戻り先は`/`で始まり`//`で始まらない相対パスだけを許可する(外部URLへのオープンリダイレクト防止)
- Cognitoドメインのプレフィックスは`jquants-beta-vqvfk`(友人全員にログイン画面のURLとして見えるため、アカウントIDを含めない)
- `bin/j-quants.ts`がsynth時にシークレット`JQuantsAppPassword`を読んでいる(起票後に追加)ため、これも削除する。削除しないとシークレット削除後に`cdk deploy`が失敗する
- J-Quants等の規約確認は、友人の招待(移行手順8)の前に管理者が行う

## 目的とスコープ

共有パスワード認証をCognito User Poolによるユーザー別認証に置き換え、友人向けベータ公開で「誰がアクセスしているか分かり、個別に止められる」状態にする。

- 対象：少人数（数名〜十数名）の信頼できる友人。管理者が招待したユーザーのみ利用可能
- 達成条件：ユーザー単位でのログイン・アクセス停止ができ、共有パスワードと `sessionStorage` 上の平文パスワードが無くなること
- 本設計はClaude Codeでの実装を前提とし、実装はTDDで進める

## 現状の認証構成と課題

フロントとAPIの両方を1つの共有パスワード `APP_PASSWORD` で保護しており、個人単位の識別・停止ができない。

| 層 | 現状の実装 | 該当箇所 |
| --- | --- | --- |
| フロント | CloudFront Function（viewer-request）でBasic認証。ユーザー名 `jquants` 固定、パスワードはsynth時に埋め込み | `lib/j-quants-stack.ts` `BasicAuthFunction` |
| API | `HttpLambdaAuthorizer`（SIMPLE）が `x-app-password` ヘッダーを `JQuantsAppPassword` シークレットと照合、5分キャッシュ | `lambda/authorizer/index.ts`、`ApiAuthorizer` |
| フロント保持 | `PasswordGate` が `sessionStorage` に平文保存し全API呼び出しに付与。401で破棄 | `frontend/src/lib/appPassword.ts` |
| デプロイ | `APP_PASSWORD` 未設定だとsynthエラー | スタック冒頭のチェック、テスト `throws a clear error when APP_PASSWORD is not set` |

課題：

- 特定の友人だけアクセスを止められない（全員のパスワード変更が必要）
- 誰がアクセスしたか分からない
- パスワードがフロントのコードとブラウザに平文で存在する

## 方針

Cognito User Pool（招待制）＋Managed Loginの認可コードフロー（PKCE）でログインし、HTTP APIの組み込みJWT authorizerでアクセストークンを検証する。自前のオーソライザーLambdaと共有パスワードは廃止する。

| 論点 | 決定 | 理由 |
| --- | --- | --- |
| 認証基盤 | Cognito User Pool（機能プラン Essentials） | 個別停止・ロックアウトが標準装備。この規模なら無料枠内の見込み |
| 登録方式 | セルフサインアップ無効、管理者招待のみ | ベータは信頼できる友人限定 |
| ログインUI | Managed Login（Cognitoドメイン） | ログイン・初回パスワード変更・パスワードリセット画面を自作しない |
| フロー | 認可コード＋PKCE、クライアントシークレットなし | SPA向けの推奨方式 |
| API検証 | `HttpUserPoolAuthorizer`（JWT authorizer）を `defaultAuthorizer` に設定 | Lambda不要、全ルートに一括適用 |
| 送るトークン | アクセストークンを `Authorization: Bearer` で送信 | API認可用途のトークン。JWT authorizerは `client_id` クレームで検証 |
| 権限 | 全ユーザー同じ(グループは作らない) | 現在のAPIは全ルートがGETで、変更系の操作が無い |
| ユーザー識別 | `sub` | メールアドレスは変更されうる。将来ユーザー別データのキーに使う |
| フロントの静的配信 | CloudFrontのBasic認証は廃止し、静的ファイルは公開 | バンドルに秘密情報は無くなり、データは全てAPI側で保護される |

ログインの流れ：

1. 未ログインでアプリを開くと、フロントがCognitoのManaged Loginへリダイレクト
2. ユーザーがメールアドレスとパスワードでログイン（初回は招待時の仮パスワードを変更）
3. Cognitoが認可コード付きでアプリのURLへ戻し、フロントがトークンに交換
4. フロントがアクセストークンを付けてAPIを呼び、JWT authorizerが署名・有効期限・`client_id` を検証
5. Lambdaは検証済みクレーム（`sub`）を参照してユーザーを識別し、アクセスをログに残す
6. ログイン前に開いていたページ(相対パスのみ)へ戻る

## インフラ（CDK）変更点

変更は `lib/j-quants-stack.ts` に閉じる。User Pool関連のリソースを追加し、共有パスワード関連のリソースを削除する。

追加：

| リソース | 主な設定 |
| --- | --- |
| `cognito.UserPool`（`JQuantsUserPool`） | `selfSignUpEnabled: false`、`signInAliases: { email: true }`、`featurePlan: ESSENTIALS`、`accountRecovery: EMAIL_ONLY`、`deletionProtection: true`、`removalPolicy: RETAIN`、`userInvitation` で日本語の招待メール文面を設定 |
| `UserPoolDomain` | Cognitoプレフィックスドメイン `jquants-beta-vqvfk`、`managedLoginVersion: NEWER_MANAGED_LOGIN` |
| `UserPoolClient` | `generateSecret: false`、`oAuth.flows.authorizationCodeGrant: true`、scopes は `openid` / `email`、`callbackUrls` と `logoutUrls` に `https://<CloudFrontドメイン>/` と `http://localhost:5173/`、`accessTokenValidity: 1時間`、`idTokenValidity: 1時間`、`refreshTokenValidity: 7日`、`enableTokenRevocation: true`、`preventUserExistenceErrors: true` |
| Managed Loginブランディング | `CfnManagedLoginBranding` を `useCognitoProvidedValues: true` で作成（新Managed Loginはこれが無いとログイン画面が表示されない） |
| `PreTokenGenerationFunction` | User PoolのPre Token Generationトリガー(`LambdaVersion.V2_0`)。アクセストークンに`email`クレームを足す |

変更：

- `HttpApi` の `defaultAuthorizer` を `HttpUserPoolAuthorizer('ApiAuthorizer', userPool, { userPoolClients: [client] })` に差し替え
- CORS `allowHeaders` を `['Content-Type', 'Authorization']` に変更（`x-app-password` を削除）
- `CloudFront` の `functionAssociations` を削除
- CfnOutputに `UserPoolId`、`UserPoolClientId`、`CognitoDomain`（`https://<prefix>.auth.ap-northeast-1.amazoncognito.com`）を追加

削除：

- `BasicAuthFunction`（CloudFront Function）
- `AuthorizerFunction`（`lambda/authorizer/`）と `HttpLambdaAuthorizer`
- `JQuantsAppPasswordSecret` と、`APP_PASSWORD` 未設定時にsynthを失敗させるチェック（シークレット1つ分、月$0.40減）
- スタックの`appPassword`プロパティと、`bin/j-quants.ts`のシークレット読み込み

補足：User Poolは `RETAIN` にし、スタックを作り直しても招待済みユーザーが消えないようにする。

## フロントエンド変更点

`oidc-client-ts` ＋ `react-oidc-context` でログイン状態を管理し、`PasswordGate` を `AuthGate` に置き換える。Amplifyは機能過多のため使わない。

| ファイル | 変更内容 |
| --- | --- |
| `frontend/src/main.tsx` | `AuthProvider`（`authority`、`client_id`、`redirect_uri`、`scope: 'openid email'`、`onSigninCallback` でURLから `code`/`state` を除去し、stateに入れた元のページへ戻る）で全体を包み、`PasswordGate` を `AuthGate` に差し替え |
| `frontend/src/components/AuthGate.tsx`（新規） | 未認証なら `signinRedirect()`（stateに現在のパスを入れる）、読み込み中はローディング表示、エラー時は再ログインボタン |
| `frontend/src/api/client.ts` | `x-app-password` の代わりに `Authorization: Bearer <access_token>` を付与。401時は再ログインへ誘導 |
| `frontend/src/lib/auth.ts`（新規） | React外の `client.ts` からトークンを取得するための `UserManager` 参照、ログアウト処理 |
| `frontend/src/lib/return-path.ts`（新規） | ログイン後の戻り先の検証。`/`で始まり`//`で始まらない相対パスだけを許可し、それ以外はトップ`/`にする |
| `Layout` | ログイン中のメールアドレス表示とログアウトボタン |
| `frontend/src/components/PasswordGate.tsx`、`frontend/src/lib/appPassword.ts` | 削除 |
| `frontend/.env.example` | `VITE_COGNITO_AUTHORITY`（`https://cognito-idp.ap-northeast-1.amazonaws.com/<UserPoolId>`）、`VITE_COGNITO_CLIENT_ID`、`VITE_COGNITO_DOMAIN`、`VITE_REDIRECT_URI` を追加 |

実装上の注意：

- ログアウトは `signoutRedirect()` ではなく、ローカルのユーザー情報を消したうえで `<CognitoDomain>/logout?client_id=...&logout_uri=...` へ遷移する（Cognitoのログアウトは標準のOIDC end\_session と形式が異なる）
- `automaticSilentRenew` を有効にし、リフレッシュトークンでアクセストークンを更新する
- トークンの保存先は `oidc-client-ts` 既定の `sessionStorage`（タブごと）。新しいタブではCognito側のログイン状態が残っていればパスワード入力なしで戻ってくる
- React StrictModeの二重実行で `signinRedirect()` が2回呼ばれないようガードする

## バックエンド変更点

`lambda/reference-api/index.ts` にユーザー識別とアクセスログを加える。権限による出し分けは無い(全ルートがGET)。

- `event.requestContext.authorizer.jwt.claims` から呼び出し元を取り出す関数 `getCaller(event)` を追加し、`{ sub, email }` を返す。`sub`は将来ユーザー別データのパーティションキーに使う。`email`はPre Token Generationトリガーがアクセストークンに足したクレームを使い、無ければ`null`
- 全リクエストで `sub`、`routeKey` を構造化ログ（`console.log(JSON.stringify(...))`）に出し、誰がアクセスしたかをCloudWatch Logsで追えるようにする
- クレームが無い場合（authorizerの設定漏れ）は401を返して処理しない

## ユーザー管理運用

ユーザー操作はAWS CLIで行い、管理画面は作らない。手順はREADMEの「認証モデル」節に追記する。

| 操作 | コマンド | 効果 |
| --- | --- | --- |
| 招待 | `aws cognito-idp admin-create-user --user-pool-id <id> --username <email> --user-attributes Name=email,Value=<email> Name=email_verified,Value=true --desired-delivery-mediums EMAIL` | 仮パスワード付き招待メールが届く。初回ログイン時にパスワード変更 |
| 一時停止 | `admin-disable-user` → `admin-user-global-sign-out` | 新規ログインとトークン更新が止まる。発行済みアクセストークンは最大1時間有効 |
| 再開 | `admin-enable-user` | ログイン可能に戻る |
| 削除 | `admin-delete-user` | ユーザーを完全削除 |
| 一覧 | `aws cognito-idp list-users --user-pool-id <id>` | 招待済みユーザーと状態を確認 |

- 招待メールはCognito既定の送信元を使う（送信数に1日あたりの上限があるが、数名の招待には十分）
- 停止を即時にしたい場合はアクセストークン有効期限を短くする（例 15分）。ベータでは1時間で許容する

## 移行手順とロールバック

APIとフロントを同時に切り替える一括移行とし、`cdk deploy` からフロント配信完了までの数分間は旧フロントが401になることを許容する。

1. ローカルで `npm test` とフロントのビルドが通ることを確認
2. `npx cdk deploy`（`APP_PASSWORD` は不要になる）
3. CfnOutputの `UserPoolId` / `UserPoolClientId` / `CognitoDomain` を `frontend/.env` に設定
4. 自分のユーザーを `admin-create-user` で作成
5. フロントをビルドし `aws s3 sync` ＋ CloudFront invalidation
6. 自分のアカウントで確認：ログイン、一覧・詳細の表示、詳細ページを直接開いてログイン後にそのページへ戻ること、ログアウト
7. テスト用ユーザーを作り、`admin-disable-user` 後にログインできないことを確認し、削除
8. (J-Quants・taisyaku.jpの規約確認後に)友人を招待
9. 不要になった `JQuantsAppPassword` シークレットを `--force-delete-without-recovery` で即時削除

ロールバック：シークレットが削除保留中だと同名で再作成できないため、手順9はベータが安定してから行う。必要なら \`aws secretsmanager restore-secret\` で戻したうえで、変更をgit revertし、`APP_PASSWORD=xxxxx npx cdk deploy` と旧フロントの再配信で元に戻す。User Poolは `RETAIN` のため残り、再移行時に招待済みユーザーをそのまま使える。

## テスト方針

既存のjest構成（スタック合成テスト＋Lambda単体テスト）に沿って、テストを先に書き換えてから実装する。

スタック合成テスト（`test/j-quants.test.ts`）：

- [ ] User Poolが `AdminCreateUserConfig.AllowAdminCreateUserOnly: true`、`DeletionProtection: ACTIVE`、`DeletionPolicy: Retain`
- [ ] User Pool Clientが `GenerateSecret: false`、`AllowedOAuthFlows: ['code']`、`CallbackURLs` にCloudFrontドメインと `http://localhost:5173/` を含む
- [ ] User Pool Domainがプレフィックス`jquants-beta-vqvfk`で存在する
- [ ] `protects every route with the shared-password Lambda authorizer` を置き換え：Authorizerが `AuthorizerType: 'JWT'` で、全ルートに `AuthorizerId` が付く
- [ ] CORS `AllowHeaders` に `Authorization` を含み、`x-app-password` を含まない
- [ ] `AWS::CloudFront::Function` と `JQuantsAppPassword` シークレットが存在しない
- [ ] `appPassword`プロパティ・`APP_PASSWORD`環境変数に関するテスト4件(`appPassword prop takes precedence…`、`falls back to the APP_PASSWORD env var…`、`throws when neither…`、`throws a clear error when APP_PASSWORD is not set`)とBasic認証のテスト(`protects the frontend with a CloudFront Function…`)を削除し、`APP_PASSWORD` 無しでsynthできることを確認
- [ ] CfnOutputに `UserPoolId` / `UserPoolClientId` / `CognitoDomain` がある

Lambda単体テスト（`test/reference-api.test.ts`）：

- [ ] `makeEvent` は既定でクレーム（`sub`、`email`）付きのイベントを作る
- [ ] `getCaller` が `{ sub, email }` を返し、`email` が無いクレームでは `email: null`
- [ ] GET 系は既存テストどおり成功し、`sub` と `routeKey` が構造化ログに出る
- [ ] クレームが無いイベントは401で、DynamoDBを呼ばない

戻り先の検証（`test/return-path.test.ts`、フロントの純関数をルートのjestで検証）：

- [ ] `/yutai/2282`・`/yutai?x=1` は許可、`//evil.example`・`https://evil.example`・`javascript:…`・`yutai`(先頭`/`なし)・空・`/\evil.example` はトップ`/`

削除：`test/authorizer.test.ts`（authorizer Lambdaごと削除）。

フロントの画面：単体テスト基盤が無いため、移行手順6〜7の手動確認で代替する。

## 未決事項・スコープ外

本設計では認証の置き換えのみを扱い、以下は別タスクとする。

- ユーザー別データ(優待月ごとの銘柄登録など)と、それに伴う権限設計：`getCaller`の`sub`をキーにする
- レート制限とコスト上限：HTTP APIのステージスロットリング設定、AWS WAF（CloudFront側）、Budgetsアラート
- データ提供の規約確認：J-Quantsの利用規約上、取得データを第三者（友人）に表示してよいか。taisyaku.jp由来データも同様
- 投資判断に関する免責表示：リスク判定は参考値で、投資判断は利用者の責任である旨の表示
- 独自ドメイン化：Managed Loginとアプリを独自ドメインにする場合はACM証明書（us-east-1）とRoute 53が必要
- MFA：ベータでは無効。対象を広げる際にTOTPの任意有効化を検討
