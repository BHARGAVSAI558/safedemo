import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  TouchableOpacity,
  Alert,
  TextInput,
  Platform,
} from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Buffer } from 'buffer';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { claims, workers as workersApi } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { useClaims } from '../contexts/ClaimContext';
import { useLocalization } from '../contexts/LocalizationContext';
import { formatIstDateTime } from '../utils/istFormat';
import AppModal from '../components/AppModal';
import { useWorkerProfile } from '../hooks/useWorkerProfile';

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
  if (s.includes('PROCESSING_PAYOUT')) return 3;
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

function stepMessage(step, status, payoutRemainSec) {
  const s = String(status || '').toUpperCase();
  if (s.includes('PROCESSING_PAYOUT') && payoutRemainSec != null && payoutRemainSec >= 0) {
    return `Payout in ${payoutRemainSec} seconds…`;
  }
  if (s.includes('BLOCKED') || s.includes('REJECT')) return 'Not eligible — disruption signal insufficient';
  if (s === 'CREDITED' || s.includes('PAYOUT') || s.includes('APPROVED')) return 'Payout credited to your wallet ✔';
  if (s.includes('REVALIDAT') || s.includes('REVIEW')) return 'Under verification — manual review in progress';
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

function arrayBufferToBase64(buffer) {
  try {
    return Buffer.from(buffer).toString('base64');
  } catch (_) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i += 1) binary += String.fromCharCode(bytes[i]);
    if (typeof btoa === 'function') return btoa(binary);
    return '';
  }
}

