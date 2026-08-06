import { NavLink, Outlet } from 'react-router-dom';

const NAV_ITEMS = [
  { to: '/', label: '銘柄一覧', end: true },
  { to: '/screening', label: 'スクリーニング' },
  { to: '/watchlist', label: 'ウォッチリスト管理' },
];

export function Layout() {
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
      </nav>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
