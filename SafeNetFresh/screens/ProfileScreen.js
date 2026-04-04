import React, { useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator } from 'react-native';
import { CommonActions } from '@react-navigation/native';

import { useAuth } from '../contexts/AuthContext';
import { useWorkerProfile } from '../hooks/useWorkerProfile';
import { navigationRef } from '../services/navigationService';
import { trustLabelOnly } from '../utils/trustBadge';

function formatOccupation(o) {
  if (!o) return '—';
  const s = String(o).replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default function ProfileScreen() {
  const { signOut } = useAuth();
  const { data: profile, isLoading } = useWorkerProfile();

  const trust = trustLabelOnly(profile?.trust_score);

  const onLogout = useCallback(async () => {
    await signOut();
    requestAnimationFrame(() => {
      if (navigationRef.isReady()) {
        navigationRef.dispatch(CommonActions.reset({ index: 0, routes: [{ name: 'Onboarding' }] }));
      }
    });
  }, [signOut]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Account</Text>

      {isLoading && !profile ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color="#1a73e8" />
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.label}>Name</Text>
        <Text style={styles.value}>{profile?.name ? String(profile.name) : '—'}</Text>

        <Text style={styles.label}>City</Text>
        <Text style={styles.value}>{profile?.city ? String(profile.city) : '—'}</Text>

        <Text style={styles.label}>Occupation</Text>
        <View style={styles.pillWrap}>
          <View style={styles.pill}>
            <Text style={styles.pillText}>{formatOccupation(profile?.occupation)}</Text>
          </View>
        </View>

        <Text style={styles.label}>Avg. daily income</Text>
        <Text style={styles.value}>
          {typeof profile?.avg_daily_income === 'number' ? `₹${Math.round(profile.avg_daily_income)}` : '—'}
        </Text>

        <Text style={styles.label}>Trust score</Text>
        <Text style={styles.value}>
          {trust.points != null ? `${Math.round(trust.points)} · ${trust.short}` : '—'}
        </Text>
      </View>

      <Text style={styles.sectionTitle}>Policy history</Text>
      <View style={styles.card}>
        {Array.isArray(profile?.policy_history) && profile.policy_history.length ? (
          profile.policy_history.map((row, i) => (
            <View
              key={`${row.started_at || i}-${row.plan}`}
              style={[styles.policyRow, i > 0 ? styles.policyRowBorder : null]}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.policyPlan}>{row.plan} plan</Text>
                <Text style={styles.policyMeta}>
                  {row.started_at ? String(row.started_at).slice(0, 10) : '—'} · {String(row.status || '—')}
                </Text>
              </View>
              <Text style={styles.policyPrem}>₹{Math.round(Number(row.weekly_premium || 0))}/wk</Text>
            </View>
          ))
        ) : (
          <Text style={styles.muted}>No policy history yet.</Text>
        )}
      </View>

      <TouchableOpacity style={styles.logoutBtn} onPress={() => void onLogout()}>
        <Text style={styles.logoutText}>Logout</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f0f4ff' },
  content: { padding: 20, paddingBottom: 48 },
  title: { fontSize: 20, fontWeight: 'bold', color: '#1a1a2e', marginBottom: 16 },
  loadingWrap: { padding: 24, alignItems: 'center' },
  card: { backgroundColor: '#fff', borderRadius: 16, padding: 16, marginBottom: 14 },
  label: { fontSize: 13, color: '#777', fontWeight: '600', marginTop: 10 },
  value: { fontSize: 16, color: '#1a1a2e', fontWeight: '800', marginTop: 6 },
  pillWrap: { marginTop: 8, alignSelf: 'flex-start' },
  pill: {
    alignSelf: 'flex-start',
    backgroundColor: '#e8f0fe',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  pillText: { color: '#1a73e8', fontWeight: '800', fontSize: 13 },
  sectionTitle: { fontSize: 15, fontWeight: '900', color: '#1a1a2e', marginBottom: 8 },
  policyRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  policyRowBorder: { borderTopWidth: 1, borderTopColor: 'rgba(0,0,0,0.06)' },
  policyPlan: { fontSize: 14, fontWeight: '800', color: '#1a1a2e' },
  policyMeta: { fontSize: 12, color: '#777', marginTop: 4 },
  policyPrem: { fontSize: 13, fontWeight: '800', color: '#1a73e8' },
  muted: { fontSize: 13, color: '#777' },
  logoutBtn: { backgroundColor: '#ffebee', borderRadius: 12, padding: 16, alignItems: 'center' },
  logoutText: { color: '#c62828', fontWeight: 'bold' },
});
