import React, { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

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

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showAdminLogin, setShowAdminLogin] = useState(false);
  const navigate = useNavigate();
  const signIn = useAuthStore((s) => s.signIn);
  const busy = useRef(false);
  const loginSectionRef = useRef<HTMLDivElement | null>(null);

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

  const revealLoginSection = () => {
    setShowAdminLogin(true);
    setUsername((prev) => prev || 'admin');
    setPassword((prev) => prev || 'admin123');
    requestAnimationFrame(() => {
      loginSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <section className="w-full bg-gradient-to-r from-blue-600 to-purple-600 py-16 text-center text-white shadow-lg">
        <div className="mx-auto max-w-5xl">
          <img src="/favicon.svg" alt="SafeNet logo" className="mx-auto h-14 w-14 rounded-xl bg-white/15 p-1.5" />
          <h1 className="mt-5 text-3xl font-extrabold leading-tight md:text-5xl">SafeNet - AI Income Protection for Gig Workers</h1>
          <p className="mx-auto mt-4 max-w-3xl text-sm text-blue-50 md:text-lg">
            Parametric insurance that pays gig workers exactly what they lost, verified automatically, credited instantly.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3 text-xs font-semibold md:text-sm">
            <span className="rounded-full bg-white/15 px-4 py-2 ring-1 ring-white/30">🔴 Live Backend</span>
            <span className="rounded-full bg-white/15 px-4 py-2 ring-1 ring-white/30">⚡ Real-time WebSockets</span>
            <span className="rounded-full bg-white/15 px-4 py-2 ring-1 ring-white/30">🤖 ML-Powered</span>
          </div>
        </div>
      </section>

      <main className="py-10">
        <section className="mx-auto grid max-w-6xl gap-6 px-4 md:grid-cols-2">
          <article className="rounded-2xl bg-white p-6 shadow-lg transition-shadow hover:shadow-xl">
            <h2 className="text-2xl font-bold text-slate-900">📱 Try the Worker App</h2>
            <p className="mt-2 text-sm text-slate-600">Experience SafeNet as a Zomato delivery partner</p>
            <div className="mt-4 flex flex-col items-start gap-3">
              <img src="/worker-app-qr.png" alt="Worker app QR code" className="h-[150px] w-[150px] rounded-lg border border-slate-200 bg-white p-2" />
              <p className="text-xs text-slate-500">Scan with your phone camera</p>
              <a
                href="https://safenet-sage.vercel.app/"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700"
              >
                Open Worker App →
              </a>
              <p className="text-xs text-slate-500">Also available in Expo Go</p>
            </div>
          </article>

          <article className="rounded-2xl bg-white p-6 shadow-lg transition-shadow hover:shadow-xl">
            <h2 className="text-2xl font-bold text-slate-900">🖥️ Admin Dashboard</h2>
            <p className="mt-2 text-sm text-slate-600">Monitor claims, fraud rings, and zone analytics in real time</p>
            <div className="mt-4 rounded bg-gray-100 p-3 text-sm text-slate-700">
              <p>
                Username: <span className="font-mono font-semibold">admin</span>
              </p>
              <p className="mt-1">
                Password: <span className="font-mono font-semibold">admin123</span>
              </p>
            </div>
            <button
              type="button"
              onClick={revealLoginSection}
              className="mt-4 inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700"
            >
              Sign in as Admin →
            </button>
            <p className="mt-3 text-xs text-slate-500">Live WebSocket feed • Fraud detection • Zone heatmap</p>
          </article>
        </section>

        <section className="mx-auto mt-10 grid max-w-6xl gap-4 px-4 md:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h3 className="text-base font-bold text-slate-900">Earnings DNA</h3>
            <p className="mt-2 text-sm text-slate-600">Learns each worker’s 7x24 earning fingerprint to estimate protected income windows.</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h3 className="text-base font-bold text-slate-900">4-Layer Fraud Engine</h3>
            <p className="mt-2 text-sm text-slate-600">GPS integrity, behavioral checks, cluster signals, and enrollment trust in one pipeline.</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h3 className="text-base font-bold text-slate-900">Forecast Shield</h3>
            <p className="mt-2 text-sm text-slate-600">Auto-upgrades coverage when disruption risk spikes so workers stay protected.</p>
          </div>
        </section>

        <section ref={loginSectionRef} className="mx-auto mt-10 max-w-6xl rounded-2xl border border-slate-200 bg-white p-6 shadow-lg">
          <button
            type="button"
            onClick={() => setShowAdminLogin((v) => !v)}
            className="w-full text-left text-sm font-semibold text-blue-700 transition hover:text-blue-900"
          >
            Team / evaluator admin access →
          </button>

          {showAdminLogin ? (
            <div className="mt-5 border-t border-slate-200 pt-5">
              <h3 className="text-lg font-bold text-slate-900">Administrator sign in</h3>
              <p className="mt-1 text-sm text-slate-600">Use your dashboard username and password. OTP is not used for admin access.</p>

              {error ? <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{error}</div> : null}

              <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-slate-600">Username</label>
              <input
                className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none ring-blue-200 transition focus:ring"
                placeholder="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                onKeyDown={(e) => e.key === 'Enter' && void submit()}
              />

              <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-slate-600">Password</label>
              <input
                className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none ring-blue-200 transition focus:ring"
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
                className="mt-5 w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-bold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {loading ? 'Signing in...' : 'Sign in'}
              </button>
            </div>
          ) : null}
        </section>
      </main>
    </div>
  );
}
