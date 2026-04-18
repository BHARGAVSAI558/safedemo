import axios from 'axios';

import { useAuthStore } from './stores/auth';

function resolveBackendBaseUrl() {
  const envBase = (import.meta.env.VITE_BACKEND_URL as string | undefined)?.trim();
  if (envBase) return envBase.replace(/\/$/, '');
  return 'https://safenet-api-y4se.onrender.com';
}

const BASE_URL = resolveBackendBaseUrl();
export { BASE_URL };

const isDev = import.meta.env.DEV;
const useDevProxy = isDev && !import.meta.env.VITE_BACKEND_URL;
const apiBaseURL = useDevProxy ? '/api/v1' : `${BASE_URL}/api/v1`;

const api = axios.create({
  baseURL: apiBaseURL,
  timeout: 60_000,
  headers: { 'Content-Type': 'application/json' },
});

/**
 * Safe wrapper for API responses — ensures JSON parsing and null-safe data.
 */
export function safeJsonResponse<T>(data: unknown, fallback: T): T {
  if (data === null || data === undefined) return fallback;
  if (typeof data === 'object') return data as T;
  return fallback;
}

/**
 * Safe array access — returns empty array if data is not an array.
 */
export function safeArray<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  return [];
}

let warmupPromise: Promise<void> | null = null;
/**
 * Best-effort backend wake-up to reduce first-login latency after Render idle.
 * Non-blocking; safe to call multiple times.
 */
export function warmBackendOnce(): Promise<void> {
  if (warmupPromise) return warmupPromise;
  warmupPromise = (async () => {
    try {
      await axios.get(`${BASE_URL}/health`, { timeout: 8_000 });
    } catch {
      // ignore warmup failures; real requests still handle errors/retries
    }
  })();
  return warmupPromise;
}

// Attach JWT token to every request
api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().jwt;
  const adminKey = (import.meta.env.VITE_ADMIN_API_KEY as string | undefined)?.trim();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  if (adminKey) config.headers['X-Admin-Key'] = adminKey;
  return config;
});

// Redirect to login on 401 (but not failed admin password — that must show "Invalid" on the form)
api.interceptors.response.use(
  (res) => res,
  async (err) => {
    if (err.response?.status === 401) {
      const reqUrl = String(err.config?.url ?? '');
      if (reqUrl.includes('/auth/admin-login')) {
        return Promise.reject(err);
      }
      useAuthStore.getState().signOut();
      if (!window.location.pathname.endsWith('/login')) {
        window.location.href = '/login';
      }
    }
    return Promise.reject(err);
  }
);

export default api;
