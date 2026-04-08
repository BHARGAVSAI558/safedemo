import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import api from '../api';
import { adminUi } from '../theme/adminUi';
import { formatIstDateTime } from '../utils/adminDate';

type SupportRow = {
  id: number;
  user_id: number;
  message: string;
  reply: string;
  admin_reply?: string | null;
  status: 'open' | 'resolved';
  created_at?: string | null;
};

export default function SupportQueries() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<'all' | 'open' | 'resolved'>('all');
  const [replyText, setReplyText] = useState<Record<number, string>>({});

  const q = useQuery({
    queryKey: ['admin', 'support', status],
    queryFn: async (): Promise<SupportRow[]> =>
      (await api.get('/admin/support/queries', { params: status === 'all' ? {} : { status } })).data,
    refetchInterval: 15_000,
  });

  const rows = useMemo(() => (Array.isArray(q.data) ? q.data : []), [q.data]);

  const replyMut = useMutation({
    mutationFn: async ({ id, text }: { id: number; text: string }) =>
      (await api.post('/admin/support/reply', { query_id: id, admin_reply: text })).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'support'] }),
  });

  return (
    <div style={adminUi.page}>
      <header style={adminUi.pageHeader}>
        <h1 style={adminUi.h1}>Support & User Queries</h1>
        <p style={adminUi.sub}>Two-way support feed. Reply to users and resolve issues from one place.</p>
      </header>

      <div style={{ ...adminUi.toolbar, marginBottom: 10 }}>
        <select value={status} onChange={(e) => setStatus(e.target.value as 'all' | 'open' | 'resolved')} style={adminUi.select}>
          <option value="all">All</option>
          <option value="open">Open</option>
          <option value="resolved">Resolved</option>
        </select>
        <button type="button" style={adminUi.btn} onClick={() => void q.refetch()}>
          Refresh
        </button>
      </div>

      <div style={adminUi.tableScroll}>
        <table style={{ ...adminUi.table, minWidth: 1040 }}>
          <thead>
            <tr>
              <th style={adminUi.th}>User ID</th>
              <th style={adminUi.th}>Message</th>
              <th style={adminUi.th}>System Response</th>
              <th style={adminUi.th}>Admin Reply</th>
              <th style={adminUi.th}>Status</th>
              <th style={adminUi.th}>Timestamp</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td style={adminUi.td}>{r.user_id}</td>
                <td style={adminUi.td}>{r.message}</td>
                <td style={adminUi.td}>{r.reply}</td>
                <td style={adminUi.td}>
                  <div style={{ display: 'grid', gap: 8 }}>
                    {r.admin_reply ? (
                      <div style={{ fontSize: '0.8125rem', fontWeight: 700, color: '#0f172a' }}>{r.admin_reply}</div>
                    ) : null}
                    <textarea
                      value={replyText[r.id] ?? ''}
                      onChange={(e) => setReplyText((s) => ({ ...s, [r.id]: e.target.value }))}
                      placeholder="Type admin reply..."
                      style={{
                        width: '100%',
                        minHeight: 74,
                        border: '1px solid var(--admin-border)',
                        borderRadius: 8,
                        padding: 8,
                        fontFamily: 'inherit',
                        fontSize: '0.8125rem',
                      }}
                    />
                    <button
                      type="button"
                      style={adminUi.btnPrimary}
                      disabled={replyMut.isPending || !String(replyText[r.id] || '').trim()}
                      onClick={() => replyMut.mutate({ id: r.id, text: String(replyText[r.id] || '').trim() })}
                    >
                      Send Reply
                    </button>
                  </div>
                </td>
                <td style={adminUi.td}>
                  <span style={{ ...adminUi.pill, background: r.status === 'resolved' ? 'rgba(22,163,74,0.14)' : 'rgba(234,179,8,0.18)' }}>
                    {r.status}
                  </span>
                </td>
                <td style={adminUi.td}>{formatIstDateTime(r.created_at)}</td>
              </tr>
            ))}
            {!rows.length ? (
              <tr>
                <td colSpan={6} style={adminUi.td}>
                  <div style={adminUi.empty}>{q.isLoading ? 'Loading…' : 'No support queries yet.'}</div>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

