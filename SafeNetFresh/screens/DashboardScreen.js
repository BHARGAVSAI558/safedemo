import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  RefreshControl,
  useColorScheme,
  ActivityIndicator,
  Animated,
  Pressable,
  Alert,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import Svg, { Circle, Rect } from 'react-native-svg';

import api, { notifications, simulation, workers as workersApi, zones as zonesApi } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { useClaims } from '../contexts/ClaimContext';
import { useWsConnection } from '../contexts/WsConnectionContext';
import { usePolicy } from '../contexts/PolicyContext';
import { useWorkerProfile } from '../hooks/useWorkerProfile';
import { usePayoutHistory } from '../hooks/usePayoutHistory';
import AppModal from '../components/AppModal';
import AssistantModal from '../components/AssistantModal';
import AssistantWidget from '../components/AssistantWidget';
import NotificationBell from '../components/NotificationBell';
import { logButtonTap, logClaimStatusView } from '../services/device_fingerprint.service';
import { trustBadge } from '../utils/trustBadge';
import { canonicalTierLabel } from '../utils/tierDisplay';
import { formatPayoutWhen, formatIstTodayLong } from '../utils/istFormat';

function getTimeGreeting(now = new Date()) {
  const h = now.getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

/** Maps profile.city (and common variants) to backend zone_id in zone_coordinates.json */
const CITY_TO_ZONE_ID = {
  hyderabad: 'hyd_central',
  'hyderabad central': 'hyd_central',
  kukatpally: 'kukatpally',
  miyapur: 'miyapur',
  madhapur: 'madhapur',
  'jubilee hills': 'jubilee_hills',
  'banjara hills': 'banjara_hills',
  begumpet: 'begumpet',
  uppal: 'uppal',
  kondapur: 'kondapur',
  'old city': 'old_city',
  ameerpet: 'ameerpet',
  'hitec city': 'hitec_city',
  hitec: 'hitec_city',
  secunderabad: 'secunderabad',
  gachibowli: 'gachibowli',
  'lb nagar': 'lb_nagar',
  'l.b. nagar': 'lb_nagar',
  bengaluru: 'blr_central',
  bangalore: 'blr_central',
  mumbai: 'bom_central',
  delhi: 'del_central',
};

function resolveZoneIdFromCity(city) {
  const raw = String(city || '').trim().toLowerCase();
  if (!raw) return 'unknown';
  if (CITY_TO_ZONE_ID[raw]) return CITY_TO_ZONE_ID[raw];
  const slug = raw.replace(/\s+/g, '_');
  if (CITY_TO_ZONE_ID[slug]) return CITY_TO_ZONE_ID[slug];
  return slug;
}

function weatherEmojiFromIconCode(iconCode) {
  const k = String(iconCode || '').toLowerCase();
  if (k === 'rain') return '☔';
  if (k === 'sunny') return '☀️';
  if (k === 'cloudy') return '⛅';
  if (k === 'hot') return '🔥';
  return '⛅';
}

function aqiHexFromCategoryLabel(label) {
  const c = String(label || '').toLowerCase();
  if (c === 'good') return '#16a34a';
  if (c === 'moderate') return '#ca8a04';
  if (c === 'poor' || c === 'very poor') return '#ea580c';
  return '#dc2626';
}

function coverageBadge(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'active') return { label: '🟢 COVERED', tone: 'success' };
  if (s === 'expiring') return { label: '⚠️ EXPIRING', tone: 'warn' };
  if (s === 'inactive') return { label: '🔴 NOT COVERED', tone: 'danger' };
  return { label: '🔴 NOT COVERED', tone: 'danger' };
}

function aqiCategory(aqi) {
  const v = typeof aqi === 'number' ? aqi : null;
  if (v === null) return { label: '—', tone: 'neutral' };
  if (v <= 50) return { label: 'Good', tone: 'success' };
  if (v <= 100) return { label: 'Moderate', tone: 'warn' };
  if (v <= 200) return { label: 'Poor', tone: 'warn' };
  if (v <= 300) return { label: 'Very Poor', tone: 'danger' };
  return { label: 'Hazardous', tone: 'danger' };
}

const DNA_DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DNA_DAY_NAMES_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
/** IST hours shown in heatmap: 6 → 22 (17 columns) */
const DNA_H_START = 6;
const DNA_H_END = 22;
const DNA_GRID_COLS = DNA_H_END - DNA_H_START + 1;
const DNA_X_TICKS = [6, 8, 10, 12, 14, 16, 18, 20, 22];
const DNA_CELL_W = 14;
const DNA_CELL_H = 10;
const DNA_CELL_GAP = 1;
const DNA_GRID_PIX_W = DNA_GRID_COLS * (DNA_CELL_W + DNA_CELL_GAP) - DNA_CELL_GAP;
const DNA_GRID_PIX_H = 7 * (DNA_CELL_H + DNA_CELL_GAP) - DNA_CELL_GAP;

function formatDnaHourTick(h) {
  if (h === 0) return '12A';
  if (h < 12) return `${h}A`;
  if (h === 12) return '12P';
  return `${h - 12}P`;
}

/** Tooltip copy e.g. "8 PM" for hour slot start (IST). */
function formatDnaHour12Long(h) {
  if (h === 0) return '12 AM';
  if (h < 12) return `${h} AM`;
  if (h === 12) return '12 PM';
  return `${h - 12} PM`;
}

function getIstWeekdayMon0() {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' }).format(new Date());
  const map = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  return map[wd] ?? 0;
}

function getIstHour() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(new Date());
  const hp = parts.find((p) => p.type === 'hour');
  return hp ? parseInt(hp.value, 10) : 12;
}

/** Heat: light = quieter hours, deep green = stronger typical earnings (₹/hr). */
function dnaHeatColorEarnings(t) {
  const x = Math.min(1, Math.max(0, t));
  const low = [241, 245, 249];
  const mid = [187, 247, 208];
  const high = [22, 101, 52];
  const a = x < 0.5 ? low : mid;
  const b = x < 0.5 ? mid : high;
  const local = x < 0.5 ? x * 2 : (x - 0.5) * 2;
  const r = Math.round(a[0] + (b[0] - a[0]) * local);
  const g = Math.round(a[1] + (b[1] - a[1]) * local);
  const bl = Math.round(a[2] + (b[2] - a[2]) * local);
  return `rgb(${r},${g},${bl})`;
}

const DEMO_SCENARIOS = [
  { label: 'Heavy Rain', value: 'HEAVY_RAIN', emoji: '🌧️', hint: 'Most common disruption' },
  { label: 'Extreme Heat', value: 'EXTREME_HEAT', emoji: '🌡️', hint: 'Summer peak risk' },
  { label: 'Air Quality Alert', value: 'AQI_SPIKE', emoji: '🏭', hint: 'Hazardous AQI >300' },
  { label: 'Zone Curfew', value: 'CURFEW', emoji: '🚫', hint: 'Social disruption' },
];

/** Often show “all clear” so every tap does not pay out — feels closer to real checks. */
const DEMO_NO_EVENT_CHANCE = 0.42;
const DEMO_NO_EVENT_MESSAGES = {
  HEAVY_RAIN: 'No heavy rain alerts in your area right now.',
  EXTREME_HEAT: 'No extreme heat warnings for your zone at the moment.',
  AQI_SPIKE: 'Air quality looks normal where you ride — no hazard spike.',
  CURFEW: 'No curfew or movement restrictions reported in your zone.',
};

function demoCompletedSteps(status) {
  const s = String(status || '').toUpperCase();
  if (s === 'INITIATED') return 0;
  if (s === 'VERIFYING') return 1;
  if (s === 'BEHAVIORAL_CHECK') return 2;
  if (s === 'FRAUD_CHECK') return 3;
  if (s === 'APPROVED' || s === 'BLOCKED') return 4;
  return 0;
}

const DEMO_STEP_LABELS = ['Disruption Detected', 'Verifying Signals', 'Fraud Check', 'Decision'];

function DemoClaimProgress({ status, colors, primary }) {
  const doneSteps = demoCompletedSteps(status);
  const isTerminal = ['APPROVED', 'BLOCKED'].includes(String(status || '').toUpperCase());
  const isApproved = String(status || '').toUpperCase() === 'APPROVED';

  return (
    <View style={{ marginTop: 8 }}>
      {DEMO_STEP_LABELS.map((label, i) => {
        const complete = doneSteps > i || isTerminal;
        const active = !isTerminal && doneSteps === i;
        const decisionFail = isTerminal && String(status).toUpperCase() === 'BLOCKED' && i === 3;

        return (
          <View
            key={label}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingVertical: 12,
              borderBottomWidth: i < 3 ? 1 : 0,
              borderBottomColor: colors.border,
            }}
          >
            <View style={{ width: 36, alignItems: 'center' }}>
              {complete ? (
                <Text style={{ fontSize: 18, color: isApproved && i === 3 ? '#2e7d32' : primary }}>✓</Text>
              ) : active ? (
                <ActivityIndicator size="small" color={primary} />
              ) : (
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.border }} />
              )}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 13, fontWeight: '800', color: complete || active ? colors.text : colors.muted }}>
                {label}
              </Text>
              {active ? (
                <Text style={{ fontSize: 11, color: colors.muted, marginTop: 2 }}>Working…</Text>
              ) : null}
            </View>
            {decisionFail ? <Text style={{ fontSize: 18 }}>✗</Text> : null}
          </View>
        );
      })}
    </View>
  );
}