export default function ClaimsScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const { t } = useLocalization();
  const { userId } = useAuth();
  const { lastClaimUpdate, activeClaims } = useClaims();
  const [elapsed, setElapsed] = useState(0);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [selectedTx, setSelectedTx] = useState(null);
  const [disputeRow, setDisputeRow] = useState(null);
  const [disputeText, setDisputeText] = useState('');
  const [disputeBusy, setDisputeBusy] = useState(false);
  const { data: workerProfile } = useWorkerProfile();

  const [payoutRemainSec, setPayoutRemainSec] = useState(null);

  const summariesQuery = useQuery({
    queryKey: ['weeklySummaries', userId],
    queryFn: () => workersApi.listWeeklySummaries(),
    enabled: Boolean(userId),
    staleTime: 60_000,
  });

  const historyQuery = useQuery({
    queryKey: ['claimsHistory', userId],
    queryFn: () => (userId ? claims.getWorkerHistory(userId) : claims.getHistory()),
    staleTime: 1000 * 20,
    refetchInterval: 10000,
    refetchOnMount: 'always',
    refetchOnReconnect: true,
    enabled: Boolean(userId),
  });

  const activeDisruptionsQuery = useQuery({
    queryKey: ['activeDisruptions'],
    queryFn: () => claims.getActive(),
    staleTime: 1000 * 30,
    refetchInterval: 30000,
  });

  const list = useMemo(() => {
    const raw = historyQuery.data;
    const rows = Array.isArray(raw) ? raw : [];
    const filtered = rows.filter((r) => {
      const reason = String(r?.reason || '').toLowerCase();
      if (!reason) return true;
      return !(
        reason.includes('daily payout limit reached') ||
        reason.includes('already simulated and paid today')
      );
    });
    const seen = new Set();
    const out = [];
    for (const r of filtered) {
      const id = String(r?.id ?? r?.claim_id ?? '');
      const key = id || `${r?.created_at}-${r?.disruption_type}-${r?.status}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
    return out;
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
  useEffect(() => {
    const st = String(lastClaimUpdate?.status || '').toUpperCase();
    if (!st.includes('PROCESSING_PAYOUT')) {
      setPayoutRemainSec(null);
      return;
    }
    const total = Number(lastClaimUpdate?.payout_countdown_seconds ?? 0);
    const epoch = Number(lastClaimUpdate?.event_epoch_ms ?? 0);
    const tick = () => {
      if (!total || !epoch) {
        setPayoutRemainSec(total || null);
        return;
      }
      const elapsed = Math.floor((Date.now() - epoch) / 1000);
      setPayoutRemainSec(Math.max(0, total - elapsed));
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [
    lastClaimUpdate?.status,
    lastClaimUpdate?.payout_countdown_seconds,
    lastClaimUpdate?.event_epoch_ms,
  ]);

  const msg = useMemo(
    () => stepMessage(currentStep, lastClaimUpdate?.status, payoutRemainSec),
    [currentStep, lastClaimUpdate?.status, payoutRemainSec]
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
      <Text style={styles.screenTitle}>{t('claims.title')}</Text>
      <Text style={styles.screenSub}>{t('claims.screen_sub')}</Text>

      {/* Live disruptions from /claims/active */}
      {Array.isArray(activeDisruptionsQuery.data) && activeDisruptionsQuery.data.length > 0 ? (
        activeDisruptionsQuery.data.map((d) => (
          <View key={String(d.disruption_event_id)} style={styles.disruptionBanner}>
            <Text style={styles.disruptionBannerIcon}>{disruptionIcon(d.disruption_type)}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.disruptionBannerTitle}>
                {d.disruption_type?.replace(/_/g, ' ')} detected — {d.confidence} confidence
              </Text>
              {d.claim_status ? (
                <Text style={styles.disruptionBannerSub}>
                  Claim status: {d.claim_status}{d.claim_payout > 0 ? ` · ₹${Math.round(d.claim_payout)} queued` : ''}
                </Text>
              ) : (
                <Text style={styles.disruptionBannerSub}>Your claim is being processed</Text>
              )}
            </View>
          </View>
        ))
      ) : null}

      <Text style={styles.sectionLabel}>{t('claims.active')}</Text>
      <View style={styles.card}>
        {!inflight ? (
          <>
            <Text style={styles.emptyActive}>{t('claims.no_active_claim')}</Text>
            {Array.isArray(activeDisruptionsQuery.data) && activeDisruptionsQuery.data.length === 0 ? (
              <Text style={[styles.emptyActive, { marginTop: 10, fontSize: 13 }]}>{t('claims.zone_monitoring')}</Text>
            ) : null}
          </>
        ) : (
          <>
            {elapsed > 0 ? (
              <View style={styles.activeTimerRow}>
                <Text style={styles.activeTimerLabel}>{t('claims.active')}</Text>
                <Text style={styles.activeTimerValue}>{elapsed}s</Text>
              </View>
            ) : null}
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
            </View>
          </>
        )}
      </View>

      <View style={styles.sectionHead}>
        <Text style={styles.sectionLabel}>{t('claims.past_summaries')}</Text>
        <View style={styles.hintChip}>
          <Text style={styles.hintChipText} numberOfLines={2}>
            {summariesQuery.isLoading ? '…' : t('claims.summaries_hint')}
          </Text>
        </View>
      </View>
      {Array.isArray(summariesQuery.data) && summariesQuery.data.length > 0 ? (
        summariesQuery.data.slice(0, 6).map((s) => (
          <View key={String(s.id)} style={styles.card}>
            <Text style={styles.histTitle}>{s.title || 'Week in review'}</Text>
            <Text style={styles.reasonLine}>{s.body || '—'}</Text>
            <Text style={styles.histWhen}>
              Week of {s.week_start ? formatIstDateTime(s.week_start) : '—'} · Risk next week:{' '}
              {s.zone_risk_next_week || '—'}
            </Text>
          </View>
        ))
      ) : (
        <View style={styles.card}>
          <Text style={styles.emptyHist}>
            {summariesQuery.isLoading ? 'Loading summaries…' : t('claims.summaries_empty')}
          </Text>
        </View>
      )}

      <View style={[styles.sectionHead, { marginTop: 4 }]}>
        <Text style={styles.sectionLabel}>{t('claims.history')}</Text>
        <TouchableOpacity
          style={[
            styles.bankMiniBtn,
            !(workerProfile?.bank_upi_id || workerProfile?.bank_account_number) && { opacity: 0.5 },
          ]}
          disabled={!(workerProfile?.bank_upi_id || workerProfile?.bank_account_number)}
          onPress={() => setSelectedTx({ _viewBank: true })}
        >
          <Text style={styles.bankMiniBtnText}>View bank details</Text>
        </TouchableOpacity>
      </View>

      {historyQuery.isLoading && list.length === 0 ? (
        <View style={styles.loadingBox}>
          <ActivityIndicator color={BRAND} />
          <Text style={styles.loadingText}>{t('common.loading')}</Text>
        </View>
      ) : historyQuery.isError && list.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.errorText}>Could not load history. Pull to refresh.</Text>
        </View>
      ) : list.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.emptyHist}>{t('claims.history_empty_hint')}</Text>
        </View>
      ) : (
        list.map((row) => {
          const st = String(row.status || '').toUpperCase();
          const amt = Number(row.payout_amount ?? 0);
          const isCredited = Number.isFinite(amt) && amt > 0;
          const isApp = st === 'APPROVED' || st === 'CREDITED' || isCredited;
          const isBlock = st === 'BLOCKED';
          const isNoPayout = st === 'NO_PAYOUT';
          const isRej =
            (st === 'REJECTED' || (st.includes('REJECT') && !isNoPayout)) && !isBlock;
          const isFlagged = st.includes('FLAG');
          const showAmt = isApp ? amt : 0;
          let chipLabel = st || 'PENDING';
          if (isCredited && st !== 'BLOCKED') chipLabel = 'CREDITED';
          else if (isNoPayout) chipLabel = 'NO PAYOUT';
          else if (isBlock) chipLabel = 'BLOCKED';
          return (
            <View key={String(row.id)} style={styles.card}>
              <TouchableOpacity activeOpacity={0.88} onPress={() => setSelectedTx(row)}>
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
                      isFlagged && styles.chipYellow,
                      isNoPayout && styles.chipInfo,
                      (isRej || (!isApp && !isBlock && !isFlagged && !isNoPayout)) && styles.chipAmber,
                    ]}
                  >
                    <Text
                      style={[
                        styles.statusChipText,
                        isApp && styles.chipTextGreen,
                        isBlock && styles.chipTextRed,
                        isFlagged && styles.chipTextYellow,
                        isNoPayout && styles.chipTextInfo,
                      ]}
                    >
                      {chipLabel}
                    </Text>
                  </View>
                </View>
                <Text style={styles.histAmount}>
                  {isApp ? `₹${Math.round(showAmt)}` : '₹0'}
                </Text>
                {isApp ? (
                  <View style={styles.breakdownBox}>
                    <Text style={styles.breakdownLabel}>{t('claims.payout_basis_title')}</Text>
                    <Text style={styles.breakdownFormula}>{t('claims.payout_basis')}</Text>
                  </View>
                ) : null}
                {isApp ? (
                  <Text style={styles.histHint}>{t('claims.fingerprint_hint')}</Text>
                ) : null}
                {isBlock ? (
                  <Text style={styles.fraudNote}>Fraud check failed — GPS anomaly detected</Text>
                ) : null}
                {row.reason && !isBlock ? (
                  <Text style={styles.reasonLine}>{row.reason}</Text>
                ) : null}
                {row.ai_explanation ? (
                  <Text style={styles.aiCard}>
                    🤖 SafeNet AI: {row.ai_explanation}
                  </Text>
                ) : null}
                {row.dispute_verdict?.reasoning ? (
                  <Text style={styles.disputeVerdict}>
                    Dispute review: {row.dispute_verdict.verdict} — {row.dispute_verdict.reasoning}
                  </Text>
                ) : null}
              </TouchableOpacity>
              {!isCredited && (isRej || isNoPayout || isBlock) ? (
                <TouchableOpacity
                  style={styles.disputeBtn}
                  onPress={() => {
                    setDisputeText('');
                    setDisputeRow(row);
                  }}
                >
                  <Text style={styles.disputeBtnText}>Dispute this decision</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          );
        })
      )}
      <AppModal visible={Boolean(selectedTx)} transparent animationType="slide" onRequestClose={() => setSelectedTx(null)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>Payment details</Text>
            {selectedTx?._viewBank ? (
              <>
                <Text style={styles.modalLine}>UPI: {workerProfile?.bank_upi_id || 'Not added'}</Text>
                <Text style={styles.modalLine}>
                  Account: {workerProfile?.bank_account_number ? `••••${String(workerProfile.bank_account_number).slice(-4)}` : 'Not added'}
                </Text>
                <Text style={styles.modalLine}>IFSC: {workerProfile?.bank_ifsc || 'Not added'}</Text>
                <Text style={styles.modalLine}>Name: {workerProfile?.bank_account_name || 'Not added'}</Text>
                <TouchableOpacity style={styles.modalBtn} onPress={() => {
                  setSelectedTx(null);
                  navigation?.navigate?.('Account');
                }}>
                  <Text style={styles.modalBtnText}>Update details</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.modalBtn} onPress={() => {
                  setSelectedTx(null);
                }}>
                  <Text style={styles.modalBtnText}>Close</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <Text style={styles.modalLine}>Transaction ID: {selectedTx?.transaction_id || '—'}</Text>
                <Text style={styles.modalLine}>Claim ID: {selectedTx?.id ?? '—'}</Text>
                <Text style={styles.modalLine}>Status: {String(selectedTx?.status || '—')}</Text>
                <Text style={styles.modalLine}>Amount: ₹{Math.round(Number(selectedTx?.payout_amount || 0))}</Text>
                <Text style={styles.modalLine}>Timestamp: {selectedTx?.created_at ? formatIstDateTime(selectedTx?.created_at) : '—'}</Text>
                <Text style={styles.modalLine}>
                  Credited to: {workerProfile?.bank_upi_id || workerProfile?.bank_account_number || 'Bank details pending'}
                </Text>
                <Text style={styles.modalReason}>{selectedTx?.reason || '—'}</Text>
                {(() => {
                  const st = String(selectedTx?.status || '').toUpperCase();
                  const amt = Number(selectedTx?.payout_amount ?? 0);
                  return (
                    amt > 0 &&
                    (st === 'CREDITED' || st === 'APPROVED' || st.includes('CREDIT'))
                  );
                })() ? (
                  <TouchableOpacity
                    style={[styles.modalBtn, { backgroundColor: '#0f766e', marginTop: 8 }]}
                    onPress={async () => {
                      const cid = selectedTx?.id ?? selectedTx?.claim_id;
                      if (!cid) return;
                      try {
                        const res = await claims.downloadReceipt(cid);
                        const data = res?.data;
                        if (!data) throw new Error('empty');
                        if (Platform.OS === 'web') {
                          const blob = new Blob([data], { type: 'application/pdf' });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = `safenet-receipt-${cid}.pdf`;
                          document.body.appendChild(a);
                          a.click();
                          a.remove();
                          URL.revokeObjectURL(url);
                          return;
                        }
                        const b64 = arrayBufferToBase64(data);
                        const name = `safenet-receipt-${cid}.pdf`;
                        const path = `${FileSystem.cacheDirectory || ''}${name}`;
                        await FileSystem.writeAsStringAsync(path, b64, {
                          encoding: FileSystem.EncodingType.Base64,
                        });
                        if (await Sharing.isAvailableAsync()) {
                          await Sharing.shareAsync(path, {
                            mimeType: 'application/pdf',
                            dialogTitle: 'Income loss receipt',
                            UTI: 'com.adobe.pdf',
                          });
                        } else {
                          Alert.alert('Receipt saved', path);
                        }
                      } catch (e) {
                        Alert.alert('Download failed', 'Could not fetch PDF. Try again when online.');
                      }
                    }}
                  >
                    <Text style={styles.modalBtnText}>Download receipt (PDF)</Text>
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity style={styles.modalBtn} onPress={() => setSelectedTx(null)}>
                  <Text style={styles.modalBtnText}>Close</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </AppModal>
      <AppModal
        visible={Boolean(disputeRow)}
        transparent
        animationType="slide"
        onRequestClose={() => {
          if (!disputeBusy) setDisputeRow(null);
        }}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>Dispute claim decision</Text>
            <Text style={styles.modalLine}>
              Explain why you believe this decision should be reviewed (max 8000 characters).
            </Text>
            <TextInput
              style={styles.disputeInput}
              multiline
              numberOfLines={5}
              value={disputeText}
              onChangeText={setDisputeText}
              editable={!disputeBusy}
              placeholder="Your message…"
              placeholderTextColor="#94a3b8"
            />
            <TouchableOpacity
              style={[styles.modalBtn, disputeBusy && { opacity: 0.6 }]}
              disabled={disputeBusy || !disputeText.trim()}
              onPress={async () => {
                const cid = disputeRow?.id;
                if (!cid || !disputeText.trim()) return;
                setDisputeBusy(true);
                try {
                  const verdict = await claims.submitDispute(cid, disputeText.trim());
                  await historyQuery.refetch();
                  setDisputeRow(null);
                  setDisputeText('');
                  Alert.alert(
                    'Dispute submitted',
                    verdict?.reasoning
                      ? `${verdict.verdict}: ${verdict.reasoning}`
                      : 'Your dispute was recorded.',
                  );
                } catch (e) {
                  Alert.alert('Could not submit', 'Try again when online.');
                } finally {
                  setDisputeBusy(false);
                }
              }}
            >
              <Text style={styles.modalBtnText}>{disputeBusy ? 'Submitting…' : 'Submit dispute'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modalBtn, { backgroundColor: '#64748b' }]}
              disabled={disputeBusy}
              onPress={() => setDisputeRow(null)}
            >
              <Text style={styles.modalBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </AppModal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f0f4ff' },
  disruptionBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: 'rgba(26,115,232,0.2)',
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  disruptionBannerIcon: { fontSize: 26, lineHeight: 30 },
  disruptionBannerTitle: { fontSize: 14, fontWeight: '800', color: '#0f172a' },
  disruptionBannerSub: { fontSize: 12, color: '#64748b', marginTop: 4, fontWeight: '600' },
  content: { padding: 20 },
  screenTitle: { fontSize: 26, fontWeight: '900', color: '#0f172a' },
  screenSub: { fontSize: 14, color: '#64748b', marginTop: 6, marginBottom: 20 },
  sectionLabel: { fontSize: 13, fontWeight: '800', color: '#475569', marginBottom: 10, textTransform: 'uppercase' },
  sectionHead: {
    marginTop: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 10,
  },
  hintChip: {
    maxWidth: '52%',
    backgroundColor: '#f1f5f9',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  hintChipText: { fontSize: 11, fontWeight: '700', color: '#64748b', lineHeight: 15 },
  activeTimerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  activeTimerLabel: { fontSize: 12, fontWeight: '800', color: '#475569', textTransform: 'uppercase' },
  activeTimerValue: { fontSize: 14, fontWeight: '900', color: BRAND },
  bankMiniBtn: { borderWidth: 1, borderColor: '#93c5fd', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: '#eff6ff' },
  bankMiniBtnText: { color: '#1d4ed8', fontSize: 11, fontWeight: '800' },
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
  chipYellow: { backgroundColor: '#fef08a' },
  chipAmber: { backgroundColor: '#fef3c7' },
  chipInfo: { backgroundColor: '#dbeafe', borderWidth: 1, borderColor: '#93c5fd' },
  chipTextInfo: { color: '#1e3a8a' },
  statusChipText: { fontSize: 10, fontWeight: '900', color: '#0f172a' },
  chipTextGreen: { color: '#15803d' },
  chipTextRed: { color: '#b91c1c' },
  chipTextYellow: { color: '#854d0e' },
  histAmount: { fontSize: 22, fontWeight: '900', color: '#0f172a', marginTop: 12 },
  breakdownBox: {
    marginTop: 10,
    backgroundColor: 'rgba(26,115,232,0.08)',
    borderRadius: 10,
    padding: 10,
    borderLeftWidth: 3,
    borderLeftColor: '#1a73e8',
  },
  breakdownLabel: { fontSize: 11, fontWeight: '700', color: '#334155', marginBottom: 4 },
  breakdownFormula: { fontSize: 12, fontWeight: '700', color: '#0f172a', lineHeight: 18 },
  histHint: { fontSize: 12, color: '#64748b', marginTop: 6, lineHeight: 18 },
  fraudNote: { fontSize: 12, color: '#b91c1c', fontWeight: '700', marginTop: 10 },
  reasonLine: { fontSize: 12, color: '#475569', marginTop: 8, lineHeight: 18 },
  aiCard: {
    marginTop: 10,
    padding: 10,
    borderRadius: 10,
    backgroundColor: 'rgba(26,115,232,0.08)',
    borderLeftWidth: 3,
    borderLeftColor: '#1a73e8',
    fontSize: 12,
    color: '#0f172a',
    lineHeight: 18,
    fontWeight: '600',
  },
  disputeVerdict: { fontSize: 11, color: '#334155', marginTop: 8, lineHeight: 16 },
  disputeBtn: {
    marginTop: 10,
    alignSelf: 'flex-start',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    backgroundColor: '#f8fafc',
  },
  disputeBtnText: { fontSize: 12, fontWeight: '800', color: '#334155' },
  disputeInput: {
    minHeight: 100,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    padding: 10,
    marginTop: 8,
    marginBottom: 4,
    fontSize: 14,
    color: '#0f172a',
    textAlignVertical: 'top',
  },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  modalSheet: { backgroundColor: '#fff', borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16 },
  modalTitle: { fontSize: 16, fontWeight: '900', color: '#0f172a', marginBottom: 8 },
  modalLine: { fontSize: 13, color: '#1e293b', marginBottom: 6, fontWeight: '700' },
  modalReason: { fontSize: 12, color: '#475569', marginTop: 6, lineHeight: 18 },
  modalBtn: { marginTop: 12, backgroundColor: '#1a73e8', paddingVertical: 11, borderRadius: 10, alignItems: 'center' },
  modalBtnText: { color: '#fff', fontSize: 13, fontWeight: '900' },
});
