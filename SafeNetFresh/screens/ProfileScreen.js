import React, { useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { CommonActions } from '@react-navigation/native';
import { useQueryClient } from '@tanstack/react-query';

import { useAuth } from '../contexts/AuthContext';
import { useClaims } from '../contexts/ClaimContext';
import { usePolicy } from '../contexts/PolicyContext';
import { useWorkerProfile } from '../hooks/useWorkerProfile';
import { navigationRef } from '../services/navigationService';
import { canonicalTierLabel } from '../utils/tierDisplay';

const LADDER = ['Newcomer', 'Verified', 'Trusted', 'Guardian', 'Champion'];

const PLATFORM_UI = {
  zomato: { bg: '#fef2f2', color: '#E23744', label: 'Zomato' },
  swiggy: { bg: '#fff7ed', color: '#EA580C', label: 'Swiggy' },
  both: { bg: '#f5f3ff', color: '#7c3aed', label: 'Both' },
  other: { bg: '#f1f5f9', color: '#475569', label: 'Other' },
};

function ladderTierIndex(score) {
  if (score === null || score === undefined || Number.isNaN(Number(score))) return 0;
  const raw = Number(score);
  const pts = raw <= 1 ? raw * 100 : raw;
  if (pts >= 85) return 4;
  if (pts >= 68) return 3;
  if (pts >= 51) return 2;
  if (pts >= 34) return 1;
  return 0;
}

function platformUi(platform) {
  const k = String(platform || 'other').toLowerCase();
  return PLATFORM_UI[k] || PLATFORM_UI.other;
}

function ProfileRow({ label, children, isLast }) {
  return (
    <View style={[styles.row, !isLast && styles.rowBorder]}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.rowValue}>{children}</View>
    </View>
  );
}

