import { AppState, Dimensions, Platform } from 'react-native';

import * as BackgroundFetch from 'expo-background-fetch';
import * as Battery from 'expo-battery';
import * as Cellular from 'expo-cellular';
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import * as Application from 'expo-application';
import * as Location from 'expo-location';
import * as Network from 'expo-network';
import * as SQLite from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';
import * as TaskManager from 'expo-task-manager';
import { Accelerometer } from 'expo-sensors';

import api from './api';

// Background tasks names (must be globally unique within your app).
const TELEMETRY_TASK = 'fraud-gps-telemetry-task';
const EVENTS_FLUSH_TASK = 'fraud-app-events-flush-task';

// SecureStore keys.
const FINGERPRINT_HASH_KEY = 'device_fingerprint_hash';
const FINGERPRINT_LAST_SENT_AT_KEY = 'device_fingerprint_last_sent_at_ms';
const ACTIVE_WORKER_ID_KEY = 'fraud_telemetry_active_worker_id';
const TELEMETRY_ACTIVE_FLAG_KEY = 'fraud_telemetry_active_flag';

// Telemetry anomaly meta keys (used for cross-task correlation best-effort).
const META_STATIC_SINCE_KEY = 'fraud_meta_static_since_ms';
const META_LAST_COORDS_KEY = 'fraud_meta_last_coords_json';
const META_NETWORK_SWITCH_HISTORY_KEY = 'fraud_meta_network_switch_history_json';

// Anomaly thresholds.
const POOR_GPS_ACCURACY_M = 500;
const NEAR_ZERO_VARIANCE_THRESHOLD = 0.001;
const STATIC_MOTION_SUSPICIOUS_MIN_MS = 5 * 60 * 1000;
const GPS_MOVEMENT_DISTANCE_M = 25;

// Vehicle every 5 minutes while policy is active (background fetch is inexact).
const GPS_MIN_INTERVAL_SEC = 5 * 60;
// Flush app events every 3 minutes (background fetch is inexact).
const EVENTS_MIN_INTERVAL_SEC = 3 * 60;

// Circular buffer max.
const MAX_EVENTS = 100;

let dbPromise = null;

async function getDb() {
  if (dbPromise) return dbPromise;
  try {
    dbPromise = SQLite.openDatabaseAsync('fraud_telemetry.sqlite');
    return await dbPromise;
  } catch (_) {
    dbPromise = null;
    return null;
  }
}

let telemetryActive = false;
let lastAppState = 'background';
let appStateSub = null;
let tasksDefined = false;

// In-memory circular buffer (also persisted to SQLite to survive background contexts).
let eventBuffer = [];

// Screen timers for screen_visit duration.
const screenVisitStarts = new Map();

function stableJson(obj) {
  return JSON.stringify(obj);
}

async function sha256Hex(input) {
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, String(input));
  return digest;
}

function getNetworkTypeLabelFromState(state) {
  const rawType = (state?.type || state?.networkType || '').toString().toLowerCase();
  if (!state?.isConnected || rawType === 'none' || rawType === 'no internet') return 'NONE';
  if (rawType.includes('wifi')) return 'WIFI';
  if (rawType.includes('cell')) return 'CELLULAR';
  // Some platforms might return other types; treat as NONE if not connected.
  return state?.isConnected ? 'CELLULAR' : 'NONE';
}

function haversineDistanceM(a, b) {
  if (!a || !b) return 0;
  const lat1 = Number(a.lat);
  const lon1 = Number(a.lon);
  const lat2 = Number(b.lat);
  const lon2 = Number(b.lon);
  if (!Number.isFinite(lat1) || !Number.isFinite(lon1) || !Number.isFinite(lat2) || !Number.isFinite(lon2)) return 0;

  const R = 6371000; // meters
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const sLat1 = toRad(lat1);
  const sLat2 = toRad(lat2);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const aHar = sinDLat * sinDLat + Math.cos(sLat1) * Math.cos(sLat2) * sinDLon * sinDLon;
  const c = 2 * Math.atan2(Math.sqrt(aHar), Math.sqrt(1 - aHar));
  return R * c;
}

