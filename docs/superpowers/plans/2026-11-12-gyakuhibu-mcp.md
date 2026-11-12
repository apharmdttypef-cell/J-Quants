# 逆日歩予測MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** claude.ai(Web・スマホ)のカスタムコネクタから、銘柄別の逆日歩予測(`get_gyakuhibu_forecast`)を呼べるリモートMCPサーバーを既存スタックに追加する。

**Architecture:** 既存の`JQuantsApi`(HTTP API)に、オーソライザー無しの`/mcp`と`/.well-known/*`ルートを足し、新しいLambda `lambda/mcp-server`で受ける。認証はLambda内で`aws-jwt-verify`によりCognitoのアクセストークン(MCP専用クライアント)を検証し、`sub`の許可リストで本人だけに絞る。予測の組み立ては`reference-api`から共有モジュール`lambda/shared/yutai-forecast-detail.ts`へ切り出し、APIとMCPで同じ値を返す。

**Tech Stack:** TypeScript, AWS CDK v2 (aws-cdk-lib), Lambda Node 22 (NodejsFunction/esbuild), API Gateway HTTP API, Cognito User Pool (Essentials, Managed Login v2), DynamoDB (lib-dynamodb), aws-jwt-verify, Jest + ts-jest。

設計書: `docs/superpowers/specs/2026-11-12-gyakuhibu-mcp-design.md`

## Global Constraints

- ツールは`get_gyakuhibu_forecast`の1本だけ。入力は`{ ticker: string }`。
- MCPはStreamable HTTPのステートレス方式。セッションIDを発行しない。レスポンスは常に`application/json`で、SSEは使わない。`GET /mcp`は405。
- 扱うJSON-RPCメソッド: `initialize`, `notifications/initialized`(202・空ボディ), `tools/list`, `tools/call`, `ping`。それ以外は`-32601`。
- 公式MCP SDKは使わない(JSON-RPCは自前)。
- 認証: `CognitoJwtVerifier`(`tokenUse: 'access'`、`clientId` = MCPクライアント)。トークン無し・無効は401 + `WWW-Authenticate: Bearer resource_metadata="{apiBase}/.well-known/oauth-protected-resource"`。`sub`が`MCP_ALLOWED_SUBS`(カンマ区切り)に無ければ403。空なら全員403。
- `{apiBase}`は`https://${event.requestContext.domainName}`(リクエストから組む。CDKでAPIのURLをLambdaへ渡さない)。
- ログには`sub`・メソッド名・ツール名だけを出す。メールアドレスは出さない。
- 既存ルートは従来どおりJWTオーソライザー付き。CORS設定は変更しない。
- Cognitoクライアント`JQuantsClaudeMcpClient`: シークレットあり、認可コードフロー、スコープ`openid email`、コールバック`https://claude.ai/api/mcp/auth_callback`と`https://claude.com/api/mcp/auth_callback`、アクセス1時間・IDトークン1時間・リフレッシュ7日。
- ツールの出力: `history`は新しい順に直近10件まで。`poolBins`は含めない。`abolitionNotice`は優待マスタ行から(無ければ`null`)。
- `GET /yutai/{ticker}/forecast`のレスポンスは切り出しの前後で1バイトも変えない。
- データ規約上、個人利用に限る。MCPは自分の`sub`だけを通す。
- テストは`npx jest <file>`で個別に流す(全体は20分以上かかるので最後に1回だけ)。

---

## ファイル構成

| ファイル | 役割 |
|---|---|
| `lambda/shared/yutai-forecast-detail.ts`(新規) | 予測詳細の読み出しと組み立て。`ForecastFields`/`buildForecast`/`buildTseForecast`/`queryTaisyakuMarginRows`もここへ移す |
| `lambda/reference-api/index.ts`(変更) | 上を呼ぶだけにする。一覧・margin-trendも共有モジュールの関数を使う |
| `lambda/mcp-server/auth.ts`(新規) | Bearerトークンの検証と許可リスト判定 |
| `lambda/mcp-server/metadata.ts`(新規) | OAuthの2種類のメタデータ文書 |
| `lambda/mcp-server/tool.ts`(新規) | ツール定義(説明文・入力スキーマ)と実行 |
| `lambda/mcp-server/index.ts`(新規) | ルーティングとJSON-RPC |
| `lib/j-quants-stack.ts`(変更) | Cognitoクライアント・ブランディング・Lambda・ルート・出力 |
| `test/yutai-forecast-detail.test.ts`, `test/mcp-server.test.ts`(新規), `test/j-quants.test.ts`(変更) | テスト |
| `README.md`(変更) | 接続手順 |

---

### Task 1: 予測詳細の共有モジュールへの切り出し

**Files:**
- Create: `lambda/shared/yutai-forecast-detail.ts`
- Modify: `lambda/reference-api/index.ts`(`ForecastFields`〜`buildTseForecast`、`getYutaiForecast`、`MARGIN_TREND_RANGE_DAYS`、`queryTaisyakuMarginRows`)
- Test: `test/yutai-forecast-detail.test.ts`(新規)、`test/reference-api.test.ts`(既存。変更しない)

