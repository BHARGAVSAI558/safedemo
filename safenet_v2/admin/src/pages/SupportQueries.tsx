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
  query_type?: string;
  ticket_no?: string | null;
  created_at?: string | null;
  priority?: 'HIGH' | 'MEDIUM' | 'LOW' | string;
  category?: string;
  score?: number;
  reason?: string;
};

export default function SupportQueries() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<'all' | 'open' | 'resolved'>('all');
  const [priority, setPriority] = useState<'all' | 'HIGH' | 'MEDIUM' | 'LOW'>('all');
  const [category, setCategory] = useState<'all' | 'payment' | 'safety' | 'weather' | 'technical' | 'other'>('all');
  const [sort, setSort] = useState<'score_desc' | 'created_desc'>('score_desc');
  const [replyText, setReplyText] = useState<Record<number, string>>({});

  const q = useQuery({
    queryKey: ['admin', 'support', status, priority, category, sort],
    queryFn: async (): Promise<SupportRow[]> => {
      try {
        const params: Record<string, string> = { sort };
        if (status !== 'all') params.status = status;
        if (priority !== 'all') params.priority = priority;
        if (category !== 'all') params.category = category;
        const res = await api.get('/admin/support/queries', { params });
        return Array.isArray(res.data) ? res.data : [];
      } catch (err) {
        console.error('Support queries fetch failed:', err);
        return [];
      }
    },
    refetchInterval: 15_000,
    retry: 1,
  });

  const rows = useMemo(() => (Array.isArray(q.data) ? q.data : []), [q.data]);

  const replyMut = useMutation({
    mutationFn: async ({ id, text }: { id: number; text: string }) => {
      try {
        const res = await api.post('/admin/support/reply', { query_id: id, admin_reply: text });
        return res.data;
      } catch (err) {
        console.error('Support reply failed:', err);
        throw err;
      }
    },
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
        <select value={priority} onChange={(e) => setPriority(e.target.value as 'all' | 'HIGH' | 'MEDIUM' | 'LOW')} style={adminUi.select}>
          <option value="all">All Priority</option>
          <option value="HIGH">HIGH</option>
          <option value="MEDIUM">MEDIUM</option>
          <option value="LOW">LOW</option>
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value as 'all' | 'payment' | 'safety' | 'weather' | 'technical' | 'other')} style={adminUi.select}>
          <option value="all">All Category</option>
          <option value="payment">payment</option>
          <option value="safety">safety</option>
          <option value="weather">weather</option>
          <option value="technical">technical</option>
          <option value="other">other</option>
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as 'score_desc' | 'created_desc')} style={adminUi.select}>
          <option value="score_desc">Score ↓</option>
          <option value="created_desc">Newest</option>
        </select>
        <button type="button" style={adminUi.btn} onClick={() => void q.refetch()}>
          Refresh
        </button>
      </div>

      <div style={adminUi.tableScroll}>
        <table style={{ ...adminUi.table, minWidth: 1320 }}>
          <thead>
            <tr>
              <th style={adminUi.th}>Ticket</th>
              <th style={adminUi.th}>Type</th>
              <th style={adminUi.th}>Priority</th>
              <th style={adminUi.th}>Category</th>
              <th style={adminUi.th}>Score</th>
              <th style={adminUi.th}>Reason</th>
              <th style={adminUi.th}>User ID</th>
              <th style={adminUi.th}>Message</th>
              <th style={adminUi.th}>System Response</th>
              <th style={adminUi.th}>Admin Reply</th>
              <th style={adminUi.th}>Status</th>
              <th style={adminUi.th}>Timestamp</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const tkt = String(r.ticket_no || `Q-${r.id}`);
              const qtype = String(r.query_type || 'custom');
              const msg = String(r.message || '');
              const reply = String(r.reply || '');
              const adminReply = String(r.admin_reply || '');
              const st = String(r.status || 'open');
              const ts = String(r.created_at || '');
              const pri = String(r.priority || 'LOW').toUpperCase();
              const priBg = pri === 'HIGH' ? 'rgba(220,38,38,0.2)' : pri === 'MEDIUM' ? 'rgba(234,179,8,0.22)' : 'rgba(22,163,74,0.18)';
              const priColor = pri === 'HIGH' ? '#b91c1c' : pri === 'MEDIUM' ? '#92400e' : '#166534';
              const cat = String(r.category || 'other');
              const score = Number(r.score || 0);
              const reason = String(r.reason || '');
              return (
                <tr key={r.id}>
                  <td style={adminUi.td}>{tkt}</td>
                  <td style={adminUi.td}>
                    <span style={{ ...adminUi.pill, background: qtype === 'ticket' ? 'rgba(30,64,175,0.18)' : 'rgba(22,163,74,0.14)' }}>
                      {qtype}
                    </span>
                  </td>
                  <td style={adminUi.td}>
                    <span style={{ ...adminUi.pill, background: priBg, fontWeight: 800, color: priColor, border: `1px solid ${priColor}33` }}>{pri}</span>
                  </td>
                  <td style={adminUi.td}>{cat}</td>
                  <td style={adminUi.td}>{score}</td>
                  <td style={adminUi.td}>{reason || '—'}</td>
                  <td style={adminUi.td}>{r.user_id}</td>
                  <td style={adminUi.td}>{msg}</td>
                  <td style={adminUi.td}>{reply}</td>
                  <td style={adminUi.td}>
                    <div style={{ display: 'grid', gap: 8 }}>
                      {adminReply ? (
                        <div style={{ fontSize: '0.8125rem', fontWeight: 700, color: '#0f172a' }}>{adminReply}</div>
                      ) : null}
                      <textarea
                        value={replyText[r.id] ?? ''}
                        onChange={(e) => setReplyText((s) => ({ ...s, [r.id]: e.target.value }))}
                        placeholder="Type admin reply..."
                        style={{
                          width: '100%',
                          minHeight: 74,
                          border: '1px solid #cbd5e1',
                          borderRadius: 10,
                          padding: 10,
                          background: '#f8fafc',
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
                    <span style={{ ...adminUi.pill, background: st === 'resolved' ? 'rgba(22,163,74,0.14)' : 'rgba(234,179,8,0.18)' }}>
                      {st}
                    </span>
                  </td>
                  <td style={adminUi.td}>{formatIstDateTime(ts)}</td>
                </tr>
              );
            })}
            {!rows.length ? (
              <tr>
                <td colSpan={12} style={adminUi.td}>
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

