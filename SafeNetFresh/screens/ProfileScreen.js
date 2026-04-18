import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  useColorScheme,
  TextInput,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { CommonActions } from '@react-navigation/native';
import { useQueryClient, useQuery, useMutation } from '@tanstack/react-query';

import { useAuth } from '../contexts/AuthContext';
import { useClaims } from '../contexts/ClaimContext';
import { usePolicy } from '../contexts/PolicyContext';
import { useWorkerProfile } from '../hooks/useWorkerProfile';
import { policies, workers, formatApiError } from '../services/api';
import { navigationRef } from '../services/navigationService';
import { canonicalTierLabel } from '../utils/tierDisplay';
import { useLocalization } from '../contexts/LocalizationContext';
import { formatShortLocation } from '../utils/locationDisplay';
import AppModal from '../components/AppModal';

const LADDER = ['Newcomer', 'Verified', 'Trusted', 'Guardian', 'Champion'];

const PLATFORM_UI = {
  zomato: { bg: '#fef2f2', color: '#E23744', label: 'Zomato' },
  swiggy: { bg: '#fff7ed', color: '#EA580C', label: 'Swiggy' },
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

function ProfileRow({ label, children, isLast, theme: th }) {
  return (
    <View
      style={[
        styles.row,
        !isLast && styles.rowBorder,
        !isLast && th ? { borderBottomColor: th.cardBorder } : null,
      ]}
    >
      <Text style={[styles.rowLabel, th ? { color: th.sub } : null]}>{label}</Text>
      <View style={styles.rowValue}>{children}</View>
    </View>
  );
}

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme() || 'light';
  const { signOut, workerProfile, token } = useAuth();
  const { resetClaims } = useClaims();
  const { resetPolicy, policy } = usePolicy();
  const qc = useQueryClient();
  const { data: profileQuery, isLoading } = useWorkerProfile();
  const { language, setLanguage } = useLocalization();
  const profile = profileQuery ?? workerProfile ?? null;
  const [bankOpen, setBankOpen] = useState(false);
  const [bankName, setBankName] = useState('');
  const [bankUpi, setBankUpi] = useState('');
  const [bankAcc, setBankAcc] = useState('');
  const [bankIfsc, setBankIfsc] = useState('');
  const policiesQuery = useQuery({
    queryKey: ['policies', 'list'],
    enabled: Boolean(token),
    queryFn: () => policies.list(),
    staleTime: 1000 * 60,
  });
  const saveBankMutation = useMutation({
    mutationFn: () =>
      workers.updateProfile({
        bank_account_name: String(bankName || '').trim() || null,
        bank_upi_id: String(bankUpi || '').trim() || null,
        bank_account_number: String(bankAcc || '').trim() || null,
        bank_ifsc: String(bankIfsc || '').trim().toUpperCase() || null,
      }),
    onSuccess: async () => {
      setBankOpen(false);
      await qc.invalidateQueries({ queryKey: ['workerProfile'] });
      Alert.alert('Saved', 'Bank details updated successfully.');
    },
    onError: (e) => {
      Alert.alert('Could not save', formatApiError(e));
    },
  });

  const trustIdx = useMemo(() => ladderTierIndex(profile?.trust_score), [profile?.trust_score]);
  const filledCircles = trustIdx + 1;

  const policyRows = useMemo(() => {
    const rows = policiesQuery.data;
    if (!Array.isArray(rows)) return [];
    return rows.slice(0, 3).map((p) => ({
      plan: p.tier || p.product_code,
      weekly_premium: p.weekly_premium,
      status: p.status,
      started_at: p.valid_from || p.created_at,
    }));
  }, [policiesQuery.data]);

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

  const locLine = useMemo(() => {
    const raw = String(profile?.location_display || '').trim() || String(profile?.city || '').trim();
    if (!raw) return 'City not set';
    return formatShortLocation(raw) || raw;
  }, [profile?.location_display, profile?.city]);

  const theme = useMemo(() => {
    const dark = scheme === 'dark';
    return {
      bg: dark ? '#0b1020' : '#f1f5f9',
      text: dark ? '#f8fafc' : '#0f172a',
      sub: dark ? '#94a3b8' : '#64748b',
      card: dark ? '#121a32' : '#fff',
      cardBorder: dark ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.06)',
    };
  }, [scheme]);

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: theme.bg }]}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
    >
      <Text style={[styles.title, { color: theme.text }]}>Account</Text>
      <View style={styles.langRow}>
        {[
          { code: 'en', label: 'English' },
          { code: 'hi', label: 'हिंदी' },
          { code: 'te', label: 'తెలుగు' },
        ].map((lang) => {
          const active = language === lang.code;
          return (
            <TouchableOpacity
              key={lang.code}
              style={[
                styles.langBtn,
                { borderColor: theme.cardBorder, backgroundColor: theme.card },
                active ? styles.langBtnActive : null,
              ]}
              onPress={() => void setLanguage(lang.code)}
            >
              <Text style={[styles.langBtnText, { color: active ? '#fff' : theme.sub }]}>
                {lang.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {isLoading && !profile ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color="#1a73e8" />
          <Text style={[styles.loadingHint, { color: theme.sub }]}>Loading your profile…</Text>
        </View>
      ) : null}

      <LinearGradient
        colors={scheme === 'dark' ? ['#1e3a5f', '#0f172a'] : ['#4f8ef7', '#1d4ed8']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.hero}
      >
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initial}</Text>
        </View>
        <Text style={styles.heroName}>{profile?.name ? String(profile.name) : 'Your profile'}</Text>
        <Text style={styles.heroSub}>{locLine}</Text>
      </LinearGradient>

      <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.cardBorder, borderWidth: 1 }]}>
        <Text style={[styles.cardTitle, { color: theme.sub }]}>Details</Text>
        <ProfileRow label="Platform" isLast={false} theme={theme}>
          <View style={[styles.platformBadge, { backgroundColor: plat.bg }]}>
            <Text style={[styles.platformBadgeText, { color: plat.color }]}>{plat.label}</Text>
          </View>
        </ProfileRow>
        <ProfileRow label="Coverage plan" isLast={false} theme={theme}>
          <Text style={[styles.rowValueText, { color: theme.text }]}>{coveragePlanLabel}</Text>
        </ProfileRow>
        <ProfileRow label="Typical daily earnings" isLast={false} theme={theme}>
          <Text style={[styles.rowValueText, { color: theme.text }]}>
            {typeof profile?.avg_daily_income === 'number'
              ? `₹${Math.round(profile.avg_daily_income).toLocaleString('en-IN')}`
              : '—'}
          </Text>
        </ProfileRow>
        <ProfileRow label="Trust level" isLast theme={theme}>
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
            <Text style={[styles.ladderCaption, { color: theme.sub }]}>
              {LADDER[trustIdx]} · score{' '}
              {profile?.trust_score != null ? Number(profile.trust_score).toFixed(1) : '—'}
            </Text>
          </View>
        </ProfileRow>
      </View>
      <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.cardBorder, borderWidth: 1 }]}>
        <Text style={[styles.cardTitle, { color: theme.sub }]}>Payout destination</Text>
        <Text style={[styles.muted, { color: theme.sub }]}>
          {profile?.bank_upi_id || profile?.bank_account_number
            ? `Saved: ${profile?.bank_upi_id || `A/C ••••${String(profile?.bank_account_number || '').slice(-4)}`}`
            : 'No bank details added yet.'}
        </Text>
        <TouchableOpacity
          style={[styles.logoutBtn, { marginTop: 12, backgroundColor: '#dbeafe' }]}
          onPress={() => {
            setBankName(String(profile?.bank_account_name || ''));
            setBankUpi(String(profile?.bank_upi_id || ''));
            setBankAcc(String(profile?.bank_account_number || ''));
            setBankIfsc(String(profile?.bank_ifsc || ''));
            setBankOpen(true);
          }}
        >
          <Text style={[styles.logoutText, { color: '#1d4ed8' }]}>Update bank details</Text>
        </TouchableOpacity>
      </View>

      <Text style={[styles.sectionTitle, { color: theme.text }]}>Policy history</Text>
      <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.cardBorder, borderWidth: 1 }]}>
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
                style={[styles.policyRow, i > 0 ? { borderTopWidth: 1, borderTopColor: theme.cardBorder } : null]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.policyLine, { color: theme.text }]}>{line}</Text>
                  <Text style={[styles.policyMeta, { color: theme.sub }]}>
                    {row.started_at ? String(row.started_at).slice(0, 10) : '—'} ·{' '}
                    {String(row.status || '—')}
                  </Text>
                </View>
              </View>
            );
          })
        ) : (
          <Text style={[styles.muted, { color: theme.sub }]}>No policy history yet.</Text>
        )}
      </View>

      <TouchableOpacity style={styles.logoutBtn} onPress={() => void onLogout()}>
        <Text style={styles.logoutText}>Logout</Text>
      </TouchableOpacity>
      <AppModal visible={bankOpen} transparent animationType="slide" onRequestClose={() => setBankOpen(false)}>
        <View style={styles.bankBackdrop}>
          <View style={styles.bankSheet}>
            <LinearGradient
              colors={['#1e3a8a', '#2563eb', '#38bdf8']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.bankHero}
            >
              <View style={styles.bankLiveRow}>
                <View style={styles.bankPulse} />
                <Text style={styles.bankLiveText}>Live payout setup</Text>
              </View>
              <Text style={styles.bankTitleLight}>Secure bank & UPI</Text>
              <Text style={styles.bankSubLight}>Encrypted on save · used only for verified payouts</Text>
            </LinearGradient>
            <View style={styles.bankBody}>
              <Text style={[styles.bankFieldLabel, { marginTop: 0 }]}>Account holder</Text>
              <TextInput
                style={styles.bankInput}
                placeholder="Account holder name"
                placeholderTextColor="#94a3b8"
                value={bankName}
                onChangeText={setBankName}
              />
              <Text style={styles.bankSectionLabel}>Bank transfer</Text>
              <Text style={styles.bankHint}>IFSC + account for NEFT-style payouts</Text>
              <Text style={styles.bankFieldLabel}>IFSC code</Text>
              <TextInput
                style={styles.bankInput}
                placeholder="IFSC code"
                placeholderTextColor="#94a3b8"
                value={bankIfsc}
                onChangeText={setBankIfsc}
                autoCapitalize="characters"
              />
              <Text style={styles.bankFieldLabel}>Account number</Text>
              <TextInput
                style={styles.bankInput}
                placeholder="Account number"
                placeholderTextColor="#94a3b8"
                value={bankAcc}
                onChangeText={setBankAcc}
                keyboardType="number-pad"
              />
              <Text style={styles.bankSectionLabel}>UPI</Text>
              <Text style={styles.bankHint}>Faster credits when your UPI ID matches the bank name above</Text>
              <Text style={styles.bankFieldLabel}>UPI ID</Text>
              <TextInput
                style={styles.bankInput}
                placeholder="you@bankupi"
                placeholderTextColor="#94a3b8"
                value={bankUpi}
                onChangeText={setBankUpi}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TouchableOpacity style={styles.bankSaveBtn} onPress={() => saveBankMutation.mutate()} disabled={saveBankMutation.isPending}>
                <Text style={styles.bankSaveText}>{saveBankMutation.isPending ? 'Saving...' : 'Save securely'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.bankCloseBtn} onPress={() => setBankOpen(false)}>
                <Text style={styles.bankCloseText}>Close</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </AppModal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 48 },
  title: { fontSize: 22, fontWeight: '900', marginBottom: 4 },
  screenSub: { fontSize: 13, fontWeight: '600', marginBottom: 14 },
  langRow: { flexDirection: 'row', gap: 8, marginBottom: 14 },
  langBtn: { borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10 },
  langBtnActive: { borderColor: '#2563eb', backgroundColor: '#2563eb' },
  langBtnText: { fontWeight: '700' },
  loadingWrap: { padding: 24, alignItems: 'center' },
  loadingHint: { marginTop: 10, color: '#64748b', fontWeight: '600' },
  hero: {
    borderRadius: 20,
    padding: 20,
    marginBottom: 18,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
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
  heroName: { fontSize: 20, fontWeight: '900', color: '#fff', textAlign: 'center' },
  heroSub: { fontSize: 14, fontWeight: '600', color: 'rgba(255,255,255,0.74)', marginTop: 6 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    marginBottom: 18,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 9,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  cardTitle: { fontSize: 12, fontWeight: '800', color: '#64748b', letterSpacing: 0.6, marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 13, gap: 12 },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: '#eee', marginVertical: 6 },
  rowLabel: { width: 128, fontSize: 14, color: '#6b7280', fontWeight: '700', paddingTop: 1 },
  rowValue: { flex: 1, alignItems: 'flex-end' },
  rowValueText: { fontSize: 16, color: '#1a1a2e', fontWeight: '600', textAlign: 'right' },
  platformBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    backgroundColor: '#fff3e0',
  },
  platformBadgeText: { fontWeight: '800', fontSize: 14 },
  ladderRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  ladderDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
  },
  ladderDotFilled: { backgroundColor: '#1a73e8', borderColor: '#1a73e8' },
  ladderDotEmpty: { backgroundColor: '#f1f5f9', borderColor: '#cbd5e1' },
  ladderCaption: { fontSize: 13, color: '#475569', fontWeight: '700', marginTop: 6, textAlign: 'right' },
  sectionTitle: { fontSize: 15, fontWeight: '900', color: '#1a1a2e', marginBottom: 8 },
  policyRow: { paddingVertical: 14 },
  policyRowBorder: { borderTopWidth: 1, borderTopColor: 'rgba(0,0,0,0.06)' },
  policyLine: { fontSize: 14, fontWeight: '800', color: '#1a1a2e' },
  policyMeta: { fontSize: 11, color: '#9ca3af', marginTop: 4 },
  muted: { fontSize: 13, color: '#777' },
  logoutBtn: { backgroundColor: '#fee2e2', borderRadius: 14, padding: 16, alignItems: 'center', width: '100%' },
  logoutText: { color: '#dc2626', fontWeight: '600' },
  bankBackdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.55)', justifyContent: 'flex-end' },
  bankSheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(37,99,235,0.25)',
    shadowColor: '#1d4ed8',
    shadowOpacity: 0.2,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: -8 },
    elevation: 12,
  },
  bankHero: { paddingHorizontal: 18, paddingTop: 18, paddingBottom: 16 },
  bankLiveRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  bankPulse: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#4ade80',
    shadowColor: '#4ade80',
    shadowOpacity: 0.9,
    shadowRadius: 6,
  },
  bankLiveText: { color: 'rgba(255,255,255,0.92)', fontSize: 12, fontWeight: '800', letterSpacing: 0.4 },
  bankTitleLight: { fontSize: 20, fontWeight: '900', color: '#fff' },
  bankSubLight: { fontSize: 12, fontWeight: '600', color: 'rgba(255,255,255,0.78)', marginTop: 4 },
  bankBody: { paddingHorizontal: 18, paddingTop: 16, paddingBottom: 20 },
  bankSectionLabel: {
    fontSize: 11,
    fontWeight: '900',
    color: '#64748b',
    letterSpacing: 1,
    marginTop: 14,
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  bankFieldLabel: { fontSize: 12, fontWeight: '700', color: '#475569', marginBottom: 6, marginTop: 10 },
  bankHint: { fontSize: 12, color: '#94a3b8', fontWeight: '600', marginBottom: 2 },
  bankInput: {
    borderWidth: 1.5,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 15,
    fontWeight: '600',
    color: '#0f172a',
    backgroundColor: '#f8fafc',
  },
  bankSaveBtn: {
    backgroundColor: '#1d4ed8',
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 20,
    shadowColor: '#1d4ed8',
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  bankSaveText: { color: '#fff', fontWeight: '900', fontSize: 15 },
  bankCloseBtn: { marginTop: 12, alignItems: 'center', paddingVertical: 10 },
  bankCloseText: { color: '#64748b', fontWeight: '700' },
});