function statusToStep(status) {
  const s = String(status || '').toUpperCase();
  if (s.includes('INITIATED')) return 0;
  if (s.includes('VERIFYING') || s.includes('CONFIDENCE')) return 1;
  if (s.includes('FRAUD_CHECK') || s.includes('FRAUD')) return 2;
  if (s.includes('DECISION')) return 3;
  if (s.includes('PAYOUT') || s.includes('CREDITED')) return 3;
  if (s.includes('FLAG')) return 2;
  if (s.includes('REJECT')) return 3;
  return 0;
}

function isInFlightClaim(lastUpdate, activeClaims) {
  const terminal = new Set([
    'PAYOUT_DONE',
    'PAYOUT_CREDITED',
    'NO_PAYOUT',
    'DECISION_REJECTED',
    'CLAIM_REJECTED',
    'ERROR',
    'APPROVED',
    'BLOCKED',
  ]);
  const lastStatus = String(lastUpdate?.status || '');
  if (lastStatus && terminal.has(lastStatus)) return false;
  if (activeClaims?.length) return true;
  return Boolean(lastUpdate?.claim_id && lastUpdate?.status && !terminal.has(lastUpdate.status));
}

function ZonePulseDot({ tone }) {
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(0.7)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.parallel([
        Animated.sequence([
          Animated.timing(scale, { toValue: 1.35, duration: 900, useNativeDriver: true }),
          Animated.timing(scale, { toValue: 1, duration: 900, useNativeDriver: true }),
        ]),
        Animated.sequence([
          Animated.timing(opacity, { toValue: 0.25, duration: 900, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 0.7, duration: 900, useNativeDriver: true }),
        ]),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [opacity, scale, tone]);

  return (
    <View style={styles.dotWrap}>
      <Animated.View
        style={[
          styles.dotRing,
          { transform: [{ scale }], opacity },
          tone === 'success' ? styles.dotSuccess : tone === 'warn' ? styles.dotWarn : styles.dotDanger,
        ]}
      />
      <View style={[styles.dotCore, tone === 'success' ? styles.dotSuccess : tone === 'warn' ? styles.dotWarn : styles.dotDanger]} />
    </View>
  );
}

function formatDisruptionLabel(raw) {
  const s = String(raw || '').trim();
  if (!s) return 'Disruption';
  const map = {
    HEAVY_RAIN: 'Heavy Rain',
    EXTREME_HEAT: 'Extreme Heat',
    AQI_SPIKE: 'AQI Spike',
    CURFEW: 'Curfew',
  };
  if (map[s]) return map[s];
  return s.replace(/_/g, ' ');
}

function scenarioHumanPhrase(scenario) {
  const s = String(scenario || '').toUpperCase();
  const map = {
    HEAVY_RAIN: 'heavy rain',
    EXTREME_HEAT: 'extreme heat',
    AQI_SPIKE: 'poor air quality',
    CURFEW: 'curfew',
  };
  return map[s] || formatDisruptionLabel(scenario).toLowerCase();
}

function payoutIconEmoji(icon) {
  const k = String(icon || '').toLowerCase();
  if (k === 'rain') return '☔';
  if (k === 'hot') return '🔥';
  if (k === 'cloudy') return '⛅';
  return '💰';
}

function ProgressRing({ value, max, size, stroke, scheme }) {
  const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const fg = scheme === 'dark' ? '#8ab4f8' : '#1a73e8';
  const bg = scheme === 'dark' ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)';
  const label = `${Math.round(pct * 100)}%`;
  const r = (size - stroke) / 2;
  const c = size / 2;
  const circumference = 2 * Math.PI * r;
  const dashOffset = circumference * (1 - pct);

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={{ position: 'absolute' }}>
        <Circle cx={c} cy={c} r={r} stroke={bg} strokeWidth={stroke} fill="none" />
        <Circle
          cx={c}
          cy={c}
          r={r}
          stroke={fg}
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          transform={`rotate(-90 ${c} ${c})`}
        />
      </Svg>
      <Text style={{ color: fg, fontSize: size >= 90 ? 15 : 11, fontWeight: '900' }}>{label}</Text>
    </View>
  );
}

