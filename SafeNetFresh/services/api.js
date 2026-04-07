import axios from 'axios';
import axiosRetry from 'axios-retry';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

import { getCurrentTokenStore, clearTokenStore } from './tokenStore';

const getBackendURL = () => {
  try {
    const envPublic =
      typeof process !== 'undefined' && process.env && process.env.EXPO_PUBLIC_BACKEND_URL;
    if (envPublic && String(envPublic).trim().startsWith('http')) {
      return String(envPublic).trim().replace(/\/$/, '');
    }
  } catch (_) {
    /* ignore */
  }
  const devMode = Constants.expoConfig?.extra?.BACKEND_URL_DEV;
  const prodURL =
    Constants.expoConfig?.extra?.BACKEND_URL ||
    'https://safenet-api-y4se.onrender.com';

  if (__DEV__ && devMode === 'local') {
    return 'http://192.168.1.100:8000';
  }
  return String(prodURL).trim().replace(/\/$/, '');
};

export const BASE_URL = getBackendURL();
export const BACKEND_URL = BASE_URL;

function _isLikelyLocalApi(url) {
  if (!url || typeof url !== 'string') return false;
  if (/localhost|127\.0\.0\.1|10\.0\.2\.2/i.test(url)) return true;
  // Private LAN (phone -> PC hotspot / Wi‑Fi)
  if (/^https?:\/\/(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url)) return true;
  if (/onrender\.com|amazonaws\.com|vercel\.app/i.test(url)) return false;
  return /:\d{4,5}(\/|$)/i.test(url);
}

/** Hosted APIs: cold start. Local: keep moderate; retries on timeout are disabled so failures are fast. */
const TIMEOUT_MS = /onrender\.com|render\.com|amazonaws\.com|vercel\.app/i.test(BACKEND_URL)
  ? 90000
  : _isLikelyLocalApi(BACKEND_URL)
    ? 45000
    : 30000;

if (__DEV__) {
  // eslint-disable-next-line no-console
  console.log('[API] BACKEND_URL =', BACKEND_URL, '| timeout', TIMEOUT_MS, 'ms');
  if (Platform.OS === 'ios' && _isLikelyLocalApi(BACKEND_URL)) {
    // eslint-disable-next-line no-console
    console.warn(
      '[API] iOS device → PC: iPhone hotspot makes Windows treat the link as Public. If calls time out, run PowerShell as Admin: npm run windows:firewall-api (opens TCP 8000 on all profiles). In Safari on the phone open:',
      `${BACKEND_URL}/`,
      '— if that fails, it is firewall or uvicorn not on 0.0.0.0:8000.'
    );
  }
}

const api = axios.create({
  baseURL: `${BACKEND_URL}/api/v1`,
  timeout: TIMEOUT_MS,
  headers: { 'Content-Type': 'application/json' },
});

let _warmupPromise = null;
/**
 * Best-effort API warm-up to reduce first OTP/login delay when hosted backend is cold.
 */
export function warmBackendOnce() {
  if (_warmupPromise) return _warmupPromise;
  _warmupPromise = axios
    .get(`${BACKEND_URL}/health`, { timeout: 8000 })
    .then(() => {})
    .catch(() => {});
  return _warmupPromise;
}

let onUnauthorized = null;

export const setUnauthorizedHandler = (handler) => {
  onUnauthorized = handler;
};

function shouldTreatAsUnauthorized(error) {
  const status = error?.response?.status;
  if (status === 401) return true;
  if (status !== 404) return false;
  const detail = String(error?.response?.data?.detail || '').toLowerCase();
  return detail.includes('user not found');
}

api.interceptors.request.use(async (config) => {
  const token = await getCurrentTokenStore();
  if (token) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (shouldTreatAsUnauthorized(error)) {
      await clearTokenStore();
      if (onUnauthorized) onUnauthorized();
    }
    throw error;
  }
);

axiosRetry(api, {
  retries: 2,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error) => {
    const code = error?.code;
    const msg = String(error?.message || '');
    if (code === 'ECONNABORTED' || msg.toLowerCase().includes('timeout')) {
      return false;
    }
    const status = error?.response?.status;
    const isRetryableStatus = [502, 503, 504].includes(status);
    return isRetryableStatus;
  },
});

