import AsyncStorage from '@react-native-async-storage/async-storage';

const KEYS = {
  token: 'token',
  refresh: 'refresh',
  userId: 'user_id',
  phone: 'phone',
};

export const getCurrentTokenStore = async () => {
  try {
    return await AsyncStorage.getItem(KEYS.token);
  } catch (_) {
    return null;
  }
};

export const setTokenStore = async ({ token, refreshToken, userId, phone }) => {
  if (token) await AsyncStorage.setItem(KEYS.token, String(token));
  if (refreshToken) await AsyncStorage.setItem(KEYS.refresh, String(refreshToken));
  if (userId !== undefined && userId !== null) {
    await AsyncStorage.setItem(KEYS.userId, String(userId));
  }
  if (phone) await AsyncStorage.setItem(KEYS.phone, String(phone));
};

export const getUserIdStore = async () => {
  try {
    const v = await AsyncStorage.getItem(KEYS.userId);
    return v ? Number(v) : null;
  } catch (_) {
    return null;
  }
};

export const getPhoneStore = async () => {
  try {
    return await AsyncStorage.getItem(KEYS.phone);
  } catch (_) {
    return null;
  }
};

export const clearTokenStore = async () => {
  await Promise.all(Object.values(KEYS).map((k) => AsyncStorage.removeItem(k).catch(() => {})));
};