**Interfaces:**
- Produces(Task 3が使う):
  ```ts
  export interface YutaiForecastDetail { /* GET /yutai/{ticker}/forecastのレスポンスボディと同じ形 */ }
  export interface YutaiForecastDetailResult { detail: YutaiForecastDetail; abolitionNotice: AbolitionNotice | null }
  export async function loadYutaiForecastDetail(ticker: string): Promise<YutaiForecastDetailResult | null>
  export type { ForecastFields, TseForecastFields };
  export function defaultForecast(): ForecastFields;
  export function buildForecast(item: Record<string, unknown> | undefined): ForecastFields;
  export function buildTseForecast(item: Record<string, unknown> | undefined): TseForecastFields | null;
  export async function queryTaisyakuMarginRows(ticker: string, ascending: boolean): Promise<Record<string, unknown>[]>;
  ```
  `abolitionNotice`はAPIのレスポンスに無い項目なので`detail`の外に置く(設計書の「APIのレスポンスは変えない」を守るため)。

- [ ] **Step 1: 失敗するテストを書く**(`test/yutai-forecast-detail.test.ts`)

  DynamoDBのモックは`test/reference-api.test.ts`と同じ書き方にする(`jest.mock('@aws-sdk/lib-dynamodb', ...)`で`DynamoDBDocumentClient.from`が`{ send: mockSend }`を返す。`GetCommand`/`QueryCommand`は入力をそのまま返す)。環境変数`YUTAI_MASTER_TABLE_NAME`等を`require`の前に設定する。

  ```ts
  test('returns null when the ticker is not in the yutai master', async () => {
    mockSend.mockResolvedValueOnce({}); // master Get
    await expect(loadYutaiForecastDetail('0000')).resolves.toBeNull();
  });

  test('returns the API body and the abolition notice from the master row', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { ticker: '1234', companyName: 'テスト', content: 'QUO', value: 1000, unitShares: 100,
        requiredShares: 100, rightsMonths: [3], maxGyakuhibu: 500, closePrice: 1500,
        abolitionNotice: { disclosedAt: '2026-10-13', title: '株主優待制度の廃止に関するお知らせ' } } })
      .mockResolvedValueOnce({ Item: { ticker: '1234', forecastStatus: 'safe', tickerSamples: 3, poolSamples: 10 } }) // forecast
      .mockResolvedValueOnce({ Item: { ticker: '_POOL_', bins: [{ label: 'a' }] } }) // pool
      .mockResolvedValueOnce({ Items: [{ rightsDate: '2026-03-27', financingBalance: 100, lendingBalance: 200, avgRate: 1, days: 1 }] }) // actual
      .mockResolvedValueOnce({ Items: [] }); // margin
    const result = await loadYutaiForecastDetail('1234');
    expect(result?.abolitionNotice).toEqual({ disclosedAt: '2026-10-13', title: '株主優待制度の廃止に関するお知らせ' });
    expect(result?.detail.ticker).toBe('1234');
    expect(result?.detail.forecast.forecastStatus).toBe('safe');
    expect(result?.detail.poolBins).toEqual([{ label: 'a' }]);
    expect(result?.detail.history).toHaveLength(1);
    expect(result?.detail).not.toHaveProperty('abolitionNotice');
  });

  test('abolitionNotice is null when the master row has none', async () => {
    mockSend.mockResolvedValueOnce({ Item: { ticker: '1234', content: 'QUO', unitShares: 100, rightsMonths: [3] } });
    // 残りの呼び出しはbeforeEachのmockResolvedValue({})に任せる
    const result = await loadYutaiForecastDetail('1234');
    expect(result?.abolitionNotice).toBeNull();
  });
  ```

- [ ] **Step 2: 失敗を確認** — `npx jest test/yutai-forecast-detail.test.ts`。モジュールが無いので失敗する。

- [ ] **Step 3: 実装**

  `lambda/reference-api/index.ts`から次をそのまま(コメントも含めて)`lambda/shared/yutai-forecast-detail.ts`へ移し、`export`を付ける: `ForecastFields`, `defaultForecast`, `buildForecast`, `TseForecastFields`, `buildTseForecast`, `MARGIN_TREND_RANGE_DAYS`, `queryTaisyakuMarginRows`、そして`getYutaiForecast`の本体。

  - 共有モジュールは自分で`DynamoDBDocumentClient.from(new DynamoDBClient({}))`を作る。
  - テーブル名は`process.env`を**関数の中で**読む(モジュール読み込み時に読まない。読み込み順に依存しないため)。
  - 優待マスタ行は`GetCommand`で取り、`getYutaiForecast`が使う項目だけを`toYutaiMasterRow`と同じ既定値で読む: `companyName ?? null`は出力時、`value ?? null`, `requiredShares ?? null`, `maxGyakuhibu ?? null`, `closePrice ?? null`, `rightsMonths ?? []`, `abolitionNotice ?? null`。`unitShares`と`content`はそのまま。
  - DynamoDBの呼び出し順は今と同じ(master get → forecast get → `_POOL_` get → actual query → margin query)。既存テストが`mockResolvedValueOnce`の順に依存している。
  - 戻り値は`{ detail: <今のjsonResponse(200, …)に渡しているオブジェクト>, abolitionNotice }`。マスタに無ければ`null`。

  `reference-api`側:

  ```ts
  import { buildForecast, loadYutaiForecastDetail, queryTaisyakuMarginRows } from '../shared/yutai-forecast-detail';

  async function getYutaiForecast(ticker: string): Promise<APIGatewayProxyResultV2> {
    const result = await loadYutaiForecastDetail(ticker);
    if (!result) return jsonResponse(404, { message: `Unknown yutai ticker: ${ticker}` });
    return jsonResponse(200, result.detail);
  }
  ```

  使わなくなった`import`(`excessRatio`, `fillRatio`など)は消す。`listYutaiForecast`の`buildForecast`/`buildTseForecast`呼び出しと`getMarginTrend`の`queryTaisyakuMarginRows`呼び出しは共有モジュールのものを使う。