function ensureTableSql() {
  const createGps = `
    CREATE TABLE IF NOT EXISTS gps_batches_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worker_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
  `;
  const createEvents = `
    CREATE TABLE IF NOT EXISTS app_events_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worker_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      data_json TEXT NOT NULL
    );
  `;
  return { createGps, createEvents };
}

function execSql(sql, params = []) {
  return (async () => {
    const db = await getDb();
    if (!db) {
      if (String(sql || '').trim().toLowerCase().startsWith('select')) {
        return { rows: { length: 0, item: () => undefined } };
      }
      return;
    }
    const normalized = String(sql || '').trim().toLowerCase();
    if (normalized.startsWith('select')) {
      const rows = await db.getAllAsync(sql, params);
      return {
        rows: {
          length: rows.length,
          item: (i) => rows[i],
        },
      };
    }
    return db.runAsync(sql, params);
  })();
}

async function ensureSchema() {
  const { createGps, createEvents } = ensureTableSql();
  await execSql(createGps);
  await execSql(createEvents);
}

async function enqueueGpsBatch({ workerId, payload }) {
  await ensureSchema();
  const payloadJson = stableJson(payload);
  await execSql(
    'INSERT INTO gps_batches_queue (worker_id, payload_json, created_at_ms) VALUES (?, ?, ?)',
    [String(workerId), payloadJson, Date.now()]
  );
}

async function dequeueGpsBatches({ workerId, limit = 10 }) {
  await ensureSchema();
  const db = await getDb();
  const rows = await db.getAllAsync(
    `SELECT id, payload_json FROM gps_batches_queue WHERE worker_id = ? ORDER BY created_at_ms ASC LIMIT ?`,
    [String(workerId), limit]
  );
  return rows;
}

async function deleteGpsBatchIds({ ids }) {
  if (!ids?.length) return;
  await ensureSchema();
  // SQLite doesn't support binding arrays directly.
  const placeholders = ids.map(() => '?').join(',');
  await execSql(`DELETE FROM gps_batches_queue WHERE id IN (${placeholders})`, ids);
}

async function flushQueuedGpsBatches(workerId) {
  const networkState = await Network.getNetworkStateAsync().catch(() => null);
  const isConnected = Boolean(networkState?.isConnected);
  if (!isConnected) return;

  const queued = await dequeueGpsBatches({ workerId, limit: 10 });
  if (!queued.length) return;

  const sentIds = [];
  for (const row of queued) {
    try {
      const payload = JSON.parse(row.payload_json);
      await api.post(`/workers/${workerId}/gps-trail`, payload);
      sentIds.push(row.id);
    } catch (_) {
      // Stop flushing after the first failure so we don't spin.
      break;
    }
  }

  await deleteGpsBatchIds({ ids: sentIds });
}

async function measureAccelerometer3s() {
  const magnitudes = [];

  Accelerometer.setUpdateInterval(100);

  const sub = Accelerometer.addListener((reading) => {
    const x = reading?.x;
    const y = reading?.y;
    const z = reading?.z;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    const mag = Math.sqrt(x * x + y * y + z * z);
    magnitudes.push(mag);
  });

  await new Promise((r) => setTimeout(r, 3000));
  sub.remove();

  if (!magnitudes.length) {
    return { mean_magnitude: 0, variance: 0, is_moving: false };
  }

  const mean = magnitudes.reduce((acc, v) => acc + v, 0) / magnitudes.length;
  const variance =
    magnitudes.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / magnitudes.length;
  const is_moving = variance > 0.1;

  return { mean_magnitude: mean, variance, is_moving };
}

async function getBatteryLevelSafe() {
  try {
    const level = await Battery.getBatteryLevelAsync();
    return typeof level === 'number' ? level : null;
  } catch (_) {
    return null;
  }
}

