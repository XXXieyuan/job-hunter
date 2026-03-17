import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import './AppLayout.css';

interface Props {
  children: React.ReactNode;
}

export const AppLayout: React.FC<Props> = ({ children }) => {
  const location = useLocation();

  const navItems = [
    { to: '/jobs', label: 'Jobs' },
    { to: '/scraper', label: 'Scraper' },
    { to: '/resumes', label: 'Resumes' },
    { to: '/match', label: 'Match' }
  ];

  return (
    <div className="layout-root">
      <aside className="layout-sidebar">
        <div className="layout-logo">Job Hunter</div>
        <nav className="layout-nav">
          {navItems.map((item) => {
            const isActive = location.pathname.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                className={isActive ? 'layout-nav-item active' : 'layout-nav-item'}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>
      <div className="layout-main">
        <header className="layout-topbar">
          <div className="layout-topbar-title">Job Hunter</div>
          <div className="layout-topbar-user">User #1</div>
        </header>
        <main className="layout-content">{children}</main>
      </div>
    </div>
  );
};

