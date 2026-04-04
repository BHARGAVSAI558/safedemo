import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as Cellular from 'expo-cellular';

import api from './api';

export const LOCATION_TASK = 'LOCATION_TASK_GPS_TRAIL';

let workerIdForTracking = null;
let bufferedPoints = [];
let lastFlushAt = 0;
let accelerometerMagnitudeAvg = null;
let accelerometerMagnitudes = [];
const ACCEL_WINDOW_SIZE = 5;

let accelerometerSub = null;

function computeMagnitude({ x, y, z }) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return Math.sqrt(x * x + y * y + z * z);
}

export async function startGpsTracking({ workerId }) {
  if (!workerId) return;
  workerIdForTracking = workerId;

  // Start background task if not already running.
  const isRunning = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
  if (!isRunning) {
    await Location.startLocationUpdatesAsync(LOCATION_TASK, {
      accuracy: Location.Accuracy.BestForNavigation,
      timeInterval: 5000,
      distanceInterval: 0,
      showsBackgroundLocationIndicator: false,
      pausesUpdatesAutomatically: false,
      foregroundService: true,
      activityType: Location.ActivityType.AutomotiveNavigation,
      deferredUpdatesInterval: 0,
      // allow background updates
      // eslint-disable-next-line camelcase
      foregroundServiceDelay: 0,
    });
  }

  // Foreground accelerometer subscription (best-effort for payload).
  // eslint-disable-next-line global-require
  const { Accelerometer } = require('expo-sensors');
  const subscription = Accelerometer.addListener((reading) => {
    const magnitude = computeMagnitude(reading);
    if (magnitude === null) return;
    accelerometerMagnitudes.push(magnitude);
    if (accelerometerMagnitudes.length > ACCEL_WINDOW_SIZE) accelerometerMagnitudes.shift();
    const sum = accelerometerMagnitudes.reduce((acc, v) => acc + v, 0);
    accelerometerMagnitudeAvg = sum / accelerometerMagnitudes.length;
  });
  accelerometerSub = subscription;
  Accelerometer.setUpdateInterval(1000);
}

export async function stopGpsTracking() {
  workerIdForTracking = null;
  bufferedPoints = [];
  lastFlushAt = 0;

  const isRunning = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
  if (isRunning) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK).catch(() => {});
  }

  try {
    accelerometerSub?.remove?.();
  } catch (_) {}
  accelerometerSub = null;
  accelerometerMagnitudeAvg = null;
  accelerometerMagnitudes = [];
}

async function flushBufferIfNeeded() {
  if (!workerIdForTracking) return;
  if (!bufferedPoints.length) return;

  const now = Date.now();
  if (!lastFlushAt) lastFlushAt = now;
  if (now - lastFlushAt < 1000 * 60 * 5) return;

  const pointsToSend = bufferedPoints;
  bufferedPoints = [];
  lastFlushAt = now;

  const payload = {
    gps_trail: pointsToSend,
    accelerometer_magnitude_avg: accelerometerMagnitudeAvg,
  };

  try {
    await api.workers.uploadGPSTrail(workerIdForTracking, payload);
  } catch (_) {
    // Best effort: keep points for next flush.
    bufferedPoints = pointsToSend.concat(bufferedPoints);
  }
}

try {
  TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
    if (error) return;
    if (!data?.locations?.length) return;
    if (!workerIdForTracking) return;

  for (const loc of data.locations) {
    const lat = loc?.coords?.latitude;
    const lon = loc?.coords?.longitude;
    const timestamp = loc?.timestamp ? new Date(loc.timestamp).toISOString() : new Date().toISOString();
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    let cell = null;
    try {
      const gen = await Cellular.getCellularGenerationAsync();
      const carrier = await Cellular.getCarrierNameAsync();
      cell = { generation: gen, carrier };
    } catch (_) {}

    bufferedPoints.push({
      lat,
      lon,
      timestamp,
      cell_tower_id: cell?.carrier || null,
      accelerometer_magnitude: accelerometerMagnitudeAvg,
    });
  }

    await flushBufferIfNeeded();
  });
} catch (_) {}

