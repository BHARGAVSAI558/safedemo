import React, { useCallback, useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { FlashList } from '@shopify/flash-list';

import { useClaims } from '../contexts/ClaimContext';
import { useActiveClaims } from '../hooks/useActiveClaims';
import { usePayoutHistory } from '../hooks/usePayoutHistory';

export default function ClaimsScreen() {
  const { lastClaimUpdate } = useClaims();
  const { data: activeClaims } = useActiveClaims();
  const { data: payoutHistory } = usePayoutHistory();

  const actives = useMemo(() => (Array.isArray(activeClaims) ? activeClaims : []), [activeClaims]);
  const history = useMemo(() => (Array.isArray(payoutHistory) ? payoutHistory : []), [payoutHistory]);
  const listData = useMemo(
    () => [
      { type: 'header' },
      ...actives.slice(0, 20).map((c, i) => ({ type: 'active', item: c, key: `a-${c.id || c.claim_id || i}` })),
      ...history.slice(0, 50).map((h, i) => ({ type: 'history', item: h, key: `h-${h.id || h.claim_id || i}` })),
      ...(lastClaimUpdate ? [{ type: 'live', item: lastClaimUpdate, key: 'live' }] : []),
    ],
    [actives, history, lastClaimUpdate]
  );

  const renderItem = useCallback(({ item }) => {
    if (item.type === 'header') {
      return <Text style={styles.title}>Claims</Text>;
    }
    if (item.type === 'active') {
      const c = item.item;
      return (
        <View style={styles.row}>
          <Text style={styles.rowTitle}>{c.status ? String(c.status) : 'IN_PROGRESS'}</Text>
          <Text style={styles.rowSub}>{c.message ? String(c.message) : ''}</Text>
        </View>
      );
    }
    if (item.type === 'history') {
      const h = item.item;
      return (
        <View style={styles.row}>
          <Text style={styles.rowTitle}>{h.decision ? String(h.decision) : 'PAID'}</Text>
          <Text style={styles.rowSub}>
            Rs.{typeof h.payout === 'number' ? h.payout.toFixed(0) : h.payout ? String(h.payout) : '—'} ·{' '}
            {h.created_at ? new Date(h.created_at).toLocaleString() : ''}
          </Text>
        </View>
      );
    }
    return (
      <View style={styles.liveBox}>
        <Text style={styles.liveTitle}>Live update</Text>
        <Text style={styles.liveText}>
          {item.item.status ? String(item.item.status) : 'UPDATE'}: {item.item.message ? String(item.item.message) : ''}
        </Text>
      </View>
    );
  }, []);

  return (
    <View style={styles.container}>
      <FlashList
        data={listData}
        renderItem={renderItem}
        keyExtractor={(item) => item.key}
        estimatedItemSize={72}
        contentContainerStyle={styles.content}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f0f4ff' },
  content: { padding: 20, paddingBottom: 48 },
  title: { fontSize: 20, fontWeight: 'bold', color: '#1a1a2e', marginBottom: 16 },
  card: { backgroundColor: '#fff', borderRadius: 16, padding: 16, marginBottom: 14 },
  sectionTitle: { fontSize: 14, fontWeight: 'bold', color: '#555', marginBottom: 10 },
  muted: { fontSize: 13, color: '#888' },
  row: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: 'rgba(0,0,0,0.06)' },
  rowTitle: { fontSize: 13, fontWeight: '800', color: '#1a1a2e' },
  rowSub: { marginTop: 4, fontSize: 12, color: '#777', lineHeight: 16 },
  liveBox: { backgroundColor: '#e3f2fd', borderRadius: 16, padding: 14 },
  liveTitle: { fontSize: 13, fontWeight: 'bold', color: '#1a73e8', marginBottom: 6 },
  liveText: { fontSize: 12, color: '#1a1a2e', lineHeight: 18 },
});