function Stepper({ step, flagged, scheme }) {
  const steps = ['Detected', 'Verifying', 'Fraud Check', 'Approved'];
  const colors = {
    done: scheme === 'dark' ? '#7ee787' : '#2e7d32',
    todo: scheme === 'dark' ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.12)',
    text: scheme === 'dark' ? '#e8eaed' : '#1a1a2e',
    warn: '#ffb300',
  };

  return (
    <View style={styles.stepperWrap}>
      {steps.map((label, i) => {
        const isDone = i <= step;
        const tone = flagged && i === 2 ? colors.warn : isDone ? colors.done : colors.todo;
        return (
          <View key={label} style={styles.stepItem}>
            <View style={[styles.stepDot, { backgroundColor: tone }]} />
            <Text style={[styles.stepText, { color: colors.text, opacity: isDone ? 1 : 0.6 }]} numberOfLines={1}>
              {label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

export default function DashboardScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme() || 'light';
  const qc = useQueryClient();
  const { userId, workerProfile } = useAuth();
  const { status: wsStatus } = useWsConnection();

  const { disruptionAlert, lastClaimUpdate, activeClaims } = useClaims();
  const { coverageStatus, policy } = usePolicy();
  const homePlanTier = useMemo(() => canonicalTierLabel(policy?.tier), [policy?.tier]);
  const { data: profileQueryData, isLoading: profileQueryLoading } = useWorkerProfile();
  const profile = profileQueryData ?? workerProfile ?? null;
  const profileLoading = Boolean(profileQueryLoading && !workerProfile);
  const payoutsQuery = usePayoutHistory();
  const [assistantOpen, setAssistantOpen] = useState(false);
  const notificationsQuery = useQuery({
    queryKey: ['notifications', userId],
    queryFn: () => notifications.list(String(userId || '')),
    enabled: Boolean(userId),
    refetchInterval: 12000,
  });

  const trust = profile?.trust_score;
  const tb = trustBadge(trust);
  const cb = coverageBadge(coverageStatus || policy?.status);

  const firstName = useMemo(() => {
    const raw = String(profile?.name || '').trim();
    if (raw) {
      const part = raw.split(/\s+/)[0];
      if (part) return part;
    }
    if (profileLoading) return '';
    return 'there';
  }, [profile?.name, profileLoading]);

  const greetingName = useMemo(() => {
    if (firstName) return `${firstName} 👋`;
    if (profileLoading) return '👋';
    return 'there 👋';
  }, [firstName, profileLoading]);

  const zoneId = useMemo(() => resolveZoneIdFromCity(profile?.city), [profile?.city]);
  const effectiveZoneId = useMemo(() => {
    const z = profile?.zone_id;
    if (z && String(z) !== 'default' && String(z) !== 'unknown') return String(z);
    return zoneId && zoneId !== 'unknown' ? zoneId : 'hyd_central';
  }, [profile?.zone_id, zoneId]);

  const zoneStatusQuery = useQuery({
    queryKey: ['zoneStatus', effectiveZoneId],
    enabled: Boolean(effectiveZoneId),
    queryFn: async () => {
      const res = await api.get(`/zones/${encodeURIComponent(effectiveZoneId)}/status`);
      return res.data;
    },
    staleTime: 1000 * 60 * 5,
  });

  const forecastShieldQuery = useQuery({
    queryKey: ['forecastShield', effectiveZoneId],
    enabled: Boolean(effectiveZoneId),
    queryFn: () => zonesApi.getForecastShield(effectiveZoneId),
    staleTime: 1000 * 60 * 10,
  });

  const zoneStatus = zoneStatusQuery.data || null;
  const disruptionActive =
    Boolean(disruptionAlert?.visible) ||
    Boolean(zoneStatus?.disruption_active) ||
    String(zoneStatus?.status || '').toLowerCase() === 'disruption';

  /** Amber = live socket (fintech “connected” cue); muted when offline */
  const wsDotColor =
    wsStatus === 'connected' ? '#FBBF24' : wsStatus === 'reconnecting' ? '#F59E0B' : 'rgba(255,255,255,0.35)';

  const [approvalToast, setApprovalToast] = useState(null);
  const approvalSlide = useRef(new Animated.Value(-140)).current;
  const lastApprovedIdRef = useRef(null);
  const zoneStressAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const id = lastClaimUpdate?.claim_id;
    const st = String(lastClaimUpdate?.status || '').toUpperCase();
    if (st !== 'APPROVED' || id == null) return;
    if (lastApprovedIdRef.current === id) return;
    lastApprovedIdRef.current = id;
    const amt = Number(lastClaimUpdate?.payout_amount ?? 0);
    const label = formatDisruptionLabel(lastClaimUpdate?.disruption_type);
    const toastMsg = String(lastClaimUpdate?.message || '');
    let shieldToastLine = null;
    const tIdx = toastMsg.indexOf('SafeNet predicted this risk');
    if (tIdx >= 0) {
      const rest = toastMsg.slice(tIdx);
      const dot = rest.indexOf('.');
      shieldToastLine = dot >= 0 ? rest.slice(0, dot + 1).trim() : rest.trim();
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    setApprovalToast({ amount: amt, disruption: label, shieldLine: shieldToastLine });
    approvalSlide.setValue(-140);
    Animated.spring(approvalSlide, { toValue: 0, friction: 7, tension: 80, useNativeDriver: true }).start();
    const t = setTimeout(() => {
      Animated.timing(approvalSlide, { toValue: -140, duration: 240, useNativeDriver: true }).start(() =>
        setApprovalToast(null)
      );
    }, 3000);
    return () => clearTimeout(t);
  }, [lastClaimUpdate, approvalSlide]);

  useEffect(() => {
    if (!disruptionAlert?.visible) return;
    zoneStressAnim.setValue(0);
    const pulse = Animated.sequence([
      Animated.timing(zoneStressAnim, { toValue: 1, duration: 260, useNativeDriver: false }),
      Animated.timing(zoneStressAnim, { toValue: 0, duration: 260, useNativeDriver: false }),
    ]);
    Animated.sequence([pulse, pulse, pulse]).start();
  }, [disruptionAlert?.received_at, disruptionAlert?.visible, zoneStressAnim]);

  const safeLevel = zoneStatus?.safe_level;
  const zonePulseTone = disruptionAlert?.visible
    ? 'danger'
    : safeLevel === 'DISRUPTED'
      ? 'danger'
      : safeLevel === 'WATCH'
        ? 'warn'
        : 'success';
  const aqiVal = zoneStatus?.aqi?.value ?? zoneStatus?.aqi_value ?? null;
  const aqiNum = typeof aqiVal === 'number' ? aqiVal : Number(aqiVal);
  const aqi = aqiCategory(Number.isFinite(aqiNum) ? aqiNum : null);
  const aqiLabel = zoneStatus?.aqi?.category || aqi.label;
  const aqiHex = zoneStatus?.aqi?.color || aqiHexFromCategoryLabel(aqiLabel);
  const weatherEmoji = weatherEmojiFromIconCode(zoneStatus?.weather?.icon_code);
  const tempC =
    typeof zoneStatus?.weather?.temp_c === 'number' && !Number.isNaN(zoneStatus.weather.temp_c)
      ? Math.round(zoneStatus.weather.temp_c)
      : null;
  const alertCount =
    typeof zoneStatus?.active_alerts_count === 'number' ? zoneStatus.active_alerts_count : 0;

  const protectedMax = useMemo(() => {
    const cap = Number(profile?.max_weekly_coverage);
    if (Number.isFinite(cap) && cap > 0) return cap;
    return 3500;
  }, [profile?.max_weekly_coverage]);

  const protectedThisWeek = useMemo(() => {
    const v = Number(profile?.earnings_protected_this_week);
    if (Number.isFinite(v) && v >= 0) return v;
    return 0;
  }, [profile?.earnings_protected_this_week]);

  const trend = useMemo(() => {
    // Backend doesn’t provide last-week baseline yet, so keep deterministic UX.
    // If you add last_week_payouts, we’ll compute real trend.
    return protectedThisWeek > 0 ? { dir: 'up', pct: 8 } : { dir: 'flat', pct: 0 };
  }, [protectedThisWeek]);

  const breakdownQuery = useQuery({
    queryKey: ['weeklyBreakdown'],
    queryFn: () => workersApi.getWeeklyBreakdown(),
    enabled: Boolean(userId),
    staleTime: 60 * 1000,
  });

  const breakdownHasData = useMemo(() => {
    const rows = breakdownQuery.data?.weekly_breakdown;
    if (!Array.isArray(rows)) return false;
    return rows.some((r) => Number(r?.amount) > 0);
  }, [breakdownQuery.data]);

  const [dnaExpanded, setDnaExpanded] = useState(false);
  const [coverageExpanded, setCoverageExpanded] = useState(false);
  const [tick, setTick] = useState(0);
  const [dnaTick, setDnaTick] = useState(0);
  const [dnaTooltip, setDnaTooltip] = useState({
    visible: false,
    dayName: '',
    hour: '',
    amount: 0,
    x: 0,
    y: 0,
  });
  const zoneBgPulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setDnaTick((x) => x + 1), 4000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!disruptionActive) {
      zoneBgPulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(zoneBgPulse, { toValue: 1, duration: 1100, useNativeDriver: false }),
        Animated.timing(zoneBgPulse, { toValue: 0, duration: 1100, useNativeDriver: false }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [disruptionActive, zoneBgPulse]);

  const inFlight = useMemo(() => isInFlightClaim(lastClaimUpdate, activeClaims), [lastClaimUpdate, activeClaims]);
  const flagged = useMemo(() => String(lastClaimUpdate?.status || '').toUpperCase().includes('FLAG'), [lastClaimUpdate?.status]);
  const step = useMemo(() => statusToStep(lastClaimUpdate?.status), [lastClaimUpdate?.status]);

  useEffect(() => {
    if (lastClaimUpdate?.status) logClaimStatusView(lastClaimUpdate.status);
  }, [lastClaimUpdate?.status]);

  const claimStartedAtRef = useRef(null);
  const [etaSeconds, setEtaSeconds] = useState(0);
  useEffect(() => {
    if (!inFlight) {
      claimStartedAtRef.current = null;
      setEtaSeconds(0);
      return;
    }
    if (!claimStartedAtRef.current) claimStartedAtRef.current = Date.now();
    const total = 120;
    const t = setInterval(() => {
      const elapsed = Math.floor((Date.now() - claimStartedAtRef.current) / 1000);
      setEtaSeconds(Math.max(0, total - elapsed));
    }, 500);
    return () => clearInterval(t);
  }, [inFlight]);

  const dnaQuery = useQuery({
    queryKey: ['earningsDna'],
    queryFn: () => workersApi.getEarningsDna(),
    enabled: Boolean(userId),
    staleTime: 30 * 1000,
    refetchInterval: 90 * 1000,
  });

  const dnaMaxDisplay = useMemo(() => {
    const m = dnaQuery.data?.dna;
    if (!m || !Array.isArray(m)) return 1;
    let mx = 0;
    for (const row of m) {
      for (let hi = DNA_H_START; hi <= DNA_H_END; hi++) {
        const n = Number(row[hi]);
        if (Number.isFinite(n) && n > mx) mx = n;
      }
    }
    return mx > 0 ? mx : 1;
  }, [dnaQuery.data?.dna]);

  const fingerprintPct = useMemo(() => {
    const exp = Number(dnaQuery.data?.weekly_expected);
    const act = Number(dnaQuery.data?.weekly_actual);
    if (!Number.isFinite(exp) || exp <= 0) return null;
    return Math.min(100, Math.round((act / exp) * 100));
  }, [dnaQuery.data]);
  const dnaData = dnaQuery.data || {};
  const currentHourRate = useMemo(() => {
    const row = dnaData?.dna?.[getIstWeekdayMon0()] || [];
    const hr = getIstHour();
    return Number(row?.[hr] || 0);
  }, [dnaData?.dna]);
  const liveBand = useMemo(() => {
    if (currentHourRate >= 120) return { tone: '🟢 High earning window', min: 120, max: 150 };
    if (currentHourRate >= 80) return { tone: '🟡 Moderate demand', min: 70, max: 95 };
    return { tone: '🔵 Lower demand window', min: 45, max: 70 };
  }, [currentHourRate]);
  const todayPotential = useMemo(() => {
    const row = dnaData?.dna?.[getIstWeekdayMon0()] || [];
    const total = row.slice(6, 23).reduce((s, n) => s + (Number(n) || 0), 0);
    const low = Math.round(total * 0.82);
    const high = Math.round(total * 1.12);
    return { low: Math.max(250, low), high: Math.max(350, high) };
  }, [dnaData?.dna]);
  const nextBestLabel = useMemo(() => {
    const pk = dnaData?.peak_window;
    if (!pk) return '⏳ Next peak: loading…';
    return `⏳ Next peak: ${pk.day_name} ${formatDnaHour12Long(pk.hour_start)}-${formatDnaHour12Long(pk.hour_end)}`;
  }, [dnaData?.peak_window]);

  const istDnaRow = getIstWeekdayMon0();
  const istDnaHour = getIstHour();
  const istHighlightCol = istDnaHour >= DNA_H_START && istDnaHour <= DNA_H_END ? istDnaHour - DNA_H_START : -1;

  const [disruptionSheetVisible, setDisruptionSheetVisible] = useState(false);
  const [sheetPhase, setSheetPhase] = useState('scenarios');
  const [payoutCelebration, setPayoutCelebration] = useState(null);
  const [displayWeeklyProtected, setDisplayWeeklyProtected] = useState(null);
  const celebratedClaimIdRef = useRef(null);
  const demoStepStatusRef = useRef(null);
  const weeklyBeforeDemoRef = useRef(null);

  const shownWeeklyProtected =
    displayWeeklyProtected != null && Number.isFinite(displayWeeklyProtected)
      ? displayWeeklyProtected
      : protectedThisWeek;

  const simMutation = useMutation({
    mutationFn: async (scenario) =>
      simulation.run({
        scenario,
        zone_id: effectiveZoneId,
        worker_id: userId,
        fast_mode: true,
      }),
    onSuccess: () => {
      setSheetPhase('progress');
    },
  });

  const runningScenario =
    simMutation.isPending && simMutation.variables != null ? simMutation.variables : null;

  useEffect(() => {
    if (!disruptionSheetVisible || sheetPhase !== 'progress') return;
    const st = lastClaimUpdate?.status;
    if (!st || st === demoStepStatusRef.current) return;
    demoStepStatusRef.current = st;
    if (st !== 'APPROVED') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    }
  }, [lastClaimUpdate?.status, disruptionSheetVisible, sheetPhase]);

  useEffect(() => {
    const st = String(lastClaimUpdate?.status || '').toUpperCase();
    if (st !== 'APPROVED') return;
    const cid = lastClaimUpdate?.claim_id;
    if (cid == null || celebratedClaimIdRef.current === cid) return;
    celebratedClaimIdRef.current = cid;
    const amt = Number(lastClaimUpdate?.payout_amount ?? 0);
    const breakdown = lastClaimUpdate?.payout_breakdown;
    const expected =
      typeof breakdown === 'object' && breakdown !== null && breakdown.expected != null
        ? Number(breakdown.expected)
        : null;
    const scenario = lastClaimUpdate?.disruption_type || 'HEAVY_RAIN';
    const rawMsg = String(lastClaimUpdate?.message || '');
    let forecastShieldLine = null;
    const fsIdx = rawMsg.indexOf('SafeNet predicted this risk');
    if (fsIdx >= 0) {
      const rest = rawMsg.slice(fsIdx);
      const dot = rest.indexOf('.');
      forecastShieldLine = dot >= 0 ? rest.slice(0, dot + 1).trim() : rest.trim();
    }
    setPayoutCelebration({
      amount: amt,
      expected: expected ?? amt,
      scenario,
      message: lastClaimUpdate?.message,
      forecastShieldLine,
    });
    setDisruptionSheetVisible(false);
    setSheetPhase('scenarios');
    demoStepStatusRef.current = null;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    const base = weeklyBeforeDemoRef.current;
    if (base != null && Number.isFinite(base)) {
      setDisplayWeeklyProtected(base);
      const target = base + amt;
      const t0 = Date.now();
      const dur = 1100;
      const tick = () => {
        const t = Math.min(1, (Date.now() - t0) / dur);
        const eased = 1 - (1 - t) * (1 - t);
        setDisplayWeeklyProtected(base + (target - base) * eased);
        if (t < 1) requestAnimationFrame(tick);
        else setDisplayWeeklyProtected(null);
      };
      requestAnimationFrame(tick);
    }
    qc.invalidateQueries({ queryKey: ['workerProfile'] });
    qc.invalidateQueries({ queryKey: ['payoutHistory'] });
    qc.invalidateQueries({ queryKey: ['claimsHistory'] });
    qc.invalidateQueries({ queryKey: ['earningsDna'] });
    qc.invalidateQueries({ queryKey: ['zoneStatus'] });
    qc.invalidateQueries({ queryKey: ['forecastShield'] });
  }, [lastClaimUpdate, qc]);

  const forecastShields = Array.isArray(forecastShieldQuery.data?.shields)
    ? forecastShieldQuery.data.shields
    : [];
  const primaryForecastShield = forecastShields[0];

  const refreshing =
    payoutsQuery.isRefetching ||
    zoneStatusQuery.isRefetching ||
    dnaQuery.isRefetching ||
    forecastShieldQuery.isRefetching ||
    breakdownQuery.isRefetching;
  const onRefresh = useCallback(() => {
    void payoutsQuery.refetch();
    void zoneStatusQuery.refetch();
    void dnaQuery.refetch();
    void forecastShieldQuery.refetch();
    void breakdownQuery.refetch();
  }, [
    payoutsQuery.refetch,
    zoneStatusQuery.refetch,
    dnaQuery.refetch,
    forecastShieldQuery.refetch,
    breakdownQuery.refetch,
  ]);

  const colors = useMemo(() => {
    const isDark = scheme === 'dark';
    return {
      bg: isDark ? '#0b1020' : '#f0f4ff',
      card: isDark ? '#121a32' : '#fff',
      text: isDark ? '#e8eaed' : '#1a1a2e',
      sub: isDark ? 'rgba(255,255,255,0.70)' : '#666',
      muted: isDark ? 'rgba(255,255,255,0.55)' : '#777',
      border: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)',
      primary: '#1a73e8',
      dangerBg: isDark ? '#3a0d12' : '#ffebee',
      warnBg: isDark ? '#2a210a' : '#fff8e1',
      successBg: isDark ? '#0d2b16' : '#e8f5e9',
    };
  }, [scheme]);

  const payouts = (payoutsQuery.data || []).slice(0, 3);

  const zoneDisplayName = zoneStatus?.zone_name || profile?.city || 'Your zone';
  const timeGreeting = getTimeGreeting();

  const zoneUpdatedText = useMemo(() => {
    const t = zoneStatusQuery.dataUpdatedAt;
    if (!t) return '';
    void tick;
    const sec = Math.floor((Date.now() - t) / 1000);
    if (sec < 8) return 'Updated just now';
    if (sec < 60) return `Updated ${sec}s ago`;
    const m = Math.floor(sec / 60);
    if (m < 120) return `Updated ${m}m ago`;
    return 'Updated earlier';
  }, [zoneStatusQuery.dataUpdatedAt, tick]);

  const dnaUpdatedText = useMemo(() => {
    const t = dnaQuery.dataUpdatedAt;
    if (!t) return '';
    void dnaTick;
    if (dnaQuery.isRefetching || dnaQuery.isFetching) return 'Live · refreshing pattern…';
    const sec = Math.floor((Date.now() - t) / 1000);
    if (sec < 6) return 'Live · pattern just synced';
    if (sec < 60) return `Live · synced ${sec}s ago`;
    const m = Math.floor(sec / 60);
    if (m < 120) return `Live · synced ${m}m ago`;
    return 'Pattern last synced from server';
  }, [dnaQuery.dataUpdatedAt, dnaQuery.isRefetching, dnaQuery.isFetching, dnaTick]);

  const istTodayLine = useMemo(() => formatIstTodayLong(), []);

  const rideStatus = useMemo(() => {
    if (disruptionActive) return { key: 'red', label: 'Disruption active', bar: '#dc2626' };
    if (safeLevel === 'WATCH' || (Number.isFinite(aqiNum) && aqiNum > 150))
      return { key: 'amber', label: 'Be careful', bar: '#d97706' };
    return { key: 'green', label: 'Safe to ride', bar: '#16a34a' };
  }, [disruptionActive, safeLevel, aqiNum]);

  const zonePulseOverlayOpacity = zoneBgPulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.08, 0.22],
  });

  const zoneCardBorderColor = zoneStressAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [colors.border, '#e53935'],
  });

  return (
    <>
    <View
      style={[
        styles.container,
        { backgroundColor: colors.bg, flex: 1 },
        Platform.OS === 'web' && styles.screenRootWeb,
      ]}
    >
      {approvalToast ? (
        <Animated.View
          style={[
            styles.approvalToastOuter,
            { transform: [{ translateY: approvalSlide }] },
          ]}
          pointerEvents="none"
        >
          <LinearGradient
            colors={['#1b5e20', '#2e7d32']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.approvalToastInner}
          >
            <Text style={styles.approvalToastText}>
              ₹{Math.round(approvalToast.amount)} credited — {approvalToast.disruption}
            </Text>
            {approvalToast.shieldLine ? (
              <Text style={styles.approvalToastSub}>{approvalToast.shieldLine}</Text>
            ) : null}
          </LinearGradient>
        </Animated.View>
      ) : null}

      <ScrollView
        style={[styles.container, { backgroundColor: colors.bg }]}
        contentContainerStyle={[
          styles.content,
          { paddingBottom: Math.max(insets.bottom, 12) + 72 },
        ]}
        refreshControl={<RefreshControl refreshing={Boolean(refreshing)} onRefresh={onRefresh} />}
      >
      <LinearGradient
        colors={scheme === 'dark' ? ['#0b1f4a', '#1e3a8a', '#172554'] : ['#1557C7', '#2563eb', '#38bdf8']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.headerGradient}
      >
        <Text style={styles.headerGreetingLine1}>{timeGreeting},</Text>
        <Text style={styles.headerGreetingLine2} numberOfLines={1}>
          {greetingName}
        </Text>
        <View style={styles.headerBadgeRow}>
          <NotificationBell
            unread={Number(notificationsQuery.data?.unread_count || 0)}
            onPress={() => navigation.navigate('Notifications')}
          />
          <View style={[styles.wsLiveDot, { backgroundColor: wsDotColor }]} accessibilityLabel="WebSocket live status" />
          <TouchableOpacity
            onPress={() => navigation.navigate('Coverage')}
            style={[
              styles.pill,
              cb.tone === 'success'
                ? styles.pillSuccess
                : cb.tone === 'warn'
                  ? styles.pillWarn
                  : styles.pillDanger,
            ]}
          >
            <Text style={styles.pillText}>{cb.label}</Text>
          </TouchableOpacity>
          <View
            style={[
              styles.pill,
              tb.tone === 'premium' ? styles.pillPremium : tb.tone === 'trusted' ? styles.pillTrusted : styles.pillNeutral,
            ]}
          >
            <Text style={styles.pillText}>{tb.label}</Text>
          </View>
        </View>
        {homePlanTier && homePlanTier !== '—' ? (
          <Text style={styles.headerPlanLine} numberOfLines={1}>
            Plan: {homePlanTier}
          </Text>
        ) : null}
      </LinearGradient>

      {/* Zone status — innovation #1: real-time zone intelligence */}
      <Animated.View
        style={[
          styles.card,
          styles.cardElevated,
          {
            backgroundColor: colors.card,
            borderWidth: 1,
            borderColor: zoneCardBorderColor,
            overflow: 'hidden',
          },
        ]}
      >
        {disruptionActive ? (
          <Animated.View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFillObject,
              { backgroundColor: '#fecaca', opacity: zonePulseOverlayOpacity },
            ]}
          />
        ) : null}
        <View style={styles.cardHeaderRow}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.zoneCardTitle, { color: colors.text }]}>Your Zone · {zoneDisplayName}</Text>
            <Text style={[styles.cardSub, { color: colors.muted }]} numberOfLines={1}>
              {zoneUpdatedText || 'Pull down on Home to refresh'}
            </Text>
            {disruptionAlert?.visible && disruptionAlert?.disruption_type ? (
              <Text style={[styles.liveDisruptionLine, { color: scheme === 'dark' ? '#ff8a80' : '#b71c1c' }]}>
                Live: {formatDisruptionLabel(disruptionAlert.disruption_type)}
              </Text>
            ) : null}
            {!primaryForecastShield &&
            !forecastShieldQuery.isLoading &&
            !forecastShieldQuery.isError &&
            effectiveZoneId ? (
              <View style={styles.forecastClearChipInline}>
                <Text
                  style={[
                    styles.forecastClearChipText,
                    { color: scheme === 'dark' ? '#4ade80' : '#15803d' },
                  ]}
                >
                  48h forecast clear 🛡️
                </Text>
              </View>
            ) : null}
          </View>
          <ZonePulseDot tone={zoneStatus ? zonePulseTone : disruptionActive ? 'danger' : 'success'} />
        </View>

        {zoneStatusQuery.isLoading ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.primary} />
            <Text style={[styles.loadingText, { color: colors.muted }]}>Loading zone status…</Text>
          </View>
        ) : zoneStatusQuery.isError ? (
          <View style={styles.errorBox}>
            <Text style={[styles.errorText, { color: colors.muted }]}>
              Couldn’t load zone status. Pull down to retry.
            </Text>
          </View>
        ) : (
          <View style={styles.zoneGrid}>
            <View style={styles.zoneCell}>
              <Text style={[styles.zoneLabel, { color: colors.muted }]}>Weather</Text>
              <Text style={[styles.zoneValue, { color: colors.text }]} numberOfLines={2}>
                {weatherEmoji}
                {'\n'}
                {tempC != null ? `${tempC}°C` : '—'}
              </Text>
            </View>
            <View style={styles.zoneCell}>
              <Text style={[styles.zoneLabel, { color: colors.muted }]}>AQI</Text>
              <Text style={[styles.zoneValue, { color: aqiHex }]} numberOfLines={3}>
                {aqiLabel}
                {Number.isFinite(aqiNum) ? `\n${Math.round(aqiNum)}` : ''}
              </Text>
            </View>
            <View style={styles.zoneCell}>
              <Text style={[styles.zoneLabel, { color: colors.muted }]}>Alerts</Text>
              <Text
                style={[
                  styles.zoneValue,
                  { color: alertCount > 0 ? '#c62828' : colors.text, fontWeight: '900' },
                ]}
              >
                {alertCount}
              </Text>
            </View>
          </View>
        )}

        <View style={[styles.zoneStatusBarWrap, { backgroundColor: rideStatus.bar }]}>
          <Text style={styles.zoneStatusBarLabel}>{rideStatus.label}</Text>
        </View>

        {disruptionActive ? (
          <View style={styles.disruptionBanner}>
            <Text style={[styles.disruptionTitle, { color: scheme === 'dark' ? '#ffd6d6' : '#b71c1c' }]}>
              Disruption active — claim in progress
            </Text>
          </View>
        ) : null}
      </Animated.View>

      {primaryForecastShield && !forecastShieldQuery.isError ? (
        <LinearGradient
          colors={['#0f172a', '#1d4ed8', '#3b82f6']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.forecastShieldCardHero}
        >
          <Text style={styles.forecastShieldHeroIcon}>🛡️</Text>
          <Text style={styles.forecastShieldHeroTitle}>Forecast Shield Active</Text>
          <Text style={styles.forecastShieldHeroSubtitle}>
            {primaryForecastShield.subtitle || 'Heavy rain predicted tomorrow 3–7 PM'}
          </Text>
          <Text style={styles.forecastShieldHeroFooter}>
            {primaryForecastShield.coverage_line || 'Your coverage auto-upgraded to Pro'}
          </Text>
          <View style={styles.forecastShieldBadge}>
            <Text style={styles.forecastShieldBadgeText}>Proactive · no extra cost</Text>
          </View>
        </LinearGradient>
      ) : null}

      {/* Earnings DNA — hour × day heatmap */}
      <View style={[styles.card, styles.cardElevated, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <TouchableOpacity
          style={[
            styles.dnaCollapseHeader,
            { borderColor: colors.primary, backgroundColor: dnaExpanded ? 'transparent' : `${colors.primary}14` },
          ]}
          onPress={() => setDnaExpanded((v) => !v)}
          activeOpacity={0.85}
        >
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={[styles.sectionTitle, { color: colors.text }]}>Earnings DNA</Text>
            </View>
            <Text style={[styles.cardSub, { color: colors.muted }]}>🟢 Live • updated just now</Text>
          </View>
          <Text style={[styles.dnaChevron, { color: colors.primary }]}>{dnaExpanded ? '▲' : '▼'}</Text>
        </TouchableOpacity>
        {dnaQuery.isLoading ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.primary} />
            <Text style={[styles.loadingText, { color: colors.muted }]}>Loading your pattern…</Text>
          </View>
        ) : dnaQuery.isError ? (
          <Text style={[styles.cardSub, { color: colors.muted }]}>Could not load Earnings DNA.</Text>
        ) : dnaQuery.data && dnaExpanded ? (
          <>
            <View style={styles.dnaLiveCard}>
              <Text style={styles.dnaLiveTone}>{liveBand.tone}</Text>
              <Text style={styles.dnaLiveAmt}>
                ₹{liveBand.min}–₹{liveBand.max}/hr expected in your zone
              </Text>
            </View>
            <View style={{ flexDirection: 'row', marginTop: 4 }}>
              <View style={{ width: 34, justifyContent: 'flex-end', paddingBottom: 18, paddingRight: 4 }}>
                {DNA_DAY_LABELS.map((L, yi) => (
                  <Text
                    key={`dna-row-${yi}`}
                    style={{
                      height: DNA_CELL_H + DNA_CELL_GAP,
                      lineHeight: DNA_CELL_H,
                      fontSize: 10,
                      fontWeight: '800',
                      color: colors.muted,
                      textAlign: 'right',
                    }}
                  >
                    {L}
                  </Text>
                ))}
              </View>
              <View>
                <View style={{ width: DNA_GRID_PIX_W, height: DNA_GRID_PIX_H, position: 'relative' }}>
                  <Svg width={DNA_GRID_PIX_W} height={DNA_GRID_PIX_H}>
                    {(dnaQuery.data.dna || []).flatMap((row, di) =>
                      Array.from({ length: DNA_GRID_COLS }, (_, ci) => {
                        const hour = DNA_H_START + ci;
                        const v = Number(row[hour]) || 0;
                        const t = dnaMaxDisplay > 0 ? v / dnaMaxDisplay : 0;
                        const x = ci * (DNA_CELL_W + DNA_CELL_GAP);
                        const y = di * (DNA_CELL_H + DNA_CELL_GAP);
                        const highlight = di === istDnaRow && ci === istHighlightCol;
                        return (
                          <Rect
                            key={`r-${di}-${ci}`}
                            x={x}
                            y={y}
                            width={DNA_CELL_W}
                            height={DNA_CELL_H}
                            rx={1}
                            fill={dnaHeatColorEarnings(t)}
                            stroke={highlight ? '#1a73e8' : 'none'}
                            strokeWidth={highlight ? 2 : 0}
                          />
                        );
                      })
                    )}
                  </Svg>
                  {(dnaQuery.data.dna || []).flatMap((row, di) =>
                    Array.from({ length: DNA_GRID_COLS }, (_, ci) => {
                      const hour = DNA_H_START + ci;
                      const v = Number(row[hour]) || 0;
                      return (
                        <Pressable
                          key={`p-${di}-${ci}`}
                          style={{
                            position: 'absolute',
                            left: ci * (DNA_CELL_W + DNA_CELL_GAP),
                            top: di * (DNA_CELL_H + DNA_CELL_GAP),
                            width: DNA_CELL_W,
                            height: DNA_CELL_H,
                          }}
                          onPress={(e) => {
                            const { pageX, pageY } = e.nativeEvent;
                            setDnaTooltip({
                              visible: true,
                              dayName: DNA_DAY_NAMES_LONG[di],
                              hour: formatDnaHour12Long(hour),
                              amount: Math.round(v),
                              x: pageX,
                              y: pageY,
                            });
                          }}
                        />
                      );
                    })
                  )}
                </View>
                <View style={{ flexDirection: 'row', width: DNA_GRID_PIX_W, marginTop: 8, justifyContent: 'space-between' }}>
                  {DNA_X_TICKS.map((h) => (
                    <Text key={h} style={{ fontSize: 9, fontWeight: '800', color: colors.muted, width: 26, textAlign: 'center' }}>
                      {formatDnaHourTick(h)}
                    </Text>
                  ))}
                </View>
              </View>
            </View>
            <Text style={[styles.dnaInsightLine, { color: colors.text }]}>{nextBestLabel}</Text>
            <Text style={[styles.dnaTodayPotential, { color: colors.text }]}>₹{todayPotential.low}–₹{todayPotential.high} today</Text>
            <Text style={[styles.dnaInsightLine, { color: colors.text }]}>
              ₹{Math.round(Number(dnaQuery.data.weekly_actual || 0))} / ₹{Math.round(Number(dnaQuery.data.weekly_expected || 0))} expected
            </Text>
            <View style={[styles.dnaProgressTrack, { backgroundColor: colors.border }]}>
              <View
                style={[
                  styles.dnaProgressFill,
                  {
                    backgroundColor: colors.primary,
                    width: `${Math.min(
                      100,
                      (Number(dnaQuery.data.weekly_expected) > 0
                        ? (Number(dnaQuery.data.weekly_actual) / Number(dnaQuery.data.weekly_expected)) * 100
                        : 0) || 0
                    )}%`,
                  },
                ]}
              />
            </View>
            <Text style={[styles.dnaConfNote, { color: colors.muted }]}>This week earnings snapshot</Text>
          </>
        ) : null}
      </View>

      {/* Coverage ring — weekly protection */}
      <View style={[styles.card, styles.cardElevated, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.coverageRingRow}>
          <View style={{ flex: 1, paddingRight: 8 }}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Weekly protection</Text>
            <Text style={[styles.coverageRingAmount, { color: colors.text }]}>
              ₹{Math.round(shownWeeklyProtected).toLocaleString('en-IN')} protected this week
            </Text>
            <Text style={[styles.fingerprintHint, { color: colors.muted }]}>
              {fingerprintPct != null
                ? `↗ ${fingerprintPct}% of your earning fingerprint`
                : `${trend.dir === 'up' ? '↗' : trend.dir === 'down' ? '↘' : '→'} ${trend.pct}% vs typical week`}
            </Text>
            <Text style={[styles.cardSub, { color: colors.muted, marginTop: 6 }]}>
              Weekly cap ₹{Math.round(protectedMax).toLocaleString('en-IN')}
            </Text>
            {breakdownHasData ? (
              <TouchableOpacity onPress={() => setCoverageExpanded((x) => !x)} style={{ marginTop: 10 }}>
                <Text style={[styles.linkText, { color: colors.primary }]}>
                  {coverageExpanded ? 'Hide' : 'Show'} week breakdown
                </Text>
              </TouchableOpacity>
            ) : null}
          </View>
          <View style={styles.coverageRingWrap}>
            <ProgressRing value={shownWeeklyProtected} max={protectedMax} size={104} stroke={10} scheme={scheme} />
          </View>
        </View>
        {coverageExpanded && breakdownHasData ? (
          <View style={styles.breakdownWrap}>
            {(breakdownQuery.data?.weekly_breakdown || []).map((row) => (
              <View
                key={String(row.day)}
                style={[styles.breakdownRow, { borderColor: colors.border }]}
              >
                <Text style={[styles.breakdownDay, { color: colors.text }]}>{row.day}</Text>
                <Text style={[styles.breakdownReason, { color: colors.muted }]} numberOfLines={1}>
                  {row.disruption || '—'}
                </Text>
                <Text style={[styles.breakdownAmt, { color: colors.text }]}>
                  ₹{Math.round(Number(row.amount || 0))}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>

      {/* Active claim card (hidden while demo bottom sheet shows progress) */}
      {inFlight && !disruptionSheetVisible ? (
        <View
          style={[
            styles.card,
            { backgroundColor: flagged ? colors.warnBg : colors.card, borderColor: colors.border },
          ]}
        >
          <View style={styles.cardHeaderRow}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.cardTitle, { color: colors.text }]}>Active claim</Text>
              <Text style={[styles.cardSub, { color: colors.muted }]} numberOfLines={2}>
                {lastClaimUpdate?.message ? String(lastClaimUpdate.message) : 'Processing in real-time…'}
              </Text>
            </View>
            <Text style={[styles.etaText, { color: colors.muted }]}>{etaSeconds ? `${etaSeconds}s` : '—'}</Text>
          </View>

          <Stepper step={step} flagged={flagged} scheme={scheme} />

          {flagged ? (
            <Text style={[styles.flaggedNote, { color: scheme === 'dark' ? '#ffd180' : '#8a5a00' }]}>
              Routine verification — your claim history is strong
            </Text>
          ) : null}
        </View>
      ) : null}

      {/* Simulate disruption — primary demo CTA */}
      {!inFlight ? (
        <View style={styles.simulateBlock}>
          <TouchableOpacity
            style={[styles.simulateCta, { backgroundColor: colors.primary }]}
            activeOpacity={0.9}
            onPress={() => {
              logButtonTap('simulate_disruption_open');
              weeklyBeforeDemoRef.current = protectedThisWeek;
              demoStepStatusRef.current = null;
              setSheetPhase('scenarios');
              setDisruptionSheetVisible(true);
            }}
          >
            <Text style={styles.simulateCtaText}>Simulate disruption — watch a live claim end-to-end</Text>
          </TouchableOpacity>
          <Text style={[styles.simulateCtaHint, { color: colors.muted }]}>
            Full fraud + payout pipeline — best for judge demos. Use Coverage & Claims tabs for more.
          </Text>
        </View>
      ) : null}

      <View style={[styles.card, styles.cardElevated, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.cardHeaderRow}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Recent payouts</Text>
          <TouchableOpacity onPress={() => payoutsQuery.refetch()} hitSlop={12}>
            <Text style={[styles.linkText, { color: colors.primary }]}>Refresh</Text>
          </TouchableOpacity>
        </View>

        {payoutsQuery.isLoading ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.primary} />
            <Text style={[styles.loadingText, { color: colors.muted }]}>Loading payouts…</Text>
          </View>
        ) : payouts.length === 0 ? (
          <Text style={[styles.emptyPayouts, { color: colors.muted }]}>
            {"No disruptions yet — you're all set ✅"}
          </Text>
        ) : (
          payouts.map((p) => {
            const when = formatPayoutWhen(p);
            const amount =
              typeof p.amount === 'number'
                ? p.amount
                : typeof p.payout === 'number'
                  ? p.payout
                  : typeof p.payout_amount === 'number'
                    ? p.payout_amount
                    : 0;
            const typeIcon = payoutIconEmoji(p.icon);
            const disruption = formatDisruptionLabel(p.disruption_type || p.label || 'Payout');
            const isCredited =
              String(p.status || '').toLowerCase() === 'credited' ||
              String(p.decision || '').toUpperCase().includes('APPROV');
            return (
              <View
                key={String(p.id || p.claim_id || when + disruption)}
                style={[styles.payoutRow, { borderColor: colors.border }]}
              >
                <Text style={[styles.payoutDate, { color: colors.muted }]} numberOfLines={2}>
                  {when}
                </Text>
                <Text style={[styles.payoutType, { color: colors.text }]}>{typeIcon}</Text>
                <Text style={[styles.payoutDisruption, { color: colors.text }]} numberOfLines={2}>
                  {disruption}
                </Text>
                <Text style={[styles.payoutAmt, { color: colors.text }]}>₹{Math.round(amount)}</Text>
                <View style={styles.payoutCreditedBadge}>
                  <Text style={styles.payoutCreditedText}>{isCredited ? 'CREDITED' : 'PAID'}</Text>
                </View>
              </View>
            );
          })
        )}
      </View>

      {lastClaimUpdate?.status === 'BLOCKED' ? (
        <View
          style={[
            styles.card,
            {
              backgroundColor: scheme === 'dark' ? '#3a0d12' : '#ffebee',
              borderColor: 'rgba(198,40,40,0.45)',
            },
          ]}
        >
          <Text style={[styles.cardTitle, { color: colors.text }]}>Claim blocked</Text>
          <Text style={[styles.cardSub, { color: colors.muted, marginTop: 6 }]}>
            Unusual activity detected — claim blocked
          </Text>
          {Array.isArray(lastClaimUpdate.fraud_flags) && lastClaimUpdate.fraud_flags.length ? (
            <Text style={[styles.cardSub, { color: '#c62828', marginTop: 8 }]}>
              {lastClaimUpdate.fraud_flags.join(' · ')}
            </Text>
          ) : null}
        </View>
      ) : null}

    </ScrollView>

      <AppModal
        visible={disruptionSheetVisible}
        transparent
        animationType="slide"
        onRequestClose={() => {
          if (!simMutation.isPending) setDisruptionSheetVisible(false);
        }}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => !simMutation.isPending && setDisruptionSheetVisible(false)}>
          <Pressable style={[styles.modalSheet, { backgroundColor: colors.card, borderColor: colors.border }]} onPress={(e) => e.stopPropagation()}>
            {sheetPhase === 'scenarios' ? (
              <>
                <Text style={[styles.cardTitle, { color: colors.text, marginBottom: 6 }]}>Pick a disruption</Text>
                <Text style={[styles.cardSub, { color: colors.muted, marginBottom: 14 }]}>
                  Pick one scenario — only that run starts. Watch each step update in real time.
                </Text>
                {DEMO_SCENARIOS.map((s) => (
                  <TouchableOpacity
                    key={s.value}
                    style={[
                      styles.scenarioCard,
                      { borderColor: runningScenario === s.value ? colors.primary : colors.border },
                      runningScenario === s.value ? { borderWidth: 2 } : null,
                    ]}
                    onPress={() => {
                      logButtonTap('trigger_simulation_button');
                      if (Math.random() < DEMO_NO_EVENT_CHANCE) {
                        Alert.alert(
                          'All clear',
                          DEMO_NO_EVENT_MESSAGES[s.value] || 'No disruption signals in your area right now.'
                        );
                        return;
                      }
                      weeklyBeforeDemoRef.current = protectedThisWeek;
                      demoStepStatusRef.current = null;
                      simMutation.mutate(s.value);
                    }}
                    disabled={simMutation.isPending}
                  >
                    <Text style={styles.scenarioEmoji}>{s.emoji}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.scenarioTitle, { color: colors.text }]}>{s.label}</Text>
                      <Text style={[styles.scenarioHint, { color: colors.muted }]}>{s.hint}</Text>
                    </View>
                    {runningScenario === s.value ? (
                      <ActivityIndicator size="small" color={colors.primary} />
                    ) : (
                      <Text style={{ color: colors.muted }}>→</Text>
                    )}
                  </TouchableOpacity>
                ))}
                {simMutation.isError ? (
                  <Text style={[styles.errorText, { marginTop: 10, color: colors.muted }]}>Could not start simulation. Try again.</Text>
                ) : null}
              </>
            ) : (
              <>
                <Text style={[styles.cardTitle, { color: colors.text }]}>Live claim</Text>
                <Text style={[styles.cardSub, { color: colors.muted, marginBottom: 4 }]} numberOfLines={2}>
                  {lastClaimUpdate?.message || 'Starting…'}
                </Text>
                <DemoClaimProgress status={lastClaimUpdate?.status} colors={colors} primary={colors.primary} />
              </>
            )}
            <TouchableOpacity
              style={{ marginTop: 16, alignItems: 'center' }}
              onPress={() => !simMutation.isPending && setDisruptionSheetVisible(false)}
            >
              <Text style={[styles.linkText, { color: colors.primary }]}>Close</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </AppModal>

      <AppModal
        visible={Boolean(payoutCelebration)}
        transparent
        animationType="fade"
        onRequestClose={() => setPayoutCelebration(null)}
      >
        <Pressable style={styles.celebrationBackdrop} onPress={() => setPayoutCelebration(null)}>
          <Pressable style={styles.celebrationInner} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.celebrationAmt}>₹{Math.round(Number(payoutCelebration?.amount || 0))}</Text>
            <Text style={styles.celebrationSub}>credited to your wallet</Text>
            <View style={styles.celebrationCard}>
              <Text style={styles.celebrationExplain}>
                Based on your earnings pattern, you typically earn ₹{Math.round(Number(payoutCelebration?.expected || 0))} at this time. The{' '}
                {scenarioHumanPhrase(payoutCelebration?.scenario)} reduced that to ₹0. SafeNet covered your loss.
              </Text>
              {payoutCelebration?.forecastShieldLine ? (
                <Text style={styles.celebrationShieldLine}>{payoutCelebration.forecastShieldLine}</Text>
              ) : null}
            </View>
            <TouchableOpacity style={styles.celebrationBtn} onPress={() => setPayoutCelebration(null)}>
              <Text style={styles.celebrationBtnText}>Done</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </AppModal>

      {dnaTooltip.visible ? (
        <>
          <Pressable
            style={[StyleSheet.absoluteFillObject, { zIndex: 400 }]}
            onPress={() =>
              setDnaTooltip({ visible: false, dayName: '', hour: '', amount: 0, x: 0, y: 0 })
            }
          />
          <View
            style={[
              styles.dnaTooltipCard,
              {
                left: Math.max(16, dnaTooltip.x - 140),
                top: Math.max(120, dnaTooltip.y - 72),
              },
            ]}
            pointerEvents="box-none"
          >
            <Text style={styles.dnaTooltipText}>
              {dnaTooltip.dayName} {dnaTooltip.hour} · typical ~₹{dnaTooltip.amount}/hr
            </Text>
          </View>
        </>
      ) : null}
    </View>
    <AssistantWidget onPress={() => setAssistantOpen(true)} />
    <AssistantModal visible={assistantOpen} onClose={() => setAssistantOpen(false)} />
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  /** Web: in-tree modals position:absolute fill this screen, not the scroll body */
  screenRootWeb: { position: 'relative' },
  content: { padding: 16, paddingBottom: 64 },

  approvalToastOuter: {
    position: 'absolute',
    top: 8,
    left: 12,
    right: 12,
    zIndex: 100,
    elevation: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
  },
  approvalToastInner: {
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  approvalToastText: { color: '#fff', fontSize: 15, fontWeight: '900', textAlign: 'center' },
  approvalToastSub: {
    color: 'rgba(255,255,255,0.92)',
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 17,
    paddingHorizontal: 4,
  },

  headerGradient: {
    borderRadius: 20,
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 16,
    marginBottom: 14,
  },
  headerGreetingLine1: { color: 'rgba(255,255,255,0.92)', fontSize: 16, fontWeight: '700' },
  headerGreetingLine2: {
    color: '#fff',
    fontSize: 26,
    fontWeight: '900',
    marginTop: 2,
    lineHeight: 32,
  },

  forecastShieldCardHero: {
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
  forecastClearChipInline: {
    alignSelf: 'flex-start',
    marginTop: 8,
    backgroundColor: 'rgba(22,163,74,0.12)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  forecastClearChipText: { fontSize: 12, fontWeight: '800' },
  wsLiveDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.55)',
    marginRight: 2,
  },
  liveDisruptionLine: { fontSize: 12, fontWeight: '900', marginTop: 6 },
  headerBadgeRow: { marginTop: 12, flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
  headerPlanLine: {
    marginTop: 10,
    fontSize: 13,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.92)',
  },

  pill: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)' },
  pillText: { color: '#fff', fontSize: 12, fontWeight: '900' },
  pillSuccess: { backgroundColor: 'rgba(46,125,50,0.28)' },
  pillWarn: { backgroundColor: 'rgba(255,143,0,0.28)' },
  pillDanger: { backgroundColor: 'rgba(198,40,40,0.28)' },
  pillTrusted: { backgroundColor: 'rgba(255,255,255,0.14)' },
  pillPremium: { backgroundColor: 'rgba(255,215,0,0.16)' },
  pillNeutral: { backgroundColor: 'rgba(255,255,255,0.10)' },

  card: { borderRadius: 18, padding: 16, marginBottom: 14, borderWidth: 1 },
  cardElevated: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.07,
    shadowRadius: 12,
    elevation: 3,
  },
  cardHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardTitle: { fontSize: 14, fontWeight: '900' },
  sectionTitle: { fontSize: 16, fontWeight: '900' },
  zoneCardTitle: { fontSize: 17, fontWeight: '900' },
  cardSub: { fontSize: 12, marginTop: 4 },

  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 10 },
  loadingText: { fontSize: 12 },
  errorBox: { paddingTop: 10 },
  errorText: { fontSize: 12, lineHeight: 16 },

  zoneGrid: { flexDirection: 'row', gap: 10, marginTop: 12 },
  zoneCell: { flex: 1 },
  zoneLabel: { fontSize: 12, fontWeight: '700' },
  zoneValue: { fontSize: 14, fontWeight: '900', marginTop: 6 },

  zoneStatusBarWrap: {
    marginTop: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  zoneStatusBarLabel: { color: '#fff', fontSize: 13, fontWeight: '800' },
  disruptionBanner: { marginTop: 12, padding: 12, borderRadius: 14, backgroundColor: 'rgba(183,28,28,0.12)' },
  disruptionTitle: { fontSize: 12, fontWeight: '900' },

  dotWrap: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  dotRing: { position: 'absolute', width: 18, height: 18, borderRadius: 999, opacity: 0.3 },
  dotCore: { width: 10, height: 10, borderRadius: 999 },
  dotSuccess: { backgroundColor: '#2e7d32' },
  dotWarn: { backgroundColor: '#ff8f00' },
  dotDanger: { backgroundColor: '#c62828' },

  bigMoney: { fontSize: 16, fontWeight: '900' },
  breakdownWrap: { marginTop: 12 },
  breakdownRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10, borderBottomWidth: 1 },
  breakdownDay: { width: 42, fontWeight: '900' },
  breakdownReason: { flex: 1, paddingHorizontal: 10 },
  breakdownAmt: { width: 70, textAlign: 'right', fontWeight: '900' },
  breakdownNote: { marginTop: 10, fontSize: 12, lineHeight: 16 },

  stepperWrap: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12 },
  stepItem: { alignItems: 'center', flex: 1 },
  stepDot: { width: 10, height: 10, borderRadius: 999, marginBottom: 8 },
  stepText: { fontSize: 11, fontWeight: '800' },
  etaText: { fontSize: 12, fontWeight: '900' },
  flaggedNote: { marginTop: 10, fontSize: 12, fontWeight: '800' },

  actionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  actionBtn: { paddingVertical: 12, paddingHorizontal: 12, borderRadius: 14, borderWidth: 1, minWidth: 120, alignItems: 'center' },
  actionText: { fontSize: 12, fontWeight: '900' },

  linkText: { fontSize: 12, fontWeight: '900' },

  payoutRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1 },
  payoutDate: { width: 88, fontSize: 11 },
  payoutType: { width: 28, textAlign: 'center' },
  payoutDisruption: { flex: 1, fontSize: 12, fontWeight: '700', paddingHorizontal: 6 },
  payoutAmt: { width: 52, textAlign: 'right', fontWeight: '900' },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, borderWidth: 1 },
  chipText: { fontSize: 11, fontWeight: '900' },

  primaryBtn: { backgroundColor: '#1a73e8', borderRadius: 14, padding: 14, alignItems: 'center' },
  primaryBtnText: { color: '#fff', fontSize: 14, fontWeight: '900' },

  selectRow: { paddingVertical: 12, paddingHorizontal: 12, borderRadius: 14, borderWidth: 1, marginBottom: 8, flexDirection: 'row', justifyContent: 'space-between' },
  selectText: { fontSize: 12, fontWeight: '900' },

  fraudRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 },
  fraudBtn: { width: 42, height: 42, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  fraudValue: { flex: 1, textAlign: 'center', fontWeight: '900', fontSize: 14 },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    paddingBottom: 32,
    borderWidth: 1,
    borderBottomWidth: 0,
  },

  dnaSummaryRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10, marginBottom: 8 },
  dnaSummaryCol: { flex: 1 },
  dnaSummaryLabel: { fontSize: 11, fontWeight: '700' },
  dnaSummaryVal: { fontSize: 16, fontWeight: '900', marginTop: 4 },
  dnaPeakLine: { fontSize: 12, fontWeight: '800', marginBottom: 8 },
  dnaScroll: { marginTop: 4 },
  dnaHourRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  dnaCorner: { width: 28, fontSize: 9 },
  dnaHourLbl: { width: 14, fontSize: 8, textAlign: 'center' },
  dnaDataRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 3 },
  dnaDayLbl: { width: 28, fontSize: 10, fontWeight: '800' },
  dnaCell: { width: 14, height: 14, marginHorizontal: 0.5, borderRadius: 2 },
  dnaModalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', padding: 24 },
  dnaModalSheet: { borderRadius: 16, padding: 20, borderWidth: 1 },
  dnaModalAmt: { fontSize: 22, fontWeight: '900', marginTop: 12 },

  dnaPeakBadge: {
    marginTop: 12,
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(26,115,232,0.1)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
  },
  dnaPeakBadgeText: { fontSize: 12, fontWeight: '800' },
  dnaAiLabel: { fontSize: 11, fontWeight: '800', marginTop: 4 },
  dnaLiveCard: {
    marginTop: 10,
    borderRadius: 12,
    backgroundColor: 'rgba(16,185,129,0.12)',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  dnaLiveTone: { fontSize: 13, fontWeight: '900', color: '#065f46' },
  dnaLiveAmt: { fontSize: 13, fontWeight: '700', color: '#065f46', marginTop: 2 },
  dnaInsightLine: { fontSize: 13, fontWeight: '700', marginTop: 8, lineHeight: 19 },
  dnaMetricsRow: { flexDirection: 'row', marginTop: 14, gap: 12 },
  dnaProgressTrack: { height: 8, borderRadius: 4, marginTop: 10, overflow: 'hidden' },
  dnaProgressFill: { height: '100%', borderRadius: 4 },
  dnaConfNote: { fontSize: 11, marginTop: 10, fontWeight: '600' },
  optimizeBtn: {
    marginTop: 12,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: 'center',
  },
  optimizeBtnText: { fontSize: 13, fontWeight: '900' },
  dnaCollapseHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginHorizontal: -4,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  dnaChevron: { fontSize: 14, fontWeight: '900', paddingLeft: 8 },
  coverageRingRow: { flexDirection: 'row', alignItems: 'center' },
  coverageRingWrap: { width: 112, height: 112, alignItems: 'center', justifyContent: 'center' },
  coverageRingAmount: { fontSize: 18, fontWeight: '900', marginTop: 6, lineHeight: 24 },
  fingerprintHint: { fontSize: 13, fontWeight: '700', marginTop: 8 },
  simulateBlock: { marginBottom: 14 },
  simulateCtaHint: { fontSize: 12, textAlign: 'center', marginTop: 10, lineHeight: 18, paddingHorizontal: 8 },
  emptyPayouts: { fontSize: 14, fontWeight: '600', textAlign: 'center', paddingVertical: 16 },
  payoutCreditedBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: 'rgba(22,163,74,0.15)',
  },
  payoutCreditedText: { fontSize: 10, fontWeight: '900', color: '#15803d' },
  dnaTooltipCard: {
    position: 'absolute',
    maxWidth: 280,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 14,
    backgroundColor: '#fff',
    zIndex: 401,
    elevation: 10,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.06)',
  },
  dnaTooltipText: { color: '#0f172a', fontSize: 14, fontWeight: '700' },

  simulateCta: {
    borderRadius: 16,
    paddingVertical: 18,
    paddingHorizontal: 16,
    alignItems: 'center',
    shadowColor: '#1a73e8',
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  simulateCtaText: { color: '#fff', fontSize: 16, fontWeight: '900', textAlign: 'center', lineHeight: 22 },

  scenarioCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    marginBottom: 10,
  },
  scenarioEmoji: { fontSize: 28 },
  scenarioTitle: { fontSize: 15, fontWeight: '900' },
  scenarioHint: { fontSize: 12, marginTop: 2 },

  celebrationBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    padding: 20,
  },
  celebrationInner: {
    backgroundColor: '#1b5e20',
    borderRadius: 20,
    padding: 24,
    alignItems: 'center',
  },
  celebrationAmt: { fontSize: 52, fontWeight: '900', color: '#fff' },
  celebrationSub: { fontSize: 15, color: 'rgba(255,255,255,0.92)', marginTop: 8, fontWeight: '600' },
  celebrationCard: {
    marginTop: 20,
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderRadius: 14,
    padding: 14,
    width: '100%',
  },
  celebrationExplain: { color: '#fff', fontSize: 14, lineHeight: 22, fontWeight: '600' },
  celebrationShieldLine: {
    color: 'rgba(255,255,255,0.95)',
    fontSize: 14,
    lineHeight: 22,
    fontWeight: '800',
    marginTop: 14,
  },
  celebrationBtn: {
    marginTop: 22,
    backgroundColor: '#fff',
    paddingHorizontal: 40,
    paddingVertical: 14,
    borderRadius: 12,
    width: '100%',
    alignItems: 'center',
  },
  celebrationBtnText: { color: '#1b5e20', fontWeight: '900', fontSize: 16 },
});

