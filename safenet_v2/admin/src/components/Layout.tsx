import React, { useEffect, useState } from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/auth';
import { useAdminConnectionStore } from '../stores/adminConnection';
import { connectAdminWebSocket } from '../services/admin_websocket';

const links: { to: string; label: string; icon: string }[] = [
  { to: '/', label: 'Dashboard', icon: 'D' },
  { to: '/zones', label: 'Zone heatmap', icon: 'Z' },
  { to: '/fraud', label: 'Fraud insights', icon: 'F' },
  { to: '/workers', label: 'Workers', icon: 'W' },
  { to: '/simulations', label: 'Simulations', icon: 'S' },
  { to: '/support', label: 'Support', icon: '?' },
];

export default function Layout() {
  const navigate = useNavigate();
  const signOut = useAuthStore((s) => s.signOut);
  const jwt = useAuthStore((s) => s.jwt);
  const wsStatus = useAdminConnectionStore((s) => s.status);
  const lastEventAtMs = useAdminConnectionStore((s) => s.lastEventAtMs);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 2000);
    return () => window.clearInterval(id);
  }, []);

  const lastEventSec =
    lastEventAtMs != null ? Math.max(0, Math.floor((now - lastEventAtMs) / 1000)) : null;

  useEffect(() => {
    if (!jwt) return;
    const stop = connectAdminWebSocket(jwt);
    return () => stop();
  }, [jwt]);

  const logout = () => {
    signOut();
    navigate('/login');
  };

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <div className="admin-sidebar-brand">
          <div className="admin-brand-row">
            <span className="admin-brand-icon" aria-hidden>S</span>
            <div>
              <div className="admin-brand-name">SafeNet</div>
              <div className="admin-brand-sub">Operations</div>
            </div>
          </div>
          <div className="admin-ws-pill" title="Real-time connection to live events">
            <span
              className="admin-ws-dot"
              data-live={wsStatus === 'live' ? 'true' : 'false'}
              data-reconnect={wsStatus === 'reconnecting' ? 'true' : 'false'}
            />
            <div className="admin-ws-text-wrap">
              <span className="admin-ws-label">
                {wsStatus === 'live' ? 'Live' : wsStatus === 'reconnecting' ? 'Reconnecting' : 'Offline'}
              </span>
              <span className="admin-ws-sub">
                {lastEventSec != null ? `Last event ${lastEventSec}s ago` : 'Waiting for events'}
              </span>
            </div>
          </div>
        </div>

        <nav className="admin-nav">
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.to === '/'}
              className={({ isActive }) => `admin-nav-link${isActive ? ' admin-nav-link--active' : ''}`}
            >
              <span className="admin-nav-icon">{l.icon}</span>
              <span>{l.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="admin-sidebar-footer">
          <button type="button" className="admin-logout" onClick={logout}>
            Sign out
          </button>
        </div>
      </aside>

      <main className="admin-main">
        <Outlet />
      </main>

      <style>{`
        /* Lock shell to viewport: sidebar stays put; only .admin-main scrolls */
        .admin-shell {
          display: flex;
          width: 100%;
          height: 100vh;
          max-height: 100vh;
          min-height: 0;
          overflow: hidden;
          background: var(--admin-bg);
        }
        .admin-sidebar {
          width: 260px;
          min-width: 260px;
          flex-shrink: 0;
          height: 100%;
          max-height: 100%;
          background: linear-gradient(180deg, #0f172a 0%, #1e293b 52%, #0f172a 100%);
          color: #f8fafc;
          display: flex;
          flex-direction: column;
          border-right: 1px solid rgba(15, 23, 42, 0.85);
          box-shadow: 4px 0 24px rgba(15, 23, 42, 0.12);
          overflow: hidden;
        }
        .admin-sidebar-brand {
          padding: 22px 20px 20px;
          border-bottom: 1px solid var(--admin-border);
        }
        .admin-brand-row {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 16px;
        }
        .admin-brand-icon {
          width: 32px;
          height: 32px;
          border-radius: 8px;
          background: rgba(59, 130, 246, 0.22);
          color: #bfdbfe;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 14px;
          font-weight: 700;
          line-height: 1;
        }
        .admin-brand-name {
          font-weight: 800;
          font-size: 1.125rem;
          letter-spacing: -0.02em;
          line-height: 1.2;
          color: #f8fafc;
        }
        .admin-brand-sub {
          font-size: 0.75rem;
          font-weight: 600;
          color: #94a3b8;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          margin-top: 2px;
        }
        .admin-ws-pill {
          display: flex;
          align-items: flex-start;
          gap: 10px;
          padding: 10px 12px;
          border-radius: 10px;
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid rgba(255, 255, 255, 0.1);
        }
        .admin-ws-dot {
          width: 8px;
          height: 8px;
          border-radius: 999px;
          margin-top: 5px;
          flex-shrink: 0;
          background: #94a3b8;
        }
        .admin-ws-dot[data-live="true"] { background: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,0.2); }
        .admin-ws-dot[data-reconnect="true"] { background: #fbbf24; }
        .admin-ws-text-wrap { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .admin-ws-label { font-size: 0.8125rem; font-weight: 700; color: #f1f5f9; }
        .admin-ws-sub { font-size: 0.6875rem; color: #94a3b8; font-weight: 600; }
        .admin-nav {
          flex: 1;
          min-height: 0;
          padding: 16px 12px;
          display: flex;
          flex-direction: column;
          gap: 4px;
          overflow-y: auto;
          overflow-x: hidden;
          -webkit-overflow-scrolling: touch;
        }
        .admin-nav-link {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px 14px;
          border-radius: 10px;
          color: #cbd5e1;
          text-decoration: none;
          font-size: 0.9375rem;
          font-weight: 600;
          transition: background 0.15s, color 0.15s, border-color 0.15s;
          border: 1px solid transparent;
          border-left: 2px solid transparent;
        }
        .admin-nav-link:hover {
          background: rgba(255, 255, 255, 0.06);
          color: #f8fafc;
        }
        .admin-nav-link--active {
          background: rgba(37, 99, 235, 0.35);
          color: #f8fafc;
          border-color: rgba(96, 165, 250, 0.35);
          border-left-color: #60a5fa;
          box-shadow: none;
        }
        .admin-nav-icon {
          width: 20px;
          height: 20px;
          border-radius: 6px;
          background: rgba(255, 255, 255, 0.08);
          color: #e2e8f0;
          font-size: 11px;
          font-weight: 700;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          text-align: center;
        }
        .admin-sidebar-footer {
          padding: 16px 12px 20px;
          border-top: 1px solid var(--admin-border);
        }
        .admin-logout {
          width: 100%;
          padding: 11px 14px;
          border-radius: 10px;
          border: 1px solid rgba(255, 255, 255, 0.14);
          background: rgba(255, 255, 255, 0.06);
          color: #f1f5f9;
          font-weight: 700;
          font-size: 0.875rem;
          cursor: pointer;
          transition: background 0.15s;
        }
        .admin-logout:hover { background: rgba(255, 255, 255, 0.1); }
        .admin-main {
          flex: 1;
          min-width: 0;
          min-height: 0;
          overflow-x: hidden;
          overflow-y: auto;
          padding: clamp(16px, 3vw, 32px);
          -webkit-overflow-scrolling: touch;
          background: var(--admin-main-tint, var(--admin-bg));
        }
        @media (max-width: 1024px) {
          .admin-shell {
            flex-direction: column;
            height: 100vh;
            max-height: 100vh;
          }
          .admin-sidebar {
            width: 100%;
            min-width: 0;
            height: auto;
            max-height: none;
            flex-shrink: 0;
            flex-direction: row;
            flex-wrap: nowrap;
            align-items: center;
            padding: 12px;
            gap: 12px;
            overflow: visible;
          }
          .admin-sidebar-brand {
            flex: 1;
            min-width: 200px;
            padding: 0;
            border: none;
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 10px;
          }
          .admin-brand-row { margin-bottom: 0; }
          .admin-ws-pill { flex: 1; min-width: 180px; max-width: 360px; }
          .admin-nav {
            flex: none;
            min-height: 0;
            flex-direction: row;
            flex-wrap: nowrap;
            padding: 0;
            width: 100%;
            order: 3;
            max-height: none;
            overflow-x: auto;
            overflow-y: hidden;
            gap: 8px;
          }
          .admin-nav-link {
            flex: 0 0 auto;
            justify-content: center;
            min-width: 140px;
            white-space: nowrap;
          }
          .admin-sidebar-footer { width: auto; padding: 0; border: none; order: 2; }
          .admin-logout { width: auto; padding: 10px 16px; }
          .admin-main {
            flex: 1;
            min-height: 0;
            max-height: none;
            padding: 16px;
          }
        }
        @media (max-width: 640px) {
          .admin-sidebar {
            flex-wrap: wrap;
          }
          .admin-sidebar-brand {
            min-width: 100%;
            justify-content: space-between;
          }
          .admin-brand-row {
            min-width: max-content;
          }
          .admin-ws-pill {
            width: 100%;
            max-width: none;
          }
          .admin-logout {
            width: 100%;
          }
          .admin-sidebar-footer {
            width: 100%;
            order: 4;
          }
          .admin-nav-link {
            min-width: 132px;
          }
        }
      `}</style>
    </div>
  );
}
