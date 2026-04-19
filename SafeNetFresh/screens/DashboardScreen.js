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
  Platform,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Svg, { Circle, Rect } from 'react-native-svg';

import api, { notifications, simulation, claims as claimsApi, workers as workersApi, zones as zonesApi } from '../services/api';
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
import { formatPayoutWhen } from '../utils/istFormat';
import { useLocalization } from '../contexts/LocalizationContext';
import { formatShortLocation } from '../utils/locationDisplay';
import { stripDailyLimitPrefix } from '../utils/liveClaimCopy';

function getGreetingKey(now = new Date()) {
  const h = now.getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}

function resolveZoneIdFromCity(city) {
  return String(city || '').trim();
}

function weatherEmojiFromIconCode(iconCode) {
  const k = String(iconCode || '').toLowerCase();
  if (k === 'rain') return '☔';
  if (k === 'sunny') return '☀️';
  if (k === 'cloudy') return '⛅';
  if (k === 'hot') return '☀️';
  return '☀️';
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
/** IST hours shown in heatmap: 6 -> 22 (17 columns) */
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
  { label: 'Heavy Rain', value: 'HEAVY_RAIN', emoji: '🌧️', hint: 'Most common disruption', payoutEligible: true },
  { label: 'Extreme Heat', value: 'EXTREME_HEAT', emoji: '🌡️', hint: 'Summer peak risk', payoutEligible: false },
  { label: 'Air Quality Alert', value: 'AQI_SPIKE', emoji: '🏭', hint: 'Hazardous AQI >300', payoutEligible: false },
  { label: 'Others', value: 'CURFEW', emoji: '🚫', hint: 'Other disruption types', payoutEligible: false },
];

function extractGate1ApiValue(update) {
  const gm0 = update?.gate_messages?.[0];
  if (typeof gm0 === 'string') {
    const m = gm0.match(/[—–-]\s*(.+?)\s*[✅✓]/u);
    if (m) return m[1].trim();
    return gm0.replace(/^Gate\s*1:\s*/i, '').trim();
  }
  return 'Signal verified';
}

function gate1PassSubtitle(update) {
  const raw = extractGate1ApiValue(update);
  const cleaned = String(raw)
    .replace(/\s*in your zone\s*$/i, '')
    .replace(/\s*in your zone\s+/gi, ' ')
    .trim();
  return cleaned || 'Signal verified';
}

function extractGate2AppMinutes(update) {
  const gm1 = update?.gate_messages?.[1];
  const candidates = [gm1, String(update?.message || '')].filter((x) => typeof x === 'string');
  for (const s of candidates) {
    const m = s.match(/(\d+)\s*min/i);
    if (m) return m[1];
  }
  return 'recent';
}

function buildPayoutFormulaLine(update) {
  const st = String(update?.status || '').toUpperCase();
  const done = ['APPROVED', 'PAYOUT_CREDITED'].includes(st);
  const pb = update?.payout_breakdown;
  const amt = Number(update?.payout_amount ?? (pb && pb.final_payout) ?? 0);
  if (st === 'NO_PAYOUT') return '✅ No payout credited for this simulation run';
  if (st === 'CLAIM_REJECTED' || st === 'DECISION_REJECTED' || st === 'REJECTED') {
    return '✅ Decision recorded — no payout';
  }
  if (!done) return '✅ Payout finalizing…';
  if (!pb || typeof pb !== 'object') {
    return amt > 0 ? `✅ ₹${Math.round(amt)} credited` : '✅ Decision recorded';
  }
  const rate = Number(pb.hourly_rate ?? 0);
  const hours = Number(pb.disruption_hours ?? 0);
  const mult = Number(pb.coverage_multiplier ?? 0);
  if (!Number.isFinite(rate) || !Number.isFinite(hours) || !Number.isFinite(mult)) {
    return `✅ ₹${Math.round(amt)} credited`;
  }
  return `✅ ₹${Math.round(amt)} credited — Formula: ₹${rate.toFixed(0)}/hr × ${hours.toFixed(1)}h × ${mult}`;
}

function simulationDoneStepIndex(update) {
  if (!update) return -1;
  const st = String(update.status || '').toUpperCase();
  const gm = Array.isArray(update.gate_messages) ? update.gate_messages : [];
  const msg = String(update.message || '');
  if (st === 'INITIATED') return -1;
  if (st === 'VERIFYING') return 0;
  if (st === 'GATE_CHECK') {
    const second =
      gm.length >= 2 &&
      msg &&
      (msg === gm[1] || (gm[1] && msg.includes(gm[1].slice(0, Math.min(24, gm[1].length)))));
    return second ? 2 : 1;
  }
  if (st === 'FRAUD_CHECK') return 3;
  if (st === 'BEHAVIORAL_CHECK') return 4;
  if (st === 'PROCESSING_PAYOUT') return 5;
  if (['APPROVED', 'NO_PAYOUT', 'CLAIM_REJECTED', 'PAYOUT_CREDITED'].includes(st)) return 7;
  if (st === 'BLOCKED') return 4;
  return -1;
}

