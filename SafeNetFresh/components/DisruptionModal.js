import React, { useEffect, useMemo, useState } from 'react';
import { Modal, View, Text, StyleSheet } from 'react-native';

import { useClaims } from '../contexts/ClaimContext';

export default function DisruptionModal() {
  const { disruptionAlert, clearDisruptionAlert } = useClaims();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!disruptionAlert?.visible) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [disruptionAlert?.visible]);

  const countdownSeconds = useMemo(() => {
    if (!disruptionAlert?.visible) return 0;
    const countdown = Number(disruptionAlert.countdown_seconds ?? 0);
    if (Number.isFinite(countdown) && countdown > 0) return Math.max(0, countdown);
    const receivedAt = Number(disruptionAlert.received_at ?? now);
    if (!receivedAt) return 0;
    const endsAt = Number(disruptionAlert.ends_at ?? 0);
    if (endsAt > 0) {
      return Math.max(0, Math.ceil((endsAt - now) / 1000));
    }
    return 0;
  }, [disruptionAlert, now]);

  const visible = Boolean(disruptionAlert?.visible);

  useEffect(() => {
    if (!visible) return;
    if (countdownSeconds > 0) return;
    const t = setTimeout(() => clearDisruptionAlert(), 500);
    return () => clearTimeout(t);
  }, [visible, countdownSeconds, clearDisruptionAlert]);

  return (
    <Modal visible={visible} animationType="slide" transparent={false}>
      <View style={styles.container}>
        <Text style={styles.title}>Disruption Alert</Text>
        <Text style={styles.subtitle}>
          {disruptionAlert?.event_type ? String(disruptionAlert.event_type) : 'Impact in your zone'}
        </Text>
        <Text style={styles.timer}>
          {countdownSeconds > 0 ? `${countdownSeconds}s` : 'Calculating...'}
        </Text>
        <Text style={styles.tip}>Stay alert. Your payouts may be affected during this period.</Text>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0b1020',
    padding: 20,
    justifyContent: 'center',
  },
  title: { color: '#fff', fontSize: 26, fontWeight: '800', textAlign: 'center', marginBottom: 10 },
  subtitle: { color: 'rgba(255,255,255,0.85)', fontSize: 14, textAlign: 'center', marginBottom: 14 },
  timer: { color: '#ff6f00', fontSize: 56, fontWeight: '900', textAlign: 'center', marginBottom: 12 },
  tip: { color: 'rgba(255,255,255,0.65)', fontSize: 14, textAlign: 'center', marginTop: 8, lineHeight: 20 },
});

