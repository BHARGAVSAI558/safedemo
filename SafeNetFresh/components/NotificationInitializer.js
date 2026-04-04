import React, { useEffect } from 'react';

import { useClaims } from '../contexts/ClaimContext';
import { registerForPushNotificationsAsync, setupNotificationHandlers } from '../services/notification.service';

export default function NotificationInitializer() {
  const { setDisruptionAlert, setPremiumDue } = useClaims();

  useEffect(() => {
    let cleanup = null;

    (async () => {
      try {
        await registerForPushNotificationsAsync();
        cleanup = setupNotificationHandlers({
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
      } catch (_) {}
    })();

    return () => {
      try {
        cleanup?.();
      } catch (_) {}
    };
  }, []);

  return null;
}

