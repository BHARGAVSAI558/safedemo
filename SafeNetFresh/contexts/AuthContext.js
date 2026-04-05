import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer } from 'react';
import { auth, setUnauthorizedHandler } from '../services/api';
import { getCurrentTokenStore, setTokenStore, clearTokenStore, getUserIdStore, getPhoneStore } from '../services/tokenStore';

const AuthContext = createContext(null);

const KEY = {
  token: 'token',
  userId: 'user_id',
  phone: 'phone',
};

const initialState = {
  isRestored: false,
  token: null,
  userId: null,
  phone: null,
  workerProfile: null,
  trustScore: null,
  profileReady: null,
};

function reducer(state, action) {
  switch (action.type) {
    case 'RESTORE':
      return {
        ...state,
        isRestored: true,
        token: action.token,
        userId: action.userId,
        phone: action.phone,
      };
    case 'SIGN_IN':
      return {
        ...state,
        token: action.token,
        userId: action.userId,
        phone: action.phone,
        profileReady: null,
        workerProfile: null,
        trustScore: null,
      };
    case 'SIGN_OUT':
      return { ...initialState, isRestored: true };
    case 'SET_PROFILE':
      return {
        ...state,
        workerProfile: action.profile,
        trustScore: action.profile?.trust_score ?? null,
        profileReady: action.profile?.is_profile_complete !== false,
      };
    case 'SET_PROFILE_READY':
      return {
        ...state,
        profileReady: Boolean(action.ready),
        workerProfile: action.ready ? state.workerProfile : null,
        trustScore: action.ready ? state.trustScore : null,
      };
    default:
      return state;
  }
}

export function AuthProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const token = await getCurrentTokenStore();
        const userId = await getUserIdStore();
        const phone = await getPhoneStore();
        if (mounted) {
          dispatch({ type: 'RESTORE', token, userId, phone });
        }
      } catch (_) {
        if (mounted) dispatch({ type: 'RESTORE', token: null, userId: null, phone: null });
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const signOut = useCallback(async () => {
    await clearTokenStore();
    dispatch({ type: 'SIGN_OUT' });
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      signOut().catch(() => {});
    });
  }, [signOut]);

  const signIn = useCallback(async ({ phone, access_token, refresh_token, user_id }) => {
    await setTokenStore({ token: access_token, refreshToken: refresh_token, userId: user_id, phone });
    dispatch({ type: 'SIGN_IN', token: access_token, refreshToken: refresh_token, userId: user_id, phone });
  }, []);

  const value = useMemo(() => ({ ...state, signOut, signIn, dispatch }), [state]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