async function getAppStateLabel() {
  return lastAppState === 'active' ? 'foreground' : 'background';
}

async function getNetworkStateSafe() {
  try {
    return await Network.getNetworkStateAsync();
  } catch (_) {
    return null;
  }
}

async function collectSingleGpsPayload({ workerId, staticMeta, networkSwitchHistory }) {
  const [position, accelStats, networkState, batteryLevel] = await Promise.all([
    Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.BestForNavigation,
      maximumAge: 0,
      timeout: 15000,
    }),
    measureAccelerometer3s(),
    getNetworkStateSafe(),
    getBatteryLevelSafe(),
  ]);

  const coords = position?.coords || {};
  const lat = coords.latitude;
  const lon = coords.longitude;
  const accuracy = coords.accuracy;
  const altitude = coords.altitude ?? null;
  const timestamp = position?.timestamp ? new Date(position.timestamp).toISOString() : new Date().toISOString();

  let cellCarrierName = null;
  try {
    const carrier = await Cellular.getCarrierNameAsync();
    const voipAllowed = await Cellular.allowsVoipAsync();
    if (carrier) cellCarrierName = carrier;
    else if (voipAllowed === true) cellCarrierName = 'UNKNOWN_CARRIER';
    else cellCarrierName = null;
  } catch (_) {
    cellCarrierName = null;
  }

  const network_type = getNetworkTypeLabelFromState(networkState);
  const app_state = await getAppStateLabel();

  const gps_quality = typeof accuracy === 'number' && accuracy > POOR_GPS_ACCURACY_M ? 'POOR' : 'OK';

  const lastCoords = staticMeta?.lastCoords || null;
  const movementDistanceM = lastCoords ? haversineDistanceM({ lat: lastCoords.lat, lon: lastCoords.lon }, { lat, lon }) : 0;
  const gps_moved = movementDistanceM >= GPS_MOVEMENT_DISTANCE_M;

  // Suspicious motion: near-zero accel variance for >5 min but GPS shows movement.
  const varianceNearZero = typeof accelStats?.variance === 'number' && accelStats.variance <= NEAR_ZERO_VARIANCE_THRESHOLD;
  const now = Date.now();
  let staticSinceMs = staticMeta?.staticSinceMs ?? null;
  if (varianceNearZero) {
    if (!staticSinceMs) staticSinceMs = now;
  } else {
    staticSinceMs = null;
  }
  const staticDurationMs = staticSinceMs ? now - staticSinceMs : 0;
  const suspicious_motion = Boolean(staticSinceMs && staticDurationMs >= STATIC_MOTION_SUSPICIOUS_MIN_MS && gps_moved);

  // Network unstable: track WIFI<->CELLULAR switching close to 1 min cadence.
  const currentSwitchType =
    network_type === 'WIFI' || network_type === 'CELLULAR' ? network_type : null;
  const nextNetworkSwitchHistory = Array.isArray(networkSwitchHistory) ? [...networkSwitchHistory] : [];
  if (currentSwitchType) {
    const last = nextNetworkSwitchHistory[nextNetworkSwitchHistory.length - 1];
    if (!last || last.type !== currentSwitchType) {
      nextNetworkSwitchHistory.push({ type: currentSwitchType, at_ms: now });
      // Keep last few.
      if (nextNetworkSwitchHistory.length > 10) nextNetworkSwitchHistory.shift();
    }
  }

  let network_unstable = false;
  if (nextNetworkSwitchHistory.length >= 3) {
    // Count consecutive switches with near-1min spacing.
    let transitionsCloseToMinute = 0;
    for (let i = 1; i < nextNetworkSwitchHistory.length; i += 1) {
      const prev = nextNetworkSwitchHistory[i - 1];
      const cur = nextNetworkSwitchHistory[i];
      const dt = cur.at_ms - prev.at_ms;
      if (dt >= 30 * 1000 && dt <= 90 * 1000) transitionsCloseToMinute += 1;
    }
    network_unstable = transitionsCloseToMinute >= 2;
  }

  return {
    reading: {
      lat,
      lon,
      accuracy,
      altitude,
      timestamp,
      cell_carrier_name: cellCarrierName,
      network_type,
      accelerometer: {
        mean_magnitude: accelStats.mean_magnitude,
        variance: accelStats.variance,
        is_moving: accelStats.is_moving,
      },
      battery_level: batteryLevel,
      app_state,
      gps_quality,
      suspicious_motion,
      network_unstable,
    },
    staticSinceMs,
    nextNetworkSwitchHistory,
  };
}