- [ ] **Step 4: テストを流す** — `npx jest test/yutai-forecast-detail.test.ts test/reference-api.test.ts`。両方とも成功すること。`test/reference-api.test.ts`は**一切変更しない**(切り出し前後でレスポンスが同じことの確認になる)。`npx tsc --noEmit -p .`も通すこと。

- [ ] **Step 5: コミット**

  ```bash
  git add lambda/shared/yutai-forecast-detail.ts lambda/reference-api/index.ts test/yutai-forecast-detail.test.ts
  git commit -m "Move the yutai forecast detail assembly into a shared module"
  ```

---

### Task 2: MCPの認証とOAuthメタデータ

**Files:**
- Modify: `package.json`, `package-lock.json`(`aws-jwt-verify`を`dependencies`に追加)
- Create: `lambda/mcp-server/auth.ts`, `lambda/mcp-server/metadata.ts`
- Test: `test/mcp-server.test.ts`(新規。Task 3でも追記する)

**Interfaces:**
- Produces(Task 3が使う):
  ```ts
  // auth.ts
  export interface TokenVerifier { verify(token: string): Promise<{ sub: string }> }
  export type AuthResult = { ok: true; sub: string } | { ok: false; statusCode: 401 | 403; headers: Record<string, string>; message: string };
  export function parseAllowedSubs(raw: string | undefined): Set<string>;
  export async function authorize(
    authorizationHeader: string | undefined, apiBase: string, verifier: TokenVerifier, allowedSubs: Set<string>,
  ): Promise<AuthResult>;
  // metadata.ts
  export interface CognitoSettings { region: string; userPoolId: string; domainUrl: string }
  export function protectedResourceMetadata(apiBase: string): Record<string, unknown>;
  export function authorizationServerMetadata(apiBase: string, cognito: CognitoSettings): Record<string, unknown>;
  ```

- [ ] **Step 1: 依存を追加** — `npm install aws-jwt-verify`(`dependencies`に入ること)。esbuildがLambdaに束ねるので`externalModules`の変更は不要。

- [ ] **Step 2: 失敗するテストを書く**(`test/mcp-server.test.ts`)

  ```ts
  import { authorize, parseAllowedSubs } from '../lambda/mcp-server/auth';
  import { authorizationServerMetadata, protectedResourceMetadata } from '../lambda/mcp-server/metadata';

  const API = 'https://abc.execute-api.ap-northeast-1.amazonaws.com';
  const okVerifier = { verify: jest.fn(async () => ({ sub: 'me' })) };
  const badVerifier = { verify: jest.fn(async () => { throw new Error('JwtExpiredError'); }) };

  describe('authorize', () => {
    test('401 with resource_metadata when the header is missing', async () => {
      const r = await authorize(undefined, API, okVerifier, new Set(['me']));
      expect(r).toEqual({ ok: false, statusCode: 401, message: expect.any(String),
        headers: { 'WWW-Authenticate': `Bearer resource_metadata="${API}/.well-known/oauth-protected-resource"` } });
    });
    test('401 when the header is not a Bearer token', async () => {
      expect((await authorize('Basic xyz', API, okVerifier, new Set(['me']))).ok).toBe(false);
    });
    test('401 when the verifier rejects the token (bad signature, expired, other client)', async () => {
      const r = await authorize('Bearer t', API, badVerifier, new Set(['me']));
      expect(r.ok === false && r.statusCode).toBe(401);
    });
    test('403 when the sub is not allowed', async () => {
      const r = await authorize('Bearer t', API, okVerifier, new Set(['someone-else']));
      expect(r.ok === false && r.statusCode).toBe(403);
    });
    test('403 for everyone when the allow list is empty', async () => {
      const r = await authorize('Bearer t', API, okVerifier, parseAllowedSubs(''));
      expect(r.ok === false && r.statusCode).toBe(403);
    });
    test('ok with the sub when allowed', async () => {
      await expect(authorize('Bearer t', API, okVerifier, new Set(['me']))).resolves.toEqual({ ok: true, sub: 'me' });
    });
  });

  test('parseAllowedSubs trims, drops blanks and the placeholder "none"', () => {
    expect([...parseAllowedSubs(' a , ,b ')]).toEqual(['a', 'b']);
    expect(parseAllowedSubs(undefined).size).toBe(0);
    expect(parseAllowedSubs('none').size).toBe(0);
  });

  test('protected resource metadata points at the API as the authorization server', () => {
    expect(protectedResourceMetadata(API)).toEqual({
      resource: `${API}/mcp`,
      authorization_servers: [API],
      scopes_supported: ['openid', 'email'],
      bearer_methods_supported: ['header'],
    });
  });

  test('authorization server metadata forwards to Cognito and requires S256', () => {
    const m = authorizationServerMetadata(API, {
      region: 'ap-northeast-1', userPoolId: 'ap-northeast-1_X', domainUrl: 'https://d.auth.ap-northeast-1.amazoncognito.com',
    });
    expect(m).toEqual({
      issuer: API,
      authorization_endpoint: 'https://d.auth.ap-northeast-1.amazoncognito.com/oauth2/authorize',
      token_endpoint: 'https://d.auth.ap-northeast-1.amazoncognito.com/oauth2/token',
      revocation_endpoint: 'https://d.auth.ap-northeast-1.amazoncognito.com/oauth2/revoke',
      jwks_uri: 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_X/.well-known/jwks.json',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      scopes_supported: ['openid', 'email'],
    });
  });
  ```

