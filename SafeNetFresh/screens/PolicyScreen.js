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
  RefreshControl,
} from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import { policies, zones as zonesApi } from '../services/api';
import { usePolicy } from '../contexts/PolicyContext';
import { useWorkerProfile } from '../hooks/useWorkerProfile';
import { canonicalTierLabel } from '../utils/tierDisplay';

function policySnapshotFromActivate(activated, prev) {
  const validUntil = activated?.valid_until;
  let days_remaining = 0;
  if (validUntil) {
    const end = new Date(validUntil).getTime();
    if (!Number.isNaN(end)) {
      days_remaining = Math.max(0, Math.ceil((end - Date.now()) / 86400000));
    }
  }
  let st = 'active';
  if (days_remaining <= 0) st = 'inactive';
  else if (days_remaining < 3) st = 'expiring';
  return {
    status: st,
    tier: activated.tier,
    weekly_premium: Number(activated.weekly_premium || 0),
    valid_until: validUntil,
    days_remaining,
    max_coverage_per_day: Number(activated.max_coverage_per_day || 0),
    risk_score: Number(activated.risk_score ?? prev?.risk_score ?? 0),
    zone: activated.city || prev?.zone || '',
    pool_balance: Number(prev?.pool_balance ?? 0),
    pool_utilization_pct: Number(prev?.pool_utilization_pct ?? 0),
    policy_id: activated.id,
    message: null,
  };
}

const TIERS = [
  { id: 'Basic', name: 'Basic', blurb: 'Essential daily protection', listWeekly: 35, maxDay: 350 },
  { id: 'Standard', name: 'Standard', blurb: 'Balanced coverage for most riders', listWeekly: 49, maxDay: 500, popular: true },
  { id: 'Pro', name: 'Pro', blurb: 'Maximum daily payout cap', listWeekly: 70, maxDay: 700 },
];

function riskBarColor(pct) {
  if (pct >= 70) return '#16a34a';
  if (pct >= 40) return '#ca8a04';
  return '#dc2626';
}

function formatUntil(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return String(iso).slice(0, 10);
  }
}

function buildOutlook14(zoneId) {
  const z = String(zoneId || 'hyd_central');
  const seed = Array.from(z).reduce((a, c) => a + c.charCodeAt(0), 0);
  const days = [];
  const now = new Date();
  for (let i = 0; i < 14; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    const r = (seed + i * 31) % 100;
    let icon = '⛅';
    let tag = 'Clear';
    let tone = '#64748b';
    if (r > 78) {
      icon = '☔';
      tag = 'Wet';
      tone = '#1d4ed8';
    } else if (r > 55) {
      icon = '🌤️';
      tag = 'Mixed';
      tone = '#ca8a04';
    } else if (r < 18) {
      icon = '🌡️';
      tag = 'Hot';
      tone = '#dc2626';
    }
    days.push({
      key: i,
      dow: d.toLocaleDateString('en-IN', { weekday: 'short' }),
      dayNum: d.getDate(),
      icon,
      tag,
      tone,
    });
  }
  return days;
}

