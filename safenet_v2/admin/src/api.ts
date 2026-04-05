import axios from 'axios';

import { useAuthStore } from './stores/auth';

const RENDER_BACKEND = 'https://devtrails2026-alphanexus-phase2-2.onrender.com';

const BASE_URL = (
  (import.meta.env.VITE_BACKEND_URL as string | undefined) ||
  RENDER_BACKEND
).replace(/\/$/, '');
export { BASE_URL };

const isDev = import.meta.env.DEV;
const useDevProxy = isDev && !import.meta.env.VITE_BACKEND_URL;
const apiBaseURL = useDevProxy ? '/api/v1' : `${BASE_URL}/api/v1`;

const api = axios.create({
  baseURL: apiBaseURL,
  timeout: 25_000,
  headers: { 'Content-Type': 'application/json' },
});

// Attach JWT token to every request
api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().jwt;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Redirect to login on 401 (but not failed admin password — that must show "Invalid" on the form)
api.interceptors.response.use(
  (res) => res,
  (err) => {
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