- [ ] **Step 3: 失敗を確認** — `npx jest test/mcp-server.test.ts`

- [ ] **Step 4: 実装**

  `auth.ts`:
  ```ts
  // claude.aiのMCPコネクタ用の認証。API GatewayのJWTオーソライザーは401に
  // WWW-Authenticate(resource_metadata)を付けられず、MCPのOAuth検出が始まらないため、Lambda内で検証する。
  export interface TokenVerifier { verify(token: string): Promise<{ sub: string }> }
  export type AuthResult =
    | { ok: true; sub: string }
    | { ok: false; statusCode: 401 | 403; headers: Record<string, string>; message: string };

  // SSMのStringパラメータは空にできないので、未設定の意味で'none'を置く。
  export function parseAllowedSubs(raw: string | undefined): Set<string> {
    return new Set((raw ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '' && s !== 'none'));
  }

  export async function authorize(authorizationHeader: string | undefined, apiBase: string,
    verifier: TokenVerifier, allowedSubs: Set<string>): Promise<AuthResult> {
    const unauthorized: AuthResult = { ok: false, statusCode: 401, message: 'Unauthorized',
      headers: { 'WWW-Authenticate': `Bearer resource_metadata="${apiBase}/.well-known/oauth-protected-resource"` } };
    const match = /^Bearer\s+(\S+)$/i.exec(authorizationHeader ?? '');
    if (!match) return unauthorized;
    let sub: string;
    try {
      sub = (await verifier.verify(match[1])).sub;
    } catch {
      return unauthorized;
    }
    // 許可リストが空なら誰も通さない(フェイルクローズ)。データ規約上、本人だけに限る。
    if (!allowedSubs.has(sub)) return { ok: false, statusCode: 403, headers: {}, message: 'Forbidden' };
    return { ok: true, sub };
  }
  ```

  `metadata.ts`はテストの期待値どおりのオブジェクトを返す2関数。`protectedResourceMetadata`はRFC 9728、`authorizationServerMetadata`はRFC 8414。CognitoはDynamic Client Registrationに対応しないので`registration_endpoint`は載せない(claude.ai側でクライアントIDとシークレットを手入力する)とコメントに書く。

- [ ] **Step 5: テストを流す** — `npx jest test/mcp-server.test.ts`、`npx tsc --noEmit -p .`

- [ ] **Step 6: コミット**

  ```bash
  git add package.json package-lock.json lambda/mcp-server/auth.ts lambda/mcp-server/metadata.ts test/mcp-server.test.ts
  git commit -m "Add bearer token checks and OAuth metadata for the gyakuhibu MCP server"
  ```

---

### Task 3: MCPのツールとJSON-RPCハンドラ

**Files:**
- Create: `lambda/mcp-server/tool.ts`, `lambda/mcp-server/index.ts`
- Test: `test/mcp-server.test.ts`(追記)

**Interfaces:**
- Consumes: Task 1の`loadYutaiForecastDetail`、Task 2の`authorize`/`parseAllowedSubs`/`TokenVerifier`/メタデータ関数。
- Produces(Task 4が使う): `lambda/mcp-server/index.ts`の`handler`。環境変数`USER_POOL_ID`, `MCP_CLIENT_ID`, `COGNITO_DOMAIN_URL`, `MCP_ALLOWED_SUBS`と、共有モジュールが読むテーブル名4つ(`YUTAI_MASTER_TABLE_NAME`, `GYAKUHIBU_FORECAST_TABLE_NAME`, `GYAKUHIBU_ACTUAL_TABLE_NAME`, `MARGIN_BALANCE_TABLE_NAME`)。ルートキーは`POST /mcp`, `GET /mcp`, `GET /.well-known/oauth-protected-resource`, `GET /.well-known/oauth-protected-resource/mcp`, `GET /.well-known/oauth-authorization-server`, `GET /.well-known/openid-configuration`。テスト用に`export function setTokenVerifierForTest(v: TokenVerifier | null): void`。

