import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { claims } from '../services/api';
import { useClaims } from '../contexts/ClaimContext';
import { formatIstDateTime } from '../utils/istFormat';

const BRAND = '#1a73e8';
const STEPS = ['Detected', 'Verifying', 'Fraud Check', 'Approved'];

const TERMINAL = new Set([
  'PAYOUT_DONE',
  'PAYOUT_CREDITED',
  'NO_PAYOUT',
  'DECISION_REJECTED',
  'CLAIM_REJECTED',
  'ERROR',
  'APPROVED',
  'BLOCKED',
]);

function statusToStep(status) {
  const s = String(status || '').toUpperCase();
  if (s.includes('INITIATED')) return 0;
  if (s.includes('VERIFYING') || s.includes('CONFIDENCE')) return 1;
  if (s.includes('BEHAVIORAL')) return 1;
  if (s.includes('FRAUD_CHECK') || (s.includes('FRAUD') && !s.includes('CHECK'))) return 2;
  if (s.includes('FRAUD') && s.includes('CHECK')) return 2;
  if (s.includes('DECISION')) return 3;
  if (s.includes('PAYOUT') || s.includes('CREDITED')) return 3;
  if (s.includes('APPROVED')) return 3;
  return 0;
}

function stepMessage(step, status) {
  const s = String(status || '').toUpperCase();
  if (s.includes('BLOCKED') || s.includes('REJECT')) return 'Claim could not be completed';
  if (step >= 3) return 'Payout processing — wallet credit incoming';
  if (step === 2) return 'Running fraud & behavior checks…';
  if (step === 1) return 'GPS integrity verified ✓';
  return 'Disruption detected in your zone';
}

function isInFlight(lastUpdate, activeList) {
  const st = String(lastUpdate?.status || '');
  if (st && TERMINAL.has(st)) return false;
  if (activeList?.length) return true;
  return Boolean(lastUpdate?.claim_id && lastUpdate?.status && !TERMINAL.has(st));
}

function disruptionIcon(label) {
  const t = String(label || '').toLowerCase();
  if (t.includes('rain')) return '🌧️';
  if (t.includes('heat')) return '🌡️';
  if (t.includes('aqi') || t.includes('air') || t.includes('spike')) return '🏭';
  if (t.includes('curfew')) return '🚫';
  return '⚠️';
}