async function getGpsMetaState() {
  const [staticSinceRaw, coordsRaw, netSwitchRaw] = await Promise.all([
    SecureStore.getItemAsync(META_STATIC_SINCE_KEY).catch(() => null),
    SecureStore.getItemAsync(META_LAST_COORDS_KEY).catch(() => null),
    SecureStore.getItemAsync(META_NETWORK_SWITCH_HISTORY_KEY).catch(() => null),
  ]);

  const staticSinceMs = staticSinceRaw ? Number(staticSinceRaw) : null;
  const lastCoords = coordsRaw ? JSON.parse(coordsRaw) : null;
  const networkSwitchHistory = netSwitchRaw ? JSON.parse(netSwitchRaw) : [];

  return { staticSinceMs, lastCoords, networkSwitchHistory };
}

async function setGpsMetaState({ staticSinceMs, lastCoords, networkSwitchHistory }) {
  await Promise.all([
    SecureStore.setItemAsync(META_STATIC_SINCE_KEY, staticSinceMs ? String(staticSinceMs) : ''),
    SecureStore.setItemAsync(META_LAST_COORDS_KEY, lastCoords ? JSON.stringify(lastCoords) : ''),
    SecureStore.setItemAsync(
      META_NETWORK_SWITCH_HISTORY_KEY,
      networkSwitchHistory ? JSON.stringify(networkSwitchHistory) : '[]'
    ),
  ]);
}

async function collectAndBatchGpsTelemetry({ workerId }) {
  const meta = await getGpsMetaState();
  const staticMeta = { staticSinceMs: meta.staticSinceMs, lastCoords: meta.lastCoords };
  let networkSwitchHistory = meta.networkSwitchHistory;

  const readings = [];
  for (let i = 0; i < 3; i += 1) {
    const result = await collectSingleGpsPayload({
      workerId,
      staticMeta,
      networkSwitchHistory,
    });

    readings.push(result.reading);
    staticMeta.staticSinceMs = result.staticSinceMs;
    networkSwitchHistory = result.nextNetworkSwitchHistory;
    staticMeta.lastCoords = { lat: result.reading.lat, lon: result.reading.lon };
  }

  await setGpsMetaState({
    staticSinceMs: staticMeta.staticSinceMs,
    lastCoords: staticMeta.lastCoords,
    networkSwitchHistory,
  });

  return readings;
}

async function sendGpsBatchOrQueue({ workerId, batchReadings }) {
  const networkState = await getNetworkStateSafe();
  const isConnected = Boolean(networkState?.isConnected);
  if (!isConnected) {
    await enqueueGpsBatch({ workerId, payload: { gps_trail: batchReadings } });
    return { queued: true };
  }

  try {
    await api.post(`/workers/${workerId}/gps-trail`, { gps_trail: batchReadings });
    return { queued: false };
  } catch (_) {
    await enqueueGpsBatch({ workerId, payload: { gps_trail: batchReadings } });
    return { queued: true };
  }
}

async function ensureBackgroundPermissions() {
  try {
    await Location.requestForegroundPermissionsAsync();
  } catch (_) {}
  // Background location + background fetch are not reliable in Expo Go.
  // Skip background permission prompts to avoid native HostFunction crashes.
}