- [ ] **Step 1: 失敗するテストを書く**(`test/mcp-server.test.ts`に追記)

  - `jest.mock('../lambda/shared/yutai-forecast-detail', () => ({ loadYutaiForecastDetail: jest.fn() }))`で共有モジュールを差し替える。
  - `process.env.MCP_ALLOWED_SUBS = 'me'`、`USER_POOL_ID`, `MCP_CLIENT_ID`, `COGNITO_DOMAIN_URL`, `AWS_REGION='ap-northeast-1'`を`require`の前に設定。
  - `setTokenVerifierForTest({ verify: async (t) => { if (t === 'good') return { sub: 'me' }; if (t === 'other') return { sub: 'x' }; throw new Error('bad'); } })`。
  - イベントは`{ routeKey, rawPath, headers: { authorization: 'Bearer good' }, body, isBase64Encoded: false, requestContext: { domainName: 'abc.execute-api.ap-northeast-1.amazonaws.com' } }`。

  テストケース(それぞれ1つの`test`):
  1. `initialize` → 200、`content-type: application/json`、`result.protocolVersion`はクライアントが送った`'2025-06-18'`をそのまま返す。未知のバージョン(`'1999-01-01'`)なら`'2025-06-18'`。`result.capabilities`は`{ tools: {} }`、`result.serverInfo.name`は`'j-quants-gyakuhibu'`。`Mcp-Session-Id`ヘッダーを返さない。
  2. `notifications/initialized`(`id`無し) → 202、ボディ空。
  3. `ping` → `result: {}`。
  4. `tools/list` → ツール1本、`name: 'get_gyakuhibu_forecast'`、`inputSchema.required: ['ticker']`。
  5. 未知メソッド → `error.code: -32601`。
  6. 不正なJSON → 400、`error.code: -32700`、`id: null`。配列(バッチ) → `error.code: -32600`。
  7. `GET /mcp` → 405、`Allow: POST`。
  8. Authorizationヘッダー無しの`POST /mcp` → 401、`www-authenticate`に`resource_metadata="https://abc.execute-api.ap-northeast-1.amazonaws.com/.well-known/oauth-protected-resource"`。`Bearer other` → 403。
  9. `GET /.well-known/oauth-protected-resource`と`.../mcp`付き → 200、認証無しで`resource`が`https://abc…/mcp`。`GET /.well-known/oauth-authorization-server`と`/.well-known/openid-configuration` → 200、`issuer`が`https://abc…`。
  10. `tools/call`正常: `loadYutaiForecastDetail`が`{ detail: {…, history: 12件, poolBins: [...], marginTrend: { latest: {...} } }, abolitionNotice: {...} }`を返す → `result.isError`が無く、`JSON.parse(result.content[0].text)`が`history`10件(先頭は元の先頭と同じ)、`poolBins`を含まない、`abolitionNotice`を含む、`marginTrend.latest`を含む。`loadYutaiForecastDetail`が`' 1234 '`ではなく`'1234'`で呼ばれる(前後の空白を除く)。
  11. `tools/call`でマスタに無い銘柄(`loadYutaiForecastDetail`が`null`) → `result.isError: true`、本文に`優待マスタに無い銘柄です`。
  12. `tools/call`で`ticker`が不正(`'12'`、数値、未指定) → `result.isError: true`。
  13. `tools/call`で`forecast.forecastStatus: 'general-only'` → `isError`無しの通常の結果。
  14. `tools/call`で未知のツール名 → `error.code: -32602`。
  15. 認証を通ったリクエストで`console.log`に`{ event: 'mcp-access', sub: 'me', method: 'tools/call', tool: 'get_gyakuhibu_forecast' }`が出る(`jest.spyOn(console, 'log')`)。

- [ ] **Step 2: 失敗を確認** — `npx jest test/mcp-server.test.ts`