export default function ClaimsScreen() {
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const { lastClaimUpdate, activeClaims } = useClaims();
  const [elapsed, setElapsed] = useState(0);
  const [manualRefreshing, setManualRefreshing] = useState(false);

  const historyQuery = useQuery({
    queryKey: ['claimsHistory'],
    queryFn: () => claims.getHistory(),
    staleTime: 1000 * 20,
    refetchInterval: 10000,
    refetchOnMount: 'always',
    refetchOnReconnect: true,
  });

  const list = useMemo(() => {
    const raw = historyQuery.data;
    return Array.isArray(raw) ? raw : [];
  }, [historyQuery.data]);

  const inflight = useMemo(
    () => isInFlight(lastClaimUpdate, activeClaims),
    [lastClaimUpdate, activeClaims]
  );

  const startedAt = useMemo(() => {
    const ts =
      lastClaimUpdate?.timestamp ||
      lastClaimUpdate?.created_at ||
      activeClaims?.[0]?.created_at;
    if (!ts) return null;
    const ms = Date.parse(ts);
    return Number.isFinite(ms) ? ms : null;
  }, [lastClaimUpdate, activeClaims]);

  useEffect(() => {
    if (!inflight || startedAt == null) {
      setElapsed(0);
      return;
    }
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [inflight, startedAt]);

  const currentStep = useMemo(
    () => statusToStep(lastClaimUpdate?.status),
    [lastClaimUpdate?.status]
  );
  const msg = useMemo(
    () => stepMessage(currentStep, lastClaimUpdate?.status),
    [currentStep, lastClaimUpdate?.status]
  );

  const onRefresh = useCallback(() => {
    setManualRefreshing(true);
    Promise.allSettled([
      historyQuery.refetch(),
      qc.invalidateQueries({ queryKey: ['payoutHistory'] }),
    ]).finally(() => setManualRefreshing(false));
  }, [historyQuery, qc]);

  useEffect(() => {
    const st = String(lastClaimUpdate?.status || '').toUpperCase();
    const isTerminal = ['APPROVED', 'PAYOUT_DONE', 'PAYOUT_CREDITED', 'CLAIM_REJECTED', 'DECISION_REJECTED', 'BLOCKED', 'REJECTED'].includes(st);
    if (!isTerminal) return;
    void historyQuery.refetch();
    const delayed = setTimeout(() => {
      void historyQuery.refetch();
    }, 2500);
    const payoutAmt = Number(lastClaimUpdate?.payout_amount ?? 0);
    const hasPayout = Number.isFinite(payoutAmt) && payoutAmt > 0;
    if (hasPayout) void qc.invalidateQueries({ queryKey: ['payoutHistory'] });
    return () => clearTimeout(delayed);
  }, [lastClaimUpdate?.claim_id, lastClaimUpdate?.status, lastClaimUpdate?.payout_amount, historyQuery, qc]);

  const refreshing = manualRefreshing;

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
      refreshControl={<RefreshControl refreshing={Boolean(refreshing)} onRefresh={onRefresh} />}
    >
      <Text style={styles.screenTitle}>Claims</Text>
      <Text style={styles.screenSub}>Live lifecycle and your full claim history</Text>

      <Text style={styles.sectionLabel}>Active claim</Text>
      <View style={styles.card}>
        {!inflight ? (
          <Text style={styles.emptyActive}>No active claims — system monitoring your zone</Text>
        ) : (
          <>
            <View style={styles.stepRow}>
              {STEPS.map((label, i) => {
                const done = i < currentStep;
                const active = i === currentStep;
                const pending = i > currentStep;
                return (
                  <View key={label} style={styles.stepItem}>
                    <View
                      style={[
                        styles.stepDot,
                        done && styles.stepDotDone,
                        active && styles.stepDotActive,
                        pending && styles.stepDotPending,
                      ]}
                    >
                      {done ? <Text style={styles.stepCheck}>✓</Text> : null}
                    </View>
                    <Text
                      style={[
                        styles.stepLabel,
                        active && styles.stepLabelActive,
                        done && styles.stepLabelDone,
                        pending && styles.stepLabelPending,
                      ]}
                      numberOfLines={2}
                    >
                      {label}
                    </Text>
                  </View>
                );
              })}
            </View>
            <View style={styles.msgBox}>
              <Text style={styles.msgText}>{msg}</Text>
              <Text style={styles.elapsedText}>{elapsed} seconds elapsed</Text>
            </View>
          </>
        )}
      </View>

      <View style={styles.sectionHead}>
        <Text style={styles.sectionLabel}>Claim history</Text>
      </View>

      {historyQuery.isLoading && list.length === 0 ? (
        <View style={styles.loadingBox}>
          <ActivityIndicator color={BRAND} />
          <Text style={styles.loadingText}>Loading history…</Text>
        </View>
      ) : historyQuery.isError && list.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.errorText}>Could not load history. Pull to refresh.</Text>
        </View>
      ) : list.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.emptyHist}>No past claims yet. Run a simulation from Home.</Text>
        </View>
      ) : (
        list.map((row) => {
          const st = String(row.status || '').toUpperCase();
          const amt = Number(row.payout_amount ?? 0);
          const isCredited = Number.isFinite(amt) && amt > 0;
          const isApp = st === 'APPROVED' || st === 'CREDITED' || isCredited;
          const isBlock = st === 'BLOCKED';
          const isRej = st === 'REJECTED';
          const showAmt = isApp ? amt : 0;
          const chipLabel = isCredited && st !== 'BLOCKED' ? 'CREDITED' : st || 'PENDING';
          return (
            <View key={String(row.id)} style={styles.card}>
              <View style={styles.histTop}>
                <Text style={styles.histIcon}>{disruptionIcon(row.disruption_type)}</Text>
                <View style={styles.histMain}>
                  <Text style={styles.histTitle}>{row.disruption_type || 'Disruption'}</Text>
                  <Text style={styles.histWhen}>{formatIstDateTime(row.created_at)}</Text>
                </View>
                <View
                  style={[
                    styles.statusChip,
                    isApp && styles.chipGreen,
                    isBlock && styles.chipRed,
                    (isRej || (!isApp && !isBlock)) && styles.chipAmber,
                  ]}
                >
                  <Text style={styles.statusChipText}>{chipLabel}</Text>
                </View>
              </View>
              <Text style={styles.histAmount}>
                {isApp ? `₹${Math.round(showAmt)}` : '₹0'}
              </Text>
              {isApp ? (
                <Text style={styles.histHint}>Paid based on your earning fingerprint for this time slot</Text>
              ) : null}
              {isBlock ? (
                <Text style={styles.fraudNote}>Fraud check failed — GPS anomaly detected</Text>
              ) : null}
              {row.reason && !isBlock ? (
                <Text style={styles.reasonLine}>{row.reason}</Text>
              ) : null}
            </View>
          );
        })
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f0f4ff' },
  content: { padding: 20 },
  screenTitle: { fontSize: 26, fontWeight: '900', color: '#0f172a' },
  screenSub: { fontSize: 14, color: '#64748b', marginTop: 6, marginBottom: 20 },
  sectionLabel: { fontSize: 13, fontWeight: '800', color: '#475569', marginBottom: 10, textTransform: 'uppercase' },
  sectionHead: { marginTop: 8, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.06)',
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  emptyActive: { fontSize: 15, color: '#64748b', fontWeight: '600', lineHeight: 22 },
  stepRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 18 },
  stepItem: { alignItems: 'center', width: '22%' },
  stepDot: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
  },
  stepDotPending: { borderColor: '#e2e8f0', backgroundColor: '#f8fafc' },
  stepDotActive: { borderColor: BRAND, backgroundColor: '#eff6ff' },
  stepDotDone: { borderColor: '#16a34a', backgroundColor: '#ecfdf5' },
  stepCheck: { color: '#16a34a', fontWeight: '900', fontSize: 14 },
  stepLabel: { fontSize: 10, fontWeight: '700', color: '#94a3b8', textAlign: 'center', marginTop: 6 },
  stepLabelActive: { color: BRAND },
  stepLabelDone: { color: '#15803d' },
  stepLabelPending: { color: '#94a3b8' },
  msgBox: {
    backgroundColor: '#f8fafc',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  msgText: { fontSize: 15, fontWeight: '700', color: '#0f172a' },
  elapsedText: { fontSize: 13, color: '#64748b', marginTop: 8, fontWeight: '600' },
  loadingBox: { padding: 28, alignItems: 'center' },
  loadingText: { marginTop: 10, color: '#64748b', fontSize: 13 },
  errorText: { color: '#b91c1c', fontWeight: '600' },
  emptyHist: { color: '#64748b', fontSize: 14 },
  histTop: { flexDirection: 'row', alignItems: 'flex-start' },
  histMain: { flex: 1, marginLeft: 10, marginRight: 8 },
  histIcon: { fontSize: 28, marginTop: 2 },
  histTitle: { fontSize: 16, fontWeight: '800', color: '#0f172a' },
  histWhen: { fontSize: 12, color: '#64748b', marginTop: 4 },
  statusChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
  },
  chipGreen: { backgroundColor: '#dcfce7' },
  chipRed: { backgroundColor: '#fee2e2' },
  chipAmber: { backgroundColor: '#fef3c7' },
  statusChipText: { fontSize: 10, fontWeight: '900', color: '#0f172a' },
  histAmount: { fontSize: 22, fontWeight: '900', color: '#0f172a', marginTop: 12 },
  histHint: { fontSize: 12, color: '#64748b', marginTop: 6, lineHeight: 18 },
  fraudNote: { fontSize: 12, color: '#b91c1c', fontWeight: '700', marginTop: 10 },
  reasonLine: { fontSize: 12, color: '#475569', marginTop: 8, lineHeight: 18 },
});
