import React, { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, LineChart, Line, CartesianGrid } from 'recharts';

import api from '../api';
import { adminUi } from '../theme/adminUi';
import { useFraudQueueStore } from '../stores/fraudQueue';
import { useZeroDayStore } from '../stores/zeroDay';

type QueueRow = {
  cluster_id: string;
  ring_confidence: string;
  worker_ids?: number[];
  workers_in_ring?: number[];
  zone_id?: string;
  zone?: string;
  timestamp: number;
  freeze_status?: string;
};

export default function FraudInsights() {
  const wsQueue = useFraudQueueStore((s) => s.items);

  const alertsQuery = useQuery({
    queryKey: ['admin', 'fraud-alerts'],
    queryFn: async () => {
      try {
        const res = await api.get('/admin/fraud-alerts');
        return Array.isArray(res.data) ? res.data : [];
      } catch (err) {
        console.error('Fraud alerts fetch failed:', err);
        return [];
      }
    },
    refetchInterval: 30_000,
    retry: 1,
  });
  const analyticsQuery = useQuery({
    queryKey: ['admin', 'fraud-analytics'],
    queryFn: async () => {
      try {
        const res = await api.get('/admin/fraud/analytics');
        return res.data ?? {};
      } catch (err) {
        console.error('Fraud analytics fetch failed:', err);
        return {};
      }
    },
    refetchInterval: 30_000,
    retry: 1,
  });

  const rows: QueueRow[] = wsQueue.length
    ? (wsQueue as QueueRow[])
    : (Array.isArray(alertsQuery.data) ? alertsQuery.data : []).map((x: { id: number; user_id: number; fraud_score: number; created_at: string }) => ({
        cluster_id: `sim-${x.id}`,
        ring_confidence: Number(x.fraud_score) > 0.85 ? 'CONFIRMED' : 'PROBABLE',
        workers_in_ring: [x.user_id],
        zone: 'unknown',
        timestamp: new Date(x.created_at).getTime(),
        freeze_status: Number(x.fraud_score) > 0.85 ? 'FROZEN' : 'PENDING',
      }));

  const wsZero = useZeroDayStore((s) => s.items);

  const zeroDayQuery = useQuery({
    queryKey: ['admin', 'zero-day-alerts'],
    queryFn: async () => {
      try {
        const res = await api.get('/admin/zero-day-alerts');
        return Array.isArray(res.data) ? res.data : [];
      } catch (err) {
        console.error('Zero-day alerts fetch failed:', err);
        return [];
      }
    },
    refetchInterval: 30_000,
    retry: 1,
  });

  const doAction = async (clusterId: string, action: string) => {
    try {
      await api.post(`/admin/fraud/${clusterId}/action`, { action });
    } catch {
      // action failures are non-critical; queue will refresh
    }
  };

  const zeroDayRows = Array.isArray(zeroDayQuery.data) ? zeroDayQuery.data : [];
  const hasActiveZeroDay = zeroDayRows.some(
    (r: { status?: string }) => !r.status || r.status === 'pending' || r.status === 'active',
  );

  useEffect(() => {
    if (wsZero.length > 0) void zeroDayQuery.refetch();
  }, [wsZero.length, zeroDayQuery]);

  const zeroDayAction = async (id: number, action: 'approve_payout' | 'deny' | 'investigate') => {
    try {
      await api.post(`/admin/zero-day-alerts/${id}/action`, { action });
      void zeroDayQuery.refetch();
    } catch {
      // ignore
    }
  };

  return (
    <div style={adminUi.page}>
      <header style={adminUi.pageHeader}>
        <h1 style={adminUi.h1}>Fraud insights</h1>
        <p style={adminUi.sub}>Queue from WebSocket when live; otherwise from API. Actions post to the fraud endpoints.</p>
      </header>

      {alertsQuery.isError ? (
        <div style={{ ...adminUi.card, marginBottom: 16, borderColor: '#fecaca', background: '#fef2f2', color: '#b91c1c', fontWeight: 600, fontSize: '0.875rem' }}>
          Could not load fraud alerts.{' '}
          <button type="button" style={adminUi.btnPrimary} onClick={() => void alertsQuery.refetch()}>Retry</button>
        </div>
      ) : null}

      {hasActiveZeroDay ? (
        <div
          style={{
            marginBottom: 16,
            padding: '14px 18px',
            borderRadius: 12,
            border: '1px solid #fecaca',
            background: '#fef2f2',
            color: '#991b1b',
            fontWeight: 700,
            fontSize: '0.9rem',
          }}
          role="status"
        >
          ⚠️ Unclassified Mass Offline Event — review the Zero-Day queue below.
        </div>
      ) : null}

      <div style={{ ...adminUi.card, marginBottom: 20, padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--admin-border)' }}>
          <div style={adminUi.cardTitle}>Fraud queue</div>
          <div style={{ ...adminUi.cardSub, marginBottom: 0 }}>{rows.length} row{rows.length === 1 ? '' : 's'}</div>
        </div>
        <div style={{ ...adminUi.tableScroll, maxHeight: 'min(480px, 55vh)', border: 'none', borderRadius: 0 }}>
          <table style={{ ...adminUi.table, minWidth: 960 }}>
            <thead>
              <tr>
                <th style={adminUi.th}>Cluster</th>
                <th style={adminUi.th}>Confidence</th>
                <th style={adminUi.th}>Workers</th>
                <th style={adminUi.th}>Zone</th>
                <th style={adminUi.th}>Time</th>
                <th style={adminUi.th}>Freeze</th>
                <th style={adminUi.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={String(r.cluster_id)}>
                  <td style={{ ...adminUi.td, fontWeight: 700, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{r.cluster_id}</td>
                  <td style={adminUi.td}>{r.ring_confidence}</td>
                  <td style={adminUi.td}>{(r.worker_ids ?? r.workers_in_ring ?? []).length}</td>
                  <td style={adminUi.td}>{r.zone_id ?? r.zone ?? '—'}</td>
                  <td style={{ ...adminUi.td, whiteSpace: 'nowrap' }}>{new Date(r.timestamp).toLocaleString()}</td>
                  <td style={adminUi.td}>{r.freeze_status ?? (r.ring_confidence === 'CONFIRMED' ? 'FROZEN' : 'PENDING')}</td>
                  <td style={{ ...adminUi.td, minWidth: 280 }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      <button type="button" style={adminUi.btnDanger} onClick={() => void doAction(r.cluster_id, 'CONFIRM_FRAUD')}>
                        Confirm fraud
                      </button>
                      <button type="button" style={adminUi.btnMuted} onClick={() => void doAction(r.cluster_id, 'CLEAR_CLUSTER')}>
                        Clear cluster
                      </button>
                      <button type="button" style={adminUi.btnMuted} onClick={() => void doAction(r.cluster_id, 'MANUAL_REVIEW')}>
                        Manual review
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} style={adminUi.td}>
                    <div style={adminUi.empty}>No fraud alerts.</div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ ...adminUi.card, marginBottom: 20, padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--admin-border)' }}>
          <div style={adminUi.cardTitle}>Zero-Day Alerts</div>
          <div style={{ ...adminUi.cardSub, marginBottom: 0 }}>
            Mass offline / no API match — DBSCAN signal. Live via WebSocket when connected.
          </div>
        </div>
        <div style={{ ...adminUi.tableScroll, maxHeight: 'min(360px, 50vh)', border: 'none', borderRadius: 0 }}>
          <table style={{ ...adminUi.table, minWidth: 720 }}>
            <thead>
              <tr>
                <th style={adminUi.th}>Zone</th>
                <th style={adminUi.th}>Offline ratio</th>
                <th style={adminUi.th}>Confidence</th>
                <th style={adminUi.th}>Detected</th>
                <th style={adminUi.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {zeroDayRows.map((r) => (
                <tr key={String(r.id)}>
                  <td style={adminUi.td}>{r.zone_id}</td>
                  <td style={adminUi.td}>{typeof r.offline_ratio === 'number' ? `${Math.round(r.offline_ratio * 100)}%` : '—'}</td>
                  <td style={adminUi.td}>{typeof r.confidence === 'number' ? r.confidence.toFixed(2) : '—'}</td>
                  <td style={adminUi.td}>
                    {r.created_at
                      ? new Date(r.created_at).toLocaleString()
                      : r.timestamp
                        ? new Date(r.timestamp).toLocaleString()
                        : '—'}
                  </td>
                  <td style={adminUi.td}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      <button type="button" style={adminUi.btnPrimary} onClick={() => void zeroDayAction(r.id, 'approve_payout')}>
                        Approve payout
                      </button>
                      <button type="button" style={adminUi.btnDanger} onClick={() => void zeroDayAction(r.id, 'deny')}>
                        Deny
                      </button>
                      <button type="button" style={adminUi.btnMuted} onClick={() => void zeroDayAction(r.id, 'investigate')}>
                        Investigate
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {zeroDayRows.length === 0 ? (
                <tr>
                  <td colSpan={5} style={adminUi.td}>
                    <div style={adminUi.empty}>No zero-day anomalies.</div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      <div className="admin-chart-row">
        <div style={adminUi.card}>
          <div style={adminUi.cardTitle}>Fraud score distribution</div>
          <div style={{ height: 260, marginTop: 12, width: '100%', minWidth: 0, minHeight: 220 }}>
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <BarChart data={Array.isArray(analyticsQuery.data?.fraud_score_histogram) ? analyticsQuery.data.fraud_score_histogram : []} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--admin-border)" vertical={false} />
                <XAxis dataKey="bucket" tick={{ fontSize: 11, fill: 'var(--admin-muted)' }} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--admin-muted)' }} />
                <Tooltip contentStyle={{ borderRadius: 10, border: '1px solid var(--admin-border)' }} />
                <Bar dataKey="count" fill="#ef4444" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div style={adminUi.card}>
          <div style={adminUi.cardTitle}>Enrollment vs weather signal</div>
          <div style={{ height: 260, marginTop: 12, width: '100%', minWidth: 0, minHeight: 220 }}>
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <LineChart data={Array.isArray(analyticsQuery.data?.enrollment_timeline) ? analyticsQuery.data.enrollment_timeline : []} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--admin-border)" />
                <XAxis dataKey="hour" tick={{ fontSize: 11, fill: 'var(--admin-muted)' }} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--admin-muted)' }} />
                <Tooltip contentStyle={{ borderRadius: 10, border: '1px solid var(--admin-border)' }} />
                <Line type="monotone" dataKey="enrollments" stroke="#2563eb" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="weather_alert" stroke="#d97706" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}
