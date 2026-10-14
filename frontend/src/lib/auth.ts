import { UserManager, type User } from 'oidc-client-ts';
import { safeReturnPath } from './return-path';

// Cognito User Pool(Managed Login)で、認可コード+PKCEのログインを行う。
// 設計: docs/superpowers/specs/2026-10-07-cognito-auth-design.md
// トークンはoidc-client-ts既定のsessionStorage(タブごと)に置く。新しいタブでも、
// Cognito側のログイン状態が残っていればパスワード入力なしで戻ってくる。

const authority = import.meta.env.VITE_COGNITO_AUTHORITY;
const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID;
const cognitoDomain = import.meta.env.VITE_COGNITO_DOMAIN;
const redirectUri = import.meta.env.VITE_REDIRECT_URI ?? `${window.location.origin}/`;

export const authConfigError: string | null =
  !authority || !clientId || !cognitoDomain
    ? 'ログインの設定(VITE_COGNITO_AUTHORITY / VITE_COGNITO_CLIENT_ID / VITE_COGNITO_DOMAIN)がありません。frontend/.env.example を参照してください。'
    : null;

// AuthProvider(React)とclient.ts(React外)で同じインスタンスを共有する。
export const userManager = new UserManager({
  authority: authority ?? '',
  client_id: clientId ?? '',
  redirect_uri: redirectUri,
  post_logout_redirect_uri: redirectUri,
  response_type: 'code',
  scope: 'openid email',
  // リフレッシュトークンでアクセストークン(1時間)を期限前に更新する。
  automaticSilentRenew: true,
});

interface SigninState {
  returnTo: string;
}

function currentPath(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

// React StrictModeの二重実行や、複数のAPI呼び出しが同時に401になった場合でも、
// ログイン画面への遷移は1回だけにする。
let signinStarted = false;

export function signIn(): void {
  if (signinStarted) return;
  signinStarted = true;
  const state: SigninState = { returnTo: currentPath() };
  void userManager.signinRedirect({ state }).catch((error: unknown) => {
    signinStarted = false;
    console.error('signinRedirect failed', error);
  });
}

// ログインから戻った直後(AuthProviderのonSigninCallback)。URLから?code=&state=を消し、
// ログイン前のページへ戻す。stateはURL経由で往復するので、戻り先は検証してから使う。
export function onSigninCallback(user: User | void): void {
  const state = user ? (user.state as Partial<SigninState> | undefined) : undefined;
  window.history.replaceState({}, document.title, safeReturnPath(state?.returnTo));
}

export async function getAccessToken(): Promise<string | null> {
  const user = await userManager.getUser();
  if (!user || user.expired) return null;
  return user.access_token;
}

// CognitoのログアウトはOIDC標準のend_sessionと形式が違うので、signoutRedirect()は使わず、
// ローカルのトークンを消してからCognitoの/logoutへ遷移する。
export async function signOut(): Promise<void> {
  await userManager.removeUser();
  const query = new URLSearchParams({ client_id: clientId ?? '', logout_uri: redirectUri });
  window.location.assign(`${cognitoDomain}/logout?${query}`);
}