function SimulationClaimProgress({ update, colors, primary }) {
  const st = String(update?.status || '').toUpperCase();
  const fraud = update?.fraud_score;
  const fraudNum = Number(fraud);
  const fraudLabel = Number.isFinite(fraudNum) ? fraudNum.toFixed(0) : '—';
  const g1 = gate1PassSubtitle(update);
  const g2m = extractGate2AppMinutes(update);
  const steps = [
    '🌧 Gate 1: Validating disruption signals...',
    `✅ Gate 1 PASSED — Weather signal confirmed (${g1})`,
    '📍 Gate 2: Verifying on-duty activity...',
    `✅ Gate 2 PASSED — App active ${g2m} min ago with in-zone GPS`,
    '🛡 Running anti-fraud and integrity checks...',
    `✅ Fraud Score: ${fraudLabel} — All layers passed`,
    '💰 Calculating payout from Earnings DNA...',
    '✅ Payout approved and being credited...',
  ];
  const doneIdx = simulationDoneStepIndex(update);
  const terminal = ['APPROVED', 'NO_PAYOUT', 'CLAIM_REJECTED', 'PAYOUT_CREDITED'].includes(st);
  const blocked = st === 'BLOCKED';

  return (
    <View style={{ marginTop: 8 }}>
      {steps.map((label, i) => {
        const failRow = blocked && i === 4;
        const complete = blocked ? i < 4 : terminal || doneIdx > i;
        const active = !blocked && !terminal && doneIdx === i;

        return (
          <View
            key={`sim-step-${i}`}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingVertical: 10,
              borderBottomWidth: i < steps.length - 1 ? 1 : 0,
              borderBottomColor: colors.border,
            }}
          >
            <View style={{ width: 36, alignItems: 'center' }}>
              {failRow ? (
                <Text style={{ fontSize: 18, color: '#c62828' }}>✕</Text>
              ) : complete ? (
                <Text style={{ fontSize: 18, color: '#16a34a' }}>✓</Text>
              ) : active ? (
                <ActivityIndicator size="small" color={primary} />
              ) : (
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.border }} />
              )}
            </View>
            <View style={{ flex: 1 }}>
              <Text
                style={{
                  fontSize: 12,
                  fontWeight: '800',
                  color: failRow ? '#c62828' : complete || active ? colors.text : colors.muted,
                }}
              >
                {label}
              </Text>
              {active && !failRow ? (
                <Text style={{ fontSize: 11, color: colors.muted, marginTop: 2 }}>Working…</Text>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

function TrustScoreCard({ score, tierLabel, colors, scheme }) {
  const level =
    score > 90
      ? { label: 'Elite ⚡', color: '#2563EB', bg: '#EFF6FF', benefit: 'Instant payouts' }
      : score > 70
        ? { label: 'Trusted ✓', color: '#16a34a', bg: '#F0FDF4', benefit: 'Priority 30s payouts' }
        : score > 40
          ? { label: 'Reliable', color: '#d97706', bg: '#FFFBEB', benefit: 'Standard 2-min payouts' }
          : { label: 'Emerging', color: '#dc2626', bg: '#FEF2F2', benefit: 'Build score for faster payouts' };
  const badgeText = tierLabel ? String(tierLabel) : level.label;
  const pct = Math.min(100, Math.max(0, score));
  const cardBg = colors?.card || '#fff';
  const border = colors?.border || '#E5E7EB';
  const text = colors?.text || '#111827';
  const muted = colors?.muted || '#6B7280';
  const dark = scheme === 'dark';
  const track = dark ? 'rgba(255,255,255,0.12)' : '#F3F4F6';
  const subMuted = dark ? '#94a3b8' : '#9CA3AF';
  return (
    <View
      style={{
        backgroundColor: cardBg,
        borderRadius: 16,
        padding: 20,
        marginVertical: 8,
        borderWidth: 1,
        borderColor: border,
      }}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <Text style={{ fontSize: 13, fontWeight: '600', color: muted }}>Trust Score</Text>
        <View style={{ backgroundColor: level.bg, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 }}>
          <Text style={{ fontSize: 12, fontWeight: '700', color: level.color }}>{badgeText}</Text>
        </View>
      </View>
      <View style={{ height: 8, backgroundColor: track, borderRadius: 4, overflow: 'hidden', marginBottom: 8 }}>
        <View style={{ height: '100%', width: `${pct}%`, backgroundColor: level.color, borderRadius: 4 }} />
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text style={{ fontSize: 26, fontWeight: '900', color: text }}>
          {score}
          <Text style={{ fontSize: 13, color: subMuted }}>/100</Text>
        </Text>
        <Text style={{ fontSize: 11, color: muted, flex: 1, textAlign: 'right', marginLeft: 8 }}>{level.benefit}</Text>
      </View>
      <Text style={{ marginTop: 10, fontSize: 11, color: muted, lineHeight: 16 }}>
        Higher trust unlocks faster payouts after approved claims.
      </Text>
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
  const lastStatus = String(lastUpdate?.status || '').toUpperCase();
  const tsRaw = String(lastUpdate?.timestamp || lastUpdate?.created_at || '');
  const tsMs = Date.parse(tsRaw);
  const isFresh = Number.isFinite(tsMs) ? Date.now() - tsMs < 120_000 : true;
  if (lastStatus && terminal.has(lastStatus)) return false;
  if (activeClaims?.length) return true;
  if (!isFresh) return false;
  return Boolean(lastUpdate?.claim_id && lastStatus && !terminal.has(lastStatus));
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
  const { t, language, setLanguage } = useLocalization();

  const { disruptionAlert, lastClaimUpdate, activeClaims } = useClaims();
  const { coverageStatus, policy } = usePolicy();
  const dashboardQuery = useQuery({
    queryKey: ['workerDashboard', userId],
    enabled: Boolean(userId),
    queryFn: () => workersApi.getDashboard(userId),
    staleTime: 1000 * 30,
    refetchInterval: 1000 * 30,
  });
  const homePlanTier = useMemo(
    () => canonicalTierLabel(dashboardQuery.data?.policy?.tier || policy?.tier),
    [dashboardQuery.data?.policy?.tier, policy?.tier]
  );
  const { data: profileQueryData, isLoading: profileQueryLoading } = useWorkerProfile();
  const profile = dashboardQuery.data?.profile ?? profileQueryData ?? workerProfile ?? null;
  const profileLoading = Boolean((profileQueryLoading || dashboardQuery.isLoading) && !workerProfile);
  const payoutsQuery = usePayoutHistory();
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [selectedPayment, setSelectedPayment] = useState(null);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const notificationsQuery = useQuery({
    queryKey: ['notifications', userId],
    queryFn: () => notifications.list(String(userId || '')),
    enabled: Boolean(userId),
    refetchInterval: 12000,
  });

  const trust = profile?.trust_score;
  const tb = trustBadge(trust);
  const cb = coverageBadge(coverageStatus || policy?.status);

  const trustPts = useMemo(() => {
    const raw = profile?.trust_score_points;
    if (raw != null && Number.isFinite(Number(raw))) return Math.round(Number(raw));
    const ts = profile?.trust_score;
    if (ts == null || ts === '') return 50;
    const n = Number(ts);
    if (!Number.isFinite(n)) return 50;
    return n <= 1 ? Math.round(n * 100) : Math.round(n);
  }, [profile?.trust_score_points, profile?.trust_score]);

  const trustTierUi =
    profile?.trust_tier ||
    (trustPts >= 91 ? 'Elite' : trustPts >= 71 ? 'Trusted' : trustPts >= 41 ? 'Reliable' : 'Emerging');

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

  const zoneId = useMemo(() => resolveZoneIdFromCity(profile?.zone_id), [profile?.zone_id]);
  const effectiveZoneId = useMemo(() => {
    const z = profile?.zone_id;
    if (z && String(z) !== 'default' && String(z) !== 'unknown') return String(z);
    return zoneId || null;
  }, [profile?.zone_id, zoneId]);

  const zoneStatusQuery = useQuery({
    queryKey: ['zoneStatus', effectiveZoneId],
    enabled: Boolean(effectiveZoneId),
    queryFn: async () => {
      const res = await api.get(`/zones/${encodeURIComponent(effectiveZoneId)}/status`);
      return res.data;
    },
    staleTime: 1000 * 90,
    refetchInterval: 1000 * 120,
  });

  const forecastShieldQuery = useQuery({
    queryKey: ['forecastShield', effectiveZoneId],
    enabled: Boolean(effectiveZoneId),
    queryFn: () => zonesApi.getForecastShield(effectiveZoneId),
    staleTime: 1000 * 60 * 10,
  });

  const riskModeQuery = useQuery({
    queryKey: ['zoneRiskMode', effectiveZoneId],
    enabled: Boolean(effectiveZoneId),
    queryFn: () => zonesApi.getRiskMode(effectiveZoneId),
    staleTime: 1000 * 60 * 5,
    refetchInterval: 1000 * 120,
  });
  const riskModeData = riskModeQuery.data || null;
  const riskModeName = String(riskModeData?.mode || '').toUpperCase();
  const showProtectionBanner =
    riskModeName === 'PROTECTION' || riskModeName === 'CRITICAL';

  const zoneStatus = zoneStatusQuery.data || null;
  /** Weather/AQI / gov heuristic from zone status (amber “watch”, not a billed disruption). */
  const disruptionAmbient =
    Boolean(zoneStatus?.disruption_active) || String(zoneStatus?.status || '').toLowerCase() === 'disruption';

  /** Amber = live socket connected cue; muted when offline */
  const wsDotColor =
    wsStatus === 'connected' ? '#FBBF24' : wsStatus === 'reconnecting' ? '#F59E0B' : 'rgba(255,255,255,0.35)';

  const [approvalToast, setApprovalToast] = useState(null);
  const approvalSlide = useRef(new Animated.Value(-140)).current;
  const lastApprovedIdRef = useRef(null);
  const lastNotifToastIdRef = useRef(null);
  const approvalHideTimerRef = useRef(null);
  const [dismissBankPrompt, setDismissBankPrompt] = useState(false);
  const zoneStressAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const id = lastClaimUpdate?.claim_id;
    const st = String(lastClaimUpdate?.status || '').toUpperCase();
    if (st !== 'APPROVED' || id == null) return;
    const cid = String(id);
    if (lastApprovedIdRef.current === cid) return;
    lastApprovedIdRef.current = cid;
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
    if (approvalHideTimerRef.current) clearTimeout(approvalHideTimerRef.current);
    const hide = () => {
      Animated.timing(approvalSlide, { toValue: -140, duration: 240, useNativeDriver: true }).start(() => {
        setApprovalToast(null);
        approvalSlide.setValue(-140);
      });
    };
      // Primary auto-hide + hard safety hide (prevents "stuck" toast).
    approvalHideTimerRef.current = setTimeout(hide, 3200);
    const safety = setTimeout(hide, 9000);
    return () => {
      if (approvalHideTimerRef.current) clearTimeout(approvalHideTimerRef.current);
      clearTimeout(safety);
    };
  }, [lastClaimUpdate, approvalSlide]);

  useEffect(() => {
    const rows = notificationsQuery.data?.data;
    if (!Array.isArray(rows) || rows.length === 0) return;
    const latestPayout = rows.find((n) => String(n?.type || '').toLowerCase() === 'payout');
    if (!latestPayout) return;
    const createdMs = Date.parse(String(latestPayout.created_at || ''));
    if (Number.isFinite(createdMs) && Date.now() - createdMs > 120000) return;
    if (!String(latestPayout.title || '').toLowerCase().includes('credited')) return;
    const nid = String(latestPayout.id || '');
    if (!nid || lastNotifToastIdRef.current === nid) return;
    const amount = Number(String(latestPayout.title || '').replace(/[^\d.]/g, '')) || 0;
    lastNotifToastIdRef.current = nid;
    setApprovalToast({
      amount,
      disruption: 'Disruption',
      shieldLine: null,
    });
    approvalSlide.setValue(-140);
    Animated.spring(approvalSlide, { toValue: 0, friction: 7, tension: 80, useNativeDriver: true }).start();
    if (approvalHideTimerRef.current) clearTimeout(approvalHideTimerRef.current);
    approvalHideTimerRef.current = setTimeout(() => {
      Animated.timing(approvalSlide, { toValue: -140, duration: 240, useNativeDriver: true }).start(() => {
        setApprovalToast(null);
        approvalSlide.setValue(-140);
      });
    }, 3200);
    qc.invalidateQueries({ queryKey: ['claimsHistory'] });
    qc.invalidateQueries({ queryKey: ['payoutHistory'] });
  }, [notificationsQuery.data, approvalSlide, qc]);

  useEffect(() => {
    // If backend/UI sends follow-up statuses, do not leave the toast pinned.
    const st = String(lastClaimUpdate?.status || '').toUpperCase();
    if (!approvalToast) return;
    if (st && st !== 'APPROVED' && st !== 'PAYOUT_DONE' && st !== 'PAYOUT_CREDITED') {
      setApprovalToast(null);
      approvalSlide.setValue(-140);
    }
  }, [lastClaimUpdate?.status, approvalToast, approvalSlide]);

  const safeLevel = zoneStatus?.safe_level;
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

  const weeklyCapFallback = useMemo(() => {
    const tier = String(policy?.tier ?? profile?.coverage_tier ?? 'standard').toLowerCase();
    if (tier.includes('basic')) return 600;
    if (tier.includes('pro')) return 1200;
    return 900;
  }, [policy?.tier, profile?.coverage_tier]);

  const protectedMax = useMemo(() => {
    const cap = Number(policy?.max_coverage_per_day);
    return Number.isFinite(cap) && cap > 0 ? cap : weeklyCapFallback;
  }, [policy?.max_coverage_per_day, weeklyCapFallback]);

  const protectedThisWeek = useMemo(() => {
    const rows = payoutsQuery.data;
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    return rows.reduce((sum, r) => {
      const amt = Number(r?.amount ?? r?.payout_amount ?? r?.payout ?? 0);
      return sum + (Number.isFinite(amt) ? amt : 0);
    }, 0);
  }, [payoutsQuery.data]);

  const trend = useMemo(() => {
    // Backend does not provide last-week baseline yet, so keep deterministic UX.
    // If you add last_week_payouts, we will compute real trend.
    return protectedThisWeek > 0 ? { dir: 'up', pct: 0 } : { dir: 'flat', pct: 0 };
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

  const [activeDisruptions, setActiveDisruptions] = useState([]);
  const [dnaExpanded, setDnaExpanded] = useState(false);
  const [coverageExpanded, setCoverageExpanded] = useState(true);
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
    const fetchActiveDisruptions = async () => {
      try {
        const data = effectiveZoneId
          ? await zonesApi.getActiveDisruptions(effectiveZoneId)
          : [];
        const arr = Array.isArray(data) ? data : [];
        setActiveDisruptions(
          arr.map((d) => ({
            ...d,
            disruption_type: d.disruption_type || d.type,
          }))
        );
      } catch {
        // Silent - disruption banner is non-critical.
      }
    };
    fetchActiveDisruptions();
    const id = setInterval(fetchActiveDisruptions, 30000);
    return () => clearInterval(id);
  }, [effectiveZoneId]);

  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setDnaTick((x) => x + 1), 4000);
    return () => clearInterval(id);
  }, []);

  const inFlight = useMemo(() => isInFlightClaim(lastClaimUpdate, activeClaims), [lastClaimUpdate, activeClaims]);
  const severeDisruptionUi = Boolean(activeDisruptions?.length) || inFlight;
  const disruptionActive = severeDisruptionUi;

  useEffect(() => {
    if (!severeDisruptionUi) {
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
  }, [severeDisruptionUi, zoneBgPulse]);

  useEffect(() => {
    if (!severeDisruptionUi) return;
    zoneStressAnim.setValue(0);
    const pulse = Animated.sequence([
      Animated.timing(zoneStressAnim, { toValue: 1, duration: 260, useNativeDriver: false }),
      Animated.timing(zoneStressAnim, { toValue: 0, duration: 260, useNativeDriver: false }),
    ]);
    Animated.sequence([pulse, pulse, pulse]).start();
  }, [severeDisruptionUi, activeDisruptions, zoneStressAnim]);

  const zonePulseTone = severeDisruptionUi
    ? 'danger'
    : safeLevel === 'WATCH' || disruptionAmbient
      ? 'warn'
      : 'success';

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

  const weeklyProtectionPct = useMemo(() => {
    if (!Number.isFinite(protectedMax) || protectedMax <= 0) return null;
    return Math.min(100, Math.round((protectedThisWeek / protectedMax) * 100));
  }, [protectedThisWeek, protectedMax]);
  const dnaData = dnaQuery.data || {};
  const currentHourRate = useMemo(() => {
    const row = dnaData?.dna?.[getIstWeekdayMon0()] || [];
    const hr = getIstHour();
    return Number(row?.[hr] || 0);
  }, [dnaData?.dna]);
  const liveBand = useMemo(() => {
    if (currentHourRate >= 80) return { tone: '🟡 Moderate demand', min: 52, max: 72 };
    if (currentHourRate >= 45) return { tone: '🟢 Active demand', min: 52, max: 72 };
    return { tone: '🔵 Lower demand window', min: 35, max: 52 };
  }, [currentHourRate]);
  const todayPotential = useMemo(() => {
    const row = dnaData?.dna?.[getIstWeekdayMon0()] || [];
    const total = row.slice(6, 23).reduce((s, n) => s + (Number(n) || 0), 0);
    const low = Math.round(total * 0.82);
    const high = Math.round(total * 1.12);
    return {
      low: Math.max(180, Math.min(420, low)),
      high: Math.max(260, Math.min(720, high)),
    };
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
  const [langSheetVisible, setLangSheetVisible] = useState(false);
  const simulationEnabled = true;
  const [sheetPhase, setSheetPhase] = useState('scenarios');
  const [payoutCelebration, setPayoutCelebration] = useState(null);
  const [displayWeeklyProtected, setDisplayWeeklyProtected] = useState(null);
  const celebratedClaimIdRef = useRef(null);
  const demoStepStatusRef = useRef(null);
  const weeklyBeforeDemoRef = useRef(null);

  useEffect(() => {
    celebratedClaimIdRef.current = null;
    demoStepStatusRef.current = null;
    weeklyBeforeDemoRef.current = null;
    setPayoutCelebration(null);
    setDisplayWeeklyProtected(null);
  }, [userId]);

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

  const simTerminalStatuses = useMemo(
    () =>
      new Set([
        'APPROVED',
        'NO_PAYOUT',
        'CLAIM_REJECTED',
        'BLOCKED',
        'PAYOUT_CREDITED',
        'PAYOUT_DONE',
        'DECISION_REJECTED',
        'REJECTED',
      ]),
    []
  );
  const simClaimId = lastClaimUpdate?.claim_id;
  const simStUpper = String(lastClaimUpdate?.status || '').toUpperCase();
  const simAiExplanationEnabled = Boolean(
    disruptionSheetVisible && sheetPhase === 'progress' && simClaimId != null && simTerminalStatuses.has(simStUpper)
  );

  const simAiQuery = useQuery({
    queryKey: ['claimAiExplanation', simClaimId],
    queryFn: () => claimsApi.getAiExplanation(simClaimId),
    enabled: simAiExplanationEnabled,
    retry: false,
    staleTime: 0,
    refetchInterval: (query) => (query.state.data?.ai_explanation ? false : 2500),
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
    if (!lastClaimUpdate) return;
    const st = String(lastClaimUpdate?.status || '').toUpperCase();
    const cid = lastClaimUpdate?.claim_id;
    const evtTs = Date.parse(String(lastClaimUpdate?.timestamp || lastClaimUpdate?.created_at || ''));
    const isFreshEvent = Number.isFinite(evtTs) ? Date.now() - evtTs < 45_000 : false;
    const amt = Number(lastClaimUpdate?.payout_amount ?? 0);

    // Celebration: real credit only (positive payout + fresh APPROVED).
    if (cid != null && st === 'APPROVED' && isFreshEvent && amt > 0 && celebratedClaimIdRef.current !== cid) {
      celebratedClaimIdRef.current = cid;
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
        recipient: String(firstName || 'your account'),
        payoutRef:
          lastClaimUpdate?.transaction_id ||
          lastClaimUpdate?.payout_ref ||
          lastClaimUpdate?.payment_ref ||
          null,
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
    }

    // Always refresh history after terminal states so Claims tab matches Notifications.
    if (
      [
        'APPROVED',
        'PAYOUT_DONE',
        'PAYOUT_CREDITED',
        'NO_PAYOUT',
        'CLAIM_REJECTED',
        'DECISION_REJECTED',
        'BLOCKED',
        'REJECTED',
      ].includes(st)
    ) {
      qc.invalidateQueries({ queryKey: ['claimsHistory'] });
    }
    // Refresh payouts only when credited.
    if (Number.isFinite(amt) && amt > 0) {
      qc.invalidateQueries({ queryKey: ['payoutHistory'] });
    }
    const delayed = setTimeout(() => {
      qc.invalidateQueries({ queryKey: ['claimsHistory'] });
      qc.invalidateQueries({ queryKey: ['payoutHistory'] });
    }, 2500);
    qc.invalidateQueries({ queryKey: ['workerProfile'] });
    qc.invalidateQueries({ queryKey: ['earningsDna'] });
    qc.invalidateQueries({ queryKey: ['zoneStatus'] });
    qc.invalidateQueries({ queryKey: ['forecastShield'] });
    qc.invalidateQueries({ queryKey: ['forecastDaily'] });
    return () => clearTimeout(delayed);
  }, [lastClaimUpdate, qc]);

  const refreshing = manualRefreshing;
  const onRefresh = useCallback(() => {
    setManualRefreshing(true);
    Promise.allSettled([
      payoutsQuery.refetch(),
      zoneStatusQuery.refetch(),
      forecastShieldQuery.refetch(),
      dnaQuery.refetch(),
      breakdownQuery.refetch(),
    ]).finally(() => setManualRefreshing(false));
  }, [
    setManualRefreshing,
    payoutsQuery.refetch,
    zoneStatusQuery.refetch,
    forecastShieldQuery.refetch,
    dnaQuery.refetch,
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

  const zoneDisplayName = useMemo(() => {
    const loc = String(profile?.location_display || '').trim();
    if (loc) return formatShortLocation(loc) || loc;
    const zn = String(zoneStatus?.zone_name || '').trim();
    if (zn) return formatShortLocation(zn) || zn;
    const c = String(profile?.city || '').trim();
    if (c) return formatShortLocation(c) || c;
    return t('dashboard.zone_fallback');
  }, [profile?.location_display, zoneStatus?.zone_name, profile?.city, t]);

  const isColdProfile = useMemo(() => {
    const claims = Number(profile?.total_claims ?? 0);
    const payouts = Number(profile?.total_payouts ?? 0);
    return claims === 0 && payouts === 0;
  }, [profile?.total_claims, profile?.total_payouts]);
  const dnaMatrix = useMemo(() => {
    if (isColdProfile) {
      return Array.from({ length: 7 }, () =>
        Array.from({ length: DNA_GRID_COLS }, () => 0)
      );
    }
    return Array.isArray(dnaQuery.data?.dna) ? dnaQuery.data.dna : [];
  }, [isColdProfile, dnaQuery.data?.dna]);
  const primaryForecastShield = Array.isArray(forecastShieldQuery.data?.shields)
    ? forecastShieldQuery.data.shields[0]
    : null;

  const timeGreeting = t(`dashboard.greeting_${getGreetingKey()}`);

  const zoneUpdatedText = useMemo(() => {
    const updatedAt = zoneStatusQuery.dataUpdatedAt;
    if (!updatedAt) return '';
    void tick;
    const sec = Math.floor((Date.now() - updatedAt) / 1000);
    if (sec < 8) return t('dashboard.updated_just_now');
    if (sec < 60) return `${t('dashboard.updated_prefix')} ${sec}s`;
    const m = Math.floor(sec / 60);
    if (m < 120) return `${t('dashboard.updated_prefix')} ${m}m`;
    return t('dashboard.updated_earlier');
  }, [zoneStatusQuery.dataUpdatedAt, tick, t]);

  const dnaUpdatedText = useMemo(() => {
    const updatedAt = dnaQuery.dataUpdatedAt;
    if (!updatedAt) return '';
    void dnaTick;
    if (dnaQuery.isRefetching || dnaQuery.isFetching) return 'Live · refreshing pattern…';
    const sec = Math.floor((Date.now() - updatedAt) / 1000);
    if (sec < 6) return 'Live · pattern just synced';
    if (sec < 60) return `Live · synced ${sec}s ago`;
    const m = Math.floor(sec / 60);
    if (m < 120) return `Live · synced ${m}m ago`;
    return 'Pattern last synced from server';
  }, [dnaQuery.dataUpdatedAt, dnaQuery.isRefetching, dnaQuery.isFetching, dnaTick]);

  const rideStatus = useMemo(() => {
    if (disruptionActive) {
      let detail = '';
      if (Array.isArray(activeDisruptions) && activeDisruptions.length > 0) {
        detail = formatDisruptionLabel(activeDisruptions[0].disruption_type);
      } else if (inFlight && lastClaimUpdate?.disruption_type) {
        detail = formatDisruptionLabel(lastClaimUpdate.disruption_type);
      } else if (showProtectionBanner && riskModeName) {
        detail = String(riskModeData?.label || riskModeName);
      }
      const label = detail ? `${detail} · ${t('dashboard.disruption_active_bar')}` : t('dashboard.disruption_active_bar');
      return { key: 'red', label, bar: '#dc2626' };
    }
    if (safeLevel === 'WATCH' || disruptionAmbient || (Number.isFinite(aqiNum) && aqiNum > 150))
      return { key: 'amber', label: t('dashboard.watch_ride'), bar: '#d97706' };
    return { key: 'green', label: t('dashboard.safe_ride'), bar: '#16a34a' };
  }, [
    disruptionActive,
    activeDisruptions,
    inFlight,
    lastClaimUpdate?.disruption_type,
    showProtectionBanner,
    riskModeName,
    riskModeData?.label,
    safeLevel,
    aqiNum,
    disruptionAmbient,
    t,
  ]);

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
            { transform: [{ translateY: approvalSlide }], pointerEvents: 'none' },
          ]}
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
            <TouchableOpacity style={styles.toastCloseBtn} onPress={() => setApprovalToast(null)}>
              <Text style={styles.toastCloseText}>✕</Text>
            </TouchableOpacity>
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
      {!dismissBankPrompt && !(profile?.bank_upi_id || profile?.bank_account_number) ? (
        <View style={styles.bankPromptCard}>
          <TouchableOpacity style={styles.bankPromptClose} onPress={() => setDismissBankPrompt(true)}>
            <Text style={styles.bankPromptCloseText}>✕</Text>
          </TouchableOpacity>
          <Text style={styles.bankPromptTitle}>Update bank details to receive payouts</Text>
          <TouchableOpacity
            style={styles.bankPromptBtn}
            onPress={() => navigation.navigate('Account')}
          >
            <Text style={styles.bankPromptBtnText}>Update bank details</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      {!dismissBankPrompt &&
      (profile?.bank_upi_id || profile?.bank_account_number) &&
      String(policy?.status || coverageStatus || '').toLowerCase() !== 'active' ? (
        <View style={[styles.bankPromptCard, styles.coveragePromptCard]}>
          <TouchableOpacity style={styles.bankPromptClose} onPress={() => setDismissBankPrompt(true)}>
            <Text style={styles.bankPromptCloseText}>✕</Text>
          </TouchableOpacity>
          <Text style={[styles.bankPromptTitle, styles.coveragePromptTitle]}>
            Bank details saved. Activate coverage to unlock payouts.
          </Text>
          <TouchableOpacity style={[styles.bankPromptBtn, styles.coveragePromptBtn]} onPress={() => navigation.navigate('Coverage')}>
            <Text style={styles.bankPromptBtnText}>Activate coverage</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      {showProtectionBanner ? (
        <View
          style={[
            styles.card,
            {
              backgroundColor: riskModeName === 'CRITICAL' ? '#3a0d12' : '#2a210a',
              borderColor: riskModeName === 'CRITICAL' ? '#b71c1c' : '#d97706',
              marginBottom: 12,
            },
          ]}
        >
          <Text style={{ color: '#fff', fontWeight: '800', fontSize: 14 }}>
            ⚠️ Your zone is in {riskModeData?.label || riskModeName} — coverage auto-upgraded
          </Text>
          {riskModeData?.description ? (
            <Text style={{ color: 'rgba(255,255,255,0.85)', marginTop: 6, fontSize: 12 }}>
              {riskModeData.description}
            </Text>
          ) : null}
        </View>
      ) : null}
      {severeDisruptionUi ? (
        <View style={[styles.card, { backgroundColor: colors.dangerBg, borderColor: '#c62828', marginBottom: 12 }]}>
          <Text style={[styles.disruptionTitle, { color: scheme === 'dark' ? '#ff8a80' : '#b71c1c' }]}>
            {activeDisruptions.length > 0 ? (
              <>
                {formatDisruptionLabel(activeDisruptions[0].disruption_type)} {t('dashboard.disruption_detected_suffix')}
                {activeDisruptions[0].confidence
                  ? ` (${activeDisruptions[0].confidence} ${t('dashboard.confidence_suffix')})`
                  : ''}
                {` — ${t('dashboard.claim_processing_suffix')}`}
              </>
            ) : (
              t('dashboard.claim_pipeline_banner')
            )}
          </Text>
        </View>
      ) : null}

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
          {tb.tone === 'premium' || tb.tone === 'trusted' ? (
            <View
              style={[
                styles.pill,
                tb.tone === 'premium' ? styles.pillPremium : styles.pillTrusted,
              ]}
            >
              <Text style={styles.pillText}>{tb.label}</Text>
            </View>
          ) : null}
          <TouchableOpacity
            onPress={() => setLangSheetVisible(true)}
            style={styles.headerLangBtn}
            accessibilityRole="button"
            accessibilityLabel={t('dashboard.language_picker')}
          >
            <MaterialCommunityIcons name="earth" size={22} color="#fff" />
          </TouchableOpacity>
        </View>
        {homePlanTier && homePlanTier !== '—' ? (
          <Text style={styles.headerPlanLine} numberOfLines={1}>
            {`${t('dashboard.plan_prefix')} ${homePlanTier}`}
          </Text>
        ) : null}
      </LinearGradient>

      {/* Zone status - real-time zone intelligence */}
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
            style={[
              StyleSheet.absoluteFillObject,
              { backgroundColor: '#fecaca', opacity: zonePulseOverlayOpacity, pointerEvents: 'none' },
            ]}
          />
        ) : null}
        <View style={styles.cardHeaderRow}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.zoneCardTitle, { color: colors.text }]}>
              {t('dashboard.zone_title')} · {zoneDisplayName}
            </Text>
            <Text style={[styles.cardSub, { color: colors.muted }]} numberOfLines={1}>
              {zoneUpdatedText || t('dashboard.pull_to_refresh_hint')}
            </Text>
            {severeDisruptionUi && disruptionAlert?.visible && disruptionAlert?.disruption_type ? (
              <Text style={[styles.liveDisruptionLine, { color: scheme === 'dark' ? '#ff8a80' : '#b71c1c' }]}>
                {t('dashboard.live_prefix')} {formatDisruptionLabel(disruptionAlert.disruption_type)}
              </Text>
            ) : null}
          </View>
          <ZonePulseDot tone={zonePulseTone} />
        </View>

        {zoneStatusQuery.isLoading ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.primary} />
            <Text style={[styles.loadingText, { color: colors.muted }]}>{t('dashboard.loading_zone')}</Text>
          </View>
        ) : zoneStatusQuery.isError ? (
          <View style={styles.errorBox}>
            <Text style={[styles.errorText, { color: colors.muted }]}>{t('dashboard.zone_status_error')}</Text>
          </View>
        ) : (
          <View style={styles.zoneGrid}>
            <View style={styles.zoneCell}>
              <Text style={[styles.zoneLabel, { color: colors.muted }]}>{t('dashboard.weather_label')}</Text>
              <Text style={[styles.zoneValue, { color: colors.text }]} numberOfLines={2}>
                {weatherEmoji}
                {'\n'}
                {tempC != null ? `${tempC}°C` : '—'}
              </Text>
            </View>
            <View style={styles.zoneCell}>
              <Text style={[styles.zoneLabel, { color: colors.muted }]}>{t('dashboard.aqi_label')}</Text>
              <Text style={[styles.zoneValue, { color: aqiHex }]} numberOfLines={3}>
                {aqiLabel}
                {Number.isFinite(aqiNum) ? `\n${Math.round(aqiNum)}` : ''}
              </Text>
            </View>
            <View style={styles.zoneCell}>
              <Text style={[styles.zoneLabel, { color: colors.muted }]}>{t('dashboard.alerts_label')}</Text>
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

      </Animated.View>

      {primaryForecastShield && !forecastShieldQuery.isError ? (
        <TouchableOpacity
          activeOpacity={0.9}
          onPress={() => navigation.navigate('Coverage')}
          style={{ marginBottom: 14 }}
        >
          <LinearGradient
            colors={['#0f172a', '#1d4ed8', '#3b82f6']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.forecastShieldCardHero}
          >
            <Text style={styles.forecastShieldHeroIcon}>🛡️</Text>
            <Text style={styles.forecastShieldHeroTitle}>Forecast Shield Active</Text>
            <Text style={styles.forecastShieldHeroSubtitle}>
              {primaryForecastShield.subtitle || 'Weather risk expected tomorrow'}
            </Text>
            <Text style={styles.forecastShieldHeroFooter}>
              Tap to view 14-day weather outlook in Coverage
            </Text>
            <View style={styles.forecastShieldBadge}>
              <Text style={styles.forecastShieldBadgeText}>Live · Tap for full forecast</Text>
            </View>
          </LinearGradient>
        </TouchableOpacity>
      ) : null}

      {/* Earnings DNA - hour x day heatmap */}
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
            <Text style={[styles.cardSub, { color: colors.muted }]}>
              {isColdProfile ? t('dashboard.dna_cold_collapsed') : dnaUpdatedText}
            </Text>
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
            {isColdProfile ? (
              <View style={[styles.dnaLiveCard, { backgroundColor: scheme === 'dark' ? '#0f2742' : '#eff6ff' }]}>
                <Text style={styles.dnaLiveTone}>{t('dashboard.dna_cold_title')}</Text>
                <Text style={styles.dnaLiveAmt}>{t('dashboard.dna_cold_body')}</Text>
              </View>
            ) : (
              <View style={styles.dnaLiveCard}>
                <Text style={styles.dnaLiveTone}>{liveBand.tone}</Text>
                <Text style={styles.dnaLiveAmt}>
                  {currentHourRate >= 45
                    ? '₹52–₹72/hr expected in your zone now'
                    : '₹35–₹52/hr expected in your zone now'}
                </Text>
              </View>
            )}
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
                    {dnaMatrix.flatMap((row, di) =>
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
                  {dnaMatrix.flatMap((row, di) =>
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
                              amount: Math.min(72, Math.round(v)),
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
            <Text style={[styles.dnaInsightLine, { color: colors.text }]}>
              {isColdProfile ? t('dashboard.dna_cold_collapsed') : nextBestLabel}
            </Text>
            <Text style={[styles.dnaTodayPotential, { color: colors.text }]}>
              {isColdProfile
                ? '—'
                : `₹${todayPotential.low}-₹${todayPotential.high} today`}
            </Text>
            <Text style={[styles.dnaInsightLine, { color: colors.text }]}>
              {isColdProfile
                ? t('dashboard.protection_cold_hint')
                : `₹${Math.round(protectedThisWeek).toLocaleString('en-IN')} of ₹${Math.round(protectedMax).toLocaleString('en-IN')} used`}
            </Text>
            <View style={[styles.dnaProgressTrack, { backgroundColor: colors.border }]}>
              <View
                style={[
                  styles.dnaProgressFill,
                  {
                    backgroundColor: colors.primary,
                    width: `${weeklyProtectionPct != null ? weeklyProtectionPct : 0}%`,
                  },
                ]}
              />
            </View>
            <Text style={[styles.dnaConfNote, { color: colors.muted }]}>Weekly protection vs your plan cap</Text>
          </>
        ) : null}
      </View>

      <TrustScoreCard
        score={Math.min(100, Math.max(0, trustPts))}
        tierLabel={trustTierUi}
        colors={colors}
        scheme={scheme}
      />

      {/* Coverage ring - weekly protection */}
      <View style={[styles.card, styles.cardElevated, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.coverageRingRow}>
          <View style={{ flex: 1, paddingRight: 8 }}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('dashboard.weekly_protection')}</Text>
            <Text style={[styles.coverageRingAmount, { color: colors.text }]}>
              ₹{Math.round(shownWeeklyProtected).toLocaleString('en-IN')} of ₹
              {Math.round(protectedMax).toLocaleString('en-IN')} used
            </Text>
            <Text style={[styles.fingerprintHint, { color: colors.muted }]}>
              {isColdProfile && Math.round(shownWeeklyProtected) === 0
                ? t('dashboard.protection_cold_hint')
                : weeklyProtectionPct != null
                  ? `${weeklyProtectionPct}% of weekly cap`
                  : `${trend.dir === 'up' ? '↗' : trend.dir === 'down' ? '↘' : '→'} ${trend.pct}% vs typical week`}
            </Text>
            <Text style={[styles.cardSub, { color: colors.muted, marginTop: 6 }]}>
              Weekly cap ₹{Math.round(protectedMax).toLocaleString('en-IN')}
            </Text>
            <TouchableOpacity onPress={() => setCoverageExpanded((x) => !x)} style={{ marginTop: 10 }}>
              <Text style={[styles.linkText, { color: colors.primary }]}>
                {coverageExpanded ? 'Hide' : 'Show'} week breakdown
              </Text>
            </TouchableOpacity>
          </View>
          <View style={styles.coverageRingWrap}>
            <ProgressRing value={shownWeeklyProtected} max={protectedMax} size={104} stroke={10} scheme={scheme} />
          </View>
        </View>
        {coverageExpanded ? (
          <View style={styles.breakdownWrap}>
            {breakdownHasData ? (
              (breakdownQuery.data?.weekly_breakdown || []).map((row) => (
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
              ))
            ) : (
              <View style={[styles.breakdownRow, { borderColor: colors.border }]}>
                <Text style={[styles.breakdownDay, { color: colors.text }]}>This week</Text>
                <Text style={[styles.breakdownReason, { color: colors.muted }]} numberOfLines={1}>
                  No verified payouts yet
                </Text>
                <Text style={[styles.breakdownAmt, { color: colors.text }]}>₹0</Text>
              </View>
            )}
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
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <Text style={[styles.cardTitle, { color: colors.text, marginBottom: 0 }]}>Active claim</Text>
            <Text style={[styles.etaText, { color: colors.muted, fontWeight: '800' }]}>
              {etaSeconds ? `${etaSeconds}s` : '—'}
            </Text>
          </View>
          {lastClaimUpdate?.message ? (
            <View style={[styles.liveClaimHighlight, { marginBottom: 12 }]}>
              <Text style={[styles.liveClaimHighlightText, { color: colors.text }]}>
                {stripDailyLimitPrefix(lastClaimUpdate.message)}
              </Text>
            </View>
          ) : (
            <Text style={[styles.cardSub, { color: colors.muted, marginBottom: 12 }]} numberOfLines={2}>
              Processing in real-time…
            </Text>
          )}

          <Stepper step={step} flagged={flagged} scheme={scheme} />

          {flagged ? (
            <Text style={[styles.flaggedNote, { color: scheme === 'dark' ? '#ffd180' : '#8a5a00' }]}>
              Routine verification — your claim history is strong
            </Text>
          ) : null}
        </View>
      ) : null}

      {/* Simulate disruption - primary demo CTA */}
      {simulationEnabled && !inFlight ? (
        <View style={styles.simulateBlock}>
          <TouchableOpacity
            style={[styles.simulateCta, styles.simulateCtaHighlight, { backgroundColor: colors.primary }]}
            activeOpacity={0.9}
            onPress={() => {
              const hasBank = Boolean(
                String(profile?.bank_upi_id || '').trim() || String(profile?.bank_account_number || '').trim()
              );
              if (!hasBank) {
                Alert.alert(
                  'Bank details required',
                  'Add a UPI ID or bank account in Account before running payout simulations.',
                  [
                    { text: 'Not now', style: 'cancel' },
                    { text: 'Open Account', onPress: () => navigation.navigate('Account') },
                  ]
                );
                return;
              }
              logButtonTap('simulate_disruption_open');
              weeklyBeforeDemoRef.current = protectedThisWeek;
              demoStepStatusRef.current = null;
              setSheetPhase('scenarios');
              setDisruptionSheetVisible(true);
            }}
          >
            <Text style={styles.simulateCtaText}>Simulate disruption - watch a live claim end-to-end</Text>
          </TouchableOpacity>
          <Text style={[styles.simulateCtaHint, { color: colors.muted }]}>
            Full fraud + payout pipeline - best for judge demos. Use Coverage & Claims tabs for more.
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
            {"No disruptions yet - you're all set ✅"}
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
              <TouchableOpacity
                key={String(p.id || p.claim_id || when + disruption)}
                style={[styles.payoutRow, { borderColor: colors.border }]}
                activeOpacity={0.86}
                onPress={() => setSelectedPayment(p)}
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
              </TouchableOpacity>
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
                <Text style={[styles.cardSub, { color: colors.muted, marginBottom: 10, fontSize: 12 }]}>
                  Red dot = disruption payout eligible
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
                      if (!s.payoutEligible) {
                        Alert.alert('No active disruption', 'Zone is calm and safe. No payout run is needed right now.');
                        return;
                      }
                      logButtonTap('trigger_simulation_button');
                      weeklyBeforeDemoRef.current = protectedThisWeek;
                      demoStepStatusRef.current = null;
                      simMutation.mutate(s.value);
                    }}
                    disabled={simMutation.isPending}
                  >
                    <Text style={styles.scenarioEmoji}>{s.emoji}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.scenarioTitle, { color: colors.text }]}>
                        {s.label} {s.payoutEligible ? '🔴' : '🟢'}
                      </Text>
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
                {lastClaimUpdate?.message ? (
                  <View style={[styles.liveClaimHighlight, { marginBottom: 8 }]}>
                    <Text style={[styles.liveClaimHighlightText, { color: colors.text }]}>
                      {stripDailyLimitPrefix(lastClaimUpdate.message)}
                    </Text>
                  </View>
                ) : (
                  <Text style={[styles.cardSub, { color: colors.muted, marginBottom: 4 }]} numberOfLines={2}>
                    Starting…
                  </Text>
                )}
                <SimulationClaimProgress update={lastClaimUpdate} colors={colors} primary={colors.primary} />
                {simAiQuery.data?.ai_explanation ? (
                  <Text style={[styles.cardSub, { color: colors.text, marginTop: 12, lineHeight: 18 }]}>
                    🤖 SafeNet AI: {String(simAiQuery.data.ai_explanation).trim()}
                  </Text>
                ) : null}
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
        visible={langSheetVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setLangSheetVisible(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setLangSheetVisible(false)}>
          <Pressable style={[styles.modalSheet, { backgroundColor: colors.card, borderColor: colors.border }]} onPress={(e) => e.stopPropagation()}>
            <Text style={[styles.cardTitle, { color: colors.text, marginBottom: 10 }]}>{t('dashboard.language_picker')}</Text>
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
                    styles.scenarioCard,
                    { borderColor: active ? colors.primary : colors.border, borderWidth: active ? 2 : 1 },
                  ]}
                  onPress={() => {
                    void setLanguage(lang.code);
                    setLangSheetVisible(false);
                  }}
                >
                  <Text style={[styles.scenarioTitle, { color: colors.text }]}>{lang.label}</Text>
                  {active ? <Text style={{ color: colors.primary, fontWeight: '800' }}>✓</Text> : null}
                </TouchableOpacity>
              );
            })}
            <TouchableOpacity style={{ marginTop: 14, alignItems: 'center' }} onPress={() => setLangSheetVisible(false)}>
              <Text style={[styles.linkText, { color: colors.primary }]}>{t('common.close')}</Text>
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
            <Text style={styles.celebrationSub}>sent to {payoutCelebration?.recipient || 'your account'}</Text>
            <View style={styles.celebrationCard}>
              <Text style={styles.celebrationExplain}>
                Claim approved → Crediting payout → Amount sent successfully.
              </Text>
              {payoutCelebration?.payoutRef ? (
                <Text style={styles.celebrationShieldLine}>Payout ref: {String(payoutCelebration.payoutRef)}</Text>
              ) : null}
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

      <AppModal
        visible={Boolean(selectedPayment)}
        transparent
        animationType="slide"
        onRequestClose={() => setSelectedPayment(null)}
      >
        <Pressable style={styles.celebrationBackdrop} onPress={() => setSelectedPayment(null)}>
          <Pressable style={styles.paymentDetailSheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.paymentDetailTitle}>Payment details</Text>
            <Text style={styles.paymentDetailLine}>Transaction ID: {selectedPayment?.transaction_id || '—'}</Text>
            <Text style={styles.paymentDetailLine}>Claim ID: {selectedPayment?.claim_id ?? '—'}</Text>
            <Text style={styles.paymentDetailLine}>Amount: ₹{Math.round(Number(selectedPayment?.amount || selectedPayment?.payout || selectedPayment?.payout_amount || 0))}</Text>
            <Text style={styles.paymentDetailLine}>Status: {String(selectedPayment?.status || 'credited').toUpperCase()}</Text>
            <Text style={styles.paymentDetailLine}>Timestamp: {formatPayoutWhen(selectedPayment)}</Text>
            <Text style={styles.paymentDetailReason}>Disruption verified and payout credited.</Text>
            <TouchableOpacity style={styles.paymentDetailBtn} onPress={() => setSelectedPayment(null)}>
              <Text style={styles.paymentDetailBtnText}>Close</Text>
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
                pointerEvents: 'box-none',
              },
            ]}
          >
            <Text style={styles.dnaTooltipText}>
              {dnaTooltip.dayName} {dnaTooltip.hour} · typical ~₹{dnaTooltip.amount}/hr
            </Text>
          </View>
        </>
      ) : null}
    </View>
    {!disruptionSheetVisible && !simMutation.isPending ? (
      <AssistantWidget onPress={() => setAssistantOpen(true)} />
    ) : null}
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
  toastCloseBtn: {
    position: 'absolute',
    right: 10,
    top: 8,
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  toastCloseText: { color: '#fff', fontWeight: '900', fontSize: 12 },
  bankPromptCard: {
    backgroundColor: '#fff7ed',
    borderColor: '#fdba74',
    borderWidth: 1.5,
    borderRadius: 14,
    padding: 12,
    marginBottom: 12,
  },
  bankPromptClose: {
    position: 'absolute',
    right: 8,
    top: 8,
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bankPromptCloseText: { color: '#9a3412', fontWeight: '900' },
  bankPromptTitle: { color: '#9a3412', fontSize: 13, fontWeight: '800', marginRight: 22 },
  bankPromptBtn: {
    marginTop: 10,
    alignSelf: 'flex-start',
    backgroundColor: '#ea580c',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  bankPromptBtnText: { color: '#fff', fontWeight: '900', fontSize: 12 },
  coveragePromptCard: { backgroundColor: '#eff6ff', borderColor: '#60a5fa' },
  coveragePromptTitle: { color: '#1e3a8a' },
  coveragePromptBtn: { backgroundColor: '#1d4ed8' },

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
  headerLangBtn: {
    width: 40,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
  },
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
  breakdownRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 11,
    borderBottomWidth: 1,
    backgroundColor: 'rgba(255,255,255,0.02)',
    borderRadius: 8,
    paddingHorizontal: 8,
    marginBottom: 4,
  },
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
  simulateCtaHighlight: {
    borderWidth: 2,
    borderColor: '#fbbf24',
    shadowColor: '#fbbf24',
    shadowOpacity: 0.5,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 0 },
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

  liveClaimHighlight: {
    marginTop: 6,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: 'rgba(37, 99, 235, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(37, 99, 235, 0.35)',
  },
  liveClaimHighlightText: {
    fontSize: 14,
    lineHeight: 21,
    fontWeight: '700',
  },
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
  paymentDetailSheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    width: '100%',
    alignSelf: 'flex-end',
  },
  paymentDetailTitle: { fontSize: 16, fontWeight: '900', color: '#0f172a', marginBottom: 8 },
  paymentDetailLine: { fontSize: 13, color: '#1e293b', marginBottom: 6, fontWeight: '700' },
  paymentDetailReason: { marginTop: 6, fontSize: 12, color: '#475569', lineHeight: 18 },
  paymentDetailBtn: {
    marginTop: 12,
    backgroundColor: '#1a73e8',
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: 'center',
  },
  paymentDetailBtnText: { color: '#fff', fontWeight: '900', fontSize: 13 },
});