- [ ] **Step 3: 実装 `tool.ts`**

  ```ts
  import { loadYutaiForecastDetail } from '../shared/yutai-forecast-detail';

  export const GYAKUHIBU_TOOL = {
    name: 'get_gyakuhibu_forecast',
    title: '逆日歩予測(銘柄別)',
    description: [
      '優待クロス(制度信用の売り+現物買い)で、次の権利日にかかりそうな逆日歩を銘柄ごとに返す。',
      '金額はすべて「必要株数(requiredShares)あたりの円」。確率は0〜1。',
      'forecastStatus: safe=最悪ケース(P90)でも逆日歩は最大逆日歩の20%未満 / caution=20%以上50%未満 / danger=50%以上 /',
      'general-only=制度信用で売れない銘柄(逆日歩は発生しないが、クロスは一般信用でしか組めない) / na=実績が無く予測できない。',
      'forecast: 過去権利日の需給ベースの予測。pOccur=逆日歩の発生確率、forecastP50/P90/Mean=想定逆日歩(中央値/最悪/平均)、',
      'expectedNet=優待価値(value)-想定逆日歩の平均、tickerSamples/poolSamples=予測に使った銘柄自身/全銘柄のサンプル数。',
      'tseForecast: 現在の東証の信用残(snapshotDate時点)を使った予測。無ければnull。',
      'history: 過去の権利日の実績(新しい順、最大10件)。occurred=falseはその権利日に逆日歩が出なかったことを表す。',
      'abolitionNotice: 優待制度の廃止予告(開示日とタイトル)。nullでなければ、最後の権利日を開示で確認するよう利用者に伝えること。',
      'maxGyakuhibu: 最大逆日歩(必要株数あたりの円)。',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: { ticker: { type: 'string', description: '銘柄コード(4桁。例: 7203, 130A)' } },
      required: ['ticker'],
      additionalProperties: false,
    },
  } as const;

  export interface ToolResult { content: { type: 'text'; text: string }[]; isError?: true }

  const errorResult = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

  export async function callGyakuhibuForecast(args: unknown): Promise<ToolResult> {
    const raw = (args as { ticker?: unknown } | undefined)?.ticker;
    const ticker = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
    if (!/^[0-9][0-9A-Z]{3}$/.test(ticker)) return errorResult('銘柄コードは4桁で指定してください(例: 7203)。');
    const result = await loadYutaiForecastDetail(ticker);
    if (!result) return errorResult(`優待マスタに無い銘柄です: ${ticker}`);
    const { detail, abolitionNotice } = result;
    const output = {
      ticker: detail.ticker, companyName: detail.companyName, content: detail.content, value: detail.value,
      requiredShares: detail.requiredShares, unitShares: detail.unitShares, rightsDate: detail.rightsDate,
      closePrice: detail.closePrice, maxGyakuhibu: detail.maxGyakuhibu, abolitionNotice,
      forecast: detail.forecast, tseForecast: detail.tseForecast,
      history: detail.history.slice(0, 10), // 共有モジュールは新しい順で返す
      marginTrend: { latest: detail.marginTrend.latest },
      // poolBinsは画面のグラフ用で大きく、会話には要らないので返さない
    };
    return { content: [{ type: 'text', text: JSON.stringify(output) }] };
  }
  ```

- [ ] **Step 4: 実装 `index.ts`**

  - ルーティングは`event.routeKey`で分ける(上のInterfacesの6つ。それ以外は404)。
  - `apiBase = \`https://${event.requestContext.domainName}\``。
  - メタデータ系は認証無しで`200`・`application/json`。
  - `GET /mcp` → `405`、ヘッダー`Allow: POST`、ボディ無し。
  - `POST /mcp`: `authorize(event.headers?.authorization, apiBase, verifier, parseAllowedSubs(process.env.MCP_ALLOWED_SUBS))`。失敗は`statusCode`・`headers`・`{ error: message }`で返す。
  - ボディ(`isBase64Encoded`ならデコード)を`JSON.parse`。失敗は400 + `{ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }`。配列やオブジェクトでないものは`-32600`(MCP 2025-06-18でバッチは廃止)。
  - `id`が無い(通知) → 202・空ボディ。
  - `initialize`: `SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']`。クライアントの`params.protocolVersion`が含まれればそれを、無ければ`'2025-06-18'`。`{ protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'j-quants-gyakuhibu', version: '1.0.0' } }`。
  - `ping` → `{}`。`tools/list` → `{ tools: [GYAKUHIBU_TOOL] }`。`tools/call` → 名前が`get_gyakuhibu_forecast`なら`callGyakuhibuForecast(params.arguments)`、違えば`-32602`。ツール内で例外が出たら`-32603`(内部エラー)とし、`console.error`に出す。
  - 認証を通ったら`console.log(JSON.stringify({ event: 'mcp-access', sub, method, tool }))`(`tool`は`tools/call`のときだけ)。
  - 検証器は遅延生成し、`setTokenVerifierForTest`で差し替えられるようにする:
    ```ts
    import { CognitoJwtVerifier } from 'aws-jwt-verify';
    let verifier: TokenVerifier | null = null;
    export function setTokenVerifierForTest(v: TokenVerifier | null): void { verifier = v; }
    function getVerifier(): TokenVerifier {
      if (!verifier) {
        const v = CognitoJwtVerifier.create({ userPoolId: process.env.USER_POOL_ID!, tokenUse: 'access', clientId: process.env.MCP_CLIENT_ID! });
        verifier = { verify: async (t) => ({ sub: (await v.verify(t)).sub }) };
      }
      return verifier;
    }
    ```
  - レスポンスヘッダーは常に`content-type: application/json`(202と405を除く)。

- [ ] **Step 5: テストを流す** — `npx jest test/mcp-server.test.ts`、`npx tsc --noEmit -p .`

- [ ] **Step 6: コミット**

  ```bash
  git add lambda/mcp-server/tool.ts lambda/mcp-server/index.ts test/mcp-server.test.ts
  git commit -m "Add the stateless MCP handler with the get_gyakuhibu_forecast tool"
  ```

---

### Task 4: CDK(Cognitoクライアント・Lambda・ルート)とREADME

**Files:**
- Modify: `lib/j-quants-stack.ts`, `test/j-quants.test.ts`, `README.md`

**Interfaces:**
- Consumes: Task 3の`handler`と環境変数名・ルートキー。

