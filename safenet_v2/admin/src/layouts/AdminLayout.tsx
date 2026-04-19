import React, { useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Map,
  FileText,
  Users,
  ShieldAlert,
  TrendingUp,
  Zap,
  MessageSquare,
} from 'lucide-react';

import { useAuthStore } from '../stores/auth';
import { useAdminConnectionStore } from '../stores/adminConnection';
import { connectAdminWebSocket } from '../services/admin_websocket';

const ROUTE_TITLES: { prefix: string; title: string }[] = [
  { prefix: '/zones', title: 'Zone Map' },
  { prefix: '/claims', title: 'Claims' },
  { prefix: '/workers', title: 'Workers' },
  { prefix: '/fraud', title: 'Fraud' },
  { prefix: '/pool-health', title: 'Pool Health' },
  { prefix: '/simulations', title: 'Simulations' },
  { prefix: '/support', title: 'Support' },
  { prefix: '/', title: 'Dashboard' },
];

function pageTitle(pathname: string): string {
  if (pathname === '/') return 'Dashboard';
  const hit = ROUTE_TITLES.find((r) => r.prefix !== '/' && pathname.startsWith(r.prefix));
  if (hit) return hit.title;
  return 'Dashboard';
}

const nav = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/zones', label: 'Zone Map', icon: Map, end: false },
  { to: '/claims', label: 'Claims', icon: FileText, end: false },
  { to: '/workers', label: 'Workers', icon: Users, end: false },
  { to: '/fraud', label: 'Fraud', icon: ShieldAlert, end: false },
  { to: '/pool-health', label: 'Pool Health', icon: TrendingUp, end: false },
  { to: '/simulations', label: 'Simulations', icon: Zap, end: false },
  { to: '/support', label: 'Support', icon: MessageSquare, end: false },
];

export default function AdminLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const signOut = useAuthStore((s) => s.signOut);
  const jwt = useAuthStore((s) => s.jwt);
  const title = useMemo(() => pageTitle(location.pathname), [location.pathname]);

  const [istNow, setIstNow] = useState(() =>
    new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true }),
  );

  useEffect(() => {
    const tick = () =>
      setIstNow(new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true }));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);

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
    <div className="flex h-[100dvh] max-h-[100dvh] w-full overflow-hidden bg-slate-100">
      <aside className="flex h-full w-64 flex-shrink-0 flex-col bg-slate-900 text-slate-100">
        <div className="border-b border-slate-800 px-5 py-6">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500 text-sm font-bold text-white">
              S
            </div>
            <div>
              <div className="text-sm font-bold text-white">SafeNet Admin</div>
              <div className="text-xs text-slate-400">DevTrails 2026</div>
            </div>
          </div>
        </div>

        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 py-4">
          {nav.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  [
                    'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors',
                    isActive
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-400 hover:bg-slate-800 hover:text-white',
                  ].join(' ')
                }
              >
                <Icon className="h-4 w-4 flex-shrink-0 opacity-90" aria-hidden />
                {item.label}
              </NavLink>
            );
          })}
        </nav>

        <div className="border-t border-slate-800 p-4">
          <button
            type="button"
            onClick={logout}
            className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-700"
          >
            Sign out
          </button>
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex flex-shrink-0 items-center justify-between border-b border-gray-200 bg-white px-6 py-3">
          <h1 className="text-lg font-semibold text-gray-900">{title}</h1>
          <div className="flex items-center gap-4">
            <span className="inline-flex items-center gap-2 rounded-full border border-green-200 bg-green-50 px-3 py-1 text-xs font-semibold text-green-800">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
              </span>
              Live
            </span>
            <span className="text-sm text-gray-500">{istNow} IST</span>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-slate-100 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
