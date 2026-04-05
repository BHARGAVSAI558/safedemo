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
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '../contexts/AuthContext';
import { gigProfile, workers, policies, formatApiError } from '../services/api';

const BRAND = '#1A56DB';

const PLATFORMS = [
  { id: 'zomato', label: 'Zomato', color: '#E23744', earnMid: 780 },
  { id: 'swiggy', label: 'Swiggy', color: '#FC8019', earnMid: 720 },
  { id: 'both', label: 'Both', color: '#7c3aed', earnMid: 950 },
  { id: 'other', label: 'Other', color: '#475569', earnMid: 650 },
];

const ZONES = [
  { id: 'kukatpally', label: 'Kukatpally', badge: 'High risk', score: 81, riskLevel: 'high' },
  { id: 'miyapur', label: 'Miyapur', badge: 'Medium', score: 70, riskLevel: 'medium' },
  { id: 'hitec_city', label: 'HITEC City', badge: 'Low risk', score: 58, riskLevel: 'low' },
  { id: 'madhapur', label: 'Madhapur', badge: 'Medium', score: 65, riskLevel: 'medium' },
  { id: 'jubilee_hills', label: 'Jubilee Hills', badge: 'Low risk', score: 55, riskLevel: 'low' },
  { id: 'banjara_hills', label: 'Banjara Hills', badge: 'Medium', score: 63, riskLevel: 'medium' },
  { id: 'begumpet', label: 'Begumpet', badge: 'Medium', score: 68, riskLevel: 'medium' },
  { id: 'secunderabad', label: 'Secunderabad', badge: 'Medium', score: 69, riskLevel: 'medium' },
  { id: 'ameerpet', label: 'Ameerpet', badge: 'Medium', score: 71, riskLevel: 'medium' },
  { id: 'gachibowli', label: 'Gachibowli', badge: 'Medium', score: 66, riskLevel: 'medium' },
  { id: 'kondapur', label: 'Kondapur', badge: 'Medium', score: 67, riskLevel: 'medium' },
  { id: 'uppal', label: 'Uppal', badge: 'Medium', score: 73, riskLevel: 'medium' },
  { id: 'lb_nagar', label: 'LB Nagar', badge: 'High risk', score: 78, riskLevel: 'high' },
  { id: 'old_city', label: 'Old City', badge: 'High risk', score: 76, riskLevel: 'high' },
  { id: 'other', label: 'Other', badge: 'Medium', score: 72, riskLevel: 'medium' },
];

const ZONE_RISK_COPY = {
  high:
    'Flood-prone area. You qualify for Pro tier. Higher payouts during monsoon.',
  medium: 'Moderate disruption history. Standard tier recommended.',
  low: 'Safer zone. Basic tier sufficient for most disruptions.',
};

const HOURS = [
  { id: 'morning', label: 'Morning', sub: '6AM – 12PM' },
  { id: 'afternoon', label: 'Afternoon', sub: '12PM – 6PM' },
  { id: 'evening', label: 'Evening', sub: '6PM – 11PM' },
  { id: 'full_day', label: 'Full Day', sub: 'All shifts' },
  { id: 'flexible', label: 'Flexible', sub: 'Varies' },
];

const TIERS = [
  { id: 'Basic', weekly: 35, daily: 350, label: 'Basic', blurb: 'Core income backup' },
  { id: 'Standard', weekly: 49, daily: 500, label: 'Standard', blurb: 'Balanced protection', popular: true },
  { id: 'Pro', weekly: 70, daily: 700, label: 'Pro', blurb: 'Maximum daily cover' },
];

function platformMidpoint(p) {
  if (!p) return 750;
  if (typeof p.earnMid === 'number') return Math.round(p.earnMid);
  return Math.round(((p.earnMin || 0) + (p.earnMax || 0)) / 2) || 750;
}