- [ ] **Step 1: 失敗するテストを書く**(`test/j-quants.test.ts`の`describe('Cognito user authentication')`の中、同じ`template`を使う)

  - 既存の`'every API route is protected by the Cognito JWT authorizer'`を置き換える:
    ```ts
    const MCP_ROUTE_KEYS = [
      'POST /mcp', 'GET /mcp',
      'GET /.well-known/oauth-protected-resource', 'GET /.well-known/oauth-protected-resource/mcp',
      'GET /.well-known/oauth-authorization-server', 'GET /.well-known/openid-configuration',
    ];
    test('only the MCP and OAuth metadata routes skip the JWT authorizer', () => {
      const routes = Object.values(template.findResources('AWS::ApiGatewayV2::Route')).map(
        (r) => (r as { Properties: { RouteKey: string; AuthorizationType?: string; AuthorizerId?: unknown } }).Properties);
      const open = routes.filter((p) => p.AuthorizationType !== 'JWT').map((p) => p.RouteKey).sort();
      expect(open).toEqual([...MCP_ROUTE_KEYS].sort());
      for (const p of routes.filter((r) => !MCP_ROUTE_KEYS.includes(r.RouteKey))) {
        expect(p.AuthorizationType).toBe('JWT');
        expect(p.AuthorizerId).toBeDefined();
      }
    });
    ```
  - MCPクライアント:
    ```ts
    test('the Claude MCP client has a secret, the code flow, and the claude.ai callbacks', () => {
      template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
        ClientName: 'JQuantsClaudeMcpClient',
        GenerateSecret: true,
        AllowedOAuthFlows: ['code'],
        AllowedOAuthFlowsUserPoolClient: true,
        AllowedOAuthScopes: Match.arrayWith(['openid', 'email']),
        CallbackURLs: ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'],
        EnableTokenRevocation: true,
        PreventUserExistenceErrors: 'ENABLED',
      });
      // ブランディングはクライアントごとに要る(無いとログイン画面が出ない)
      template.resourceCountIs('AWS::Cognito::ManagedLoginBranding', 2);
    });
    ```
    既存の`'the SPA client uses ...'`テストの`hasResourceProperties`は`GenerateSecret: false`で絞られているのでそのまま通る。`callbackJson`の確認も変わらない。
  - MCP Lambda:
    ```ts
    test('the MCP Lambda gets the Cognito settings and the allowed subs from SSM', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: { Variables: Match.objectLike({
          USER_POOL_ID: Match.anyValue(), MCP_CLIENT_ID: Match.anyValue(), COGNITO_DOMAIN_URL: Match.anyValue(),
          MCP_ALLOWED_SUBS: Match.anyValue(), YUTAI_MASTER_TABLE_NAME: Match.anyValue(),
          GYAKUHIBU_FORECAST_TABLE_NAME: Match.anyValue(), GYAKUHIBU_ACTUAL_TABLE_NAME: Match.anyValue(),
          MARGIN_BALANCE_TABLE_NAME: Match.anyValue(),
        }) },
      });
      const params = template.findParameters('*');
      expect(JSON.stringify(params)).toContain('/j-quants/mcp-allowed-subs');
    });
    test('outputs the MCP endpoint and client id', () => {
      expect(Object.keys(template.findOutputs('*'))).toEqual(expect.arrayContaining(['McpEndpoint', 'McpClientId']));
    });
    ```

- [ ] **Step 2: 失敗を確認** — `npx jest test/j-quants.test.ts -t "Cognito user authentication"`