if (__DEV__) {
  api.interceptors.request.use((config) => {
    // eslint-disable-next-line no-console
    console.log('[API]', (config.method || 'GET').toUpperCase(), config.url);
    return config;
  });
  api.interceptors.response.use(
    (response) => {
      // eslint-disable-next-line no-console
      console.log('[API OK]', response.status, response.config.url);
      return response;
    },
    (error) => {
      // eslint-disable-next-line no-console
      console.log('[API ERR]', error?.response?.status, error?.config?.url, error?.message);
      return Promise.reject(error);
    }
  );
}

const unwrap = (res) => res.data;

/** User-facing message; never surfaces raw axios error objects. */
export function formatApiError(error) {
  const status = error?.response?.status;
  const detail = String(error?.response?.data?.detail || '').toLowerCase();
  if (status === 401 || (status === 404 && detail.includes('user not found'))) {
    return 'Your session expired. Please sign in again.';
  }
  if (status === 503 || status === 502 || status === 504) {
    return 'SafeNet is temporarily unavailable. Please try again in a moment.';
  }
  if (!error?.response) {
    if (error?.code === 'ECONNABORTED' || String(error?.message || '').includes('timeout')) {
      return `No response from ${BACKEND_URL}.\n\n• Local: uvicorn must use --host 0.0.0.0 --port 8000. Windows: npm run windows:firewall-api (Admin). Test in Safari on the phone: ${BACKEND_URL}/\n• Hosted (Render): service may be waking up — wait and retry, or use BACKEND_URL_DEV "local" with PC running.\n• Tunnel Expo: set BACKEND_URL_LOCAL or BACKEND_URL_DEV "remote".`;
    }
    return 'We could not reach SafeNet. Check your internet connection and try again.';
  }
  const d = error?.response?.data?.detail;
  if (typeof d === 'string') {
    return d;
  }
  if (Array.isArray(d)) {
    const parts = d
      .map((x) => (typeof x?.msg === 'string' ? x.msg : typeof x?.message === 'string' ? x.message : null))
      .filter(Boolean);
    if (parts.length) {
      return parts.join('\n');
    }
  }
  if (status === 422) {
    return 'Some information could not be saved. Please review your details and try again.';
  }
  return 'Something went wrong. Please try again.';
}

export const auth = {
  sendOTP: async (phone) => unwrap(await api.post('/auth/send-otp', { phone_number: phone })),
  verifyOTP: async (phone, otp) => {
    const data = unwrap(await api.post('/auth/verify-otp', { phone_number: phone, otp }));
    return data;
  },
  refresh: async (refreshToken) => unwrap(await api.post('/auth/refresh', { refresh_token: refreshToken })),
};

/** Gig-worker onboarding profile + policy activation (POST /api/v1/profile) */
export const gigProfile = {
  submit: async (body) => {
    try {
      return unwrap(await api.post('/profile', body));
    } catch (e) {
      if (shouldTreatAsUnauthorized(e)) throw e;
      // Backward compatibility: some deployed backends don't expose /api/v1/profile yet.
      if (e?.response?.status !== 404) throw e;

      const fallbackCreateBody = {
        name: body?.name,
        city: body?.city || 'Hyderabad',
        occupation: 'delivery',
        avg_daily_income: Number(body?.avg_daily_income || 650),
        risk_profile: 'medium',
      };

      try {
        const created = unwrap(await api.post('/workers/create', fallbackCreateBody));
        return {
          success: true,
          profile_id: created?.id,
          // Keep a response shape compatible with onboarding callers.
          risk_score: Number(created?.risk_score ?? 72),
          weekly_premium: Number(created?.weekly_premium ?? 35),
          coverage_tier: body?.coverage_tier,
          zone_id: body?.zone_id,
          zone_risk_level: 'Medium Risk',
          max_coverage_per_day: body?.coverage_tier === 'Pro' ? 700 : body?.coverage_tier === 'Standard' ? 500 : 350,
          platform: body?.platform,
          working_hours_preset: body?.working_hours_preset,
          name: body?.name,
          city: body?.city || 'Hyderabad',
        };
      } catch (createErr) {
        if (shouldTreatAsUnauthorized(createErr)) throw createErr;
        const detail = String(createErr?.response?.data?.detail || '');
        if (createErr?.response?.status === 400 && detail.toLowerCase().includes('already exists')) {
          const updated = unwrap(
            await api.put('/workers/update', {
              name: body?.name,
              city: body?.city || 'Hyderabad',
              occupation: 'delivery',
              avg_daily_income: Number(body?.avg_daily_income || 650),
              risk_profile: 'medium',
            })
          );
          return {
            success: true,
            profile_id: updated?.id,
            risk_score: Number(updated?.risk_score ?? 72),
            weekly_premium: Number(updated?.weekly_premium ?? 35),
            coverage_tier: body?.coverage_tier,
            zone_id: body?.zone_id,
            zone_risk_level: 'Medium Risk',
            max_coverage_per_day: body?.coverage_tier === 'Pro' ? 700 : body?.coverage_tier === 'Standard' ? 500 : 350,
            platform: body?.platform,
            working_hours_preset: body?.working_hours_preset,
            name: body?.name,
            city: body?.city || 'Hyderabad',
          };
        }
        throw createErr;
      }
    }
  },
};

