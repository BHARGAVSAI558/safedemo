import React, { useMemo, useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '../contexts/AuthContext';
import { gigProfile, workers } from '../services/api';

const BRAND = '#1A56DB';

const PLATFORMS = [
  { id: 'zomato', label: 'Zomato', color: '#E23744', avg: 980 },
  { id: 'swiggy', label: 'Swiggy', color: '#FC8019', avg: 950 },
  { id: 'both', label: 'Both', color: '#7c3aed', avg: 1020 },
  { id: 'other', label: 'Other', color: '#475569', avg: 880 },
];

const ZONES = [
  { id: 'kukatpally', label: 'Kukatpally', badge: '🔴 High Risk', score: 81 },
  { id: 'hitec_city', label: 'HITEC City', badge: '🟢 Low', score: 58 },
  { id: 'secunderabad', label: 'Secunderabad', badge: '🟡 Medium', score: 69 },
  { id: 'gachibowli', label: 'Gachibowli', badge: '🟡 Medium', score: 66 },
  { id: 'lb_nagar', label: 'LB Nagar', badge: '🔴 High Risk', score: 78 },
  { id: 'ameerpet', label: 'Ameerpet', badge: '🟡 Medium', score: 71 },
  { id: 'other', label: 'Other', badge: '🟡 Medium', score: 72 },
];

const HOURS = [
  { id: 'morning', label: 'Morning 6AM–12PM' },
  { id: 'afternoon', label: 'Afternoon 12PM–6PM' },
  { id: 'evening', label: 'Evening 6PM–11PM' },
  { id: 'full_day', label: 'Full Day' },
  { id: 'flexible', label: 'Flexible' },
];

const HOURS_MULT = {
  morning: 0.92,
  afternoon: 0.96,
  evening: 1.02,
  full_day: 1.12,
  flexible: 1.06,
};

const TIERS = [
  { id: 'Basic', weekly: 35, daily: 350, label: 'Basic' },
  { id: 'Standard', weekly: 49, daily: 500, label: 'Standard', popular: true },
  { id: 'Pro', weekly: 70, daily: 700, label: 'Pro' },
];

function estimateWeeklyPremium(zoneScore, hoursKey) {
  const hm = HOURS_MULT[hoursKey] || 1;
  const base = 26 + (zoneScore / 100) * 24;
  return Math.round(base * hm);
}

function coveragePct(tierId, zoneScore) {
  const base = tierId === 'Basic' ? 82 : tierId === 'Standard' ? 94 : 98;
  const adj = Math.round((zoneScore / 100) * 4);
  return Math.min(99, base + adj - 72);
}

export default function ProfileSetupScreen({ navigation }) {
  const { signOut, dispatch } = useAuth();
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [platform, setPlatform] = useState(null);
  const [zone, setZone] = useState(null);
  const [hoursPreset, setHoursPreset] = useState('full_day');
  const [tier, setTier] = useState('Standard');
  const [loading, setLoading] = useState(false);

  const scale = useRef(new Animated.Value(0.85)).current;
  useEffect(() => {
    if (step === 5) {
      Animated.spring(scale, { toValue: 1, friction: 6, useNativeDriver: true }).start();
    } else {
      scale.setValue(0.85);
    }
  }, [step, scale]);

  const zoneScore = zone?.score ?? 72;
  const livePremium = useMemo(
    () => estimateWeeklyPremium(zoneScore, hoursPreset),
    [zoneScore, hoursPreset]
  );

  const selectedTier = TIERS.find((t) => t.id === tier) || TIERS[1];
  const pct = coveragePct(selectedTier.id, zoneScore);

  const submitProfile = async () => {
    if (!name.trim() || name.trim().length < 2) {
      Alert.alert('Error', 'Please enter your name on step 1');
      setStep(1);
      return;
    }
    if (!platform || !zone) {
      Alert.alert('Error', 'Please complete platform and zone');
      return;
    }

    setLoading(true);
    try {
      await gigProfile.submit({
        name: name.trim(),
        platform: platform.id,
        city: 'Hyderabad',
        zone_id: zone.id,
        avg_daily_income: platform.avg,
        working_hours_preset: hoursPreset,
        coverage_tier: tier,
      });
      setStep(5);
    } catch (e) {
      if (e?.response?.status === 401) {
        await signOut();
        Alert.alert('Session expired', 'Please sign in again to continue.');
        navigation.replace('Onboarding');
        return;
      }
      const d = e?.response?.data?.detail;
      Alert.alert('Error', typeof d === 'string' ? d : e?.message || 'Could not save profile');
    } finally {
      setLoading(false);
    }
  };

  const goDashboard = async () => {
    try {
      const profile = await workers.getProfile();
      dispatch({ type: 'SET_PROFILE', profile });
      navigation.replace('Dashboard');
    } catch (e) {
      if (e?.response?.status === 401) {
        await signOut();
        navigation.replace('Onboarding');
        return;
      }
      // Profile fetch failed but activation succeeded — navigate anyway
      navigation.replace('Dashboard');
    }
  };

  const w = Dimensions.get('window').width;

  return (
    <View style={[styles.root, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 12 }]}>
      {step < 5 ? (
        <View style={styles.progress}>
          {[1, 2, 3, 4].map((s) => (
            <View key={s} style={[styles.dot, step >= s && styles.dotOn]} />
          ))}
        </View>
      ) : null}

      {step === 1 && (
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          <Text style={styles.stepTitle}>Which platform do you deliver for?</Text>
          <Text style={styles.stepSub}>Pick one — we use real earning benchmarks for your zone.</Text>

          <Text style={styles.nameLabel}>Your name</Text>
          <TextInput
            style={styles.nameInput}
            placeholder="As on your ID / bank"
            placeholderTextColor="#9ca3af"
            value={name}
            onChangeText={setName}
          />

          <View style={styles.platformGrid}>
            {PLATFORMS.map((p) => (
              <TouchableOpacity
                key={p.id}
                style={[styles.platformCard, { borderColor: p.color }, platform?.id === p.id && { backgroundColor: `${p.color}18` }]}
                onPress={() => setPlatform(p)}
                activeOpacity={0.85}
              >
                <View style={[styles.platformStripe, { backgroundColor: p.color }]} />
                <Text style={styles.platformName}>{p.label}</Text>
                <Text style={styles.platformEarn}>₹{p.avg} avg daily earnings</Text>
              </TouchableOpacity>
            ))}
          </View>

          <TouchableOpacity
            style={[styles.next, !platform && styles.nextDisabled]}
            disabled={!platform || !name.trim()}
            onPress={() => setStep(2)}
          >
            <Text style={styles.nextText}>Continue</Text>
          </TouchableOpacity>
        </ScrollView>
      )}

      {step === 2 && (
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          <Text style={styles.stepTitle}>Where do you mainly deliver?</Text>
          <Text style={styles.stepSub}>Hyderabad — tap your zone. Risk affects pricing and payouts.</Text>

          <View style={[styles.mapPlaceholder, { width: w - 40 }]}>
            <Text style={styles.mapEmoji}>🗺️</Text>
            <Text style={styles.mapHint}>Hyderabad delivery heat map</Text>
          </View>

          <View style={styles.chipWrap}>
            {ZONES.map((z) => (
              <TouchableOpacity
                key={z.id}
                style={[styles.chip, zone?.id === z.id && styles.chipOn]}
                onPress={() => setZone(z)}
              >
                <Text style={[styles.chipText, zone?.id === z.id && styles.chipTextOn]}>{z.label}</Text>
                <Text style={styles.chipBadge}>{z.badge}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {zone ? (
            <Text style={styles.riskLine}>
              Zone risk score: {zone.score}/100 — higher payouts available for your zone
            </Text>
          ) : null}

          <View style={styles.rowNav}>
            <TouchableOpacity style={styles.backBtn} onPress={() => setStep(1)}>
              <Text style={styles.backBtnText}>Back</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.next, !zone && styles.nextDisabled, { flex: 1 }]} disabled={!zone} onPress={() => setStep(3)}>
              <Text style={styles.nextText}>Continue</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      )}

      {step === 3 && (
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          <Text style={styles.stepTitle}>When do you usually work?</Text>
          <Text style={styles.stepSub}>This sets micro-window coverage for claims.</Text>

          <View style={styles.hoursWrap}>
            {HOURS.map((h) => (
              <TouchableOpacity
                key={h.id}
                style={[styles.hourChip, hoursPreset === h.id && styles.hourChipOn]}
                onPress={() => setHoursPreset(h.id)}
              >
                <Text style={[styles.hourChipText, hoursPreset === h.id && styles.hourChipTextOn]}>{h.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <View style={styles.premiumBanner}>
            <Text style={styles.premiumLabel}>Your estimated weekly premium</Text>
            <Text style={styles.premiumValue}>₹{livePremium}</Text>
            <Text style={styles.premiumHint}>Updates with zone risk and hours</Text>
          </View>

          <View style={styles.rowNav}>
            <TouchableOpacity style={styles.backBtn} onPress={() => setStep(2)}>
              <Text style={styles.backBtnText}>Back</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.next, { flex: 1 }]} onPress={() => setStep(4)}>
              <Text style={styles.nextText}>Continue</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      )}

      {step === 4 && (
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          <Text style={styles.stepTitle}>Choose your coverage tier</Text>
          <Text style={styles.stepSub}>
            Your zone risk means {tier} covers ~{pct}% of disruption scenarios.
          </Text>

          {TIERS.map((t) => (
            <TouchableOpacity
              key={t.id}
              style={[styles.tierCard, tier === t.id && styles.tierCardOn]}
              onPress={() => setTier(t.id)}
              activeOpacity={0.9}
            >
              {t.popular ? (
                <View style={styles.popBadge}>
                  <Text style={styles.popBadgeText}>Most Popular</Text>
                </View>
              ) : null}
              <View style={styles.tierRow}>
                <Text style={styles.tierName}>{t.label}</Text>
                <Text style={styles.tierPrice}>₹{t.weekly}/week</Text>
              </View>
              <Text style={styles.tierDay}>Up to ₹{t.daily}/day covered</Text>
            </TouchableOpacity>
          ))}

          <TouchableOpacity
            style={[styles.activate, loading && { opacity: 0.75 }]}
            onPress={submitProfile}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.activateText}>Activate Coverage — ₹{selectedTier.weekly}/week</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity style={styles.backBtnOnly} onPress={() => setStep(3)}>
            <Text style={styles.backBtnText}>Back</Text>
          </TouchableOpacity>
        </ScrollView>
      )}

      {step === 5 && (
        <View style={styles.successWrap}>
          <Animated.View style={[styles.shieldWrap, { transform: [{ scale }] }]}>
            <Text style={styles.shieldEmoji}>🛡️</Text>
            <View style={styles.checkBadge}>
              <Text style={styles.checkText}>✓</Text>
            </View>
          </Animated.View>
          <Text style={styles.successTitle}>You are protected! Coverage starts now.</Text>

          <View style={styles.summaryCard}>
            <Text style={styles.summaryLine}>
              <Text style={styles.summaryBold}>Plan:</Text> {tier} · ₹{selectedTier.weekly}/week
            </Text>
            <Text style={styles.summaryLine}>
              <Text style={styles.summaryBold}>Zone:</Text> {zone?.label} ({zone?.score}/100)
            </Text>
            <Text style={styles.summaryLine}>
              <Text style={styles.summaryBold}>Hours:</Text> {HOURS.find((h) => h.id === hoursPreset)?.label}
            </Text>
          </View>

          <TouchableOpacity style={styles.next} onPress={goDashboard}>
            <Text style={styles.nextText}>Go to Dashboard</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.logout} onPress={() => { signOut(); navigation.replace('Onboarding'); }}>
            <Text style={styles.logoutText}>Logout</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f8fafc', paddingHorizontal: 18 },
  progress: { flexDirection: 'row', gap: 8, marginBottom: 12, justifyContent: 'center' },
  dot: { width: 28, height: 4, borderRadius: 2, backgroundColor: '#e5e7eb' },
  dotOn: { backgroundColor: BRAND },
  scroll: { paddingBottom: 32 },
  stepTitle: { fontSize: 22, fontWeight: '800', color: '#111827', marginBottom: 8 },
  stepSub: { fontSize: 14, color: '#6b7280', marginBottom: 18, lineHeight: 20 },
  nameLabel: { fontSize: 13, fontWeight: '700', color: '#374151', marginBottom: 6 },
  nameInput: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
    backgroundColor: '#fff',
    marginBottom: 20,
  },
  platformGrid: { gap: 12 },
  platformCard: {
    borderWidth: 2,
    borderRadius: 16,
    padding: 16,
    backgroundColor: '#fff',
    marginBottom: 4,
    overflow: 'hidden',
  },
  platformStripe: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 5 },
  platformName: { fontSize: 20, fontWeight: '800', color: '#111827', marginLeft: 8 },
  platformEarn: { fontSize: 14, color: '#6b7280', marginTop: 6, marginLeft: 8 },
  next: {
    backgroundColor: BRAND,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 20,
  },
  nextDisabled: { opacity: 0.45 },
  nextText: { color: '#fff', fontSize: 17, fontWeight: '800' },
  mapPlaceholder: {
    height: 140,
    backgroundColor: '#e0e7ff',
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  mapEmoji: { fontSize: 40 },
  mapHint: { marginTop: 6, color: '#4338ca', fontWeight: '600' },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  chip: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    minWidth: '45%',
    flexGrow: 1,
  },
  chipOn: { borderColor: BRAND, backgroundColor: '#eff6ff' },
  chipText: { fontWeight: '700', color: '#111827' },
  chipTextOn: { color: BRAND },
  chipBadge: { fontSize: 11, color: '#6b7280', marginTop: 4 },
  riskLine: { marginTop: 16, fontSize: 14, color: '#374151', fontWeight: '600', lineHeight: 20 },
  rowNav: { flexDirection: 'row', gap: 12, marginTop: 20, alignItems: 'center' },
  backBtn: { paddingVertical: 14, paddingHorizontal: 16 },
  backBtnText: { color: BRAND, fontWeight: '700', fontSize: 15 },
  hoursWrap: { gap: 10 },
  hourChip: {
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 14,
    backgroundColor: '#fff',
    borderWidth: 2,
    borderColor: '#e5e7eb',
  },
  hourChipOn: { borderColor: BRAND, backgroundColor: '#eff6ff' },
  hourChipText: { fontSize: 15, fontWeight: '600', color: '#374151' },
  hourChipTextOn: { color: BRAND },
  premiumBanner: {
    marginTop: 22,
    padding: 18,
    borderRadius: 16,
    backgroundColor: '#1e293b',
  },
  premiumLabel: { color: '#94a3b8', fontSize: 13 },
  premiumValue: { color: '#fff', fontSize: 32, fontWeight: '800', marginTop: 4 },
  premiumHint: { color: '#64748b', fontSize: 12, marginTop: 4 },
  tierCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    borderWidth: 2,
    borderColor: '#e5e7eb',
  },
  tierCardOn: { borderColor: BRAND, backgroundColor: '#eff6ff' },
  popBadge: {
    alignSelf: 'flex-start',
    backgroundColor: '#f59e0b',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    marginBottom: 8,
  },
  popBadgeText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  tierRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  tierName: { fontSize: 18, fontWeight: '800', color: '#111827' },
  tierPrice: { fontSize: 18, fontWeight: '800', color: BRAND },
  tierDay: { fontSize: 13, color: '#6b7280', marginTop: 6 },
  activate: {
    backgroundColor: BRAND,
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: 'center',
    marginTop: 8,
  },
  activateText: { color: '#fff', fontSize: 17, fontWeight: '800' },
  backBtnOnly: { marginTop: 14, alignItems: 'center' },
  successWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  shieldWrap: { position: 'relative', marginBottom: 24 },
  shieldEmoji: { fontSize: 96 },
  checkBadge: {
    position: 'absolute',
    right: -4,
    bottom: 8,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#22c55e',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkText: { color: '#fff', fontSize: 20, fontWeight: '800' },
  successTitle: { fontSize: 22, fontWeight: '800', color: '#111827', textAlign: 'center', marginBottom: 20 },
  summaryCard: {
    width: '100%',
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    marginBottom: 24,
  },
  summaryLine: { fontSize: 15, color: '#374151', marginBottom: 8 },
  summaryBold: { fontWeight: '800', color: '#111827' },
  logout: { marginTop: 12 },
  logoutText: { color: '#b91c1c', fontWeight: '700' },
});