- [ ] **Step 3: 実装**(`lib/j-quants-stack.ts`)

  - 先頭: `export const MCP_ALLOWED_SUBS_PARAMETER_NAME = '/j-quants/mcp-allowed-subs';`(`ALERT_EMAIL_PARAMETER_NAME`の隣)。
  - Webクライアントのブランディングの後に:
    ```ts
    // claude.aiのカスタムコネクタ(逆日歩予測MCP)用。claude.aiはサーバー側でトークン交換するので
    // シークレットありのconfidentialクライアントにする。CognitoはDynamic Client Registration非対応のため、
    // クライアントIDとシークレットはコネクタの詳細設定に手で入れる。
    const mcpClient = this.userPool.addClient('JQuantsClaudeMcpClient', {
      userPoolClientName: 'JQuantsClaudeMcpClient',
      generateSecret: true,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'],
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(7),
      enableTokenRevocation: true,
      preventUserExistenceErrors: true,
    });
    new cognito.CfnManagedLoginBranding(this, 'JQuantsClaudeMcpManagedLoginBranding', {
      userPoolId: this.userPool.userPoolId,
      clientId: mcpClient.userPoolClientId,
      useCognitoProvidedValues: true,
    });
    ```
  - MCP Lambda(`referenceApiFn`と同じ形):
    ```ts
    const cognitoDomainUrl = `https://${COGNITO_DOMAIN_PREFIX}.auth.${cdk.Aws.REGION}.amazoncognito.com`;
    const mcpServerFn = new nodejs.NodejsFunction(this, 'McpServerFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'mcp-server', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      bundling: { externalModules: ['@aws-sdk/*'] },
      environment: {
        USER_POOL_ID: this.userPool.userPoolId,
        MCP_CLIENT_ID: mcpClient.userPoolClientId,
        COGNITO_DOMAIN_URL: cognitoDomainUrl,
        // 自分のCognito subだけを通す(データ規約上、個人利用に限るため)。カンマ区切り。'none'なら誰も通さない。
        MCP_ALLOWED_SUBS: ssm.StringParameter.valueForStringParameter(this, MCP_ALLOWED_SUBS_PARAMETER_NAME),
        YUTAI_MASTER_TABLE_NAME: this.yutaiMasterTable.tableName,
        GYAKUHIBU_FORECAST_TABLE_NAME: this.gyakuhibuForecastTable.tableName,
        GYAKUHIBU_ACTUAL_TABLE_NAME: this.gyakuhibuActualTable.tableName,
        MARGIN_BALANCE_TABLE_NAME: this.marginBalanceTable.tableName,
      },
    });
    this.yutaiMasterTable.grantReadData(mcpServerFn);
    this.gyakuhibuForecastTable.grantReadData(mcpServerFn);
    this.gyakuhibuActualTable.grantReadData(mcpServerFn);
    this.marginBalanceTable.grantReadData(mcpServerFn);
    const mcpIntegration = new HttpLambdaIntegration('McpServerIntegration', mcpServerFn);
    ```
  - 既存ルートの後に(`HttpNoneAuthorizer`は`aws-cdk-lib/aws-apigatewayv2`の`apigwv2.HttpNoneAuthorizer`):
    ```ts
    // MCPとOAuthメタデータはオーソライザー無し。認証はLambda内で行う(JWTオーソライザーは401に
    // WWW-Authenticateを付けられず、claude.aiのOAuth検出が始まらないため)。
    const noAuth = new apigwv2.HttpNoneAuthorizer();
    this.api.addRoutes({ path: '/mcp', methods: [apigwv2.HttpMethod.POST, apigwv2.HttpMethod.GET], integration: mcpIntegration, authorizer: noAuth });
    for (const metadataPath of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-authorization-server',
      '/.well-known/openid-configuration',
    ]) {
      this.api.addRoutes({ path: metadataPath, methods: [apigwv2.HttpMethod.GET], integration: mcpIntegration, authorizer: noAuth });
    }
    ```
  - 出力:
    ```ts
    new cdk.CfnOutput(this, 'McpEndpoint', { value: `${this.api.apiEndpoint}/mcp` });
    new cdk.CfnOutput(this, 'McpClientId', { value: mcpClient.userPoolClientId });
    ```
  - `CognitoDomain`出力の値を`cognitoDomainUrl`に置き換えて重複をなくす(値は同じ)。

- [ ] **Step 4: README**

  「## 認証モデル」の下に「### claude.aiから逆日歩予測を使う(MCP)」を足す。内容:
  - 何ができるか(ツール1本、自分のsubだけ)。
  - 初回の準備:
    1. 自分のsubを調べる: `aws cognito-idp list-users --user-pool-id <UserPoolId> --filter 'email = "<自分のメール>"' --query 'Users[].Attributes[?Name==\`sub\`].Value' --output text`
    2. 許可リストを置く(デプロイ前に必須。無いとデプロイが失敗する): `aws ssm put-parameter --name /j-quants/mcp-allowed-subs --type String --value <sub> --overwrite`。止めたいときは`--value none`にして`npx cdk deploy`。
    3. `npx cdk deploy`
    4. シークレットを取り出す: `aws cognito-idp describe-user-pool-client --user-pool-id <UserPoolId> --client-id <McpClientId> --query UserPoolClient.ClientSecret --output text`
    5. claude.ai → 設定 → コネクタ → カスタムコネクタを追加。URLは`McpEndpoint`、詳細設定にクライアントIDとシークレット。接続するとCognitoのログイン画面が開く。
  - 変更したら`npx cdk deploy`し直す必要がある(SSMの値はデプロイ時に読む)。
  - 「### API」の節の「全ルートにCognito JWT authorizerが既定で適用される」に、MCPと`/.well-known/*`だけは例外(Lambda内で検証)と一文足す。

- [ ] **Step 5: テストを流す** — `npx jest test/j-quants.test.ts`(合成が重いので数分かかる)、`npx tsc --noEmit -p .`、`npx cdk synth > /dev/null`(SSMパラメータは合成時に要らない)。

- [ ] **Step 6: コミット**

  ```bash
  git add lib/j-quants-stack.ts test/j-quants.test.ts README.md
  git commit -m "Wire the gyakuhibu MCP server into the API with its own Cognito client"
  ```

---

## 実装後(ユーザーの承認を得てから)

1. 全テスト(`npx jest`、20分程度)。
2. SSMに自分のsubを置く → `npx cdk deploy`。
3. 疎通確認(ローカルから): `curl -i -X POST {McpEndpoint}` が401と`www-authenticate`を返すこと、`/.well-known/oauth-protected-resource`と`/.well-known/oauth-authorization-server`が200を返すこと。
4. claude.aiでコネクタを追加 → Cognitoログイン → 実在の銘柄で`get_gyakuhibu_forecast`を呼ぶ。
5. 通らなければ、CloudWatch Logsとclaude.aiのエラーから原因(メタデータの検出・`resource`パラメータをCognitoが拒否する・issuerの不一致・トークン交換の認証方式)を調べ、必要ならOAuthの仲介エンドポイントを自前で足す方針に切り替えて設計書を更新する。
