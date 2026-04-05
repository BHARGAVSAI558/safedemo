import React, { createContext, useCallback, useContext, useMemo, useReducer } from 'react';

/**
 * Policy + pool snapshot for the worker app.
 * `PolicyBootstrap` runs `GET /policies/current` on a 60s refetch interval and calls `setPolicy`
 * so the dashboard coverage badge stays in sync.
 */
const PolicyContext = createContext(null);

const initialState = {
  policy: null,
  poolHealth: null,
  coverageStatus: null,
};

function reducer(state, action) {
  switch (action.type) {
    case 'SET_POLICY':
      return { ...state, policy: action.policy, coverageStatus: action.coverageStatus ?? state.coverageStatus };
    case 'SET_POOL_HEALTH':
      return { ...state, poolHealth: action.poolHealth };
    case 'RESET':
      return initialState;
    default:
      return state;
  }
}

export function PolicyProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const setPolicy = useCallback((policy, coverageStatus) => {
    dispatch({ type: 'SET_POLICY', policy, coverageStatus });
  }, []);

  const setPoolHealth = useCallback((poolHealth) => {
    dispatch({ type: 'SET_POOL_HEALTH', poolHealth });
  }, []);

  const resetPolicy = useCallback(() => {
    dispatch({ type: 'RESET' });
  }, []);

  const value = useMemo(
    () => ({ ...state, setPolicy, setPoolHealth, resetPolicy }),
    [state, setPolicy, setPoolHealth, resetPolicy]
  );

  return <PolicyContext.Provider value={value}>{children}</PolicyContext.Provider>;
}

export function usePolicy() {
  const ctx = useContext(PolicyContext);
  if (!ctx) throw new Error('usePolicy must be used within PolicyProvider');
  return ctx;
}

