import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Pressable,
  Platform,
  Animated,
  useColorScheme,
  RefreshControl,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { LinearGradient } from 'expo-linear-gradient';

import AppModal from '../components/AppModal';
import { policies, zones as zonesApi, payments } from '../services/api';
import { openRazorpayWebCheckout } from '../utils/razorpayCheckout';
import { usePolicy } from '../contexts/PolicyContext';
import { useWorkerProfile } from '../hooks/useWorkerProfile';
import { canonicalTierLabel } from '../utils/tierDisplay';
import { formatIstTodayLong } from '../utils/istFormat';
import { formatShortLocation } from '../utils/locationDisplay';
import { useLocalization } from '../contexts/LocalizationContext';

const TIERS = [
  { id: 'Basic', name: 'Basic', blurb: 'Essential daily protection', listWeekly: 35, maxDay: 350 },
  { id: 'Standard', name: 'Standard', blurb: 'Balanced coverage for most riders', listWeekly: 49, maxDay: 500, popular: true },
  { id: 'Pro', name: 'Pro', blurb: 'Maximum daily payout cap', listWeekly: 70, maxDay: 700 },
];

const CITY_ZONE_HINT = [
  ['vijayawada', 'benz_circle'],
  ['bangalore', 'blr_central'],
  ['bengaluru', 'blr_central'],
  ['mumbai', 'bom_central'],
  ['hyderabad', 'hyd_central'],
];

function riskBarColor(pct) {
  if (pct >= 70) return '#16a34a';
  if (pct >= 40) return '#ca8a04';
  return '#dc2626';
}

