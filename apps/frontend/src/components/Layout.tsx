import type { ReactElement } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const NAV_ITEMS = [
  { to: '/sub-wallets', label: 'Agent Sub-Wallets' },
  { to: '/approvals', label: 'Approvals' },
  { to: '/quarantine', label: 'Incoming Quarantine' },
  { to: '/audit-log', label: 'Audit Log' },
];

export function Layout(): ReactElement {
  const { identity, logout } = useAuth();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">BG</span>
          <div>
            <div className="brand-name">BitGo Agent Wallet</div>
            <div className="brand-tag">Governed autonomy</div>
          </div>
        </div>
        <nav>
          {NAV_ITEMS.map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="identity">
            <div className="identity-name">{identity?.name}</div>
            <div className={`role-badge role-${identity?.role}`}>{identity?.role}</div>
          </div>
          <button className="logout-btn" onClick={logout} type="button">
            Sign out
          </button>
        </div>
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
