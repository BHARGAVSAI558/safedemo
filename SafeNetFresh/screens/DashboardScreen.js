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
  Modal,
  Pressable,
} from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import Svg, { Circle, Rect } from 'react-native-svg';

import api, { simulation, workers as workersApi, zones as zonesApi } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { useClaims } from '../contexts/ClaimContext';
import { useWsConnection } from '../contexts/WsConnectionContext';
import { usePolicy } from '../contexts/PolicyContext';
import { useWorkerProfile } from '../hooks/useWorkerProfile';
import { usePayoutHistory } from '../hooks/usePayoutHistory';
import { logButtonTap, logClaimStatusView } from '../services/device_fingerprint.service';
import { trustBadge } from '../utils/trustBadge';

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
  kukatpally: 'hyd_kukatpally',
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
const DNA_Y_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
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

/** Heat colors: empty → high (#EEF2FF → #1D4ED8) */
function dnaHeatColorBlue(t) {
  const x = Math.min(1, Math.max(0, t));
  const stops = [
    [238, 242, 255],
    [147, 197, 253],
    [59, 130, 246],
    [29, 78, 216],
  ];
  const seg = Math.min(2, Math.floor(x * 3));
  const local = x * 3 - seg;
  const a = stops[seg];
  const b = stops[seg + 1];
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
      <Text style={{ color: fg, fontSize: 10, fontWeight: '900' }}>{label}</Text>
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
  const scheme = useColorScheme() || 'light';
  const qc = useQueryClient();
  const { phone, userId } = useAuth();
  const { status: wsStatus } = useWsConnection();

  const { disruptionAlert, lastClaimUpdate, activeClaims } = useClaims();
  const { coverageStatus, policy } = usePolicy();
  const { data: profile, isLoading: profileLoading } = useWorkerProfile();
  const payoutsQuery = usePayoutHistory();

  const trust = profile?.trust_score;
  const tb = trustBadge(trust);
  const cb = coverageBadge(coverageStatus || policy?.status);

  const firstName = useMemo(() => {
    const raw = String(profile?.name || '').trim();
    if (raw) {
      const part = raw.split(/\s+/)[0];
      if (part) return part;
    }
    const digits = String(phone || '').replace(/\D/g, '');
    if (digits.length >= 10) {
      const national = digits.length > 10 && digits.startsWith('91') ? digits.slice(2) : digits;
      return national.slice(0, 5) || digits.slice(0, 4);
    }
    if (digits.length >= 4) return digits.slice(0, 4);
    if (digits.length) return digits;
    return 'there';
  }, [profile?.name, phone]);

  const greeting = useMemo(() => `${getTimeGreeting()}${firstName ? `, ${firstName} 👋` : ' 👋'}`, [firstName]);

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
    refetchInterval: 1000 * 60 * 2,
    staleTime: 1000 * 30,
  });

  const forecastShieldQuery = useQuery({
    queryKey: ['forecastShield', effectiveZoneId],
    enabled: Boolean(effectiveZoneId),
    queryFn: () => zonesApi.getForecastShield(effectiveZoneId),
    refetchInterval: 1000 * 60 * 30,
    staleTime: 1000 * 60 * 5,
  });

  const zoneStatus = zoneStatusQuery.data || null;
  const disruptionActive =
    Boolean(disruptionAlert?.visible) ||
    Boolean(zoneStatus?.disruption_active) ||
    String(zoneStatus?.status || '').toLowerCase() === 'disruption';

  const wsDotColor =
    wsStatus === 'connected' ? '#69f0ae' : wsStatus === 'reconnecting' ? '#ffb74d' : '#ff8a80';

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

  const [earningsExpanded, setEarningsExpanded] = useState(false);

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

  const [dnaPopover, setDnaPopover] = useState({ visible: false, x: 0, y: 0, text: '' });

  const dnaQuery = useQuery({
    queryKey: ['earningsDna'],
    queryFn: () => workersApi.getEarningsDna(),
    enabled: Boolean(userId),
    staleTime: 60 * 1000,
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
    forecastShieldQuery.isRefetching;
  const onRefresh = useCallback(() => {
    void payoutsQuery.refetch();
    void zoneStatusQuery.refetch();
    void dnaQuery.refetch();
    void forecastShieldQuery.refetch();
  }, [payoutsQuery.refetch, zoneStatusQuery.refetch, dnaQuery.refetch, forecastShieldQuery.refetch]);

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

  const zoneCardBorderColor = zoneStressAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [colors.border, '#e53935'],
  });

  return (
    <View style={[styles.container, { backgroundColor: colors.bg, flex: 1 }]}>
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
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={Boolean(refreshing)} onRefresh={onRefresh} />}
      >
      <LinearGradient
        colors={scheme === 'dark' ? ['#0f1a3a', '#0b1020'] : ['#1a73e8', '#6aa6ff']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.headerGradient}
      >
        <View style={styles.headerTopRow}>
          <View style={styles.headerGreetingRow}>
            <View style={[styles.wsLiveDot, { backgroundColor: wsDotColor }]} />
            <Text style={styles.headerGreeting} numberOfLines={1}>
              {greeting || 'Good morning 👋'}
            </Text>
          </View>
        </View>

        <View style={styles.headerBadgeRow}>
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

          <View style={[styles.pill, tb.tone === 'premium' ? styles.pillPremium : tb.tone === 'trusted' ? styles.pillTrusted : styles.pillNeutral]}>
            <Text style={styles.pillText}>{tb.label}</Text>
          </View>
        </View>
      </LinearGradient>

      {primaryForecastShield && !forecastShieldQuery.isError ? (
        <LinearGradient
          colors={['#1E40AF', '#1D4ED8']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.forecastShieldCard}
        >
          <Text style={styles.forecastShieldTitle}>🛡️ Forecast Shield Active</Text>
          <Text style={styles.forecastShieldSubtitle}>
            {primaryForecastShield.subtitle || 'Elevated weather risk in the next 48 hours'}
          </Text>
          <Text style={styles.forecastShieldFooter}>
            {primaryForecastShield.coverage_line || 'Coverage auto-upgraded to Pro'}
          </Text>
          <View style={styles.forecastShieldBadge}>
            <Text style={styles.forecastShieldBadgeText}>No extra cost</Text>
          </View>
        </LinearGradient>
      ) : null}

      {/* Zone status */}
      <Animated.View
        style={[
          styles.card,
          {
            backgroundColor: disruptionActive ? colors.dangerBg : colors.card,
            borderWidth: 1,
            borderColor: zoneCardBorderColor,
          },
        ]}
      >
        <View style={styles.cardHeaderRow}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.cardTitle, { color: colors.text }]}>Zone status</Text>
            <Text style={[styles.cardSub, { color: colors.muted }]} numberOfLines={1}>
              {zoneStatus?.zone_name || profile?.city || 'Your zone'} · auto-refresh 2 min
            </Text>
            {disruptionAlert?.visible && disruptionAlert?.disruption_type ? (
              <Text style={[styles.liveDisruptionLine, { color: scheme === 'dark' ? '#ff8a80' : '#b71c1c' }]}>
                Live alert: {formatDisruptionLabel(disruptionAlert.disruption_type)}
              </Text>
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
              Couldn’t load zone status. Check your connection and try pull-to-refresh.
            </Text>
          </View>
        ) : (
          <View style={styles.zoneGrid}>
            <View style={styles.zoneCell}>
              <Text style={[styles.zoneLabel, { color: colors.muted }]}>Weather</Text>
              <Text style={[styles.zoneValue, { color: colors.text }]}>
                {weatherEmoji} {tempC != null ? `${tempC}°C` : '—°C'}
              </Text>
            </View>
            <View style={styles.zoneCell}>
              <Text style={[styles.zoneLabel, { color: colors.muted }]}>AQI</Text>
              <Text style={[styles.zoneValue, { color: aqiHex }]}>
                {aqiLabel}
                {Number.isFinite(aqiNum) ? ` (${Math.round(aqiNum)})` : ''}
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
                {alertCount > 0 ? `${alertCount} alert${alertCount === 1 ? '' : 's'}` : 'None'}
              </Text>
            </View>
          </View>
        )}

        {disruptionActive ? (
          <View style={styles.disruptionBanner}>
            <Text style={[styles.disruptionTitle, { color: scheme === 'dark' ? '#ffd6d6' : '#b71c1c' }]}>
              DISRUPTION DETECTED — Your claim is being processed
            </Text>
          </View>
        ) : null}
      </Animated.View>

      {!primaryForecastShield &&
      !forecastShieldQuery.isLoading &&
      !forecastShieldQuery.isError &&
      effectiveZoneId ? (
        <View style={styles.forecastClearChip}>
          <Text
            style={[
              styles.forecastClearChipText,
              { color: scheme === 'dark' ? '#4ade80' : '#15803d' },
            ]}
          >
            🛡️ No forecast risks · 48h clear
          </Text>
        </View>
      ) : null}

      {/* Your Earnings DNA — heatmap (IST 6AM–11PM) */}
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.cardHeaderRow}>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={[styles.cardTitle, { color: colors.text }]}>Your Earnings DNA</Text>
              <Text style={{ fontSize: 16 }} accessibilityLabel="About Earnings DNA">
                ℹ️
              </Text>
            </View>
            <Text style={[styles.cardSub, { color: colors.muted }]}>
              Average ₹/hr by weekday & time (IST). Tap a cell for details.
            </Text>
          </View>
        </View>
        {dnaQuery.isLoading ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.primary} />
            <Text style={[styles.loadingText, { color: colors.muted }]}>Loading your pattern…</Text>
          </View>
        ) : dnaQuery.isError ? (
          <Text style={[styles.cardSub, { color: colors.muted }]}>Could not load Earnings DNA.</Text>
        ) : dnaQuery.data ? (
          <>
            <View style={{ flexDirection: 'row', marginTop: 4 }}>
              <View style={{ width: 22, justifyContent: 'flex-end', paddingBottom: 18 }}>
                {DNA_Y_LETTERS.map((L, yi) => (
                  <Text
                    key={`dna-row-${yi}`}
                    style={{
                      height: DNA_CELL_H + DNA_CELL_GAP,
                      lineHeight: DNA_CELL_H,
                      fontSize: 11,
                      fontWeight: '800',
                      color: colors.muted,
                      textAlign: 'center',
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
                            fill={dnaHeatColorBlue(t)}
                            stroke={highlight ? '#F59E0B' : 'none'}
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
                            setDnaPopover({
                              visible: true,
                              x: pageX,
                              y: pageY,
                              text: `${DNA_DAY_NAMES_LONG[di]} ${formatDnaHour12Long(hour)}: avg ₹${Math.round(v)}/hr`,
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
            {dnaQuery.data.peak_window?.label ? (
              <View style={styles.dnaPeakBadge}>
                <Text style={[styles.dnaPeakBadgeText, { color: colors.primary }]}>{dnaQuery.data.peak_window.label}</Text>
              </View>
            ) : null}
            <View style={styles.dnaMetricsRow}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.dnaSummaryLabel, { color: colors.muted }]}>Expected this week</Text>
                <Text style={[styles.dnaSummaryVal, { color: colors.text }]}>
                  ₹{Math.round(Number(dnaQuery.data.weekly_expected || 0))}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.dnaSummaryLabel, { color: colors.muted }]}>Actual</Text>
                <Text style={[styles.dnaSummaryVal, { color: colors.text }]}>
                  ₹{Math.round(Number(dnaQuery.data.weekly_actual || 0))}
                </Text>
              </View>
            </View>
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
            <Text style={[styles.dnaConfNote, { color: colors.muted }]}>
              {(dnaQuery.data.simulation_count ?? 0) >= 14
                ? `Based on ${Number(dnaQuery.data.data_weeks_equivalent ?? (dnaQuery.data.simulation_count || 0) / 14).toFixed(1)} weeks of data`
                : 'Estimated pattern — updates as you work'}
            </Text>
          </>
        ) : null}
      </View>

      {/* Weekly earnings protection */}
      <TouchableOpacity
        activeOpacity={0.9}
        onPress={() => setEarningsExpanded((v) => !v)}
        style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
      >
        <View style={styles.cardHeaderRow}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.cardTitle, { color: colors.text }]}>Weekly earnings protection</Text>
            <Text style={[styles.cardSub, { color: colors.muted }]}>
              Tap to {earningsExpanded ? 'collapse' : 'expand'} breakdown
            </Text>
          </View>
          <View style={{ width: 62, height: 62 }}>
            <ProgressRing value={shownWeeklyProtected} max={protectedMax} size={62} stroke={8} scheme={scheme} />
          </View>
        </View>

        <View style={{ marginTop: 10 }}>
          <Text style={[styles.bigMoney, { color: colors.text }]}>
            ₹{Math.round(shownWeeklyProtected)} protected this week{' '}
            <Text style={{ color: colors.muted, fontSize: 12 }}>
              {trend.dir === 'up' ? '↗' : trend.dir === 'down' ? '↘' : '→'} {trend.pct}%
            </Text>
          </Text>
          <Text style={[styles.cardSub, { color: colors.muted }]}>Max coverage: ₹{Math.round(protectedMax)}</Text>
        </View>

        {earningsExpanded ? (
          <View style={styles.breakdownWrap}>
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
              <View key={d} style={[styles.breakdownRow, { borderColor: colors.border }]}>
                <Text style={[styles.breakdownDay, { color: colors.text }]}>{d}</Text>
                <Text style={[styles.breakdownReason, { color: colors.muted }]}>—</Text>
                <Text style={[styles.breakdownAmt, { color: colors.text }]}>₹0</Text>
              </View>
            ))}
            <Text style={[styles.breakdownNote, { color: colors.muted }]}>
              Detailed daily breakdown can be tied to approved payouts as data grows.
            </Text>
          </View>
        ) : null}
      </TouchableOpacity>

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
          <Text style={styles.simulateCtaText}>Simulate Disruption</Text>
          <Text style={styles.simulateCtaSub}>See a live claim → payout in ~9 seconds</Text>
        </TouchableOpacity>
      ) : null}

      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.cardTitle, { color: colors.text, marginBottom: 10 }]}>More</Text>
        <View style={styles.actionsRow}>
          <TouchableOpacity
            style={[styles.actionBtn, { borderColor: colors.border }]}
            onPress={() => {
              logButtonTap('view_payout_history_button');
              navigation.navigate('Claims');
            }}
          >
            <Text style={[styles.actionText, { color: colors.text }]}>Payout history</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionBtn, { borderColor: colors.border }]}
            onPress={() => {
              logButtonTap('upgrade_plan_button');
              navigation.navigate('Coverage');
            }}
          >
            <Text style={[styles.actionText, { color: colors.text }]}>Coverage</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Recent payouts */}
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.cardHeaderRow}>
          <Text style={[styles.cardTitle, { color: colors.text }]}>Recent payouts</Text>
          <TouchableOpacity onPress={() => payoutsQuery.refetch()}>
            <Text style={[styles.linkText, { color: colors.primary }]}>Refresh</Text>
          </TouchableOpacity>
        </View>

        {payoutsQuery.isLoading ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.primary} />
            <Text style={[styles.loadingText, { color: colors.muted }]}>Loading payouts…</Text>
          </View>
        ) : payouts.length === 0 ? (
          <Text style={[styles.cardSub, { color: colors.muted }]}>No payouts yet — you're all set</Text>
        ) : (
          payouts.map((p) => {
            const when = p.date || (p.created_at ? new Date(p.created_at).toLocaleDateString() : '—');
            const amount =
              typeof p.amount === 'number'
                ? p.amount
                : typeof p.payout === 'number'
                  ? p.payout
                  : typeof p.payout_amount === 'number'
                    ? p.payout_amount
                    : 0;
            const typeIcon = payoutIconEmoji(p.icon);
            const disruption = p.disruption_type || 'Payout';
            const chip =
              p.status === 'credited'
                ? 'CREDITED'
                : String(p.decision || p.status || 'DONE').toUpperCase().slice(0, 12);
            return (
              <View key={String(p.id || p.claim_id || when + disruption)} style={[styles.payoutRow, { borderColor: colors.border }]}>
                <Text style={[styles.payoutDate, { color: colors.muted }]} numberOfLines={2}>
                  {when}
                </Text>
                <Text style={[styles.payoutType, { color: colors.text }]}>{typeIcon}</Text>
                <Text style={[styles.payoutDisruption, { color: colors.text }]} numberOfLines={2}>
                  {disruption}
                </Text>
                <Text style={[styles.payoutAmt, { color: colors.text }]}>₹{Math.round(amount)}</Text>
                <View style={[styles.chip, { borderColor: colors.border }]}>
                  <Text style={[styles.chipText, { color: colors.muted }]}>{chip}</Text>
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

      <Modal
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
                  We will run a live claim check for your zone — watch each step update in real time.
                </Text>
                {DEMO_SCENARIOS.map((s) => (
                  <TouchableOpacity
                    key={s.value}
                    style={[styles.scenarioCard, { borderColor: colors.border }]}
                    onPress={() => {
                      logButtonTap('trigger_simulation_button');
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
                    {simMutation.isPending ? <ActivityIndicator size="small" color={colors.primary} /> : <Text style={{ color: colors.muted }}>→</Text>}
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
      </Modal>

      <Modal visible={Boolean(payoutCelebration)} transparent animationType="fade" onRequestClose={() => setPayoutCelebration(null)}>
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
      </Modal>
    </ScrollView>

      {dnaPopover.visible ? (
        <>
          <Pressable
            style={[StyleSheet.absoluteFillObject, { zIndex: 400 }]}
            onPress={() => setDnaPopover({ visible: false, x: 0, y: 0, text: '' })}
          />
          <View
            style={[styles.dnaPopBubble, { left: Math.max(12, dnaPopover.x - 130), top: Math.max(56, dnaPopover.y - 56) }]}
            pointerEvents="box-none"
          >
            <Text style={styles.dnaPopText}>{dnaPopover.text}</Text>
          </View>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
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

  headerGradient: { borderRadius: 18, padding: 16, marginBottom: 14 },

  forecastShieldCard: {
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
  },
  forecastShieldTitle: { color: '#fff', fontSize: 17, fontWeight: '900' },
  forecastShieldSubtitle: { color: 'rgba(255,255,255,0.92)', fontSize: 14, marginTop: 8, lineHeight: 20, fontWeight: '600' },
  forecastShieldFooter: { color: 'rgba(255,255,255,0.88)', fontSize: 13, marginTop: 12, fontWeight: '700' },
  forecastShieldBadge: {
    alignSelf: 'flex-start',
    marginTop: 12,
    backgroundColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
  },
  forecastShieldBadgeText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  forecastClearChip: { marginBottom: 12 },
  forecastClearChipText: { fontSize: 13, fontWeight: '800' },
  headerTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerGreetingRow: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: 10 },
  wsLiveDot: { width: 10, height: 10, borderRadius: 5, borderWidth: 1, borderColor: 'rgba(255,255,255,0.5)' },
  headerGreeting: { color: '#fff', fontSize: 20, fontWeight: '900', flex: 1 },
  liveDisruptionLine: { fontSize: 12, fontWeight: '900', marginTop: 6 },
  headerBadgeRow: { marginTop: 12, flexDirection: 'row', gap: 10, flexWrap: 'wrap' },

  pill: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)' },
  pillText: { color: '#fff', fontSize: 12, fontWeight: '900' },
  pillSuccess: { backgroundColor: 'rgba(46,125,50,0.28)' },
  pillWarn: { backgroundColor: 'rgba(255,143,0,0.28)' },
  pillDanger: { backgroundColor: 'rgba(198,40,40,0.28)' },
  pillTrusted: { backgroundColor: 'rgba(255,255,255,0.14)' },
  pillPremium: { backgroundColor: 'rgba(255,215,0,0.16)' },
  pillNeutral: { backgroundColor: 'rgba(255,255,255,0.10)' },

  card: { borderRadius: 18, padding: 16, marginBottom: 14, borderWidth: 1 },
  cardHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardTitle: { fontSize: 14, fontWeight: '900' },
  cardSub: { fontSize: 12, marginTop: 4 },

  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 10 },
  loadingText: { fontSize: 12 },
  errorBox: { paddingTop: 10 },
  errorText: { fontSize: 12, lineHeight: 16 },

  zoneGrid: { flexDirection: 'row', gap: 10, marginTop: 12 },
  zoneCell: { flex: 1 },
  zoneLabel: { fontSize: 12, fontWeight: '700' },
  zoneValue: { fontSize: 14, fontWeight: '900', marginTop: 6 },

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
  dnaMetricsRow: { flexDirection: 'row', marginTop: 14, gap: 12 },
  dnaProgressTrack: { height: 8, borderRadius: 4, marginTop: 10, overflow: 'hidden' },
  dnaProgressFill: { height: '100%', borderRadius: 4 },
  dnaConfNote: { fontSize: 11, marginTop: 10, fontWeight: '600' },
  dnaPopBubble: {
    position: 'absolute',
    maxWidth: 260,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: 'rgba(17,24,39,0.94)',
    zIndex: 401,
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  dnaPopText: { color: '#fff', fontSize: 13, fontWeight: '700' },

  simulateCta: {
    borderRadius: 16,
    padding: 18,
    marginBottom: 14,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  simulateCtaText: { color: '#fff', fontSize: 18, fontWeight: '900' },
  simulateCtaSub: { color: 'rgba(255,255,255,0.92)', fontSize: 12, marginTop: 8, fontWeight: '600' },

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