function outlookChipFromDay(d) {
  const pc = Number(d?.precip_prob_pct);
  const tmax = Number(d?.temp_max_c);
  if (Number.isFinite(pc) && pc >= 55) return { icon: '☔', tag: 'Wet', tone: '#60a5fa' };
  if (Number.isFinite(tmax) && tmax >= 38) return { icon: '☀️', tag: 'Hot', tone: '#ef4444' };
  if (Number.isFinite(pc) && pc >= 25) return { icon: '⛅', tag: 'Mixed', tone: '#94a3b8' };
  return { icon: '☀️', tag: 'Clear', tone: '#38bdf8' };
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

export default function PolicyScreen() {
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme() || 'light';
  const qc = useQueryClient();
  const { setPolicy } = usePolicy();
  const { data: worker } = useWorkerProfile();
  const { t } = useLocalization();

  const [sheetOpen, setSheetOpen] = useState(false);
  const [justActivated, setJustActivated] = useState(false);
  const [activateError, setActivateError] = useState('');
  const checkScale = useRef(new Animated.Value(0)).current;

  const zoneId = useMemo(() => {
    const z = worker?.zone_id;
    if (z && String(z).trim() && String(z) !== 'unknown' && String(z) !== 'default') {
      return String(z).trim();
    }
    const city = String(worker?.city || '').toLowerCase();
    for (const [needle, zid] of CITY_ZONE_HINT) {
      if (city.includes(needle)) return zid;
    }
    return 'hyd_central';
  }, [worker?.zone_id, worker?.city]);

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
    refetchInterval: 1000 * 60 * 15,
  });

  const forecastDailyQuery = useQuery({
    queryKey: ['forecastDaily', 'policy', zoneId],
    queryFn: () => zonesApi.getForecastDaily(zoneId),
    enabled: Boolean(zoneId),
    staleTime: 1000 * 60 * 10,
    refetchInterval: 1000 * 60 * 20,
  });

  const p = policyQuery.data;
  const istTodayLine = useMemo(() => formatIstTodayLong(), []);

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
  const rawRisk = worker?.risk_score ?? p?.risk_score ?? 0;
  const riskNorm = Number(rawRisk);
  const payouts = Number(worker?.total_payouts ?? 0);
  /** Until a real payout leaves your account, keep the AI risk meter at 0 (cold / calibrating). */
  const riskCalibrating = payouts === 0;
  const riskPct = riskCalibrating
    ? 0
    : Math.max(0, Math.min(100, riskNorm <= 1 ? riskNorm * 100 : riskNorm));
  const daysLeft = Number(p?.days_remaining ?? 0);

  const statusStyle = useMemo(() => {
    if (status === 'active') return { bg: '#ecfdf5', border: '#16a34a', title: '#065f46' };
    if (status === 'expiring') return { bg: '#fffbeb', border: '#f59e0b', title: '#92400e' };
    return { bg: '#fef2f2', border: '#ef4444', title: '#991b1b' };
  }, [status]);

  const payMutation = useMutation({
    mutationFn: async (tier) => {
      const policyId = p?.policy_id ?? null;
      const order = await payments.createPremiumOrder(tier, policyId);
      const keyId = String(order.key_id || '').trim();
      const orderId = order.order_id;
      const amountPaise = Number(order.amount_paise || 0);
      const isTestOrder = String(orderId || '').startsWith('order_test_');
      const canHosted = Boolean(keyId) && !isTestOrder;

      const verifyDev = () =>
        payments.verifyPremium(orderId, `pay_dev_${Date.now()}`, 'webhook_verified');

      if (Platform.OS === 'web' && canHosted) {
        const phoneRaw = worker?.phone_number || worker?.phone || '';
        const phone = String(phoneRaw).replace(/\D/g, '').length >= 10 ? String(phoneRaw).replace(/\D/g, '').slice(-10) : '';
        const resp = await openRazorpayWebCheckout({
          keyId,
          orderId,
          amountPaise,
          description: `SafeNet ${tier} — weekly premium`,
          prefill: {
            name: worker?.name ? String(worker.name) : '',
            contact: phone,
          },
        });
        return payments.verifyPremium(orderId, resp.razorpay_payment_id, resp.razorpay_signature);
      }

      if (Platform.OS !== 'web' && canHosted) {
        const go = await new Promise((resolve) => {
          if (!__DEV__) {
            Alert.alert(
              'Pay with Razorpay',
              'Complete UPI, cards, or netbanking in the worker web app (same login) — the Razorpay checkout window opens there. Simulating disruptions on Home does not charge premium.',
              [{ text: 'OK', onPress: () => resolve(false) }]
            );
            return;
          }
          Alert.alert(
            'Pay with Razorpay',
            'For a real checkout, open the worker app in the browser on this machine. In development you can simulate a test payment (no charge).',
            [
              { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
              { text: 'Simulate test pay', onPress: () => resolve(true) },
            ],
            { cancelable: true }
          );
        });
        if (!go) throw new Error('cancelled');
        return verifyDev();
      }

      /* No hosted checkout: never silently mark paid in production. */
      if (!__DEV__) {
        Alert.alert(
          'Premium checkout',
          'Razorpay is not fully configured (publishable key or live order missing). Add RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET on the server, then try again. Note: simulating disruptions does not collect premium—it only runs the claims demo.',
          [{ text: 'OK' }]
        );
        throw new Error('cancelled');
      }
      const simOk = await new Promise((resolve) => {
        Alert.alert(
          'Development only',
          'No Razorpay checkout is available (test order or missing key). Simulate a successful premium payment for local testing?',
          [
            { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
            { text: 'Simulate payment', onPress: () => resolve(true) },
          ],
          { cancelable: true }
        );
      });
      if (!simOk) throw new Error('cancelled');
      return verifyDev();
    },
    onSuccess: async () => {
      setActivateError('');
      await qc.invalidateQueries({ queryKey: ['policy', 'current'] });
      const fresh = await qc.fetchQuery({
        queryKey: ['policy', 'current'],
        queryFn: () => policies.getCurrent(),
      });
      if (fresh) setPolicy(fresh, fresh.status);
      setSheetOpen(false);
      setJustActivated(true);
      checkScale.setValue(0);
      Animated.spring(checkScale, { toValue: 1, friction: 6, useNativeDriver: true }).start(() => {
        setTimeout(() => {
          setJustActivated(false);
          checkScale.setValue(0);
        }, 2200);
      });
      await qc.invalidateQueries({ queryKey: ['workerProfile'] });
    },
    onError: (error) => {
      const msg = error?.message;
      if (msg === 'checkout_dismissed') {
        setActivateError('Payment window closed before completion.');
        return;
      }
      if (msg === 'cancelled') {
        setActivateError('');
        return;
      }
      const detail = error?.response?.data?.detail;
      setActivateError(
        typeof detail === 'string'
          ? detail
          : 'Payment could not be completed. Please try again.'
      );
    },
  });

  const pendingTierId = payMutation.isPending ? payMutation.variables : null;

  const onActivatePress = useCallback(() => {
    setActivateError('');
    setSheetOpen(true);
  }, []);

  const onRefresh = useCallback(() => {
    void policyQuery.refetch();
    void forecastQuery.refetch();
    void forecastDailyQuery.refetch();
  }, [policyQuery.refetch, forecastQuery.refetch, forecastDailyQuery.refetch]);

  const refreshing =
    policyQuery.isRefetching || forecastQuery.isRefetching || forecastDailyQuery.isRefetching;

  const colors = scheme === 'dark'
    ? { bg: '#0f172a', card: '#1e293b', text: '#f8fafc', sub: '#94a3b8' }
    : { bg: '#f0f4ff', card: '#fff', text: '#1a1a2e', sub: '#64748b' };

  const primaryShield = Array.isArray(forecastQuery.data?.shields) ? forecastQuery.data.shields[0] : null;
  const shieldHint = primaryShield?.subtitle;
  const currentTierCanon = canonicalTierLabel(p?.tier);
  const outlookDays = Array.isArray(forecastDailyQuery.data?.days) ? forecastDailyQuery.data.days : [];
  const outlookLocationLabel = formatShortLocation(
    String(worker?.location_display || forecastDailyQuery.data?.location_label || p?.zone || '')
  );

  return (
    <View style={[styles.screenWrap, Platform.OS === 'web' && styles.screenWrapWeb]}>
    <ScrollView
      style={[styles.container, { backgroundColor: colors.bg }]}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 28 }]}
      refreshControl={<RefreshControl refreshing={Boolean(refreshing)} onRefresh={onRefresh} />}
    >
      <Text style={[styles.title, { color: colors.text }]}>Coverage</Text>

      {primaryShield && !forecastQuery.isError ? (
        <LinearGradient
          colors={scheme === 'dark' ? ['#0f172a', '#1d4ed8', '#2563eb'] : ['#172554', '#2563eb', '#38bdf8']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.forecastShieldHero}
        >
          <Text style={styles.forecastShieldHeroIcon}>🛡️</Text>
          <Text style={styles.forecastShieldHeroTitle}>{t('policy.forecast_shield_title')}</Text>
          <Text style={styles.forecastShieldHeroSubtitle}>
            {primaryShield.subtitle || shieldHint || '—'}
          </Text>
          <Text style={styles.forecastShieldHeroFooter}>
            {primaryShield.coverage_line || t('policy.forecast_shield_coverage_fallback')}
          </Text>
          <View style={styles.forecastShieldBadge}>
            <Text style={styles.forecastShieldBadgeText}>{t('policy.forecast_shield_badge')}</Text>
          </View>
        </LinearGradient>
      ) : null}

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
        {p?.zone || worker?.location_display ? (
          <Text style={[styles.meta, { color: colors.sub }]}>
            Zone: {outlookLocationLabel || formatShortLocation(String(p?.zone || '')) || '—'}
          </Text>
        ) : null}
      </View>

      <View style={[styles.card, { backgroundColor: colors.card }]}>
        <Text style={[styles.outlookSectionTitle, { color: colors.text }]}>{t('policy.outlook_14_title')}</Text>
        <Text style={[styles.outlookDisclaimer, { color: colors.sub }]}>
          {t('policy.outlook_disclaimer_start')} {istTodayLine}
          {t('policy.outlook_disclaimer_end')}
        </Text>
        {forecastDailyQuery.isError ? (
          <Text style={[styles.meta, { color: colors.sub }]}>{t('policy.outlook_error')}</Text>
        ) : forecastDailyQuery.isLoading ? (
          <Text style={[styles.meta, { color: colors.sub }]}>{t('policy.outlook_loading')}</Text>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.outlookRow}>
            {outlookDays.map((d) => {
              const chip = outlookChipFromDay(d);
              const wd = String(d.date || '').slice(5);
              return (
                <View key={String(d.date)} style={[styles.outlookChip, { borderColor: chip.tone }]}>
                  <Text style={styles.outlookEmoji}>{chip.icon}</Text>
                  <Text style={[styles.outlookDow, { color: colors.text }]}>{wd}</Text>
                  <Text style={[styles.outlookDay, { color: colors.sub }]} numberOfLines={1}>
                    {d.temp_max_c != null && d.temp_min_c != null
                      ? `${Math.round(d.temp_max_c)}° / ${Math.round(d.temp_min_c)}°`
                      : '—'}
                  </Text>
                  <Text style={[styles.outlookTag, { color: chip.tone }]}>{chip.tag}</Text>
                </View>
              );
            })}
          </ScrollView>
        )}
        {shieldHint ? (
          <Text style={[styles.forecastInline, { color: colors.text, marginTop: 8 }]}>{shieldHint}</Text>
        ) : null}
        <TouchableOpacity style={styles.secondaryCta} onPress={onActivatePress} activeOpacity={0.88}>
          <Text style={styles.secondaryCtaText}>{isCovered ? 'Adjust coverage tier' : 'Choose coverage tier'}</Text>
        </TouchableOpacity>
      </View>

      <View style={[styles.card, styles.aiRiskCard, { backgroundColor: colors.card, borderColor: scheme === 'dark' ? '#334155' : '#e2e8f0' }]}>
        <Text style={[styles.aiRiskTitle, { color: colors.text }]}>{t('policy.ai_risk_title')}</Text>
        <Text style={[styles.aiRiskSub, { color: colors.sub }]}>
          {riskCalibrating ? t('policy.ai_risk_calibrating') : t('policy.ai_risk_sub')}
        </Text>
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
      </View>

      {!isCovered ? (
        <TouchableOpacity style={styles.cta} onPress={onActivatePress} activeOpacity={0.85}>
          <Text style={styles.ctaText}>Activate Coverage</Text>
        </TouchableOpacity>
      ) : null}
    </ScrollView>

      <AppModal visible={sheetOpen} animationType="slide" transparent onRequestClose={() => setSheetOpen(false)}>
        <Pressable style={styles.sheetOverlay} onPress={() => !payMutation.isPending && setSheetOpen(false)}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.sheetTitle}>{isCovered ? 'Switch plan' : 'Choose your plan'}</Text>
            <Text style={styles.sheetSub}>
              Pay weekly premium through Razorpay (UPI, cards, netbanking). Your plan activates after payment
              confirms.
            </Text>
            {payMutation.isPending ? (
              <View style={styles.rzpStatusRow}>
                <ActivityIndicator size="small" color="#2563eb" />
                <Text style={styles.rzpStatusText}>Opening Razorpay secure checkout…</Text>
              </View>
            ) : null}
            <ScrollView style={{ maxHeight: 420 }} showsVerticalScrollIndicator={false}>
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
                {currentTierCanon === t.id && p?.premium_breakdown ? (
                  <View style={styles.breakdownBox}>
                    <Text style={styles.breakdownLabel}>Premium calculation</Text>
                    <Text style={styles.breakdownFormula}>
                      {'₹'}{Math.round(p.premium_breakdown.base_tier_premium || p.premium_breakdown.base_premium || 0)}
                      {' × '}{(p.premium_breakdown.zone_risk_multiplier || p.premium_breakdown.zone_multiplier || 1).toFixed(2)}
                      {' × '}{(p.premium_breakdown.worker_adjustment || 1).toFixed(2)}
                      {' = ₹'}{Math.round(p.premium_breakdown.final_premium || p.weekly_premium || 0)}{'/week'}
                    </Text>
                    <Text style={[styles.breakdownLabel, { marginTop: 4 }]}>
                      base tier × zone risk × worker trust = your premium
                    </Text>
                  </View>
                ) : null}
                <TouchableOpacity
                  style={[styles.pickBtn, payMutation.isPending && { opacity: 0.6 }]}
                  disabled={payMutation.isPending}
                  onPress={() => payMutation.mutate(t.id)}
                >
                  <Text style={styles.pickBtnText}>
                    {pendingTierId === t.id ? 'Paying…' : `Pay & choose ${t.name}`}
                  </Text>
                </TouchableOpacity>
              </View>
            ))}
            </ScrollView>
            <TouchableOpacity style={styles.cancelBtn} onPress={() => !payMutation.isPending && setSheetOpen(false)}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </AppModal>
    </View>
  );
}