async function getDeviceId() {
  if (Platform.OS === 'android') {
    // Expo Application provides getAndroidId() on Android.
    if (typeof Application.getAndroidId === 'function') return Application.getAndroidId();
    // Fallback: androidId may not exist as a function in some versions.
    return Application.androidId || null;
  }
  if (typeof Application.getIosIdForVendorAsync === 'function') {
    return await Application.getIosIdForVendorAsync();
  }
  return null;
}

async function collectDeviceFingerprintSignals() {
  const window = Dimensions.get('window');
  const networkState = await getNetworkStateSafe();
  const networkType = getNetworkTypeLabelFromState(networkState);
  const battery_level = await getBatteryLevelSafe();

  const deviceId = await getDeviceId();
  const installDate = await Application.getInstallationTimeAsync().catch(() => null);
  const install_ts = installDate instanceof Date ? installDate.getTime() : null;

  const signals = {
    device_model: Device.modelName || Device.modelId || null,
    os_version: Device.osVersion || null,
    platform_api_level: Device.platformApiLevel || null,
    screen: { width: window.width, height: window.height, scale: window.scale, fontScale: window.scale },
    device_id: deviceId,
    app_version: Application.nativeApplicationVersion || null,
    install_timestamp_ms: install_ts,
    network_type_at_enrollment: networkType,
    battery_level,
  };

  return signals;
}

async function shouldRefreshFingerprint() {
  const lastSentRaw = await SecureStore.getItemAsync(FINGERPRINT_LAST_SENT_AT_KEY).catch(() => null);
  const lastSentMs = lastSentRaw ? Number(lastSentRaw) : null;
  if (!lastSentMs) return true;
  const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
  return Date.now() - lastSentMs >= oneWeekMs;
}

async function enrollOrRefreshDeviceFingerprint(workerId) {
  const refresh = await shouldRefreshFingerprint();
  if (!refresh) {
    const existingHash = await SecureStore.getItemAsync(FINGERPRINT_HASH_KEY).catch(() => null);
    if (existingHash) return existingHash;
  }

  const signals = await collectDeviceFingerprintSignals();
  const hashSeed = stableJson(signals);
  const device_fingerprint_hash = await sha256Hex(hashSeed);

  await api
    .post(`/workers/${workerId}/device-fingerprint`, {
      device_fingerprint_hash,
      signals,
      collected_at: new Date().toISOString(),
    })
    .catch(() => {});

  await SecureStore.setItemAsync(FINGERPRINT_HASH_KEY, device_fingerprint_hash);
  await SecureStore.setItemAsync(FINGERPRINT_LAST_SENT_AT_KEY, String(Date.now()));

  return device_fingerprint_hash;
}

async function logEventToDb({ workerId, eventType, timestampMs, data }) {
  await ensureSchema();
  const dataJson = stableJson(data || {});
  await execSql(
    'INSERT INTO app_events_queue (worker_id, event_type, timestamp_ms, data_json) VALUES (?, ?, ?, ?)',
    [String(workerId), String(eventType), Number(timestampMs), dataJson]
  );

  // Enforce circular buffer max across DB.
  const countRows = await execSql(
    'SELECT COUNT(*) as cnt FROM app_events_queue WHERE worker_id = ?',
    [String(workerId)]
  ).catch(() => null);

  const cnt = Number(countRows?.rows?.item?.(0)?.cnt ?? 0);
  if (Number.isFinite(cnt) && cnt > MAX_EVENTS) {
    const overflow = cnt - MAX_EVENTS;
    await execSql(
      'DELETE FROM app_events_queue WHERE worker_id = ? AND id IN (SELECT id FROM app_events_queue WHERE worker_id = ? ORDER BY timestamp_ms ASC LIMIT ?)',
      [String(workerId), String(workerId), overflow]
    ).catch(() => {});
  }
}

