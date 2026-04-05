import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, LineChart, Line, CartesianGrid } from 'recharts';

import api from '../api';
import { adminUi } from '../theme/adminUi';
import { useFraudQueueStore } from '../stores/fraudQueue';

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
    queryFn: async () => (await api.get('/admin/fraud-alerts')).data,
    refetchInterval: 30_000,
  });
  const analyticsQuery = useQuery({
    queryKey: ['admin', 'fraud-analytics'],
    queryFn: async () => (await api.get('/admin/fraud/analytics')).data,
    refetchInterval: 30_000,
  });

  const rows: QueueRow[] = wsQueue.length
    ? (wsQueue as QueueRow[])
    : (alertsQuery.data ?? []).map((x: { id: number; user_id: number; fraud_score: number; created_at: string }) => ({
        cluster_id: `sim-${x.id}`,
        ring_confidence: x.fraud_score > 0.85 ? 'CONFIRMED' : 'PROBABLE',
        workers_in_ring: [x.user_id],
        zone: 'unknown',
        timestamp: new Date(x.created_at).getTime(),
        freeze_status: x.fraud_score > 0.85 ? 'FROZEN' : 'PENDING',
      }));

  const doAction = async (clusterId: string, action: string) => {
    await api.post(`/admin/fraud/${clusterId}/action`, { action });
  };

  return (
    <div style={adminUi.page}>
      <header style={adminUi.pageHeader}>
        <h1 style={adminUi.h1}>Fraud insights</h1>
        <p style={adminUi.sub}>Queue from WebSocket when live; otherwise from API. Actions post to the fraud endpoints.</p>
      </header>

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

      <div className="admin-chart-row">
        <div style={adminUi.card}>
          <div style={adminUi.cardTitle}>Fraud score distribution</div>
          <div style={{ height: 260, marginTop: 12 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={analyticsQuery.data?.fraud_score_histogram ?? []} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
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
          <div style={{ height: 260, marginTop: 12 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={analyticsQuery.data?.enrollment_timeline ?? []} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
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