export default function PolicyScreen() {
  const scheme = useColorScheme() || 'light';
  const qc = useQueryClient();
  const { setPolicy } = usePolicy();
  const { data: worker } = useWorkerProfile();

  const [sheetOpen, setSheetOpen] = useState(false);
  const [justActivated, setJustActivated] = useState(false);
  const [activateError, setActivateError] = useState('');
  const checkScale = useRef(new Animated.Value(0)).current;

  const zoneId = useMemo(() => {
    const z = worker?.zone_id;
    if (z && String(z).trim() && String(z) !== 'unknown' && String(z) !== 'default') return String(z).trim();
    return 'hyd_central';
  }, [worker?.zone_id]);

  const policyQuery = useQuery({
    queryKey: ['policy', 'current'],
    queryFn: () => policies.getCurrent(),
    staleTime: 1000 * 30,
    refetchInterval: 1000 * 120,
  });

  const forecastQuery = useQuery({
    queryKey: ['forecastShield', 'policy', zoneId],
    queryFn: () => zonesApi.getForecastShield(zoneId),
    enabled: Boolean(zoneId),
    staleTime: 1000 * 60 * 5,
  });

  const p = policyQuery.data;
  const outlookDays = useMemo(() => buildOutlook14(zoneId), [zoneId]);

  useEffect(() => {
    if (p) {
      setPolicy(p, p.status);
    }
  }, [p, setPolicy]);

  const status = String(p?.status || '').toLowerCase();
  const isCovered = status === 'active' || status === 'expiring';
  const tierLabel = canonicalTierLabel(p?.tier);
  const weekly = Number(p?.weekly_premium || 0);
  const maxDay = Number(p?.max_coverage_per_day || 0);
  const risk = typeof p?.risk_score === 'number' ? p.risk_score : 0;
  const riskPct = Math.max(0, Math.min(100, risk));
  const daysLeft = Number(p?.days_remaining ?? 0);

  const statusStyle = useMemo(() => {
    if (status === 'active') return { bg: '#ecfdf5', border: '#16a34a', title: '#065f46' };
    if (status === 'expiring') return { bg: '#fffbeb', border: '#f59e0b', title: '#92400e' };
    return { bg: '#fef2f2', border: '#ef4444', title: '#991b1b' };
  }, [status]);

  const activateMutation = useMutation({
    mutationFn: (tier) => policies.activate({ tier }),
    onSuccess: async (activated) => {
      setActivateError('');
      const prev = qc.getQueryData(['policy', 'current']);
      const snapshot = policySnapshotFromActivate(activated, prev);
      qc.setQueryData(['policy', 'current'], snapshot);
      setPolicy(snapshot, snapshot.status);
      setSheetOpen(false);
      setJustActivated(true);
      checkScale.setValue(0);
      Animated.spring(checkScale, { toValue: 1, friction: 6, useNativeDriver: true }).start(() => {
        setTimeout(() => {
          setJustActivated(false);
          checkScale.setValue(0);
        }, 2200);
      });
      await qc.invalidateQueries({ queryKey: ['policy', 'current'] });
      await qc.refetchQueries({ queryKey: ['policy', 'current'] });
      await qc.invalidateQueries({ queryKey: ['workerProfile'] });
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

  const pendingTierId = activateMutation.isPending ? activateMutation.variables : null;

  const onActivatePress = useCallback(() => {
    setActivateError('');
    setSheetOpen(true);
  }, []);

  const onRefresh = useCallback(() => {
    void policyQuery.refetch();
    void forecastQuery.refetch();
  }, [policyQuery.refetch, forecastQuery.refetch]);

  const refreshing = policyQuery.isRefetching || forecastQuery.isRefetching;

  const colors = scheme === 'dark'
    ? { bg: '#0f172a', card: '#1e293b', text: '#f8fafc', sub: '#94a3b8' }
    : { bg: '#f0f4ff', card: '#fff', text: '#1a1a2e', sub: '#64748b' };

  const shieldHint = forecastQuery.data?.shields?.[0]?.subtitle;
  const currentTierCanon = canonicalTierLabel(p?.tier);

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.bg }]}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={Boolean(refreshing)} onRefresh={onRefresh} />}
    >
      <Text style={[styles.title, { color: colors.text }]}>Coverage</Text>

      {justActivated ? (
        <Animated.View style={[styles.successBanner, { transform: [{ scale: checkScale }] }]}>
          <Text style={styles.successIcon}>✓</Text>
          <Text style={styles.successText}>Plan saved</Text>
        </Animated.View>
      ) : null}

      {activateError ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{activateError}</Text>
        </View>
      ) : null}

      {isCovered ? (
        <View style={[styles.activeCard, { backgroundColor: statusStyle.bg, borderColor: statusStyle.border }]}>
          <Text style={[styles.activeTitle, { color: statusStyle.title }]}>Coverage Active</Text>
          <Text style={[styles.activeDays, { color: statusStyle.title }]}>
            {daysLeft} day{daysLeft === 1 ? '' : 's'} remaining in this period
          </Text>
          <TouchableOpacity style={styles.renewBtn} disabled>
            <Text style={styles.renewBtnText}>Renew for next week</Text>
            <Text style={styles.renewHint}>Renews automatically on Monday</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.changePlanBtn} onPress={onActivatePress} activeOpacity={0.88}>
            <Text style={styles.changePlanBtnText}>Change plan</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={[styles.statusCard, { backgroundColor: statusStyle.bg, borderColor: statusStyle.border }]}>
          <Text style={[styles.statusLabel, { color: statusStyle.title }]}>Status</Text>
          <Text style={[styles.statusValue, { color: statusStyle.title }]}>Not covered</Text>
          <Text style={[styles.statusHint, { color: colors.sub }]}>Activate a plan to stay protected on the road.</Text>
        </View>
      )}

      <View style={[styles.card, { backgroundColor: colors.card }]}>
        <Text style={[styles.label, { color: colors.sub }]}>Plan details</Text>
        <Text style={[styles.detailLine, { color: colors.text }]}>Tier: {tierLabel}</Text>
        <Text style={[styles.detailLine, { color: colors.text }]}>
          Weekly premium: {weekly > 0 ? `₹${weekly}/week` : '—'}
        </Text>
        <Text style={[styles.detailLine, { color: colors.text }]}>
          Max per disruption day: {maxDay > 0 ? `₹${Math.round(maxDay).toLocaleString('en-IN')}` : '—'}
        </Text>
        <Text style={[styles.detailLine, { color: colors.text }]}>
          Valid until: {formatUntil(p?.valid_until)}
        </Text>
        {p?.zone ? <Text style={[styles.meta, { color: colors.sub }]}>Zone: {p.zone}</Text> : null}
      </View>

      <View style={[styles.card, { backgroundColor: colors.card }]}>
        <Text style={[styles.label, { color: colors.sub }]}>Next 14 days — weather outlook</Text>
        <Text style={[styles.outlookDisclaimer, { color: colors.sub }]}>
          Indicative calendar for your area. If several days look rough, consider upgrading tier below.
        </Text>
        {shieldHint ? (
          <Text style={[styles.forecastInline, { color: colors.text }]}>Now: {shieldHint}</Text>
        ) : null}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.outlookRow}>
          {outlookDays.map((d) => (
            <View key={d.key} style={[styles.outlookChip, { borderColor: d.tone }]}>
              <Text style={styles.outlookEmoji}>{d.icon}</Text>
              <Text style={[styles.outlookDow, { color: colors.text }]}>{d.dow}</Text>
              <Text style={[styles.outlookDay, { color: colors.sub }]}>{d.dayNum}</Text>
              <Text style={[styles.outlookTag, { color: d.tone }]}>{d.tag}</Text>
            </View>
          ))}
        </ScrollView>
        <TouchableOpacity style={styles.secondaryCta} onPress={onActivatePress} activeOpacity={0.88}>
          <Text style={styles.secondaryCtaText}>{isCovered ? 'Adjust coverage tier' : 'Choose coverage tier'}</Text>
        </TouchableOpacity>
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
        <Text style={[styles.meta, { color: colors.sub }]}>Based on your profile (0–100)</Text>
      </View>

      {!isCovered ? (
        <TouchableOpacity style={styles.cta} onPress={onActivatePress} activeOpacity={0.85}>
          <Text style={styles.ctaText}>Activate Coverage</Text>
        </TouchableOpacity>
      ) : null}

      <Modal visible={sheetOpen} animationType="slide" transparent onRequestClose={() => setSheetOpen(false)}>
        <Pressable style={styles.sheetOverlay} onPress={() => !activateMutation.isPending && setSheetOpen(false)}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.sheetTitle}>{isCovered ? 'Switch plan' : 'Choose your plan'}</Text>
            <Text style={styles.sheetSub}>Three tiers — same options as onboarding.</Text>
            {TIERS.map((t) => (
              <View
                key={t.id}
                style={[
                  styles.tierCard,
                  t.popular && styles.tierPopular,
                  currentTierCanon === t.id ? styles.tierCardCurrent : null,
                ]}
              >
                {t.popular ? (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>Most Popular</Text>
                  </View>
                ) : null}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <Text style={styles.tierName}>{t.name}</Text>
                  {currentTierCanon === t.id ? (
                    <Text style={styles.tierCurrentPill}>Current</Text>
                  ) : null}
                </View>
                <Text style={styles.tierPrice}>₹{t.listWeekly}/week</Text>
                <Text style={styles.tierMax}>Up to ₹{t.maxDay.toLocaleString('en-IN')}/day payout</Text>
                <Text style={styles.tierBlurb}>{t.blurb}</Text>
                <TouchableOpacity
                  style={[styles.pickBtn, activateMutation.isPending && { opacity: 0.6 }]}
                  disabled={activateMutation.isPending}
                  onPress={() => activateMutation.mutate(t.id)}
                >
                  <Text style={styles.pickBtnText}>
                    {pendingTierId === t.id ? 'Saving…' : `Choose ${t.name}`}
                  </Text>
                </TouchableOpacity>
              </View>
            ))}
            <TouchableOpacity style={styles.cancelBtn} onPress={() => !activateMutation.isPending && setSheetOpen(false)}>
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
  activeCard: {
    borderRadius: 16,
    padding: 18,
    marginBottom: 14,
    borderWidth: 2,
  },
  activeTitle: { fontSize: 20, fontWeight: '900' },
  activeDays: { fontSize: 15, fontWeight: '700', marginTop: 8 },
  renewBtn: {
    marginTop: 16,
    backgroundColor: 'rgba(255,255,255,0.65)',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.08)',
    opacity: 0.85,
  },
  renewBtnText: { fontSize: 15, fontWeight: '800', color: '#334155', textAlign: 'center' },
  renewHint: { fontSize: 12, fontWeight: '600', color: '#64748b', textAlign: 'center', marginTop: 6 },
  changePlanBtn: {
    marginTop: 14,
    backgroundColor: '#1a73e8',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  changePlanBtnText: { color: '#fff', fontSize: 15, fontWeight: '800' },
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
  detailLine: { fontSize: 16, fontWeight: '700', marginTop: 6 },
  outlookDisclaimer: { fontSize: 12, lineHeight: 18, marginBottom: 10, fontWeight: '600' },
  forecastInline: { fontSize: 13, fontWeight: '700', marginBottom: 10 },
  outlookRow: { flexDirection: 'row', gap: 10, paddingVertical: 6 },
  outlookChip: {
    width: 72,
    borderRadius: 12,
    borderWidth: 2,
    paddingVertical: 10,
    paddingHorizontal: 6,
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.02)',
  },
  outlookEmoji: { fontSize: 22 },
  outlookDow: { fontSize: 11, fontWeight: '800', marginTop: 4 },
  outlookDay: { fontSize: 12, fontWeight: '700' },
  outlookTag: { fontSize: 10, fontWeight: '800', marginTop: 4 },
  secondaryCta: {
    marginTop: 14,
    borderWidth: 2,
    borderColor: '#1a73e8',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  secondaryCtaText: { color: '#1a73e8', fontSize: 15, fontWeight: '800' },
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
  sheetTitle: { fontSize: 18, fontWeight: '900', marginBottom: 6, color: '#0f172a' },
  sheetSub: { fontSize: 13, fontWeight: '600', color: '#64748b', marginBottom: 14 },
  tierCard: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
  },
  tierPopular: { borderColor: '#1a73e8', borderWidth: 2 },
  tierCardCurrent: { borderColor: '#16a34a', borderWidth: 2, backgroundColor: '#f0fdf4' },
  tierCurrentPill: {
    fontSize: 11,
    fontWeight: '800',
    color: '#166534',
    backgroundColor: '#bbf7d0',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    overflow: 'hidden',
  },
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
