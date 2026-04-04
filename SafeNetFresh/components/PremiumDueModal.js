import React, { useMemo, useState, useEffect } from 'react';
import { Modal, View, Text, StyleSheet, TouchableOpacity } from 'react-native';

import { useClaims } from '../contexts/ClaimContext';

export default function PremiumDueModal() {
  const { premiumDue, clearPremiumDue } = useClaims();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!premiumDue) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [premiumDue]);

  const visible = Boolean(premiumDue?.visible) || Boolean(premiumDue);

  const title = useMemo(() => premiumDue?.title || 'Premium Due', [premiumDue]);
  const body = useMemo(() => premiumDue?.message || 'Please pay your weekly premium to stay protected.', [premiumDue]);

  return (
    <Modal visible={visible} animationType="fade" transparent={false}>
      <View style={styles.container}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.body}>{body}</Text>
        <TouchableOpacity style={styles.btn} onPress={clearPremiumDue}>
          <Text style={styles.btnText}>OK</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff', justifyContent: 'center', padding: 20, alignItems: 'center' },
  title: { fontSize: 26, fontWeight: '900', color: '#1a1a2e', marginBottom: 12, textAlign: 'center' },
  body: { fontSize: 14, color: '#333', textAlign: 'center', lineHeight: 20, marginBottom: 20 },
  btn: { backgroundColor: '#1a73e8', borderRadius: 12, paddingHorizontal: 22, paddingVertical: 14 },
  btnText: { color: '#fff', fontWeight: '900' },
});

