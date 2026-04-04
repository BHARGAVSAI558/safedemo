import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';

import { navigate } from './navigationService';
import api from './api';

export async function registerForPushNotificationsAsync() {
  try {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      if (status !== 'granted') return null;
    }

    const tokenResp = await Notifications.getExpoPushTokenAsync();
    const pushToken = tokenResp?.data;
    if (!pushToken) return null;

    const backendUrl = Constants?.expoConfig?.extra?.BACKEND_URL;
    void backendUrl;

    try {
      await api.post('/notifications/register', { expo_push_token: pushToken });
    } catch (_) {
      // Ignore if backend endpoint isn't implemented.
    }
    return pushToken;
  } catch (e) {
    return null;
  }
}

export function setupNotificationHandlers({ onClaimApproved, onDisruptionAlert, onPremiumDue } = {}) {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });

  const receivedSub = Notifications.addNotificationReceivedListener(() => {});

  const responseSub = Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response?.notification?.request?.content?.data || {};
    const type = data.type || data.notification_type;

    if (type === 'CLAIM_APPROVED') {
      onClaimApproved?.(data);
      navigate('MainTabs', { screen: 'Claims' });
      return;
    }
    if (type === 'DISRUPTION_ALERT') {
      onDisruptionAlert?.(data);
      navigate('MainTabs', { screen: 'Home' });
      return;
    }
    if (type === 'PREMIUM_DUE') {
      onPremiumDue?.(data);
      navigate('MainTabs', { screen: 'Coverage' });
      return;
    }
  });

  return () => {
    receivedSub?.remove?.();
    responseSub?.remove?.();
  };
}

export async function presentClaimUpdateLocalNotification({ claim_id, status, message } = {}) {
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'SafeNet Update',
        body: message ? String(message) : `Claim ${claim_id || ''} status: ${status || ''}`.trim(),
        data: { type: 'CLAIM_UPDATE', claim_id, status },
      },
      trigger: null,
    });
  } catch (_) {}
}

export async function presentDisruptionLocalNotification({ event_type, zone_id } = {}) {
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'SafeNet Disruption',
        body: `${event_type ? String(event_type) : 'Disruption'} in your zone${zone_id ? ` (${zone_id})` : ''}`,
        data: { type: 'DISRUPTION_ALERT', event_type, zone_id },
      },
      trigger: null,
    });
  } catch (_) {}
}

export async function presentPayoutCreditedLocalNotification({ claim_id, payout_amount, message } = {}) {
  try {
    const amt = Number(payout_amount || 0);
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Payout Credited',
        body:
          message ||
          `✅ ₹${Math.round(amt)} credited — heavy rain verified in your zone`,
        data: { type: 'PAYOUT_CREDITED', claim_id, payout_amount: amt },
      },
      trigger: null,
    });
  } catch (_) {}
}