export const workers = {
  createProfile: async (body) => unwrap(await api.post('/workers/create', body)),
  getProfile: async () => unwrap(await api.get('/workers/me')),
  updateProfile: async (body) => unwrap(await api.put('/workers/update', body)),
  getWeeklyBreakdown: async () => unwrap(await api.get('/workers/weekly-breakdown')),
  getEarningsDna: async (workerId) =>
    workerId != null
      ? unwrap(await api.get(`/workers/${workerId}/earnings-dna`))
      : unwrap(await api.get('/workers/earnings-dna')),
  uploadGPSTrail: async (workerId, gpsTrail) =>
    unwrap(await api.post(`/workers/${workerId}/gps-trail`, gpsTrail)),
};

export const policies = {
  /** Full coverage snapshot from GET /policies/current */
  getCurrent: async () => unwrap(await api.get('/policies/current')),
  /** Legacy list (optional) */
  list: async () => unwrap(await api.get('/policies')),
  activate: async (body) => unwrap(await api.post('/policies/activate', body)),
};

export const pools = {
  getHealth: async () => unwrap(await api.get('/pools/health')),
};

export const claims = {
  runSimulation: async ({ is_active, fraud_flag }) =>
    unwrap(await api.post('/simulation/run', { is_active, fraud_flag })),
  /** Live claims come from WebSocket / ClaimContext — not from history API. */
  getActive: async () => [],
  getHistory: async () => {
    const raw = unwrap(await api.get('/claims/history'));
    return Array.isArray(raw) ? raw : raw?.data ?? [];
  },
  /** Dashboard recent payouts: [{ date, disruption_type, amount, status, icon, claim_id }] */
  getPayouts: async (limit = 10) => {
    const raw = unwrap(await api.get('/claims/payouts', { params: { limit } }));
    return Array.isArray(raw) ? raw : raw?.data ?? [];
  },
};

export const payouts = {
  getHistory: async () => {
    const raw = unwrap(await api.get('/claims/history'));
    return Array.isArray(raw) ? raw : raw?.data ?? [];
  },
};

export const simulation = {
  run: async (body) => unwrap(await api.post('/simulation/run', body)),
};

/** Proactive forecast windows + current weather (JWT). */
export const zones = {
  getForecastShield: async (zoneId) =>
    unwrap(await api.get(`/zones/${encodeURIComponent(zoneId)}/forecast-shield`)),
};

export const support = {
  query: async ({ user_id, message, type = 'custom', language = 'en', query_key = null }) =>
    unwrap(await api.post('/support/query', { user_id, message, type, language, query_key })),
  history: async (userId) =>
    unwrap(await api.get('/support/history', { params: { user_id: userId } })),
};

export const notifications = {
  list: async (userId, opts = {}) =>
    unwrap(await api.get('/notifications', { params: { user_id: userId, ntype: opts?.type } })),
  markRead: async (id) => unwrap(await api.post(`/notifications/mark-read/${id}`)),
  markAllRead: async () => unwrap(await api.post('/notifications/mark-all-read')),
  clearAll: async () => unwrap(await api.post('/notifications/clear-all')),
};

export default api;