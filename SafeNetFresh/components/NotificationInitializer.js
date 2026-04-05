import React, { useEffect } from 'react';

import { useAuth } from '../contexts/AuthContext';
import { useClaims } from '../contexts/ClaimContext';
import { registerForPushNotificationsAsync, setupNotificationHandlers } from '../services/notification.service';

export default function NotificationInitializer() {
  const { token } = useAuth();
  const { setDisruptionAlert, setPremiumDue } = useClaims();

  useEffect(() => {
    const cleanup = setupNotificationHandlers({
      onDisruptionAlert: (data) => {
        setDisruptionAlert({
          visible: true,
          zone_id: data?.zone_id,
          event_type: data?.event_type,
          countdown_seconds: data?.countdown_seconds,
          received_at: data?.timestamp || Date.now(),
        });
      },
      onPremiumDue: (data) => {
        setPremiumDue({
          visible: true,
          title: data?.title || 'Premium Due',
          message: data?.message || 'Your weekly premium payment is due.',
          received_at: data?.timestamp || Date.now(),
        });
      },
    });
    return () => {
      try {
        cleanup?.();
      } catch (_) {}
    };
  }, [setDisruptionAlert, setPremiumDue]);

  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    (async () => {
      try {
        if (cancelled) return;
        await registerForPushNotificationsAsync();
      } catch (_) {}
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return null;
}