export default function ProfileScreen() {
  const { signOut, workerProfile } = useAuth();
  const { resetClaims } = useClaims();
  const { resetPolicy, policy } = usePolicy();
  const qc = useQueryClient();
  const { data: profileQuery, isLoading } = useWorkerProfile();
  const profile = profileQuery ?? workerProfile ?? null;

  const trustIdx = useMemo(() => ladderTierIndex(profile?.trust_score), [profile?.trust_score]);
  const filledCircles = trustIdx + 1;

  const policyRows = useMemo(() => {
    const h = profile?.policy_history;
    if (!Array.isArray(h)) return [];
    return h.slice(0, 3);
  }, [profile?.policy_history]);

  const onLogout = useCallback(async () => {
    try {
      await signOut();
    } catch (_) {}
    try {
      resetClaims();
    } catch (_) {}
    try {
      resetPolicy();
    } catch (_) {}
    try {
      qc.clear();
    } catch (_) {}
    requestAnimationFrame(() => {
      if (navigationRef.isReady()) {
        navigationRef.dispatch(CommonActions.reset({ index: 0, routes: [{ name: 'Onboarding' }] }));
      }
    });
  }, [signOut, resetClaims, resetPolicy, qc]);

  const plat = platformUi(profile?.platform);
  const coveragePlanLabel = useMemo(
    () => canonicalTierLabel(policy?.tier || profile?.coverage_tier),
    [policy?.tier, profile?.coverage_tier]
  );

  const initial = useMemo(() => {
    const n = String(profile?.name || '').trim();
    if (n) return n[0].toUpperCase();
    return '•';
  }, [profile?.name]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Account</Text>

      {isLoading && !profile ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color="#1a73e8" />
          <Text style={styles.loadingHint}>Loading your profile…</Text>
        </View>
      ) : null}

      <LinearGradient
        colors={['#1a73e8', '#38bdf8']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.hero}
      >
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initial}</Text>
        </View>
        <Text style={styles.heroName}>{profile?.name ? String(profile.name) : 'Your profile'}</Text>
        <Text style={styles.heroSub}>{profile?.city ? String(profile.city) : 'City not set'}</Text>
      </LinearGradient>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Details</Text>
        <ProfileRow label="Platform" isLast={false}>
          <View style={[styles.platformBadge, { backgroundColor: plat.bg }]}>
            <Text style={[styles.platformBadgeText, { color: plat.color }]}>{plat.label}</Text>
          </View>
        </ProfileRow>
        <ProfileRow label="Coverage plan" isLast={false}>
          <Text style={styles.rowValueText}>{coveragePlanLabel}</Text>
        </ProfileRow>
        <ProfileRow label="Typical daily earnings" isLast={false}>
          <Text style={styles.rowValueText}>
            {typeof profile?.avg_daily_income === 'number'
              ? `₹${Math.round(profile.avg_daily_income).toLocaleString('en-IN')}`
              : '—'}
          </Text>
        </ProfileRow>
        <ProfileRow label="Trust level" isLast>
          <View>
            <View style={styles.ladderRow}>
              {LADDER.map((_, i) => (
                <View
                  key={LADDER[i]}
                  style={[
                    styles.ladderDot,
                    i < filledCircles ? styles.ladderDotFilled : styles.ladderDotEmpty,
                  ]}
                />
              ))}
            </View>
            <Text style={styles.ladderCaption}>
              {LADDER[trustIdx]} · score{' '}
              {profile?.trust_score != null ? Number(profile.trust_score).toFixed(1) : '—'}
            </Text>
          </View>
        </ProfileRow>
      </View>

      <Text style={styles.sectionTitle}>Policy history</Text>
      <View style={styles.card}>
        {policyRows.length ? (
          policyRows.map((row, i) => {
            const active = String(row.status || '').toLowerCase() === 'active';
            const planName = canonicalTierLabel(row.plan);
            const line = `${planName} · ₹${Math.round(Number(row.weekly_premium || 0))}/wk${
              active ? ' · Active' : ''
            }`;
            return (
              <View
                key={`${row.started_at || i}-${row.plan}`}
                style={[styles.policyRow, i > 0 ? styles.policyRowBorder : null]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.policyLine}>{line}</Text>
                  <Text style={styles.policyMeta}>
                    {row.started_at ? String(row.started_at).slice(0, 10) : '—'} ·{' '}
                    {String(row.status || '—')}
                  </Text>
                </View>
              </View>
            );
          })
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
  title: { fontSize: 22, fontWeight: '900', color: '#1a1a2e', marginBottom: 16 },
  loadingWrap: { padding: 24, alignItems: 'center' },
  loadingHint: { marginTop: 10, color: '#64748b', fontWeight: '600' },
  hero: {
    borderRadius: 20,
    padding: 24,
    marginBottom: 16,
    alignItems: 'center',
  },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: 'rgba(255,255,255,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  avatarText: { fontSize: 28, fontWeight: '900', color: '#fff' },
  heroName: { fontSize: 22, fontWeight: '900', color: '#fff', textAlign: 'center' },
  heroSub: { fontSize: 14, fontWeight: '600', color: 'rgba(255,255,255,0.9)', marginTop: 6 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    marginBottom: 14,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  cardTitle: { fontSize: 12, fontWeight: '800', color: '#64748b', letterSpacing: 0.6, marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 12, gap: 12 },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: 'rgba(0,0,0,0.06)' },
  rowLabel: { width: 118, fontSize: 14, color: '#64748b', fontWeight: '700', paddingTop: 2 },
  rowValue: { flex: 1 },
  rowValueText: { fontSize: 16, color: '#1a1a2e', fontWeight: '800' },
  platformBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
  },
  platformBadgeText: { fontWeight: '900', fontSize: 14 },
  ladderRow: { flexDirection: 'row', justifyContent: 'flex-start', gap: 8 },
  ladderDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
  },
  ladderDotFilled: { backgroundColor: '#1a73e8', borderColor: '#1a73e8' },
  ladderDotEmpty: { backgroundColor: '#f1f5f9', borderColor: '#cbd5e1' },
  ladderCaption: { fontSize: 13, color: '#475569', fontWeight: '700', marginTop: 8 },
  sectionTitle: { fontSize: 15, fontWeight: '900', color: '#1a1a2e', marginBottom: 8 },
  policyRow: { paddingVertical: 10 },
  policyRowBorder: { borderTopWidth: 1, borderTopColor: 'rgba(0,0,0,0.06)' },
  policyLine: { fontSize: 14, fontWeight: '800', color: '#1a1a2e' },
  policyMeta: { fontSize: 12, color: '#777', marginTop: 4 },
  muted: { fontSize: 13, color: '#777' },
  logoutBtn: { backgroundColor: '#ffebee', borderRadius: 12, padding: 16, alignItems: 'center' },
  logoutText: { color: '#c62828', fontWeight: 'bold' },
});
