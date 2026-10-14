import { useEffect, type ReactNode } from 'react';
import { hasAuthParams, useAuth } from 'react-oidc-context';
import { authConfigError, signIn } from '../lib/auth';

// ログインしていなければCognitoのログイン画面へ送り、ログイン済みのときだけ中身を出す。
export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth();

  const needsSignIn =
    authConfigError === null &&
    !auth.isLoading &&
    !auth.isAuthenticated &&
    !auth.error &&
    !auth.activeNavigator &&
    // ログインから戻った直後(?code=&state=付き)はコード交換を待つ
    !hasAuthParams();

  useEffect(() => {
    // signIn()自体が二重実行を防ぐ(React StrictModeでeffectが2回走っても遷移は1回)
    if (needsSignIn) signIn();
  }, [needsSignIn]);

  if (authConfigError) return <GateMessage message={authConfigError} />;

  if (auth.error) {
    return (
      <GateMessage message={`ログインに失敗しました: ${auth.error.message}`}>
        <button type="button" className="btn btn--primary" style={{ marginTop: '0.75rem', width: '100%' }} onClick={signIn}>
          もう一度ログインする
        </button>
      </GateMessage>
    );
  }

  if (!auth.isAuthenticated) return <GateMessage message="ログイン画面へ移動しています…" />;

  return <>{children}</>;
}

function GateMessage({ message, children }: { message: string; children?: ReactNode }) {
  return (
    <div className="app-shell" style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div className="card" style={{ width: '22rem' }}>
        <p className="page-title" style={{ fontSize: '1.1rem' }}>
          J-Quants株価ビューア
        </p>
        <p className="page-subtitle">{message}</p>
        {children}
      </div>
    </div>
  );
}
