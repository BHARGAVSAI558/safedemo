import * as SecureStore from 'expo-secure-store';

const KEYS = {
  token: 'token',
  refresh: 'refresh',
  userId: 'user_id',
  phone: 'phone',
};

export const getCurrentTokenStore = async () => {
  try {
    return await SecureStore.getItemAsync(KEYS.token);
  } catch (_) {
    return null;
  }
};

export const setTokenStore = async ({ token, refreshToken, userId, phone }) => {
  if (token) await SecureStore.setItemAsync(KEYS.token, String(token));
  if (refreshToken) await SecureStore.setItemAsync(KEYS.refresh, String(refreshToken));
  if (userId !== undefined && userId !== null) await SecureStore.setItemAsync(KEYS.userId, String(userId));
  if (phone) await SecureStore.setItemAsync(KEYS.phone, String(phone));
};

export const getUserIdStore = async () => {
  try {
    const v = await SecureStore.getItemAsync(KEYS.userId);
    return v ? Number(v) : null;
  } catch (_) {
    return null;
  }
};

export const getPhoneStore = async () => {
  try {
    return await SecureStore.getItemAsync(KEYS.phone);
  } catch (_) {
    return null;
  }
};

export const clearTokenStore = async () => {
  const deletions = Object.values(KEYS).map((k) =>
    SecureStore.deleteItemAsync(k).catch(() => {})
  );
  await Promise.all(deletions);
};

