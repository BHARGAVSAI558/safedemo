import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

/** @typedef {'connected' | 'reconnecting' | 'offline'} WsConnectionStatus */

const WsConnectionContext = createContext({
  /** @type {WsConnectionStatus} */
  status: 'offline',
  setWsStatus: () => {},
});

export function WsConnectionProvider({ children }) {
  const [status, setStatus] = useState('offline');

  const setWsStatus = useCallback((s) => {
    setStatus(s);
  }, []);

  const value = useMemo(() => ({ status, setWsStatus }), [status, setWsStatus]);

  return <WsConnectionContext.Provider value={value}>{children}</WsConnectionContext.Provider>;
}

export function useWsConnection() {
  const ctx = useContext(WsConnectionContext);
  if (!ctx) throw new Error('useWsConnection must be used within WsConnectionProvider');
  return ctx;
}
