import { BASE_URL } from './api';

const getWSURL = (workerId, token) => {
  const base = BASE_URL;
  const wsBase = base.replace('https://', 'wss://').replace('http://', 'ws://');
  const origin = wsBase.replace(/\/$/, '');
  return `${origin}/ws/claims/${encodeURIComponent(workerId)}?token=${encodeURIComponent(token)}`;
};

/**
 * Worker claims WebSocket.
 * Server sends {"type":"PING"} every 30s; client must reply {"type":"PONG"} within 10s.
 */
export function createClaimsWebSocket({ workerId, token, onMessage, onDisconnect, onStatusChange }) {
  const wsUrl = (BASE_URL || '').replace(/\/$/, '');
  const fullUrl = getWSURL(workerId, token);

  let socket = null;
  let isStopped = false;
  let reconnectAttempts = 0;
  let reconnectTimer = null;

  const emitStatus = (s) => {
    try {
      onStatusChange?.(s);
    } catch (_) {}
  };

  const disconnect = () => {
    isStopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (socket) {
      try {
        socket.close();
      } catch (_) {}
      socket = null;
    }
    emitStatus('offline');
    if (onDisconnect) onDisconnect();
  };

  const scheduleReconnect = () => {
    if (isStopped) return;
    emitStatus('reconnecting');
    reconnectAttempts += 1;
    const delay = reconnectAttempts >= 5 ? 30000 : Math.pow(2, reconnectAttempts - 1) * 1000;
    reconnectTimer = setTimeout(() => {
      if (!isStopped) connect();
    }, delay);
  };

  const connect = () => {
    isStopped = false;
    if (!wsUrl || !workerId || !token) {
      scheduleReconnect();
      return;
    }

    emitStatus('reconnecting');

    try {
      socket = new WebSocket(fullUrl);
    } catch (_) {
      scheduleReconnect();
      return;
    }

    socket.onopen = () => {
      reconnectAttempts = 0;
      emitStatus('connected');
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data?.type === 'PING') {
          if (socket && socket.readyState === 1) {
            socket.send(JSON.stringify({ type: 'PONG' }));
          }
          return;
        }
        if (data?.type === 'PONG') {
          return;
        }
        onMessage?.(data);
      } catch (_) {}
    };

    socket.onerror = () => {
      scheduleReconnect();
    };

    socket.onclose = () => {
      if (!isStopped) scheduleReconnect();
    };
  };

  connect();

  return { connect, disconnect };
}