const styles = StyleSheet.create({
  screenWrap: { flex: 1 },
  screenWrapWeb: { position: 'relative' },
  container: { flex: 1 },
  content: { padding: 20, paddingBottom: 48 },
  title: { fontSize: 22, fontWeight: '800', marginBottom: 16 },
  forecastShieldHero: {
    borderRadius: 20,
    padding: 22,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    shadowColor: '#1d4ed8',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.35,
    shadowRadius: 20,
    elevation: 8,
  },
  forecastShieldHeroIcon: { fontSize: 36, marginBottom: 6 },
  forecastShieldHeroTitle: { color: '#fff', fontSize: 20, fontWeight: '900' },
  forecastShieldHeroSubtitle: {
    color: 'rgba(255,255,255,0.95)',
    fontSize: 15,
    marginTop: 10,
    lineHeight: 22,
    fontWeight: '600',
  },
  forecastShieldHeroFooter: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 14,
    marginTop: 14,
    fontWeight: '800',
    lineHeight: 20,
  },
  forecastShieldBadge: {
    alignSelf: 'flex-start',
    marginTop: 14,
    backgroundColor: 'rgba(255,255,255,0.22)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
  },
  forecastShieldBadgeText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  aiRiskCard: {
    borderWidth: 1,
    padding: 18,
  },
  aiRiskTitle: { fontSize: 17, fontWeight: '900', marginBottom: 6 },
  aiRiskSub: { fontSize: 13, lineHeight: 19, marginBottom: 14, fontWeight: '600' },
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
  outlookSectionTitle: {
    fontSize: 16,
    fontWeight: '900',
    letterSpacing: -0.2,
    marginBottom: 8,
  },
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
  sheetSub: { fontSize: 13, fontWeight: '600', color: '#64748b', marginBottom: 10 },
  rzpStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: 'rgba(37, 99, 235, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(37, 99, 235, 0.25)',
  },
  rzpStatusText: { flex: 1, fontSize: 13, fontWeight: '700', color: '#1e40af' },
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
  breakdownBox: {
    marginTop: 12,
    backgroundColor: 'rgba(26,115,232,0.08)',
    borderRadius: 10,
    padding: 10,
    borderLeftWidth: 3,
    borderLeftColor: '#1a73e8',
  },
  breakdownLabel: { fontSize: 11, fontWeight: '700', color: '#334155', marginBottom: 4 },
  breakdownFormula: { fontSize: 13, fontWeight: '700', color: '#0f172a', lineHeight: 18 },
});
