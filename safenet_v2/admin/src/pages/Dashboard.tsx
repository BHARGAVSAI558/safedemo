import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import api, { BASE_URL } from '../api';
import { adminUi } from '../theme/adminUi';
import { useClaimsFeedStore, type AdminClaimUpdate } from '../stores/claimsFeed';
import { useFraudQueueStore, type AdminFraudAlert } from '../stores/fraudQueue';
import { usePoolHealthStore } from '../stores/poolHealth';

type AdminKpiResponse = {
  active_workers: number;
  claims_today: number;
  approval_rate_pct: number;
  fraud_blocked: number;
  pool_utilization_pct: number;
  pool_risk_level: string;
  loss_ratio_actual_pct: number;
  loss_ratio_target_low: number;
  loss_ratio_target_high: number;
  pooled_total_amount?: number;
  paid_total_amount?: number;
};
type AdminStatsResponse = {
  active_workers_this_week: number;
  claims_today: number;
  fraud_blocked_today: number;
  pool_utilization_pct: number;
  total_premiums_collected_this_week: number;
};
type HealthResponse = {
  storage?: {
    driver?: string;
    persistent?: boolean;
  };
};

const EMPTY_KPIS: AdminKpiResponse = {
  active_workers: 0,
  claims_today: 0,
  approval_rate_pct: 0,
  fraud_blocked: 0,
  pool_utilization_pct: 0,
  pool_risk_level: '—',
  loss_ratio_actual_pct: 0,
  loss_ratio_target_low: 60,
  loss_ratio_target_high: 75,
  pooled_total_amount: 0,
  paid_total_amount: 0,
};

type ClaimDrawerState = {
  open: boolean;
  selected: AdminClaimUpdate | null;
};

function statusToChip(status: string) {
  const norm = status.toLowerCase();
  if (norm.includes('approved')) return { bg: '#dcfce7', fg: '#166534', label: 'Approved' };
  if (norm.includes('fraud')) return { bg: '#fee2e2', fg: '#991b1b', label: 'Fraud' };
  if (norm.includes('flagged')) return { bg: '#fef3c7', fg: '#854d0e', label: 'Flagged' };
  if (norm.includes('rejected')) return { bg: '#fef3c7', fg: '#854d0e', label: 'Rejected' };
  if (norm.includes('processing')) return { bg: '#dbeafe', fg: '#1d4ed8', label: 'Processing' };
  return { bg: '#e5e7eb', fg: '#374151', label: status || '—' };
}

function formatUpdated(ts?: number | null) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function KpiCard({
  title,
  value,
  delta,
}: {
  title: string;
  value: string;
  delta?: { label: string; direction: 'up' | 'down' | 'flat' };
}) {
  const deltaColor =
    delta?.direction === 'up' ? '#16a34a' : delta?.direction === 'down' ? '#dc2626' : '#6b7280';
  return (
    <div style={{ ...adminUi.kpiCard }}>
      <div style={styles.kpiTitle}>{title}</div>
      <div style={styles.kpiValue}>{value}</div>
      {delta ? (
        <div style={{ ...styles.kpiDelta, color: deltaColor }}>
          {delta.direction === 'up' ? '▲' : delta.direction === 'down' ? '▼' : '•'} {delta.label}
        </div>
      ) : (
        <div style={styles.kpiDeltaPlaceholder} />
      )}
    </div>
  );
}

