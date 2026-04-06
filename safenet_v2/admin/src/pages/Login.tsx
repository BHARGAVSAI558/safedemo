import React from 'react';
import { useNavigate } from 'react-router-dom';

export default function Login() {
  const navigate = useNavigate();
  const workerAppUrl = 'https://safenet-sage.vercel.app';
  const goToAdminLogin = () => {
    navigate('/admin-login', {
      state: { username: 'admin', password: 'admin123' },
    });
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <section className="w-full bg-gradient-to-r from-blue-600 to-purple-600 py-6 text-center text-white shadow-lg">
        <div className="mx-auto max-w-5xl">
          <img src="/favicon.svg" alt="SafeNet logo" className="mx-auto h-14 w-14 rounded-xl bg-white/15 p-1.5" />
          <h1 className="mt-5 text-4xl font-extrabold leading-tight md:text-6xl">SafeNet</h1>
          <p className="mt-3 text-lg font-semibold text-blue-50 md:text-2xl">AI Income Protection for Gig Workers</p>
          <p className="mx-auto mt-3 max-w-2xl text-sm text-blue-100 md:text-base">
            Parametric insurance that pays workers exactly what they lose.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3 text-xs font-semibold md:text-sm">
            <span className="rounded-full bg-white/15 px-4 py-2 ring-1 ring-white/30">🔴 Live Backend</span>
            <span className="rounded-full bg-white/15 px-4 py-2 ring-1 ring-white/30">⚡ Real-time WebSockets</span>
            <span className="rounded-full bg-white/15 px-4 py-2 ring-1 ring-white/30">🤖 ML-Powered</span>
          </div>
        </div>
      </section>

      <main className="py-6">
        <section className="mx-auto grid max-w-6xl gap-6 px-4 md:grid-cols-2">
          <article className="rounded-2xl bg-white p-6 shadow-lg transition-shadow hover:shadow-xl">
            <h2 className="text-xl font-semibold text-slate-900">📱 Try the Worker App</h2>
            <p className="mt-2 text-sm text-gray-500">Try the worker experience</p>
            <div className="mt-4 flex flex-col items-start gap-3">
              <a
                href={workerAppUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-blue-700"
              >
                🚀 Open Worker App (Web)
              </a>
              <img src="/worker-app-qr.png" alt="Worker app QR code" className="h-[150px] w-[150px] rounded-lg border border-slate-200 bg-white p-2" />
              <p className="text-xs text-slate-500">📱 Scan for Mobile App (Expo)</p>
              <a href={workerAppUrl} target="_blank" rel="noreferrer" className="text-sm font-medium text-blue-600 underline">
                {workerAppUrl}
              </a>
              <p className="text-xs text-gray-500">Best experience: Mobile app</p>
            </div>
          </article>

          <article className="rounded-2xl bg-white p-6 shadow-lg transition-shadow hover:shadow-xl">
            <h2 className="text-xl font-semibold text-slate-900">🖥️ Admin Dashboard</h2>
            <p className="mt-2 text-sm text-gray-500">Monitor claims and zone analytics live</p>
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
              onClick={goToAdminLogin}
              className="mt-4 inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-blue-700"
            >
              🖥 Sign in as Admin →
            </button>
            <p className="mt-3 text-xs text-slate-500">Live WebSocket feed • Fraud detection • Zone heatmap</p>
          </article>
        </section>

        <section className="mx-auto mt-10 grid max-w-6xl gap-4 px-4 md:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h3 className="text-xl font-semibold text-slate-900">Earnings DNA</h3>
            <p className="mt-2 text-sm text-gray-500">7x24 income fingerprint for smarter protection.</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h3 className="text-xl font-semibold text-slate-900">4-Layer Fraud Engine</h3>
            <p className="mt-2 text-sm text-gray-500">GPS, behavior, cluster, and enrollment checks.</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h3 className="text-xl font-semibold text-slate-900">Forecast Shield</h3>
            <p className="mt-2 text-sm text-gray-500">Auto-upgrades coverage before risk spikes.</p>
          </div>
        </section>

        <section className="mx-auto mt-10 max-w-6xl rounded-2xl border border-slate-200 bg-white p-6 shadow-lg">
          <button
            type="button"
            onClick={goToAdminLogin}
            className="w-full text-left text-sm font-semibold text-blue-700 transition hover:text-blue-900"
          >
            Team / evaluator admin access →
          </button>
        </section>
      </main>
    </div>
  );
}
