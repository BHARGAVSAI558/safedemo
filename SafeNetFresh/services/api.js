import axios from 'axios';
import axiosRetry from 'axios-retry';
import Constants from 'expo-constants';

import { getCurrentTokenStore, clearTokenStore } from './tokenStore';

const TIMEOUT_MS = 30000;

const getBackendURL = () => {
  if (__DEV__) {
    return (
      Constants?.expoConfig?.extra?.BACKEND_URL_DEV ||
      'http://192.168.1.100:8000'
    );
  }
  return (
    Constants?.expoConfig?.extra?.BACKEND_URL ||
    'https://YOUR-RAILWAY-APP.railway.app'
  );
};

export const BACKEND_URL = getBackendURL();

const api = axios.create({
  baseURL: `${BACKEND_URL}/api/v1`,
  timeout: TIMEOUT_MS,
  headers: { 'Content-Type': 'application/json' },
});

let onUnauthorized = null;

export const setUnauthorizedHandler = (handler) => {
  onUnauthorized = handler;
};

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
    const status = error?.response?.status;
    if (status === 401) {
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
    const status = error?.response?.status;
    const isNetworkError = !error?.response;
    const isRetryableStatus = [502, 503, 504].includes(status);
    // ECONNABORTED = timeout; retry once after queue clears on the server
    return isNetworkError || isRetryableStatus || code === 'ECONNABORTED';
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
  submit: async (body) => unwrap(await api.post('/profile', body)),
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
  getActive: async () => {
    const raw = unwrap(await api.get('/claims/history'));
    const history = Array.isArray(raw) ? raw : raw?.data ?? [];
    const now = Date.now();
    const weekMs = 1000 * 60 * 60 * 24 * 7;
    return (history || []).filter((c) => {
      const created = new Date(c.created_at || c.createdAt || now).getTime();
      const recent = Number.isFinite(created) ? now - created <= weekMs : true;
      const hasPayout = typeof c.payout === 'number' ? c.payout > 0 : Boolean(c.payout);
      return recent && hasPayout;
    });
  },
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

export default api;