async function flushEvents(workerId) {
  const networkState = await getNetworkStateSafe();
  const isConnected = Boolean(networkState?.isConnected);
  if (!isConnected) return;

  await ensureSchema();
  const db = await getDb();
  const rows = await db.getAllAsync(
    `SELECT id, event_type, timestamp_ms, data_json FROM app_events_queue WHERE worker_id = ? ORDER BY timestamp_ms ASC LIMIT ?`,
    [String(workerId), MAX_EVENTS]
  );

  if (!rows.length) return;

  const events = rows.map((r) => ({
    type: r.event_type,
    timestamp: new Date(Number(r.timestamp_ms)).toISOString(),
    data: JSON.parse(r.data_json || '{}'),
  }));

  try {
    await api.post(`/workers/${workerId}/app-events`, { events });
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    await execSql(`DELETE FROM app_events_queue WHERE id IN (${placeholders})`, ids);
  } catch (_) {
    // Keep events until next flush.
  }
}

export function logAppOpen() {
  if (!telemetryActive) return;
  void (async () => {
    const workerId = await SecureStore.getItemAsync(ACTIVE_WORKER_ID_KEY).catch(() => null);
    if (!workerId) return;
    const timestampMs = Date.now();
    eventBuffer = [...eventBuffer.slice(-MAX_EVENTS + 1), { type: 'app_open', timestampMs }];
    await logEventToDb({ workerId, eventType: 'app_open', timestampMs, data: {} }).catch(() => {});
  })();
}

export function logAppBackground() {
  if (!telemetryActive) return;
  void (async () => {
    const workerId = await SecureStore.getItemAsync(ACTIVE_WORKER_ID_KEY).catch(() => null);
    if (!workerId) return;
    const timestampMs = Date.now();
    eventBuffer = [...eventBuffer.slice(-MAX_EVENTS + 1), { type: 'app_background', timestampMs }];
    await logEventToDb({ workerId, eventType: 'app_background', timestampMs, data: {} }).catch(() => {});
  })();
}

export function startScreenVisit(screenName) {
  if (!telemetryActive) return;
  screenVisitStarts.set(String(screenName), Date.now());
}

export function endScreenVisit(screenName) {
  if (!telemetryActive) return;
  const key = String(screenName);
  const startMs = screenVisitStarts.get(key);
  if (!startMs) return;
  screenVisitStarts.delete(key);

  const durationMs = Math.max(0, Date.now() - startMs);
  void (async () => {
    const workerId = await SecureStore.getItemAsync(ACTIVE_WORKER_ID_KEY).catch(() => null);
    if (!workerId) return;
    await logEventToDb({
      workerId,
      eventType: 'screen_visit',
      timestampMs: Date.now(),
      data: { screen_name: key, duration_ms: durationMs },
    }).catch(() => {});
  })();
}

export function logButtonTap(actionName) {
  if (!telemetryActive) return;
  void (async () => {
    const workerId = await SecureStore.getItemAsync(ACTIVE_WORKER_ID_KEY).catch(() => null);
    if (!workerId) return;
    await logEventToDb({
      workerId,
      eventType: 'button_tap',
      timestampMs: Date.now(),
      data: { action_name: String(actionName) },
    }).catch(() => {});
  })();
}

export function logClaimStatusView(status) {
  if (!telemetryActive) return;
  void (async () => {
    const workerId = await SecureStore.getItemAsync(ACTIVE_WORKER_ID_KEY).catch(() => null);
    if (!workerId) return;
    await logEventToDb({
      workerId,
      eventType: 'claim_status_view',
      timestampMs: Date.now(),
      data: { status: String(status || '') },
    }).catch(() => {});
  })();
}

