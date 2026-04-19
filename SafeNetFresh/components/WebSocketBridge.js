import React, { useEffect, useMemo, useRef } from 'react';
import { AppState } from 'react-native';

import { useAuth } from '../contexts/AuthContext';
import { useClaims } from '../contexts/ClaimContext';
import { useWsConnection } from '../contexts/WsConnectionContext';
import { createClaimsWebSocket } from '../services/websocket.service';
import {
  presentClaimUpdateLocalNotification,
  presentDisruptionLocalNotification,
  presentPayoutCreditedLocalNotification,
} from '../services/notification.service';

export default function WebSocketBridge() {
  const { token, userId } = useAuth();
  const { setClaimUpdate, setDisruptionAlert } = useClaims();
  const { setWsStatus } = useWsConnection();
  const appStateRef = useRef(AppState.currentState);

  const workerId = userId;

  const wsConfig = useMemo(() => {
    if (!token || !workerId) return null;
    return {
      workerId,
      token,
      onMessage: (msg) => {
        if (!msg || typeof msg !== 'object') return;
        const payload = msg?.payload && typeof msg.payload === 'object' ? msg.payload : msg;
        const eventType = msg?.type || payload?.type;
        const merged = {
          ...(payload || {}),
          type: eventType,
          timestamp: msg?.timestamp || payload?.timestamp || new Date().toISOString(),
          correlation_id: msg?.correlation_id || payload?.correlation_id,
        };
        if (eventType === 'CLAIM_UPDATE') {
          setClaimUpdate({ claimUpdate: merged, activeClaims: null });
          presentClaimUpdateLocalNotification({
            claim_id: merged.claim_id,
            status: merged.status,
            message: merged.message,
          }).catch(() => {});
        }
        if (eventType === 'PAYOUT_CREDITED') {
          setClaimUpdate({ claimUpdate: { ...merged, status: 'PAYOUT_CREDITED' }, activeClaims: null });
          presentPayoutCreditedLocalNotification({
            claim_id: merged.claim_id,
            payout_amount: merged.payout_amount,
            message: merged.message,
          }).catch(() => {});
        }
        if (eventType === 'DISRUPTION_ALERT' || eventType === 'ZONE_EVENT') {
          setDisruptionAlert({
            visible: true,
            zone_id: merged.zone_id,
            disruption_type: merged.disruption_type,
            event_type: merged.event_type || 'DISRUPTION_ALERT',
            countdown_seconds: merged.countdown_seconds,
            received_at: merged.timestamp || Date.now(),
          });
          presentDisruptionLocalNotification({ event_type: merged.event_type, zone_id: merged.zone_id }).catch(() => {});
        }
      },
      onDisconnect: () => {},
      onStatusChange: setWsStatus,
    };
  }, [token, workerId, setClaimUpdate, setDisruptionAlert, setWsStatus]);

  useEffect(() => {
    if (!wsConfig) return;

    const { connect, disconnect } = createClaimsWebSocket(wsConfig);

    const handleAppStateChange = (nextState) => {
      const prev = appStateRef.current;
      appStateRef.current = nextState;

      if (prev.match(/active/) && nextState.match(/inactive|background/)) {
        disconnect();
      } else if (prev.match(/inactive|background/) && nextState === 'active') {
        connect();
      }
    };

    const sub = AppState.addEventListener('change', handleAppStateChange);

    connect();

    return () => {
      disconnect();
      sub.remove();
    };
  }, [wsConfig]);

  return null;
}

