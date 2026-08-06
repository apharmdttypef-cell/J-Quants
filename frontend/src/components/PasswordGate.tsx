import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  APP_PASSWORD_INVALID_EVENT,
  getStoredAppPassword,
  setStoredAppPassword,
} from '../lib/appPassword';

interface PasswordGateProps {
  children: ReactNode;
}

export function PasswordGate({ children }: PasswordGateProps) {
  const [password, setPassword] = useState<string | null>(() => getStoredAppPassword());
  const [input, setInput] = useState('');

  useEffect(() => {
    const onInvalid = () => setPassword(null);
    window.addEventListener(APP_PASSWORD_INVALID_EVENT, onInvalid);
    return () => window.removeEventListener(APP_PASSWORD_INVALID_EVENT, onInvalid);
  }, []);

  if (password) {
    return <>{children}</>;
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (input.length === 0) return;
    setStoredAppPassword(input);
    setPassword(input);
  }

  return (
    <div className="app-shell" style={{ alignItems: 'center', justifyContent: 'center' }}>
      <form className="card" style={{ width: '20rem' }} onSubmit={handleSubmit}>
        <p className="page-title" style={{ fontSize: '1.1rem' }}>
          J-Quants株価ビューア
        </p>
        <p className="page-subtitle">パスワードを入力してください</p>
        <input
          className="input"
          style={{ width: '100%' }}
          type="password"
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button type="submit" className="btn btn--primary" style={{ marginTop: '0.75rem', width: '100%' }}>
          入る
        </button>
      </form>
    </div>
  );
}