async function startTelemetryInternal(workerId) {
  telemetryActive = true;
  await SecureStore.setItemAsync(ACTIVE_WORKER_ID_KEY, String(workerId));
  await SecureStore.setItemAsync(TELEMETRY_ACTIVE_FLAG_KEY, '1');

  await enrollOrRefreshDeviceFingerprint(workerId);
  await ensureBackgroundPermissions().catch(() => {});

  if (!appStateSub) {
    appStateSub = AppState.addEventListener('change', (nextState) => {
      lastAppState = nextState;
      if (!telemetryActive) return;
      if (nextState === 'active') logAppOpen();
      if (nextState.match(/inactive|background/)) logAppBackground();
    });
  }

  defineBackgroundTasksIfPossible();

  // Register background fetch tasks (optional; may be unsupported in Expo Go).
  try {
    const telemetryRegistered = await TaskManager.isTaskRegisteredAsync(TELEMETRY_TASK).catch(() => false);
    if (!telemetryRegistered) {
      await BackgroundFetch.registerTaskAsync(TELEMETRY_TASK, {
        minimumInterval: GPS_MIN_INTERVAL_SEC,
        stopOnTerminate: false,
        startOnBoot: true,
      }).catch(() => {});
    }

    const eventsRegistered = await TaskManager.isTaskRegisteredAsync(EVENTS_FLUSH_TASK).catch(() => false);
    if (!eventsRegistered) {
      await BackgroundFetch.registerTaskAsync(EVENTS_FLUSH_TASK, {
        minimumInterval: EVENTS_MIN_INTERVAL_SEC,
        stopOnTerminate: false,
        startOnBoot: true,
      }).catch(() => {});
    }
  } catch (_) {}
}

async function stopTelemetryInternal() {
  telemetryActive = false;
  await SecureStore.deleteItemAsync(ACTIVE_WORKER_ID_KEY).catch(() => {});
  await SecureStore.setItemAsync(TELEMETRY_ACTIVE_FLAG_KEY, '0').catch(() => {});

  try {
    const isRegisteredTelemetry = await TaskManager.isTaskRegisteredAsync(TELEMETRY_TASK).catch(() => false);
    if (isRegisteredTelemetry) await BackgroundFetch.unregisterTaskAsync(TELEMETRY_TASK).catch(() => {});
  } catch (_) {}

  try {
    const isRegisteredEvents = await TaskManager.isTaskRegisteredAsync(EVENTS_FLUSH_TASK).catch(() => false);
    if (isRegisteredEvents) await BackgroundFetch.unregisterTaskAsync(EVENTS_FLUSH_TASK).catch(() => {});
  } catch (_) {}
}

export async function syncDeviceTelemetryToPolicy({ workerId, policyActive }) {
  // Never collect data without an active policy.
  const active = Boolean(policyActive) && workerId !== undefined && workerId !== null;
  if (active) {
    await startTelemetryInternal(workerId);
  } else {
    await stopTelemetryInternal();
  }
}

// --------------------------
// Background Task Definitions
// --------------------------

function defineBackgroundTasksIfPossible() {
  if (tasksDefined) return;
  if (typeof TaskManager?.defineTask !== 'function') return;
  try {
    TaskManager.defineTask(TELEMETRY_TASK, async () => {
      try {
        const workerId = await SecureStore.getItemAsync(ACTIVE_WORKER_ID_KEY).catch(() => null);
        if (!workerId) return BackgroundFetch.BackgroundFetchResult.NoData;

        await ensureSchema();
        await flushQueuedGpsBatches(workerId);

        const batchReadings = await collectAndBatchGpsTelemetry({ workerId });
        await sendGpsBatchOrQueue({ workerId, batchReadings });
        return BackgroundFetch.BackgroundFetchResult.NewData;
      } catch (_) {
        return BackgroundFetch.BackgroundFetchResult.Failed;
      }
    });

    TaskManager.defineTask(EVENTS_FLUSH_TASK, async () => {
      try {
        const workerId = await SecureStore.getItemAsync(ACTIVE_WORKER_ID_KEY).catch(() => null);
        if (!workerId) return BackgroundFetch.BackgroundFetchResult.NoData;
        await flushEvents(workerId);
        return BackgroundFetch.BackgroundFetchResult.NewData;
      } catch (_) {
        return BackgroundFetch.BackgroundFetchResult.Failed;
      }
    });
    tasksDefined = true;
  } catch (_) {
    // Ignore unsupported environments (Expo Go limitations).
  }
}

