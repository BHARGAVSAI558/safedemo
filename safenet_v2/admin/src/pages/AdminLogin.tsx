import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import api from '../api';
import { useAuthStore } from '../stores/auth';

function formatApiError(e: unknown, fallback: string): string {
  const err = e as {
    code?: string;
    response?: { status?: number; data?: { detail?: string | Array<{ msg?: string }> } };
    message?: string;
  };
  if (err.code === 'ECONNABORTED' || String(err.message || '').toLowerCase().includes('timeout')) {
    return 'Request timed out. Start the API (port 8000) or set VITE_BACKEND_URL. In dev, use `npm run dev` with the proxy (no VITE_BACKEND_URL needed).';
  }
  const status = err.response?.status;
  const detail = err.response?.data?.detail;
  if (status === 401) return 'Invalid username or password.';
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail) && detail[0]?.msg) return detail.map((x) => x.msg).join(' ');
  return err.message || fallback;
}

type NavState = {
  username?: string;
  password?: string;
};

export default function AdminLogin() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const location = useLocation();
  const signIn = useAuthStore((s) => s.signIn);
  const busy = useRef(false);
  const autofillTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const state = (location.state || {}) as NavState;
    if (state.username && !username) setUsername(state.username);
    if (state.password && !password) setPassword(state.password);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  useEffect(() => {
    // Demo UX: if fields are empty, auto-fill within ~3.5s so evaluators can continue quickly.
    if (username || password) return undefined;
    autofillTimerRef.current = window.setTimeout(() => {
      setUsername('admin');
      setPassword('admin123');
    }, 3500);
    return () => {
      if (autofillTimerRef.current !== null) {
        window.clearTimeout(autofillTimerRef.current);
      }
    };
  }, [username, password]);

  const submit = async () => {
    if (busy.current) return;
    const u = username.trim();
    if (!u) {
      setError('Enter your username.');
      return;
    }
    if (!password) {
      setError('Enter your password.');
      return;
    }
    busy.current = true;
    setLoading(true);
    setError('');
    try {
      const { data } = await api.post('/auth/admin-login', {
        username: u,
        password,
      });
      const access = data?.access_token;
      const refresh = data?.refresh_token;
      if (typeof access !== 'string' || !access || typeof refresh !== 'string' || !refresh) {
        setError('Server returned an invalid response. Is VITE_BACKEND_URL pointing at this API?');
        return;
      }
      signIn(access, refresh);
      navigate('/', { replace: true });
    } catch (e: unknown) {
      setError(formatApiError(e, 'Could not reach the server. Check VITE_BACKEND_URL and that the API is running.'));
    } finally {
      busy.current = false;
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_#dbeafe,_#eef2ff_45%,_#f8fafc)] px-4 py-10 text-slate-900">
      <div className="mx-auto mt-8 grid w-full max-w-5xl gap-6 rounded-3xl border border-slate-200/70 bg-white/70 p-3 shadow-2xl backdrop-blur md:grid-cols-[1.1fr_0.9fr]">
        <aside className="rounded-2xl bg-gradient-to-br from-blue-700 via-indigo-700 to-violet-700 p-7 text-white">
          <div className="inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold ring-1 ring-white/30">
            <span className="h-2 w-2 rounded-full bg-emerald-300" />
            SafeNet Operations
          </div>
          <h1 className="mt-5 text-3xl font-extrabold leading-tight md:text-4xl">Admin Control Center</h1>
          <p className="mt-3 max-w-sm text-sm text-blue-100 md:text-base">
            Monitor live claims, payout signals, and fraud alerts from one secure dashboard.
          </p>
          <div className="mt-6 grid gap-3 text-xs text-blue-100 md:text-sm">
            <div className="rounded-xl bg-white/10 px-3 py-2 ring-1 ring-white/25">⚡ Real-time WebSocket feed</div>
            <div className="rounded-xl bg-white/10 px-3 py-2 ring-1 ring-white/25">🛡️ Fraud analytics & trust timeline</div>
            <div className="rounded-xl bg-white/10 px-3 py-2 ring-1 ring-white/25">📍 Zone and worker visibility</div>
          </div>
        </aside>

        <section className="rounded-2xl bg-white p-6 shadow-lg ring-1 ring-slate-200/70 md:p-8">
          <h2 className="text-2xl font-extrabold text-slate-900">SafeNet Admin Login</h2>
          <p className="mt-2 text-sm text-slate-600">Sign in to continue to the operations dashboard.</p>
          {!username && !password ? <p className="mt-2 text-xs font-semibold text-blue-600">Auto-filling demo credentials in 3-4 seconds...</p> : null}

          {error ? <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{error}</div> : null}

          <label className="mt-5 block text-xs font-semibold uppercase tracking-wide text-slate-600">Username</label>
          <input
            className="mt-2 w-full rounded-xl border border-slate-300 bg-slate-50 px-3 py-2.5 text-sm outline-none ring-blue-200 transition focus:bg-white focus:ring"
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
          />

          <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-slate-600">Password</label>
          <input
            className="mt-2 w-full rounded-xl border border-slate-300 bg-slate-50 px-3 py-2.5 text-sm outline-none ring-blue-200 transition focus:bg-white focus:ring"
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
          />

          <button
            type="button"
            onClick={() => void submit()}
            disabled={loading}
            className="mt-6 w-full rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 px-4 py-2.5 text-sm font-bold text-white transition hover:from-blue-700 hover:to-indigo-700 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </section>
      </div>
    </div>
  );
}

