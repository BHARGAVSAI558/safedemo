import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, Linking } from 'react-native';

import * as Location from 'expo-location';

import { useAuth } from '../contexts/AuthContext';
import { usePolicy } from '../contexts/PolicyContext';
import { startGpsTracking, stopGpsTracking } from '../services/location.service';

export default function LocationGate() {
  const { userId } = useAuth();
  const { coverageStatus } = usePolicy();

  const shouldTrack = useMemo(() => String(coverageStatus || '').toUpperCase() === 'ACTIVE', [coverageStatus]);

  const [permissionState, setPermissionState] = useState('unknown');
  const [showDenied, setShowDenied] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!shouldTrack) {
        await stopGpsTracking().catch(() => {});
        if (!cancelled) setShowDenied(false);
        return;
      }

      const current = await Location.getForegroundPermissionsAsync();
      if (cancelled) return;

      if (current?.status === 'granted') {
        setPermissionState('granted');
        try {
          await Location.requestBackgroundPermissionsAsync();
        } catch (_) {}
        await startGpsTracking({ workerId: userId }).catch(() => {});
        return;
      }

      if (current?.status === 'denied') {
        setPermissionState('denied');
        setShowDenied(true);
        return;
      }

      const req = await Location.requestForegroundPermissionsAsync();
      if (cancelled) return;
      if (req?.status === 'granted') {
        setPermissionState('granted');
        try {
          await Location.requestBackgroundPermissionsAsync();
        } catch (_) {}
        await startGpsTracking({ workerId: userId }).catch(() => {});
      } else {
        setPermissionState('denied');
        setShowDenied(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [shouldTrack, userId]);

  return (
    <Modal visible={showDenied} transparent animationType="fade">
      <View style={styles.modalBg}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>Location permission needed</Text>
          <Text style={styles.modalText}>We need location access to monitor disruptions and protect your payouts.</Text>
          <TouchableOpacity
            style={styles.settingsBtn}
            onPress={() => {
              setShowDenied(false);
              Linking.openSettings();
            }}
          >
            <Text style={styles.settingsBtnText}>Open Settings</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.closeBtn} onPress={() => setShowDenied(false)}>
            <Text style={styles.closeBtnText}>Not now</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 20 },
  modalCard: { backgroundColor: '#fff', borderRadius: 16, padding: 16 },
  modalTitle: { fontSize: 16, fontWeight: '900', color: '#1a1a2e', marginBottom: 8 },
  modalText: { fontSize: 13, color: '#666', lineHeight: 18, marginBottom: 14 },
  settingsBtn: { backgroundColor: '#1a73e8', borderRadius: 12, padding: 14, alignItems: 'center' },
  settingsBtnText: { color: '#fff', fontWeight: '900' },
  closeBtn: { paddingVertical: 10, alignItems: 'center' },
  closeBtnText: { color: '#1a73e8', fontWeight: '900' },
});

