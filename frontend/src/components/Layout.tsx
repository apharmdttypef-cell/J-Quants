import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from 'react-oidc-context';
import { signOut } from '../lib/auth';

const NAV_ITEMS = [
  { to: '/yutai', label: '優待クロス', end: true },
  { to: '/yutai/tdnet-events', label: '優待変更履歴' },
];

export function Layout() {
  const auth = useAuth();
  const email = auth.user?.profile.email;

  return (
    <div className="app-shell">
      <nav className="app-nav">
        <span className="app-nav__brand">J-Quants株価ビューア</span>
        <div className="app-nav__links">
          {NAV_ITEMS.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end}>
              {item.label}
            </NavLink>
          ))}
        </div>
        <div className="app-nav__user">
          {email && <span className="app-nav__email">{email}</span>}
          <button type="button" className="btn" onClick={() => void signOut()}>
            ログアウト
          </button>
        </div>
      </nav>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
