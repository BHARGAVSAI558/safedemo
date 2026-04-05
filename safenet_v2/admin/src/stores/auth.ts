import { create } from 'zustand';

const JWT_LS_KEY = 'safenet_admin_access_jwt';
const REFRESH_LS_KEY = 'admin_refresh_token';
const REFRESH_EXP_LS_KEY = 'admin_refresh_expires_at_ms';

type AuthState = {
  jwt: string | null;
  expiresAtMs: number | null;

  signIn: (accessToken: string, refreshToken: string) => void;
  signOut: () => void;
};

function decodeJwtExpMs(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const payloadJson = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(payloadJson) as { exp?: number };
    if (!payload.exp) return null;
    return payload.exp * 1000;
  } catch {
    return null;
  }
}

function readPersistedJwt(): { jwt: string | null; expiresAtMs: number | null } {
  try {
    const jwt = localStorage.getItem(JWT_LS_KEY);
    if (!jwt) return { jwt: null, expiresAtMs: null };
    const exp = decodeJwtExpMs(jwt);
    if (exp != null && exp <= Date.now()) {
      localStorage.removeItem(JWT_LS_KEY);
      return { jwt: null, expiresAtMs: null };
    }
    return { jwt, expiresAtMs: exp };
  } catch {
    return { jwt: null, expiresAtMs: null };
  }
}

const persisted = readPersistedJwt();

export const useAuthStore = create<AuthState>((set) => ({
  jwt: persisted.jwt,
  expiresAtMs: persisted.expiresAtMs,

  signIn: (accessToken, refreshToken) => {
    const accessExp = decodeJwtExpMs(accessToken);
    localStorage.setItem(JWT_LS_KEY, accessToken);

    const now = Date.now();
    const shortTtlMs = 15 * 60 * 1000;
    const refreshExpiresAtMs = now + shortTtlMs;
    localStorage.setItem(REFRESH_LS_KEY, refreshToken);
    localStorage.setItem(REFRESH_EXP_LS_KEY, String(refreshExpiresAtMs));

    set({ jwt: accessToken, expiresAtMs: accessExp });
  },

  signOut: () => {
    localStorage.removeItem(JWT_LS_KEY);
    localStorage.removeItem(REFRESH_LS_KEY);
    localStorage.removeItem(REFRESH_EXP_LS_KEY);
    set({ jwt: null, expiresAtMs: null });
  },
}));
