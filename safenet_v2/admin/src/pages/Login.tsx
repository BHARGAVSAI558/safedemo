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
  const navigate = useNavigate();
  const signIn = useAuthStore((s) => s.signIn);
  const busy = useRef(false);

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
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.header}>
          <span style={{ fontSize: 48 }}>🛡️</span>
          <h1 style={styles.title}>SafeNet Admin</h1>
          <p style={styles.sub}>Administrator sign in</p>
          <p style={styles.hint}>Use your dashboard username and password. OTP is not used for admin access.</p>
        </div>

        {error ? <div style={styles.error}>{error}</div> : null}

        <label style={styles.label}>Username</label>
        <input
          style={styles.input}
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
        />

        <label style={styles.label}>Password</label>
        <input
          style={styles.input}
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
        />

        <button type="button" style={styles.btn} onClick={() => void submit()} disabled={loading}>
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    background: 'linear-gradient(145deg, #1a56db 0%, #38bdf8 100%)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: '36px 32px',
    width: '100%',
    maxWidth: 400,
    boxShadow: '0 12px 40px rgba(0,0,0,0.15)',
  },
  header: { textAlign: 'center', marginBottom: 24 },
  title: { fontSize: 26, fontWeight: 800, color: '#0f172a', margin: '10px 0 6px' },
  sub: { color: '#334155', fontSize: 16, fontWeight: 700, margin: 0 },
  hint: { color: '#64748b', fontSize: 13, marginTop: 8, lineHeight: 1.45 },
  label: { display: 'block', fontSize: 13, fontWeight: 700, color: '#475569', marginBottom: 8, marginTop: 4 },
  input: {
    width: '100%',
    padding: 12,
    borderRadius: 10,
    border: '1px solid #e2e8f0',
    fontSize: 16,
    marginBottom: 14,
    boxSizing: 'border-box',
  },
  btn: {
    width: '100%',
    padding: 14,
    backgroundColor: '#1a56db',
    color: '#fff',
    border: 'none',
    borderRadius: 12,
    fontSize: 16,
    fontWeight: 800,
    cursor: 'pointer',
    marginTop: 6,
  },
  error: {
    backgroundColor: '#fef2f2',
    color: '#b91c1c',
    padding: 12,
    borderRadius: 10,
    marginBottom: 16,
    fontSize: 13,
    fontWeight: 600,
    lineHeight: 1.4,
  },
};
