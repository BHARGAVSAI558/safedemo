import { BASE_URL } from '../api';
import { useAdminConnectionStore } from '../stores/adminConnection';
import { useClaimsFeedStore, type AdminClaimUpdate } from '../stores/claimsFeed';
import { useFraudQueueStore, type AdminFraudAlert } from '../stores/fraudQueue';
import { useZeroDayStore, type ZeroDayRow } from '../stores/zeroDay';
import { usePoolHealthStore, type AdminPoolHealth } from '../stores/poolHealth';
import { useZoneEventsStore, type AdminZoneEvent } from '../stores/zoneEvents';

type AdminWsEnvelope = {
  channel: string;
  payload: unknown;
};

function toWsUrl(httpBaseUrl: string, path: string) {
  const u = new URL(httpBaseUrl);
  const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${u.host}${path}`;
}

function safeJsonParse<T>(raw: unknown): T | null {
  try {
    if (typeof raw === 'string') return JSON.parse(raw) as T;
    return raw as T;
  } catch {
    return null;
  }
}

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let isStopped = true;

export function connectAdminWebSocket(jwt: string) {
  isStopped = false;

  const connStore = useAdminConnectionStore.getState();
  const claimsStore = useClaimsFeedStore.getState();
  const fraudStore = useFraudQueueStore.getState();
  const zoneStore = useZoneEventsStore.getState();
  const poolStore = usePoolHealthStore.getState();

  const httpBase = BASE_URL;

  let attempt = 0;
  const maxDelayMs = 30_000;

  const connectOnce = () => {
    if (isStopped) return;
    if (!jwt) {
      connStore.setStatus('offline');
      return;
    }

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    const wsBase = toWsUrl(httpBase, '/ws/admin/feed');
    const url = `${wsBase}?token=${encodeURIComponent(jwt)}`;

    connStore.setStatus('reconnecting');

    ws = new WebSocket(url);

    ws.onopen = () => {
      attempt = 0;
      connStore.setStatus('live');
      connStore.setError(null);
    };

    ws.onmessage = (evt) => {
      const envelope = safeJsonParse<AdminWsEnvelope>(evt.data) ?? (null as any);
      if (!envelope || typeof envelope.channel !== 'string') return;

      useAdminConnectionStore.getState().touchLastEvent();

      // Messages are multiplexed: { channel, payload: { type, payload, timestamp, correlation_id } }
      const outer = envelope.payload as any;
      const payloadType = outer?.type;
      const payload = outer?.payload && typeof outer.payload === 'object' ? outer.payload : outer;
      if (!payloadType) return;

      if (payloadType === 'CLAIM_UPDATE') {
        const update: AdminClaimUpdate = { ...payload, timestamp: Date.parse(outer.timestamp || new Date().toISOString()) };
        claimsStore.upsertClaimUpdate(update);
        return;
      }

      if (payloadType === 'FRAUD_ALERT') {
        const alert: AdminFraudAlert = { ...payload, timestamp: Date.parse(outer.timestamp || new Date().toISOString()) };
        fraudStore.upsertFraudAlert(alert);
        return;
      }

      if (payloadType === 'ZONE_EVENT') {
        const evtObj: AdminZoneEvent = { ...payload, timestamp: Date.parse(outer.timestamp || new Date().toISOString()) };
        zoneStore.upsertZoneEvent(evtObj);
        return;
      }

      if (payloadType === 'POOL_UPDATE') {
        const health: AdminPoolHealth = { ...payload, timestamp: Date.parse(outer.timestamp || new Date().toISOString()) };
        poolStore.upsertPoolHealth(health);
      }

      if (payloadType === 'ZERO_DAY_ALERT') {
        const zd = payload as ZeroDayRow;
        useZeroDayStore.getState().upsert({
          ...zd,
          id: typeof (zd as any).id === 'number' ? (zd as any).id : Date.now(),
          timestamp: Date.parse(outer.timestamp || new Date().toISOString()),
        });
      }

      if (payloadType === 'PAYOUT_CREDITED') {
        const update: AdminClaimUpdate = {
          ...payload,
          status: 'PAYOUT_CREDITED',
          timestamp: Date.parse(outer.timestamp || new Date().toISOString()),
        };
        claimsStore.upsertClaimUpdate(update);
      }
    };

    ws.onerror = () => {
      connStore.setError('WebSocket error');
    };

    ws.onclose = () => {
      if (isStopped) return;
      connStore.setStatus('reconnecting');

      const delaySeconds = Math.min(30, 2 ** attempt);
      const delayMs = Math.min(maxDelayMs, delaySeconds * 1000);
      attempt += 1;

      reconnectTimer = setTimeout(() => {
        connectOnce();
      }, delayMs);
    };
  };

  connectOnce();

  return () => {
    isStopped = true;
    connStore.setStatus('offline');
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    ws = null;
  };
}