export default function Dashboard() {
  const wsClaims = useClaimsFeedStore((s) => s.items);
  const fraudItems = useFraudQueueStore((s) => s.items);
  const poolHealthByZone = usePoolHealthStore((s) => s.latestByZone);

  const [localDrawer, setLocalDrawer] = useState<ClaimDrawerState>({ open: false, selected: null });
  const [feedUpdatedAt, setFeedUpdatedAt] = useState<number | null>(null);
  const [flashRowId, setFlashRowId] = useState<string | null>(null);
  const [fraudToast, setFraudToast] = useState<AdminFraudAlert | null>(null);
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 768);
  const prevWsTopRef = useRef<string | undefined>(undefined);
  const lastFraudClusterRef = useRef<string | null>(null);

  useEffect(() => {
    const topId = wsClaims[0] ? String(wsClaims[0].claim_id) : undefined;
    if (prevWsTopRef.current === undefined) {
      prevWsTopRef.current = topId;
      return;
    }
    if (topId && topId !== prevWsTopRef.current) {
      setFlashRowId(topId);
      const t = window.setTimeout(() => setFlashRowId(null), 400);
      prevWsTopRef.current = topId;
      return () => window.clearTimeout(t);
    }
  }, [wsClaims]);

  useEffect(() => {
    if (!fraudItems.length) return;
    const latest = fraudItems[0];
    if (lastFraudClusterRef.current === latest.cluster_id) return;
    lastFraudClusterRef.current = latest.cluster_id;
    setFraudToast(latest);
    const t = window.setTimeout(() => setFraudToast(null), 7000);
    return () => window.clearTimeout(t);
  }, [fraudItems]);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const kpiQuery = useQuery({
    queryKey: ['admin', 'kpis'],
    queryFn: async (): Promise<AdminKpiResponse> => {
      try {
        const [kpiRes, statsRes] = await Promise.allSettled([api.get('/admin/kpis'), api.get('/admin/stats')]);
        const data = (kpiRes.status === 'fulfilled' ? kpiRes.value.data : {}) as AdminKpiResponse;
        const stats = (statsRes.status === 'fulfilled' ? statsRes.value.data : {}) as Partial<AdminStatsResponse>;
        return {
          active_workers: Number(stats?.active_workers_this_week ?? data?.active_workers ?? 0),
          claims_today: Number(stats?.claims_today ?? data?.claims_today ?? 0),
          approval_rate_pct: Number(data?.approval_rate_pct ?? 0),
          fraud_blocked: Number(stats?.fraud_blocked_today ?? data?.fraud_blocked ?? 0),
          pool_utilization_pct: Number(stats?.pool_utilization_pct ?? data?.pool_utilization_pct ?? 0),
          pool_risk_level: String(data?.pool_risk_level ?? '—'),
          loss_ratio_actual_pct: Number(data?.loss_ratio_actual_pct ?? 0),
          loss_ratio_target_low: Number(data?.loss_ratio_target_low ?? 60),
          loss_ratio_target_high: Number(data?.loss_ratio_target_high ?? 75),
          pooled_total_amount: Number(stats?.total_premiums_collected_this_week ?? data?.pooled_total_amount ?? 0),
          paid_total_amount: Number(data?.paid_total_amount ?? 0),
        };
      } catch (err) {
        console.error('KPI fetch failed:', err);
        throw err;
      }
    },
    refetchInterval: 30_000,
    retry: 2,
  });
  const healthQuery = useQuery({
    queryKey: ['backend', 'health'],
    queryFn: async (): Promise<HealthResponse> => {
      const res = await fetch(`${BASE_URL}/health`);
      return (await res.json()) as HealthResponse;
    },
    refetchInterval: 60_000,
  });

  const simulationsFeedQuery = useQuery({
    queryKey: ['admin', 'claims', 'live'],
    queryFn: async () => {
      try {
        const res = await api.get('/admin/claims/live', { params: { page: 1, limit: 20 } });
        return Array.isArray(res.data?.data) ? res.data.data : [];
      } catch (err) {
        console.error('Simulations feed fetch failed:', err);
        return [];
      }
    },
    refetchInterval: 30_000,
    retry: 1,
  });

  const earningsDnaAnalyticsQuery = useQuery({
    queryKey: ['admin', 'earnings-dna-analytics'],
    queryFn: async () => {
      try {
        const res = await api.get('/admin/earnings-dna-analytics', { params: { days: 14 } });
        return res.data ?? {};
      } catch (err) {
        console.error('Earnings DNA analytics fetch failed:', err);
        return {};
      }
    },
    refetchInterval: 60_000,
    retry: 1,
  });

  useEffect(() => {
    const t = Math.max(simulationsFeedQuery.dataUpdatedAt ?? 0, 0);
    if (t) setFeedUpdatedAt(t);
  }, [simulationsFeedQuery.dataUpdatedAt, simulationsFeedQuery.data]);

  const poolStatsQuery = useQuery({
    queryKey: ['admin', 'pool', 'stats'],
    queryFn: async () => {
      try {
        const res = await api.get('/admin/pool/stats');
        return res.data ?? { zones: [] };
      } catch (err) {
        console.error('Pool stats fetch failed:', err);
        return { zones: [] };
      }
    },
    refetchInterval: 30_000,
    retry: 1,
  });

  const kpis = kpiQuery.data;

  const activeWorkers = (kpis ?? EMPTY_KPIS).active_workers;
  const claimsProcessedToday = (kpis ?? EMPTY_KPIS).claims_today;
  const approvalRatePct = (kpis ?? EMPTY_KPIS).approval_rate_pct;
  const fraudBlocked = (kpis ?? EMPTY_KPIS).fraud_blocked;
  const poolUtilizationPct = (kpis ?? EMPTY_KPIS).pool_utilization_pct;

  const mergedFeed = useMemo(() => {
    try {
      const fromApi: AdminClaimUpdate[] = (Array.isArray(simulationsFeedQuery.data) ? simulationsFeedQuery.data : []).map((s: any) => {
        const ts = s.created_at ? new Date(s.created_at).getTime() : Date.now();
        return {
          claim_id: s.claim_id ?? s.id ?? 'unknown',
          worker_id: Number(s.user_id ?? s.worker_id ?? 0),
          status: String(s.status ?? s.decision ?? 'unknown'),
          message: String(s.message ?? s.reason ?? `${s.worker_name ?? 'Worker'} claim update`),
          timestamp: Number.isFinite(ts) ? ts : Date.now(),
          zone_id: s.zone_id ?? s.zone_name ?? undefined,
          fraud_score: typeof s.fraud_score === 'number' ? Math.max(0, Math.min(1, s.fraud_score)) : undefined,
          disruption_type: s.disruption_type ?? undefined,
          confidence_level: s.confidence_level ?? s.confidence ?? undefined,
        };
      });
      const byId = new Map<string, AdminClaimUpdate>();
      for (const r of fromApi) byId.set(String(r.claim_id), r);
      for (const w of wsClaims) {
        const k = String(w.claim_id);
        const prev = byId.get(k);
        if (!prev || w.timestamp >= prev.timestamp) byId.set(k, w);
      }
      return Array.from(byId.values())
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 20);
    } catch (err) {
      console.error('Merged feed error:', err);
      return wsClaims.slice(0, 20);
    }
  }, [wsClaims, simulationsFeedQuery.data]);

  /** Remaining headroom under 20% ⇒ utilization over 80%. */
  const poolStressZones = useMemo(() => {
    try {
      return Object.values(poolHealthByZone).filter((z: any) => {
        const u = Number(z?.utilization_pct ?? 0);
        return Number.isFinite(u) && 100 - u < 20;
      });
    } catch {
      return [];
    }
  }, [poolHealthByZone]);

  const lossRatio = useMemo(() => {
    try {
      const k = kpis ?? EMPTY_KPIS;
      const actual = Number(k.loss_ratio_actual_pct ?? 60);
      return {
        targetLow: Number(k.loss_ratio_target_low ?? 60),
        targetHigh: Number(k.loss_ratio_target_high ?? 75),
        actual: Number.isFinite(actual) ? actual : 60,
      };
    } catch {
      return { targetLow: 60, targetHigh: 75, actual: 60 };
    }
  }, [kpis]);

  const kpiCards = (
    <div style={adminUi.kpiGrid}>
      <KpiCard
        title="Total Active Workers"
        value={String(activeWorkers)}
        delta={{ label: '24h', direction: 'flat' }}
      />
      <KpiCard
        title="Claims Processed Today"
        value={String(claimsProcessedToday)}
        delta={{ label: `${approvalRatePct.toFixed(1)}% approval`, direction: 'up' }}
      />
      <KpiCard title="Fraud Attempts Blocked" value={String(fraudBlocked)} />
      <KpiCard
        title="Pool Utilization % (All Zones)"
        value={`${poolUtilizationPct}%`}
        delta={{ label: 'risk-based', direction: poolUtilizationPct > 80 ? 'down' : 'flat' }}
      />
      <KpiCard
        title="Pooled vs Paid (Week)"
        value={`₹${Math.round((kpis?.pooled_total_amount ?? 0) / 1000)}k / ₹${Math.round((kpis?.paid_total_amount ?? 0) / 1000)}k`}
      />
    </div>
  );
  const showStorageWarning = String(import.meta.env.VITE_SHOW_STORAGE_WARNING || '').trim() === '1';
  const isPersistentStorage = healthQuery.data?.storage?.persistent !== false;

  const zones = useMemo(() => {
    try {
      const liveZones = Array.isArray(poolStatsQuery.data?.zones) ? poolStatsQuery.data.zones : [];
      if (liveZones.length) return liveZones.slice(0, 6) as any[];
      const arr = Object.values(poolHealthByZone).filter(Boolean);
      return [...arr]
        .sort((a: any, b: any) => Number(b.timestamp ?? 0) - Number(a.timestamp ?? 0))
        .slice(0, 6) as any[];
    } catch {
      return [];
    }
  }, [poolHealthByZone, poolStatsQuery.data?.zones]);

  const lossRatioChartData = useMemo(() => {
    const actual = lossRatio.actual;
    const trend = [actual - 6, actual - 3, actual, actual + 2, actual - 1, actual + 1];
    return {
      actual,
      trend,
    };
  }, [lossRatio]);

  const fleetDnaBarData = useMemo(() => {
    try {
      type Row = { hour: number; avg_payout: number; samples: number };
      const rows = (Array.isArray(earningsDnaAnalyticsQuery.data?.fleet_hourly_avg_payout) ? earningsDnaAnalyticsQuery.data.fleet_hourly_avg_payout : []) as Row[];
      const fmt = (h: number) => {
        if (h === 0) return '12A';
        if (h < 12) return `${h}A`;
        if (h === 12) return '12P';
        return `${h - 12}P`;
      };
      return rows
        .filter((r) => Number.isFinite(r.hour) && r.hour >= 6 && r.hour <= 22)
        .map((r) => ({
          hourLabel: fmt(r.hour),
          avgPayout: Number(r.avg_payout) || 0,
          samples: Number(r.samples) || 0,
        }));
    } catch {
      return [];
    }
  }, [earningsDnaAnalyticsQuery.data]);

  const openDrawerForClaim = (claim: AdminClaimUpdate) => {
    setLocalDrawer({ open: true, selected: claim });
  };

  const drawerClaim = localDrawer.selected;

  const closeDrawer = () => {
    setLocalDrawer({ open: false, selected: null });
  };

  if (kpiQuery.isLoading && !kpiQuery.data) {
    return (
      <div style={{ ...adminUi.page, ...styles.loading }}>
        <span>Loading dashboard…</span>
      </div>
    );
  }

  if (kpiQuery.isError) {
    return (
      <div style={adminUi.page}>
        <div style={adminUi.pageHeader}>
          <h1 style={adminUi.h1}>Dashboard</h1>
          <p style={adminUi.sub}>We couldn’t load KPIs. Check that the API is running and you’re signed in.</p>
        </div>
        <button type="button" style={adminUi.btnPrimary} onClick={() => void kpiQuery.refetch()}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <div style={adminUi.page}>
      <style>
        {`
          @keyframes claimRowEnter {
            from { transform: translateY(-14px); opacity: 0.55; }
            to { transform: translateY(0); opacity: 1; }
          }
        `}
      </style>

      {showStorageWarning && !isPersistentStorage ? (
        <div style={styles.poolWarnBanner}>
          <div style={styles.poolWarnLine}>Storage warning: SQLite mode detected</div>
          <div style={{ color: '#9a3412', fontSize: 12, fontWeight: 600 }}>
            Data may reset on restart/deploy. Set backend `DATABASE_URL` to managed Postgres for permanent storage.
          </div>
        </div>
      ) : null}

      {fraudToast ? (
        <div style={styles.fraudToast} role="status">
          Fraud ring detected in {fraudToast.zone_id} — {fraudToast.worker_ids?.length ?? 0} workers frozen
        </div>
      ) : null}

      {poolStressZones.length ? (
        <div style={styles.poolWarnBanner}>
          {poolStressZones.map((z: any) => {
            const pct = Number(z.utilization_pct ?? 0);
            const health = Math.max(0, 100 - pct);
            return (
              <div key={String(z.zone_id)} style={styles.poolWarnLine}>
                {z.zone_id} pool health at {health.toFixed(0)}% (utilization {pct.toFixed(0)}%) — reinsurance may
                trigger
              </div>
            );
          })}
        </div>
      ) : null}

      <header style={{ ...adminUi.pageHeader, display: 'flex', justifyContent: 'space-between', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div>
          <h1 style={adminUi.h1}>Dashboard</h1>
          <p style={adminUi.sub}>
            Live KPIs, claim feed, pool health, and earnings DNA. Real-time rows update over the WebSocket.
          </p>
        </div>
        <div style={styles.systemMeta}>
          <span style={styles.liveDot} />
          <span style={styles.systemLive}>Live</span>
          <span style={styles.systemDivider}>•</span>
          <span style={styles.systemTime}>Updated {formatUpdated(Math.max(kpiQuery.dataUpdatedAt || 0, simulationsFeedQuery.dataUpdatedAt || 0))}</span>
        </div>
      </header>

      {kpiCards}

      <div style={{ ...adminUi.card, marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div style={adminUi.cardTitle}>Pool Health · Actuarial soundness</div>
            <div style={adminUi.cardSub}>
              Booked weekly premiums (active policies) vs approved payouts this IST week. Reserve = sum of latest zone pool
              balances. Zone loads adjust Mondays (max 2 hikes / quarter).
            </div>
          </div>
          <button
            type="button"
            style={adminUi.btnPrimary}
            onClick={() => {
              void (async () => {
                try {
                  await api.post('/admin/run-weekly-pricing');
                  await poolStatsQuery.refetch();
                } catch (e) {
                  console.error(e);
                }
              })();
            }}
          >
            Run weekly pricing (demo)
          </button>
        </div>
        {poolStatsQuery.isLoading ? (
          <div style={styles.empty}>Loading pool health…</div>
        ) : (
          <div
            style={{
              display: 'grid',
              gap: 16,
              marginTop: 16,
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            }}
          >
            {(() => {
              const ph = poolStatsQuery.data as Record<string, unknown> | undefined;
              const lr = Number(ph?.loss_ratio ?? 0) * 100;
              const gauge = String(ph?.loss_ratio_gauge ?? 'yellow');
              const gaugeColor = gauge === 'green' ? '#16a34a' : gauge === 'red' ? '#dc2626' : '#ca8a04';
              return (
                <>
                  <div>
                    <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 800 }}>Loss ratio (payouts / premiums)</div>
                    <div style={{ fontSize: 28, fontWeight: 900, color: gaugeColor }}>{lr.toFixed(1)}%</div>
                    <div style={{ fontSize: 12, color: '#64748b' }}>
                      Target under {(Number(ph?.target_loss_ratio ?? 0.7) * 100).toFixed(0)}% · Gauge: {gauge}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 800 }}>Reserve pool</div>
                    <div style={{ fontSize: 22, fontWeight: 900, color: '#0f172a' }}>
                      ₹{Number(ph?.reserve_pool ?? 0).toLocaleString('en-IN')}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 800 }}>Est. next-week payout</div>
                    <div style={{ fontSize: 22, fontWeight: 900, color: '#0f172a' }}>
                      ₹{Number(ph?.estimated_next_week_payout ?? 0).toLocaleString('en-IN')}
                    </div>
                    <div style={{ fontSize: 11, color: '#94a3b8' }}>
                      Forecast-weighted × {Number(ph?.active_policies ?? 0)} policies × avg ₹
                      {Number(ph?.avg_recent_payout ?? 0).toFixed(0)}
                    </div>
                  </div>
                </>
              );
            })()}
          </div>
        )}
        {(() => {
          const alertText = (poolStatsQuery.data as { premium_adjustment_alert?: string } | undefined)
            ?.premium_adjustment_alert;
          return alertText ? (
            <div
              style={{
                marginTop: 14,
                padding: 12,
                background: '#fef3c7',
                borderRadius: 8,
                color: '#854d0e',
                fontWeight: 600,
              }}
            >
              {alertText}
            </div>
          ) : null;
        })()}
      </div>

      <div style={{ ...adminUi.card, marginBottom: 20 }}>
        <div style={adminUi.cardTitle}>Earnings DNA · workforce</div>
        <div style={{ ...adminUi.cardSub, marginBottom: 0 }}>IST peak hours and simulation income (last 14 days)</div>
        <div style={{ marginTop: 16 }}>
        {earningsDnaAnalyticsQuery.isLoading ? (
          <div style={styles.empty}>Loading earnings analytics…</div>
        ) : earningsDnaAnalyticsQuery.error ? (
          <div style={styles.empty}>Analytics unavailable.</div>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 800 }}>Avg expected / claim</div>
                <div style={{ fontSize: 18, fontWeight: 900, color: '#0f172a' }}>
                  ₹{Number(earningsDnaAnalyticsQuery.data?.avg_expected ?? 0).toFixed(0)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 800 }}>Avg actual / claim</div>
                <div style={{ fontSize: 18, fontWeight: 900, color: '#0f172a' }}>
                  ₹{Number(earningsDnaAnalyticsQuery.data?.avg_actual ?? 0).toFixed(0)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 800 }}>Simulations in window</div>
                <div style={{ fontSize: 18, fontWeight: 900, color: '#0f172a' }}>
                  {earningsDnaAnalyticsQuery.data?.simulations_in_window ?? 0}
                </div>
              </div>
            </div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 900, color: '#334155', marginBottom: 8 }}>
                Peak hours (IST) across workers
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {(earningsDnaAnalyticsQuery.data?.peak_hours_ist ?? []).slice(0, 5).map((row: any) => (
                  <span key={row.hour_ist} style={styles.dnaPeakChip}>
                    {row.hour_ist}:00 · ₹{row.avg_slot_proxy}/h · n={row.samples}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
        </div>
      </div>

      <div style={{ ...adminUi.card, marginBottom: 20 }}>
        <div style={adminUi.cardTitle}>Fleet DNA · hourly payout pattern</div>
        <div style={{ ...adminUi.cardSub, marginBottom: 0 }}>
          When workers earn most (e.g. lunch and dinner peaks). Helps spot hours where claims cluster.
        </div>
        <div style={{ marginTop: 16 }}>
        {earningsDnaAnalyticsQuery.isLoading ? (
          <div style={styles.empty}>Loading fleet hourly pattern…</div>
        ) : earningsDnaAnalyticsQuery.error ? (
          <div style={styles.empty}>Fleet DNA chart unavailable.</div>
        ) : fleetDnaBarData.length === 0 ? (
          <div style={styles.empty}>No approved simulation payouts in this window yet.</div>
        ) : (
          <div style={{ height: 320, width: '100%' }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={fleetDnaBarData} margin={{ top: 8, right: 12, left: 4, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
                <XAxis dataKey="hourLabel" tick={{ fontSize: 11, fill: '#64748b', fontWeight: 700 }} />
                <YAxis
                  tick={{ fontSize: 11, fill: '#64748b' }}
                  tickFormatter={(v) => `₹${v}`}
                  label={{ value: 'Avg payout (₹)', angle: -90, position: 'insideLeft', fill: '#64748b', fontSize: 11 }}
                />
                <Tooltip
                  formatter={(value) => [`₹${Number(value ?? 0).toFixed(0)}`, 'Avg payout']}
                  labelFormatter={(label) => `${label} IST`}
                />
                <Bar dataKey="avgPayout" fill="#3b82f6" radius={[4, 4, 0, 0]} name="Avg payout" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
        </div>
      </div>

      <div className="admin-responsive-2col">
        <div style={adminUi.card}>
          <div style={adminUi.cardTitle}>Live claim feed</div>
          <div style={{ ...adminUi.cardSub, marginBottom: 12 }}>
            {mergedFeed.length} rows
            {feedUpdatedAt ? (
              <span style={{ marginLeft: 8, fontWeight: 600 }}>
                · Last updated {new Date(feedUpdatedAt).toLocaleTimeString()}
              </span>
            ) : null}
          </div>

          {mergedFeed.length === 0 ? (
            <div style={adminUi.empty}>No rows yet. Connect the WebSocket and wait for simulations or API refresh.</div>
          ) : (
            <div style={adminUi.tableScroll}>
              <table style={{ ...adminUi.table, minWidth: isMobile ? 680 : 820 }}>
                <thead>
                  <tr>
                    <th style={adminUi.th}>Worker ID</th>
                    <th style={adminUi.th}>Zone</th>
                    <th style={adminUi.th}>Disruption</th>
                    <th style={adminUi.th}>Confidence</th>
                    <th style={adminUi.th}>Fraud score</th>
                    <th style={adminUi.th}>Status</th>
                    <th style={adminUi.th}>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {mergedFeed.map((c) => {
                    const chip = statusToChip(c.status);
                    const rowId = String(c.claim_id);
                    const animate = flashRowId === rowId;
                    return (
                      <tr
                        key={rowId}
                        style={{
                          ...adminUi.trHover,
                          animation: animate ? 'claimRowEnter 0.3s ease' : undefined,
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = 'var(--admin-bg-subtle)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = 'transparent';
                        }}
                        onClick={() => openDrawerForClaim(c)}
                      >
                        <td style={adminUi.td}>{c.worker_id ?? '—'}</td>
                        <td style={adminUi.td}>{c.zone_id ?? '—'}</td>
                        <td style={adminUi.td}>{c.disruption_type ?? '—'}</td>
                        <td style={adminUi.td}>{c.confidence_level ?? '—'}</td>
                        <td style={adminUi.td}>{typeof c.fraud_score === 'number' ? c.fraud_score.toFixed(2) : '—'}</td>
                        <td style={adminUi.td}>
                          <span style={{ ...styles.chip, backgroundColor: chip.bg, color: chip.fg }}>{chip.label}</span>
                        </td>
                        <td style={adminUi.td}>{new Date(c.timestamp).toLocaleTimeString()}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div style={{ display: 'grid', gap: 16 }}>
          <div style={adminUi.card}>
            <div style={adminUi.cardTitle}>Loss ratio</div>
            <div style={{ ...adminUi.cardSub, marginBottom: 8 }}>Target band 60–75%</div>
            <div style={{ height: isMobile ? 220 : 260 }}>
              <ResponsiveContainer width="100%" height="100%">
              <RadialBarChart data={[{ name: 'loss', value: lossRatioChartData.actual }]} cx="50%" cy="50%" innerRadius="80%" outerRadius="100%" barSize={18}>
                  <RadialBar dataKey="value" minAngle={15} background={{ fill: '#e5e7eb' }} />
                  <Tooltip />
                </RadialBarChart>
              </ResponsiveContainer>
            </div>
            <div style={styles.lossText}>
              <div>
                Current actual: <b>{Math.round(lossRatioChartData.actual)}%</b>
              </div>
              <div style={{ color: '#6b7280', fontSize: 12 }}>Target: {lossRatio.targetLow}-{lossRatio.targetHigh}%</div>
            </div>
          </div>

          <div style={adminUi.card}>
            <div style={adminUi.cardTitle}>Weekly earnings</div>
            <div style={{ ...adminUi.cardSub, marginBottom: 8 }}>Tap to expand breakdown</div>
            <WeeklyEarningsDrawer />
          </div>
        </div>
      </div>

      <div style={{ ...adminUi.card, marginTop: 20 }}>
        <div style={adminUi.cardTitle}>Zone health</div>
        <div style={{ ...adminUi.cardSub, marginBottom: 0 }}>From latest pool health snapshots</div>

        {zones.length === 0 ? (
          <div style={{ ...adminUi.empty, marginTop: 12 }}>No pool health data yet.</div>
        ) : (
          <div style={{ ...styles.zoneGrid, marginTop: 16 }}>
            {zones.map((z) => {
              const risk = String(z.risk_level ?? 'MEDIUM').toUpperCase();
              const bg = risk === 'HIGH' ? '#fee2e2' : risk === 'LOW' ? '#dcfce7' : '#fef3c7';
              const fg = risk === 'HIGH' ? '#991b1b' : risk === 'LOW' ? '#166534' : '#854d0e';
              const bal = Number(z.balance ?? z.current_balance ?? 0);
              const util = Number(z.utilization_pct ?? 0);
              return (
                <div key={String(z.zone_id)} style={{ ...styles.zoneCard, borderColor: fg }}>
                  <div style={styles.zoneTitle}>{String(z.zone_id ?? 'unknown')}</div>
                  <div style={styles.zoneMetric}>Balance: ₹{Number.isFinite(bal) ? bal.toFixed(0) : '0'}</div>
                  <div style={styles.zoneMetric}>Utilization: {Number.isFinite(util) ? util.toFixed(1) : '0'}%</div>
                  <div style={{ ...styles.chip, backgroundColor: bg, color: fg, display: 'inline-block' }}>
                    Risk: {risk}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {localDrawer.open && drawerClaim ? (
        <div style={styles.drawerOverlay} onClick={closeDrawer} role="presentation">
          <div style={styles.drawer} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div style={styles.drawerHeader}>
              <div style={styles.drawerTitle}>Claim Details</div>
              <button style={styles.drawerClose} onClick={closeDrawer}>
                Close
              </button>
            </div>

            <div style={styles.drawerBody}>
              <div style={styles.detailRow}>
                <span style={styles.detailKey}>Claim ID</span>
                <span style={styles.detailVal}>{drawerClaim.claim_id}</span>
              </div>
              <div style={styles.detailRow}>
                <span style={styles.detailKey}>Status</span>
                <span style={styles.detailVal}>{drawerClaim.status}</span>
              </div>
              <div style={styles.detailRow}>
                <span style={styles.detailKey}>Worker</span>
                <span style={styles.detailVal}>{drawerClaim.worker_id ?? '—'}</span>
              </div>
              <div style={styles.detailRow}>
                <span style={styles.detailKey}>Zone</span>
                <span style={styles.detailVal}>{drawerClaim.zone_id ?? '—'}</span>
              </div>
              <div style={styles.detailRow}>
                <span style={styles.detailKey}>Disruption</span>
                <span style={styles.detailVal}>{drawerClaim.disruption_type ?? '—'}</span>
              </div>
              <div style={styles.detailRow}>
                <span style={styles.detailKey}>Confidence</span>
                <span style={styles.detailVal}>{drawerClaim.confidence_level ?? '—'}</span>
              </div>
              <div style={styles.detailRow}>
                <span style={styles.detailKey}>Fraud Score</span>
                <span style={styles.detailVal}>
                  {typeof drawerClaim.fraud_score === 'number' ? Math.max(0, Math.min(1, drawerClaim.fraud_score)).toFixed(2) : '—'}
                </span>
              </div>
              <div style={styles.detailRow}>
                <span style={styles.detailKey}>Message</span>
                <span style={styles.detailVal}>{drawerClaim.message}</span>
              </div>
              <div style={styles.detailRow}>
                <span style={styles.detailKey}>Time</span>
                <span style={styles.detailVal}>{new Date(drawerClaim.timestamp).toLocaleString()}</span>
              </div>
              <div style={{ marginTop: 16 }}>
                <button
                  type="button"
                  style={adminUi.btnPrimary}
                  onClick={() => {
                    void (async () => {
                      try {
                        const res = await api.get(`/admin/claims/${drawerClaim.claim_id}/receipt`, {
                          responseType: 'blob',
                        });
                        const url = URL.createObjectURL(res.data);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `safenet-receipt-${drawerClaim.claim_id}.pdf`;
                        a.click();
                        URL.revokeObjectURL(url);
                      } catch (e) {
                        console.error(e);
                      }
                    })();
                  }}
                >
                  Download income receipt (PDF)
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );

  function WeeklyEarningsDrawer() {
    const [expanded, setExpanded] = useState(false);
    const weeklyQuery = useQuery({
      queryKey: ['admin', 'weekly-earnings'],
      queryFn: async () => {
        try {
          const res = await api.get('/admin/weekly-earnings?days=7');
          return res.data ?? { protected_this_week: 0, breakdown: [] };
        } catch (err) {
          console.error('Weekly earnings fetch failed:', err);
          return { protected_this_week: 0, breakdown: [] };
        }
      },
      refetchInterval: 120_000,
      retry: 1,
    });

    return (
      <div>
        <button
          style={styles.weeklyButton}
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <span>₹ {weeklyQuery.data?.protected_this_week ?? '—'} protected this week</span>
          <span style={{ color: '#6b7280', fontWeight: 700 }}>{expanded ? '▲' : '▼'}</span>
        </button>

        {!expanded ? null : (
          <div style={styles.weeklyExpanded}>
            {weeklyQuery.isLoading ? (
              <div style={styles.empty}>Loading weekly breakdown...</div>
            ) : weeklyQuery.error ? (
              <div style={styles.empty}>No weekly breakdown available.</div>
            ) : (
              <div style={{ display: 'grid', gap: 8 }}>
                {(Array.isArray(weeklyQuery.data?.breakdown) ? weeklyQuery.data.breakdown : []).map((row: any) => {
                  const amt = Number(row.protected_amount ?? 0);
                  return (
                    <div key={String(row.day)} style={{ ...styles.weeklyRow, ...(isMobile ? styles.weeklyRowMobile : null) }}>
                      <div style={styles.weeklyDay}>{String(row.day ?? '—')}</div>
                      <div style={styles.weeklyAmount}>₹{Number.isFinite(amt) ? amt.toFixed(0) : '0'}</div>
                      <div style={styles.weeklyReason}>{String(row.reason ?? '')}</div>
                    </div>
                  );
                })}
                {(weeklyQuery.data?.breakdown ?? []).length === 0 ? (
                  <div style={styles.empty}>No breakdown rows.</div>
                ) : null}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }
}

const styles: Record<string, React.CSSProperties> = {
  page: { padding: 0, position: 'relative' },
  fraudToast: {
    position: 'fixed',
    top: 16,
    right: 16,
    zIndex: 200,
    maxWidth: 420,
    padding: '12px 16px',
    borderRadius: 12,
    backgroundColor: '#991b1b',
    color: '#fff',
    fontWeight: 800,
    fontSize: 13,
    boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
  },
  poolWarnBanner: {
    marginBottom: 12,
    padding: '10px 14px',
    borderRadius: 12,
    backgroundColor: '#fff7ed',
    border: '1px solid #fdba74',
  },
  poolWarnLine: { fontSize: 13, fontWeight: 800, color: '#9a3412', marginBottom: 4 },
  loading: { textAlign: 'center', padding: 60, color: 'var(--admin-muted)' },
  kpiTitle: { fontSize: 12, color: 'var(--admin-muted)', fontWeight: 500, marginBottom: 8 },
  kpiValue: { fontSize: 'clamp(1.35rem, 2.5vw, 1.75rem)', fontWeight: 700, color: 'var(--admin-text)', marginBottom: 6, letterSpacing: '-0.02em' },
  kpiDelta: { fontSize: 12, fontWeight: 700 },
  kpiDeltaPlaceholder: { height: 16 },
  chip: { padding: '4px 10px', borderRadius: 9999, fontSize: 11, fontWeight: 800 },
  empty: { padding: 18, color: 'var(--admin-muted)', fontSize: 13, fontWeight: 600 },
  dnaPeakChip: {
    fontSize: 12,
    fontWeight: 800,
    padding: '6px 10px',
    borderRadius: 999,
    backgroundColor: '#e0f2fe',
    color: '#0369a1',
  },
  lossText: { marginTop: 6, fontSize: 13, color: '#0f172a', fontWeight: 700 },
  systemMeta: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px',
    borderRadius: 999,
    border: '1px solid var(--admin-border)',
    backgroundColor: '#ffffff',
  },
  liveDot: { width: 8, height: 8, borderRadius: 999, backgroundColor: '#22c55e' },
  systemLive: { fontSize: 12, fontWeight: 700, color: '#0f172a' },
  systemDivider: { color: '#cbd5e1', fontSize: 12 },
  systemTime: { fontSize: 12, fontWeight: 500, color: '#64748b' },
  weeklyButton: {
    width: '100%',
    border: '1px solid #e5e7eb',
    backgroundColor: '#f8fafc',
    padding: '10px 12px',
    borderRadius: 10,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    fontWeight: 900,
    color: '#0f172a',
  },
  weeklyExpanded: { marginTop: 10, paddingTop: 10, borderTop: '1px solid #e5e7eb' },
  weeklyRow: { display: 'grid', gridTemplateColumns: 'minmax(78px, 90px) minmax(80px, 1fr) minmax(120px, 1.2fr)', gap: 10, alignItems: 'center', padding: '8px 0' },
  weeklyRowMobile: { gridTemplateColumns: '1fr', gap: 4, padding: '10px 0' },
  weeklyDay: { fontSize: 12, fontWeight: 900, color: '#334155' },
  weeklyAmount: { fontSize: 13, fontWeight: 900, color: '#0f172a' },
  weeklyReason: { fontSize: 12, color: '#6b7280', fontWeight: 700 },
  zoneGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 },
  zoneCard: { borderRadius: 12, padding: 16, border: '2px solid transparent', backgroundColor: 'var(--admin-bg-subtle)' },
  zoneTitle: { fontSize: 13, fontWeight: 900, marginBottom: 6, color: '#0f172a' },
  zoneMetric: { fontSize: 12, color: '#334155', fontWeight: 800, marginBottom: 4 },
  drawerOverlay: {
    position: 'fixed',
    inset: 0,
    backgroundColor: 'rgba(15, 23, 42, 0.5)',
    zIndex: 50,
    display: 'flex',
    justifyContent: 'flex-end',
  },
  drawer: {
    width: 'min(520px, 100vw)',
    height: '100%',
    backgroundColor: 'var(--admin-surface)',
    padding: 22,
    boxShadow: '-8px 0 32px rgba(15,23,42,0.12)',
    borderLeft: '1px solid var(--admin-border)',
  },
  drawerHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  drawerTitle: { fontSize: 16, fontWeight: 900, color: '#0f172a' },
  drawerClose: { border: '1px solid #e5e7eb', backgroundColor: '#fff', borderRadius: 10, padding: '8px 12px', cursor: 'pointer', fontWeight: 900, color: '#0f172a' },
  drawerBody: { display: 'grid', gap: 10 },
  detailRow: { display: 'flex', justifyContent: 'space-between', gap: 12, borderBottom: '1px solid #f1f5f9', paddingBottom: 8 },
  detailKey: { color: '#6b7280', fontWeight: 900, fontSize: 12 },
  detailVal: { color: 'var(--admin-text)', fontWeight: 700, fontSize: 13, textAlign: 'right' },
};
