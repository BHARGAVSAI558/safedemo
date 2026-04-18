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
import { usePolicy } from '../contexts/PolicyContext';
import { gigProfile, workers, policies, formatApiError } from '../services/api';
import { useGPSZoneDetection } from '../hooks/useGPSZoneDetection';
import { formatShortLocation } from '../utils/locationDisplay';

const BRAND = '#1A56DB';

const PLATFORMS = [
  { id: 'zomato', label: 'Zomato', color: '#E23744', earnMid: 780 },
  { id: 'swiggy', label: 'Swiggy', color: '#FC8019', earnMid: 720 },
  { id: 'other', label: 'Other', color: '#475569', earnMid: 650 },
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
  const { setPolicy } = usePolicy();
  const insets = useSafeAreaInsets();
  const nameRef = useRef(null);
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [platform, setPlatform] = useState(null);
  const [zone, setZone] = useState(null);
  const [placeQuery, setPlaceQuery] = useState('');
  const [placeLoading, setPlaceLoading] = useState(false);
  const [placeSuggestions, setPlaceSuggestions] = useState([]);
  const [selectedPlaceId, setSelectedPlaceId] = useState('');
  const [placeError, setPlaceError] = useState('');
  const [hoursPreset, setHoursPreset] = useState('full_day');
  const [tier, setTier] = useState('Standard');
  const [loading, setLoading] = useState(false);
  const [successPolicy, setSuccessPolicy] = useState(null);
  const tierRef = useRef('Standard');
  const { detectZone, gpsLoading, gpsError } = useGPSZoneDetection();

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

  const recommendedTier = useMemo(() => recommendedTierForZone(zoneRiskLevel), [zoneRiskLevel]);

  const selectedTier = TIERS.find((t) => t.id === tier) || TIERS[1];

  useEffect(() => {
    tierRef.current = tier;
  }, [tier]);

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
        city: zone?.city || zone?.label || 'India',
        zone_id: zone.id,
        location_display: String(zone?.label || zone?.zone_name || zone?.placeName || zone?.city || '').trim() || undefined,
        avg_daily_income: platformMidpoint(platform),
        working_hours_preset: hoursPreset,
        coverage_tier: tier,
      });
      const chosenTierId = tierRef.current || tier;
      const chosenTier = TIERS.find((t) => t.id === chosenTierId) || selectedTier;
      const activated = await policies.activate({ tier: chosenTierId, zone_id: zone.id });
      const mergedSuccess = {
        ...activated,
        tier: chosenTierId,
        weekly_premium: activated?.weekly_premium || chosenTier.weekly,
        zone_label: zone?.label || activated?.zone_label || 'Selected zone',
        zone_risk_level:
          zone?.riskLevel === 'high'
            ? 'High Risk'
            : zone?.riskLevel === 'low'
              ? 'Low Risk'
              : activated?.zone_risk_level || 'Medium Risk',
        max_coverage_per_day: activated?.max_coverage_per_day || chosenTier.daily,
        premium_breakdown: activated?.premium_breakdown || null,
      };
      setSuccessPolicy(mergedSuccess);
      // Keep app state synced immediately with selected plan after activation.
      setPolicy(
        {
          status: 'active',
          tier: chosenTierId,
          weekly_premium: Number(chosenTier.weekly),
          valid_until: activated?.valid_until,
          max_coverage_per_day: chosenTier.daily,
          risk_score: Number(activated?.risk_score ?? zoneScore),
          zone: zone?.label || 'Selected zone',
          policy_id: activated?.id,
        },
        'active'
      );
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
  useEffect(() => {
    const q = String(placeQuery || '').trim();
    if (q.length < 2) {
      setPlaceSuggestions([]);
      setSelectedPlaceId('');
      setPlaceError('');
      return;
    }
    const timer = setTimeout(async () => {
      setPlaceLoading(true);
      setPlaceError('');
      try {
        const url =
          `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}` +
          '&format=json&countrycodes=in&limit=10&addressdetails=1';
        const res = await fetch(url, {
          headers: {
            'Accept-Language': 'en',
            'User-Agent': 'SafeNet-App/1.0',
          },
        });
        if (!res.ok) throw new Error('Search failed');
        const data = await res.json();
        let features = Array.isArray(data) ? data : [];
        if (!features.length) {
          const purl = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=8&lang=en`;
          const pres = await fetch(purl);
          if (pres.ok) {
            const pdata = await pres.json();
            const list = Array.isArray(pdata?.features) ? pdata.features : [];
            features = list
              .map((f) => ({
                place_id: f?.properties?.osm_id || Math.random(),
                display_name: [
                  f?.properties?.name,
                  f?.properties?.city,
                  f?.properties?.district,
                  f?.properties?.state,
                  'India',
                ].filter(Boolean).join(', '),
                name: f?.properties?.name,
                lat: f?.geometry?.coordinates?.[1],
                lon: f?.geometry?.coordinates?.[0],
              }))
              .filter((x) => Number.isFinite(Number(x.lat)) && Number.isFinite(Number(x.lon)));
          }
        }
        const seen = new Set();
        setPlaceSuggestions(
          features
            .map((f) => ({
              id: String(f.place_id || Math.random()),
              label: formatShortLocation(String(f.display_name || '')) || String(f.display_name || ''),
              name: String(f.name || f.display_name || ''),
              lat: Number(f.lat),
              lng: Number(f.lon),
            }))
            .filter((it) => {
              const key = `${Math.round(it.lat * 1000)}:${Math.round(it.lng * 1000)}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            })
        );
      } catch (e) {
        setPlaceSuggestions([]);
        setPlaceError('Location not found. Try nearby town/zone name or use current location.');
      } finally {
        setPlaceLoading(false);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [placeQuery]);

  const selectSuggestedPlace = async (item) => {
    const lat = Number(item?.lat);
    const lng = Number(item?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      Alert.alert('Location error', 'Could not resolve selected location.');
      return;
    }
    try {
      const detected = await detectZone({ lat, lng, placeName: item?.label || item?.name });
      if (detected) {
        const chosen = String(item?.label || item?.name || '').trim();
        setZone({
          ...detected,
          placeName: chosen || detected.placeName,
          label: chosen || detected.label,
        });
        setSelectedPlaceId(String(item?.id || ''));
        setPlaceQuery(item?.label || '');
        setPlaceSuggestions([]);
      }
    } catch {
      Alert.alert('Location error', 'Unable to detect zone for selected place.');
    }
  };


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
            <Text style={styles.stepSub}>Search any place in India or use GPS. SafeNet maps it to the nearest zone.</Text>

            <View style={[styles.mapPlaceholder, { width: w - 36 }]}>
              <Text style={styles.mapEmoji}>🗺️</Text>
              <Text style={styles.mapHint}>Search or use current location</Text>
            </View>

            <View style={styles.searchBox}>
              <TextInput
                style={styles.searchInput}
                placeholder="Select zone (e.g. Gachibowli, Vijayawada)"
                placeholderTextColor="#94a3b8"
                value={placeQuery}
                onChangeText={setPlaceQuery}
                autoCorrect={false}
                autoCapitalize="words"
                editable
              />
              {placeLoading ? <ActivityIndicator size="small" color={BRAND} /> : null}
            </View>
            {zone?.placeName ? (
              <View style={styles.selectedPlaceCard}>
                <Text style={styles.selectedPlaceTitle}>Chosen location</Text>
                <Text style={styles.selectedPlaceValue}>{zone.placeName}</Text>
              </View>
            ) : null}
            {placeError ? <Text style={styles.gpsError}>{placeError}</Text> : null}
            {placeSuggestions.length > 0 ? (
              <View style={styles.suggestionsWrap}>
                {placeSuggestions.map((item) => (
                  <TouchableOpacity
                    key={item.id}
                    style={[
                      styles.suggestionItem,
                      selectedPlaceId === String(item.id) && styles.suggestionItemSelected,
                    ]}
                    onPress={() => selectSuggestedPlace(item)}
                  >
                    <Text style={styles.suggestionLabel}>{item.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            ) : null}

            <TouchableOpacity
              style={[styles.gpsBtn, gpsLoading && { opacity: 0.6 }]}
              onPress={async () => {
                const detected = await detectZone();
                if (detected) setZone(detected);
              }}
              disabled={gpsLoading}
            >
              {gpsLoading
                ? <ActivityIndicator color={BRAND} size="small" />
                : <Text style={styles.gpsBtnText}>Use current location</Text>}
            </TouchableOpacity>
            {gpsError ? <Text style={styles.gpsError}>{gpsError}</Text> : null}

            {zone ? (
              <View style={styles.riskExplain}>
                <Text style={styles.riskExplainTitle}>How we see your zone</Text>
                <Text style={styles.riskExplainBody}>{ZONE_RISK_COPY[zone.riskLevel]}</Text>
                <Text style={styles.riskExplainBody}>
                  Detected place: {zone.placeName || zone.label}
                </Text>
                <Text style={[styles.riskExplainBody, { marginTop: 6 }]}>
                  Mapped zone: {zone.label} · Risk: {String(zone.badge || '').toUpperCase()}
                </Text>
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
                  onPress={() => {
                    setTier(t.id);
                    tierRef.current = t.id;
                  }}
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
            <Text style={styles.successSub}>Coverage is active and synced with your dashboard.</Text>

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
              <Text style={styles.summaryFootnote}>
                AI risk calculation 0/100 · updates live as you ride with SafeNet
              </Text>
            </View>

            <TouchableOpacity style={styles.successPrimaryBtn} onPress={goDashboard}>
              <Text style={styles.successPrimaryBtnText}>Go to Dashboard</Text>
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
  gpsBtn: {
    alignSelf: 'center',
    marginBottom: 12,
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: BRAND,
    backgroundColor: '#eff6ff',
  },
  gpsBtnText: { color: BRAND, fontWeight: '800', fontSize: 15 },
  gpsError: { color: '#b91c1c', fontSize: 12, fontWeight: '600', textAlign: 'center', marginBottom: 8 },
  searchBox: {
    borderWidth: 1.5,
    borderColor: '#cbd5e1',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  searchInput: { flex: 1, fontSize: 16, fontWeight: '700', color: '#0f172a', minHeight: 28 },
  selectedPlaceCard: {
    marginTop: 10,
    marginBottom: 8,
    borderWidth: 1.5,
    borderColor: '#93c5fd',
    backgroundColor: '#eff6ff',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  selectedPlaceTitle: { color: '#1d4ed8', fontSize: 12, fontWeight: '800', marginBottom: 4, textTransform: 'uppercase' },
  selectedPlaceValue: { color: '#0f172a', fontSize: 14, fontWeight: '700' },
  suggestionsWrap: {
    maxHeight: 220,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    marginBottom: 10,
    overflow: 'hidden',
    backgroundColor: '#fff',
  },
  suggestionItem: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  suggestionItemSelected: {
    backgroundColor: '#eff6ff',
    borderLeftWidth: 3,
    borderLeftColor: BRAND,
  },
  suggestionLabel: { color: '#0f172a', fontWeight: '600', fontSize: 13 },
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
  shieldWrap: {
    marginBottom: 16,
    backgroundColor: '#eaf2ff',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#c7ddff',
    width: 120,
    height: 120,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shieldEmoji: { fontSize: 66, textAlign: 'center' },
  successTitle: { fontSize: 30, fontWeight: '900', color: '#0f172a', textAlign: 'center', marginBottom: 6 },
  successSub: { fontSize: 14, color: '#64748b', textAlign: 'center', marginBottom: 18, fontWeight: '600' },
  summaryCardPremium: {
    width: '100%',
    backgroundColor: '#f8fbff',
    borderRadius: 22,
    padding: 20,
    borderWidth: 1,
    borderColor: '#dbeafe',
    marginBottom: 24,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 6px 14px rgba(29, 78, 216, 0.08)' }
      : {
          shadowColor: '#1d4ed8',
          shadowOpacity: 0.08,
          shadowRadius: 14,
          shadowOffset: { width: 0, height: 6 },
          elevation: 3,
        }),
  },
  summaryCardTitle: { fontSize: 12, fontWeight: '800', color: '#64748b', letterSpacing: 1, marginBottom: 12 },
  summaryLine: { fontSize: 15, color: '#334155', marginBottom: 10, lineHeight: 22 },
  summaryBold: { fontWeight: '800', color: '#0f172a' },
  summaryFootnote: { fontSize: 12, color: '#94a3b8', marginTop: 8, lineHeight: 18 },
  successPrimaryBtn: {
    backgroundColor: '#1d4ed8',
    borderRadius: 14,
    minWidth: 190,
    paddingVertical: 14,
    alignItems: 'center',
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 5px 12px rgba(29, 78, 216, 0.28)' }
      : {
          shadowColor: '#1d4ed8',
          shadowOpacity: 0.28,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 5 },
          elevation: 3,
        }),
  },
  successPrimaryBtnText: { color: '#fff', fontWeight: '900', fontSize: 20 },
  logout: { marginTop: 14 },
  logoutText: { color: '#b91c1c', fontWeight: '700' },
});
