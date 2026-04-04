import axios from 'axios';

import { useAuthStore } from './stores/auth';

const BASE_URL = (import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:8000').replace(/\/$/, '');
export const WS_URL = BASE_URL.replace('https://', 'wss://').replace('http://', 'ws://');

const api = axios.create({ baseURL: `${BASE_URL}/api/v1` });

// Attach JWT token to every request
api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().jwt;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Redirect to login on 401
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      useAuthStore.getState().signOut();
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

export default api;

