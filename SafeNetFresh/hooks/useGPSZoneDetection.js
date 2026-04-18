import { useState } from 'react';
import { Platform } from 'react-native';
import * as Location from 'expo-location';
import { zones } from '../services/api';
import { formatShortLocation } from '../utils/locationDisplay';

/** Open-Meteo reverse lookup — works on web where Expo Geocoding was removed (SDK 49+). */
async function reverseGeocodeOpenMeteo(latitude, longitude) {
  try {
    const u = `https://geocoding-api.open-meteo.com/v1/reverse?latitude=${encodeURIComponent(
      String(latitude)
    )}&longitude=${encodeURIComponent(String(longitude))}&language=en`;
    const res = await fetch(u);
    if (!res.ok) return { placeName: null, cityName: null };
    const data = await res.json();
    const r = data?.results?.[0];
    if (!r) return { placeName: null, cityName: null };
    const placeName = r.name || r.admin4 || r.admin3 || null;
    const cityName = r.admin2 || r.admin1 || r.name || null;
    return { placeName, cityName };
  } catch {
    return { placeName: null, cityName: null };
  }
}

export function useGPSZoneDetection() {
  const [gpsLoading, setGpsLoading] = useState(false);
  const [gpsError, setGpsError] = useState('');

  const detectZone = async (input = null) => {
    setGpsLoading(true);
    setGpsError('');
    try {
      let latitude = Number(input?.lat);
      let longitude = Number(input?.lng);
      let placeName = input?.placeName || null;
      let cityName = null;

      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          setGpsError('Location permission denied. Please enable it in settings.');
          return null;
        }
        const location = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Highest,
        });
        latitude = Number(location.coords?.latitude);
        longitude = Number(location.coords?.longitude);
      }

      const om = await reverseGeocodeOpenMeteo(latitude, longitude);
      if (om.placeName) placeName = placeName || om.placeName;
      if (om.cityName) cityName = om.cityName;

      if (Platform.OS !== 'web') {
        try {
          const reverse = await Location.reverseGeocodeAsync({ latitude, longitude });
          if (Array.isArray(reverse) && reverse.length > 0) {
            const row = reverse[0];
            placeName = placeName || row?.district || row?.subregion || row?.street || row?.name || null;
            cityName = cityName || row?.city || row?.subregion || row?.region || null;
          }
        } catch {
          // Expo geocode optional; Open-Meteo already filled when available.
        }
      }

      const detected = await zones.detectFromGPS(latitude, longitude);
      if (!detected?.zone_id) {
        throw new Error('Zone detection failed');
      }

      const zoneId = String(detected.zone_id);
      const svcCity = detected?.city ? String(detected.city) : null;
      const svcName = detected?.zone_name ? String(detected.zone_name) : null;
      const rawLabel = [placeName, cityName || svcCity].filter(Boolean).join(', ') || svcName || svcCity || zoneId;
      const displayName = formatShortLocation(rawLabel) || rawLabel;
      const riskRaw = String(detected?.risk_label || detected?.risk_level || 'MEDIUM').toUpperCase();

      setGpsError('');
      return {
        id: zoneId,
        label: displayName,
        badge: riskRaw,
        score: riskRaw === 'HIGH' ? 80 : riskRaw === 'LOW' ? 50 : 65,
        riskLevel: riskRaw === 'HIGH' ? 'high' : riskRaw === 'LOW' ? 'low' : 'medium',
        city: cityName || svcCity || displayName,
        lat: latitude,
        lng: longitude,
        placeName: formatShortLocation(placeName || displayName) || (placeName || displayName),
        zone_name: svcName,
      };
    } catch (e) {
      setGpsError(e?.message || 'GPS detection failed');
    } finally {
      setGpsLoading(false);
    }
    return null;
  };

  return { detectZone, gpsLoading, gpsError };
}