function recommendedTierForZone(riskLevel) {
  if (riskLevel === 'high') return 'Pro';
  if (riskLevel === 'low') return 'Basic';
  return 'Standard';
}

function formatValidUntil(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return '—';
  }
}

export default function ProfileSetupScreen({ navigation }) {
  const { signOut, dispatch } = useAuth();
  const insets = useSafeAreaInsets();
  const nameRef = useRef(null);
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [platform, setPlatform] = useState(null);
  const [zone, setZone] = useState(null);
  const [hoursPreset, setHoursPreset] = useState('full_day');
  const [tier, setTier] = useState('Standard');
  const [loading, setLoading] = useState(false);
  const [successPolicy, setSuccessPolicy] = useState(null);

  const shieldScale = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    if (step === 1) {
      const t = setTimeout(() => nameRef.current?.focus?.(), 400);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [step]);

  useEffect(() => {
    if (step === 6 && successPolicy) {
      shieldScale.setValue(0.3);
      Animated.spring(shieldScale, {
        toValue: 1,
        friction: 5,
        tension: 80,
        useNativeDriver: true,
      }).start();
    }
  }, [step, successPolicy, shieldScale]);

  const zoneRiskLevel = zone?.riskLevel || 'medium';
  const zoneScore = zone?.score ?? 72;

  const disruptionCover = useMemo(() => {
    const t = TIERS.find((x) => x.id === tier) || TIERS[1];
    return t.daily;
  }, [tier]);

  const recommendedTier = useMemo(() => recommendedTierForZone(zoneRiskLevel), [zoneRiskLevel]);

  const selectedTier = TIERS.find((t) => t.id === tier) || TIERS[1];

  const submitOnboarding = async () => {
    if (!name.trim() || name.trim().length < 2) {
      Alert.alert('Name needed', 'Please tell us what to call you.');
      setStep(1);
      return;
    }
    if (!platform || !zone) {
      Alert.alert('Almost there', 'Please choose your platform and delivery zone.');
      return;
    }

    setLoading(true);
    try {
      await gigProfile.submit({
        name: name.trim(),
        platform: platform.id,
        city: 'Hyderabad',
        zone_id: zone.id,
        avg_daily_income: platformMidpoint(platform),
        working_hours_preset: hoursPreset,
        coverage_tier: tier,
      });
      const activated = await policies.activate({ tier });
      setSuccessPolicy(activated);
      setStep(6);
    } catch (e) {
      if (e?.response?.status === 401) {
        await signOut();
        Alert.alert('Session expired', formatApiError(e));
        navigation.replace('Onboarding');
        return;
      }
      Alert.alert('Could not continue', formatApiError(e));
    } finally {
      setLoading(false);
    }
  };

  const goDashboard = async () => {
    try {
      const profile = await workers.getProfile();
      dispatch({ type: 'SET_PROFILE', profile });
      // RootNavigator switches to MainTabs when profileReady === true — do not replace('MainTabs'); that route is not on the auth stack.
    } catch (e) {
      if (e?.response?.status === 401) {
        await signOut();
        navigation.replace('Onboarding');
        return;
      }
      Alert.alert('Could not refresh profile', formatApiError(e));
    }
  };

  const w = Dimensions.get('window').width;
  const canContinueStep1 = name.trim().length >= 2;
  const canContinueStep2 = Boolean(platform);
  const canContinueStep3 = Boolean(zone);

  const headerBlue = (
    <View style={styles.blueHeader}>
      <Text style={styles.blueHeaderTitle}>SafeNet</Text>
      <Text style={styles.blueHeaderSub}>Personalize your cover — takes under a minute</Text>
    </View>
  );

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom + 12 }]}>
        {step >= 1 && step <= 5 ? (
          <View style={styles.progress}>
            {[1, 2, 3, 4, 5].map((s) => (
              <View key={s} style={[styles.dot, step >= s && styles.dotOn]} />
            ))}
          </View>
        ) : null}

        {step === 1 && (
          <View style={styles.flex}>
            {headerBlue}
            <View style={styles.step1Body}>
              <Text style={styles.warmQuestion}>What should we call you?</Text>
              <TextInput
                ref={nameRef}
                style={styles.largeNameInput}
                placeholder="Your first name"
                placeholderTextColor="#94a3b8"
                value={name}
                onChangeText={setName}
                autoCapitalize="words"
                autoCorrect={false}
                returnKeyType="done"
              />
            </View>
            <TouchableOpacity
              style={[styles.continueBtn, !canContinueStep1 && styles.continueDisabled]}
              disabled={!canContinueStep1}
              onPress={() => setStep(2)}
            >
              <Text style={styles.continueBtnText}>Continue</Text>
            </TouchableOpacity>
          </View>
        )}

        {step === 2 && (
          <ScrollView
            contentContainerStyle={styles.scroll}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {headerBlue}
            <Text style={styles.stepTitle}>Which delivery app do you use most?</Text>
            <Text style={styles.stepSub}>We use this only to personalize your cover — we never link your delivery account.</Text>

            <View style={styles.platformGrid}>
              {PLATFORMS.map((p) => {
                const selected = platform?.id === p.id;
                return (
                  <TouchableOpacity
                    key={p.id}
                    style={[
                      styles.platformCard,
                      { borderColor: selected ? p.color : '#e5e7eb' },
                      selected && { backgroundColor: `${p.color}12`, borderWidth: 3 },
                    ]}
                    onPress={() => setPlatform(p)}
                    activeOpacity={0.88}
                  >
                    <View style={[styles.platformStripe, { backgroundColor: p.color }]} />
                    <View style={styles.platformRow}>
                      <Text style={styles.platformName}>{p.label}</Text>
                      {selected ? (
                        <View style={[styles.checkCircle, { borderColor: p.color }]}>
                          <Text style={[styles.checkMark, { color: p.color }]}>✓</Text>
                        </View>
                      ) : null}
                    </View>
                    <Text style={styles.platformEarn}>Typical city rider</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={styles.rowNav}>
              <TouchableOpacity style={styles.backBtn} onPress={() => setStep(1)}>
                <Text style={styles.backBtnText}>Back</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.next, !canContinueStep2 && styles.nextDisabled, { flex: 1 }]}
                disabled={!canContinueStep2}
                onPress={() => setStep(3)}
              >
                <Text style={styles.nextText}>Continue</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        )}

        {step === 3 && (
          <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
            {headerBlue}
            <Text style={styles.stepTitle}>Where do you mainly deliver?</Text>
            <Text style={styles.stepSub}>Hyderabad — your zone shapes risk, pricing, and payouts.</Text>

            <View style={[styles.mapPlaceholder, { width: w - 36 }]}>
              <Text style={styles.mapEmoji}>🗺️</Text>
              <Text style={styles.mapHint}>Zone grid · Hyderabad</Text>
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
              <View style={styles.riskExplain}>
                <Text style={styles.riskExplainTitle}>How we see your zone</Text>
                <Text style={styles.riskExplainBody}>{ZONE_RISK_COPY[zone.riskLevel]}</Text>
              </View>
            ) : null}

            <View style={styles.rowNav}>
              <TouchableOpacity style={styles.backBtn} onPress={() => setStep(2)}>
                <Text style={styles.backBtnText}>Back</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.next, !canContinueStep3 && styles.nextDisabled, { flex: 1 }]} disabled={!canContinueStep3} onPress={() => setStep(4)}>
                <Text style={styles.nextText}>Continue</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        )}

        {step === 4 && (
          <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
            {headerBlue}
            <Text style={styles.stepTitle}>When do you usually work?</Text>
            <Text style={styles.stepSub}>Helps us align cover with when you are usually on the road.</Text>

            <View style={styles.hoursWrap}>
              {HOURS.map((h) => (
                <TouchableOpacity
                  key={h.id}
                  style={[styles.hourChip, hoursPreset === h.id && styles.hourChipOn]}
                  onPress={() => setHoursPreset(h.id)}
                >
                  <Text style={[styles.hourChipTitle, hoursPreset === h.id && styles.hourChipTitleOn]}>{h.label}</Text>
                  <Text style={[styles.hourChipSub, hoursPreset === h.id && styles.hourChipSubOn]}>{h.sub}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={styles.premiumDarkCard}>
              <Text style={styles.premiumDarkLabel}>Next step</Text>
              <Text style={styles.premiumDarkValue}>Choose your tier</Text>
              <Text style={styles.premiumDarkSub}>
                Up to ₹{disruptionCover.toLocaleString('en-IN')} per disruption day with your selected plan
              </Text>
              <Text style={styles.premiumDarkHint}>Final weekly premium is set when you pick Basic, Standard, or Pro</Text>
            </View>

            <View style={styles.rowNav}>
              <TouchableOpacity style={styles.backBtn} onPress={() => setStep(3)}>
                <Text style={styles.backBtnText}>Back</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.next, { flex: 1 }]} onPress={() => setStep(5)}>
                <Text style={styles.nextText}>Continue</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        )}

        {step === 5 && (
          <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
            {headerBlue}
            <Text style={styles.stepTitle}>Choose your coverage tier</Text>
            <Text style={styles.stepSub}>
              Based on your zone risk score of {zoneScore}/100, we recommend {recommendedTier}.
            </Text>

            {TIERS.map((t) => {
              const rec = t.id === recommendedTier;
              const selected = tier === t.id;
              return (
                <TouchableOpacity
                  key={t.id}
                  style={[styles.tierCard, selected && styles.tierCardOn]}
                  onPress={() => setTier(t.id)}
                  activeOpacity={0.9}
                >
                  {rec ? (
                    <View style={styles.recBadge}>
                      <Text style={styles.recBadgeText}>Recommended for you</Text>
                    </View>
                  ) : null}
                  {t.popular && !rec ? (
                    <View style={styles.popBadge}>
                      <Text style={styles.popBadgeText}>Popular</Text>
                    </View>
                  ) : null}
                  <View style={styles.tierRow}>
                    <Text style={styles.tierName}>{t.label}</Text>
                    <Text style={styles.tierPrice}>₹{t.weekly}/wk list</Text>
                  </View>
                  <Text style={styles.tierDay}>Up to ₹{t.daily}/day covered · {t.blurb}</Text>
                </TouchableOpacity>
              );
            })}

            <TouchableOpacity
              style={[styles.activate, loading && { opacity: 0.75 }]}
              onPress={submitOnboarding}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.activateText}>
                  Activate {tier} — ₹{selectedTier.weekly}/week
                </Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity style={styles.backBtnOnly} onPress={() => setStep(4)}>
              <Text style={styles.backBtnText}>Back</Text>
            </TouchableOpacity>
          </ScrollView>
        )}

        {step === 6 && successPolicy ? (
          <View style={styles.successWrap}>
            <Animated.View style={[styles.shieldWrap, { transform: [{ scale: shieldScale }] }]}>
              <Text style={styles.shieldEmoji}>🛡️</Text>
            </Animated.View>
            <Text style={styles.successTitle}>{"You're protected 🛡️"}</Text>

            <View style={styles.summaryCardPremium}>
              <Text style={styles.summaryCardTitle}>Your coverage</Text>
              <Text style={styles.summaryLine}>
                <Text style={styles.summaryBold}>Zone: </Text>
                {successPolicy.zone_label} ({successPolicy.zone_risk_level})
              </Text>
              <Text style={styles.summaryLine}>
                <Text style={styles.summaryBold}>Coverage: </Text>₹
                {Math.round(successPolicy.max_coverage_per_day).toLocaleString('en-IN')}/day
              </Text>
              <Text style={styles.summaryLine}>
                <Text style={styles.summaryBold}>Premium: </Text>₹
                {Math.round(successPolicy.weekly_premium).toLocaleString('en-IN')}/week
              </Text>
              <Text style={styles.summaryLine}>
                <Text style={styles.summaryBold}>Active until: </Text>
                {formatValidUntil(successPolicy.valid_until)}
              </Text>
              <Text style={styles.summaryLine}>
                <Text style={styles.summaryBold}>Trust level: </Text>
                {successPolicy.trust_level || 'Newcomer'}
              </Text>
              <Text style={styles.summaryFootnote}>Risk score {successPolicy.risk_score}/100 · builds as you ride with SafeNet</Text>
            </View>

            <TouchableOpacity style={styles.next} onPress={goDashboard}>
              <Text style={styles.nextText}>Go to Dashboard</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.logout}
              onPress={() => {
                signOut();
                navigation.replace('Onboarding');
              }}
            >
              <Text style={styles.logoutText}>Logout</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  root: { flex: 1, backgroundColor: '#ffffff', paddingHorizontal: 18 },
  progress: { flexDirection: 'row', gap: 6, marginBottom: 14, justifyContent: 'center', paddingTop: 8 },
  dot: { flex: 1, maxWidth: 48, height: 4, borderRadius: 2, backgroundColor: '#e5e7eb' },
  dotOn: { backgroundColor: BRAND },
  blueHeader: {
    backgroundColor: BRAND,
    marginHorizontal: -18,
    paddingHorizontal: 18,
    paddingVertical: 20,
    marginBottom: 20,
    borderBottomLeftRadius: 20,
    borderBottomRightRadius: 20,
  },
  blueHeaderTitle: { color: '#fff', fontSize: 22, fontWeight: '800' },
  blueHeaderSub: { color: '#bfdbfe', marginTop: 4, fontSize: 14 },
  step1Body: { flex: 1, justifyContent: 'center', paddingVertical: 24 },
  warmQuestion: {
    fontSize: 28,
    fontWeight: '800',
    color: '#0f172a',
    textAlign: 'center',
    lineHeight: 36,
    marginBottom: 28,
  },
  largeNameInput: {
    fontSize: 26,
    fontWeight: '600',
    textAlign: 'center',
    borderBottomWidth: 2,
    borderBottomColor: '#e2e8f0',
    paddingVertical: 14,
    color: '#0f172a',
  },
  continueBtn: {
    backgroundColor: BRAND,
    borderRadius: 16,
    paddingVertical: 18,
    alignItems: 'center',
    marginBottom: 8,
  },
  continueDisabled: { opacity: 0.4 },
  continueBtnText: { color: '#fff', fontSize: 17, fontWeight: '800' },
  scroll: { paddingBottom: 36 },
  stepTitle: { fontSize: 22, fontWeight: '800', color: '#111827', marginBottom: 8 },
  stepSub: { fontSize: 14, color: '#6b7280', marginBottom: 18, lineHeight: 20 },
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
  platformRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginLeft: 8 },
  platformName: { fontSize: 20, fontWeight: '800', color: '#111827' },
  checkCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
  },
  checkMark: { fontSize: 16, fontWeight: '900' },
  platformEarn: { fontSize: 14, color: '#64748b', marginTop: 8, marginLeft: 8, fontWeight: '600' },
  mapPlaceholder: {
    height: 140,
    backgroundColor: '#e0e7ff',
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
    alignSelf: 'center',
  },
  mapEmoji: { fontSize: 40 },
  mapHint: { marginTop: 6, color: '#4338ca', fontWeight: '600' },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  chip: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    minWidth: '45%',
    flexGrow: 1,
  },
  chipOn: { borderColor: BRAND, backgroundColor: '#eff6ff' },
  chipText: { fontWeight: '700', color: '#111827' },
  chipTextOn: { color: BRAND },
  chipBadge: { fontSize: 11, color: '#6b7280', marginTop: 4 },
  riskExplain: {
    marginTop: 18,
    padding: 16,
    borderRadius: 14,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  riskExplainTitle: { fontSize: 13, fontWeight: '800', color: '#334155', marginBottom: 6 },
  riskExplainBody: { fontSize: 14, color: '#475569', lineHeight: 21, fontWeight: '500' },
  rowNav: { flexDirection: 'row', gap: 12, marginTop: 22, alignItems: 'center' },
  backBtn: { paddingVertical: 14, paddingHorizontal: 8 },
  backBtnText: { color: BRAND, fontWeight: '700', fontSize: 15 },
  next: {
    backgroundColor: BRAND,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  nextDisabled: { opacity: 0.45 },
  nextText: { color: '#fff', fontSize: 17, fontWeight: '800' },
  hoursWrap: { gap: 10 },
  hourChip: {
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 14,
    backgroundColor: '#f8fafc',
    borderWidth: 2,
    borderColor: '#e5e7eb',
  },
  hourChipOn: { borderColor: BRAND, backgroundColor: '#eff6ff' },
  hourChipTitle: { fontSize: 16, fontWeight: '700', color: '#374151' },
  hourChipTitleOn: { color: BRAND },
  hourChipSub: { fontSize: 13, color: '#94a3b8', marginTop: 2 },
  hourChipSubOn: { color: '#64748b' },
  premiumDarkCard: {
    marginTop: 22,
    padding: 20,
    borderRadius: 16,
    backgroundColor: '#0f172a',
  },
  premiumDarkLabel: { color: '#94a3b8', fontSize: 13, fontWeight: '600' },
  premiumDarkValue: { color: '#fff', fontSize: 34, fontWeight: '800', marginTop: 6 },
  premiumDarkSub: { color: '#e2e8f0', fontSize: 15, fontWeight: '600', marginTop: 8 },
  premiumDarkHint: { color: '#64748b', fontSize: 12, marginTop: 10 },
  tierCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    borderWidth: 2,
    borderColor: '#e5e7eb',
  },
  tierCardOn: { borderColor: BRAND, backgroundColor: '#eff6ff' },
  recBadge: {
    alignSelf: 'flex-start',
    backgroundColor: BRAND,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    marginBottom: 8,
  },
  recBadgeText: { color: '#fff', fontSize: 11, fontWeight: '800' },
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
  tierPrice: { fontSize: 16, fontWeight: '700', color: BRAND },
  tierDay: { fontSize: 13, color: '#6b7280', marginTop: 6, lineHeight: 18 },
  activate: {
    backgroundColor: BRAND,
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: 'center',
    marginTop: 8,
  },
  activateText: { color: '#fff', fontSize: 17, fontWeight: '800' },
  backBtnOnly: { marginTop: 14, alignItems: 'center' },
  successWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  shieldWrap: { marginBottom: 20 },
  shieldEmoji: { fontSize: 100, textAlign: 'center' },
  successTitle: { fontSize: 24, fontWeight: '800', color: '#0f172a', textAlign: 'center', marginBottom: 22 },
  summaryCardPremium: {
    width: '100%',
    backgroundColor: '#f8fafc',
    borderRadius: 20,
    padding: 22,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginBottom: 24,
  },
  summaryCardTitle: { fontSize: 12, fontWeight: '800', color: '#64748b', letterSpacing: 1, marginBottom: 12 },
  summaryLine: { fontSize: 15, color: '#334155', marginBottom: 10, lineHeight: 22 },
  summaryBold: { fontWeight: '800', color: '#0f172a' },
  summaryFootnote: { fontSize: 12, color: '#94a3b8', marginTop: 8, lineHeight: 18 },
  logout: { marginTop: 12 },
  logoutText: { color: '#b91c1c', fontWeight: '700' },
});
