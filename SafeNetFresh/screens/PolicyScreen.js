import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Modal,
  Pressable,
  Animated,
  useColorScheme,
} from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import { policies, pools } from '../services/api';
import { usePolicy } from '../contexts/PolicyContext';
import { usePoolHealth } from '../hooks/usePoolHealth';

const TIERS = [
  { id: 'Basic', name: 'Basic', blurb: 'Essential daily protection', estWeekly: 40, maxDay: 500 },
  { id: 'Standard', name: 'Standard', blurb: 'Balanced coverage for most riders', estWeekly: 49, maxDay: 1000, popular: true },
  { id: 'Pro', name: 'Pro', blurb: 'Maximum daily payout cap', estWeekly: 58, maxDay: 2000 },
];

function riskBarColor(pct) {
  if (pct >= 70) return '#16a34a';
  if (pct >= 40) return '#ca8a04';
  return '#dc2626';
}

export default function PolicyScreen() {
  const scheme = useColorScheme() || 'light';
  const qc = useQueryClient();
  const { setPolicy, setPoolHealth } = usePolicy();
  const { data: poolHealth } = usePoolHealth();

  const [sheetOpen, setSheetOpen] = useState(false);
  const [justActivated, setJustActivated] = useState(false);
  const [activateError, setActivateError] = useState('');
  const checkScale = useRef(new Animated.Value(0)).current;

  const policyQuery = useQuery({
    queryKey: ['policy', 'current'],
    queryFn: () => policies.getCurrent(),
    staleTime: 1000 * 30,
    refetchInterval: 1000 * 60,
  });

  const poolQuery = useQuery({
    queryKey: ['poolHealth'],
    queryFn: () => pools.getHealth(),
    staleTime: 1000 * 60,
    refetchInterval: 1000 * 60,
  });

  const p = policyQuery.data;

  useEffect(() => {
    if (p) {
      setPolicy(p, p.status);
    }
  }, [p, setPolicy]);

  useEffect(() => {
    setPoolHealth(poolHealth ?? poolQuery.data ?? null);
  }, [poolHealth, poolQuery.data, setPoolHealth]);

  const status = String(p?.status || '').toLowerCase();
  const tierLabel = p?.tier || '—';
  const weekly = Number(p?.weekly_premium || 0);
  const risk = typeof p?.risk_score === 'number' ? p.risk_score : 0;
  const riskPct = Math.max(0, Math.min(100, risk));

  const poolBalance = Number(p?.pool_balance ?? poolHealth?.pool_balance ?? poolQuery.data?.pool_balance ?? 0);
  const poolUtil = Number(p?.pool_utilization_pct ?? poolHealth?.pool_utilization_pct ?? poolQuery.data?.pool_utilization_pct ?? 0);

  const statusStyle = useMemo(() => {
    if (status === 'active') return { bg: '#ecfdf5', border: '#16a34a', title: '#065f46' };
    if (status === 'expiring') return { bg: '#fffbeb', border: '#f59e0b', title: '#92400e' };
    return { bg: '#fef2f2', border: '#ef4444', title: '#991b1b' };
  }, [status]);

  const activateMutation = useMutation({
    mutationFn: (tier) => policies.activate({ tier }),
    onSuccess: async (data) => {
      await qc.invalidateQueries({ queryKey: ['policy', 'current'] });
      await qc.invalidateQueries({ queryKey: ['poolHealth'] });
      setActivateError('');
      setPolicy(data, data.status);
      setSheetOpen(false);
      setJustActivated(true);
      checkScale.setValue(0);
      Animated.spring(checkScale, { toValue: 1, friction: 6, useNativeDriver: true }).start(() => {
        setTimeout(() => {
          setJustActivated(false);
          checkScale.setValue(0);
        }, 2200);
      });
    },
    onError: (error) => {
      const detail = error?.response?.data?.detail;
      setActivateError(
        typeof detail === 'string'
          ? detail
          : 'Unable to activate plan right now. Please try again.'
      );
    },
  });

  const onActivatePress = useCallback(() => {
    setActivateError('');
    setSheetOpen(true);
  }, []);

  const colors = scheme === 'dark'
    ? { bg: '#0f172a', card: '#1e293b', text: '#f8fafc', sub: '#94a3b8' }
    : { bg: '#f0f4ff', card: '#fff', text: '#1a1a2e', sub: '#64748b' };

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.bg }]} contentContainerStyle={styles.content}>
      <Text style={[styles.title, { color: colors.text }]}>Coverage</Text>

      {justActivated ? (
        <Animated.View style={[styles.successBanner, { transform: [{ scale: checkScale }] }]}>
          <Text style={styles.successIcon}>✓</Text>
          <Text style={styles.successText}>Coverage activated</Text>
        </Animated.View>
      ) : null}

      {activateError ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{activateError}</Text>
        </View>
      ) : null}

      <View style={[styles.statusCard, { backgroundColor: statusStyle.bg, borderColor: statusStyle.border }]}>
        <Text style={[styles.statusLabel, { color: statusStyle.title }]}>Status</Text>
        <Text style={[styles.statusValue, { color: statusStyle.title }]}>
          {status === 'active' ? 'Active' : status === 'expiring' ? 'Expiring soon' : 'Inactive'}
        </Text>
        <Text style={[styles.statusHint, { color: colors.sub }]}>
          {p?.days_remaining != null && status !== 'inactive'
            ? `${p.days_remaining} day(s) left in current period`
            : 'Activate a plan to stay protected'}
        </Text>
      </View>

      <View style={[styles.card, { backgroundColor: colors.card }]}>
        <Text style={[styles.label, { color: colors.sub }]}>Weekly premium</Text>
        <Text style={[styles.premiumLine, { color: colors.text }]}>
          {weekly > 0 ? `₹${weekly}/week — ${tierLabel} tier` : '—'}
        </Text>
        {p?.valid_until ? (
          <Text style={[styles.meta, { color: colors.sub }]}>Renews / period ends: {String(p.valid_until).slice(0, 10)}</Text>
        ) : null}
      </View>

      <View style={[styles.card, { backgroundColor: colors.card }]}>
        <Text style={[styles.label, { color: colors.sub }]}>Risk score</Text>
        <View style={styles.riskRow}>
          <View style={[styles.riskTrack, { backgroundColor: scheme === 'dark' ? '#334155' : '#e2e8f0' }]}>
            <View
              style={[
                styles.riskFill,
                { width: `${riskPct}%`, backgroundColor: riskBarColor(riskPct) },
              ]}
            />
          </View>
          <Text style={[styles.riskNum, { color: colors.text }]}>{riskPct.toFixed(0)}</Text>
        </View>
        <Text style={[styles.meta, { color: colors.sub }]}>Based on your trust profile (0–100)</Text>
      </View>

      <View style={[styles.card, { backgroundColor: colors.card }]}>
        <Text style={[styles.label, { color: colors.sub }]}>Zone pool</Text>
        <Text style={[styles.poolLine, { color: colors.text }]}>
          Zone pool: ₹{Math.round(poolBalance).toLocaleString('en-IN')} available — {poolUtil.toFixed(0)}% utilized this week
        </Text>
        {p?.zone ? <Text style={[styles.meta, { color: colors.sub }]}>Area: {p.zone}</Text> : null}
      </View>

      <TouchableOpacity style={styles.cta} onPress={onActivatePress} activeOpacity={0.85}>
        <Text style={styles.ctaText}>Activate coverage</Text>
      </TouchableOpacity>

      <Modal visible={sheetOpen} animationType="slide" transparent onRequestClose={() => setSheetOpen(false)}>
        <Pressable style={styles.sheetOverlay} onPress={() => !activateMutation.isPending && setSheetOpen(false)}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.sheetTitle}>Choose your plan</Text>
            {TIERS.map((t) => (
              <View key={t.id} style={[styles.tierCard, t.popular && styles.tierPopular]}>
                {t.popular ? (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>Most Popular</Text>
                  </View>
                ) : null}
                <Text style={styles.tierName}>{t.name}</Text>
                <Text style={styles.tierPrice}>~₹{t.estWeekly}/week est.</Text>
                <Text style={styles.tierMax}>Max ₹{t.maxDay.toLocaleString('en-IN')}/day payout</Text>
                <Text style={styles.tierBlurb}>{t.blurb}</Text>
                <TouchableOpacity
                  style={[styles.pickBtn, activateMutation.isPending && { opacity: 0.6 }]}
                  disabled={activateMutation.isPending}
                  onPress={() => activateMutation.mutate(t.id)}
                >
                  <Text style={styles.pickBtnText}>{activateMutation.isPending ? 'Activating…' : `Select ${t.name}`}</Text>
                </TouchableOpacity>
              </View>
            ))}
            <TouchableOpacity style={styles.cancelBtn} onPress={() => setSheetOpen(false)}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 20, paddingBottom: 48 },
  title: { fontSize: 22, fontWeight: '800', marginBottom: 16 },
  successBanner: {
    alignItems: 'center',
    backgroundColor: '#ecfdf5',
    borderRadius: 16,
    padding: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#16a34a',
  },
  successIcon: { fontSize: 40, color: '#16a34a', fontWeight: '900' },
  successText: { fontSize: 16, fontWeight: '800', color: '#065f46', marginTop: 6 },
  errorBanner: {
    backgroundColor: '#fef2f2',
    borderRadius: 16,
    padding: 14,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#ef4444',
  },
  errorText: { color: '#991b1b', fontSize: 14, fontWeight: '700' },
  statusCard: {
    borderRadius: 16,
    padding: 16,
    marginBottom: 14,
    borderWidth: 2,
  },
  statusLabel: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', marginBottom: 4 },
  statusValue: { fontSize: 22, fontWeight: '900' },
  statusHint: { fontSize: 13, marginTop: 8 },
  card: { borderRadius: 16, padding: 16, marginBottom: 14, shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 8 },
  label: { fontSize: 13, marginBottom: 8, fontWeight: '600' },
  premiumLine: { fontSize: 20, fontWeight: '900' },
  poolLine: { fontSize: 16, fontWeight: '700', lineHeight: 22 },
  meta: { fontSize: 12, marginTop: 8 },
  riskRow: { flexDirection: 'row', alignItems: 'center' },
  riskTrack: { flex: 1, height: 12, borderRadius: 8, overflow: 'hidden' },
  riskFill: { height: '100%', borderRadius: 8 },
  riskNum: { fontSize: 16, fontWeight: '900', minWidth: 36, textAlign: 'right', marginLeft: 10 },
  cta: {
    backgroundColor: '#1a73e8',
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  ctaText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  sheetOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.5)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 18,
    paddingBottom: 28,
    maxHeight: '88%',
  },
  sheetTitle: { fontSize: 18, fontWeight: '900', marginBottom: 14, color: '#0f172a' },
  tierCard: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
  },
  tierPopular: { borderColor: '#1a73e8', borderWidth: 2 },
  badge: {
    alignSelf: 'flex-start',
    backgroundColor: '#1a73e8',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    marginBottom: 8,
  },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  tierName: { fontSize: 18, fontWeight: '900', color: '#0f172a' },
  tierPrice: { fontSize: 15, fontWeight: '700', color: '#334155', marginTop: 4 },
  tierMax: { fontSize: 13, color: '#64748b', marginTop: 4 },
  tierBlurb: { fontSize: 12, color: '#94a3b8', marginTop: 6 },
  pickBtn: {
    marginTop: 12,
    backgroundColor: '#0f172a',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  pickBtnText: { color: '#fff', fontWeight: '800' },
  cancelBtn: { paddingVertical: 14, alignItems: 'center' },
  cancelText: { color: '#64748b', fontWeight: '700' },
});
