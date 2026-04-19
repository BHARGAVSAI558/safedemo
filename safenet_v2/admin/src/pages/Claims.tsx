import React from 'react';
import { useQuery } from '@tanstack/react-query';

import api from '../api';
import { adminUi } from '../theme/adminUi';

type ClaimRow = {
  id?: number;
  claim_id?: number | string;
  user_id?: number;
  status?: string;
  decision?: string;
  reason?: string;
  message?: string;
  created_at?: string;
  zone_id?: string;
  fraud_score?: number;
};

export default function Claims() {
  const q = useQuery({
    queryKey: ['admin', 'claims', 'page'],
    queryFn: async () => {
      try {
        const res = await api.get('/admin/claims/live', { params: { page: 1, limit: 50 } });
        return Array.isArray(res.data?.data) ? res.data.data : [];
      } catch {
        return [];
      }
    },
    refetchInterval: 25_000,
    retry: 1,
  });

  const rows = (q.data ?? []) as ClaimRow[];

  return (
    <div style={adminUi.page}>
      <p style={{ ...adminUi.sub, marginTop: 0 }}>
        Recent simulations and claim events — same feed as the dashboard, optimized for review.
      </p>

      <div style={{ ...adminUi.card, padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--admin-border)' }}>
          <div style={adminUi.cardTitle}>Claims feed</div>
          <div style={{ ...adminUi.cardSub, marginBottom: 0 }}>{rows.length} row{rows.length === 1 ? '' : 's'}</div>
        </div>
        <div style={{ ...adminUi.tableScroll, maxHeight: 'min(640px, 65vh)' }}>
          <table style={{ ...adminUi.table, minWidth: 880 }}>
            <thead>
              <tr>
                <th style={adminUi.th}>Claim</th>
                <th style={adminUi.th}>Worker</th>
                <th style={adminUi.th}>Status</th>
                <th style={adminUi.th}>Zone</th>
                <th style={adminUi.th}>Fraud</th>
                <th style={adminUi.th}>Time</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const id = r.claim_id ?? r.id ?? '—';
                const ts = r.created_at ? new Date(r.created_at).toLocaleString() : '—';
                return (
                  <tr key={String(id)}>
                    <td style={{ ...adminUi.td, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{String(id)}</td>
                    <td style={adminUi.td}>{r.user_id ?? '—'}</td>
                    <td style={adminUi.td}>{r.status ?? r.decision ?? '—'}</td>
                    <td style={adminUi.td}>{r.zone_id ?? '—'}</td>
                    <td style={adminUi.td}>
                      {typeof r.fraud_score === 'number' ? r.fraud_score.toFixed(2) : '—'}
                    </td>
                    <td style={{ ...adminUi.td, whiteSpace: 'nowrap' }}>{ts}</td>
                  </tr>
                );
              })}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6} style={adminUi.td}>
                    <div style={adminUi.empty}>No claims in feed.</div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
