import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../api';
import { adminUi } from '../theme/adminUi';

type ProfileResponse = {
  id: number;
  user_id: number;
  name: string;
  city: string;
  occupation: string;
  avg_daily_income: number;
  risk_profile: string;
  trust_score: number;
  total_claims: number;
  total_payouts: number;
  created_at: string | null;
};

type UserAdminResponse = {
  id: number;
  phone: string;
  is_active: boolean;
  is_admin: boolean;
  created_at: string | null;
  profile: ProfileResponse | null;
};

export default function Users() {
  const qc = useQueryClient();
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  const usersQuery = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: async (): Promise<UserAdminResponse[]> => {
      try {
        const res = await api.get('/admin/users');
        return Array.isArray(res.data) ? res.data : [];
      } catch (err) {
        console.error('Users fetch failed:', err);
        return [];
      }
    },
    refetchInterval: 60_000,
    retry: 1,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      try {
        const res = await api.delete(`/admin/users/${id}`);
        return res.data;
      } catch (err) {
        console.error('User delete failed:', err);
        throw err;
      }
    },
    onSuccess: () => {
      setConfirmDeleteId(null);
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
  });

  const users = Array.isArray(usersQuery.data) ? usersQuery.data : [];

  if (usersQuery.isLoading && !usersQuery.data) {
    return <div style={{ ...adminUi.page, ...adminUi.empty }}>Loading users…</div>;
  }

  if (usersQuery.isError) {
    return (
      <div style={adminUi.page}>
        <header style={adminUi.pageHeader}>
          <h1 style={adminUi.h1}>Users</h1>
        </header>
        <div style={{ ...adminUi.card, borderColor: '#fecaca', background: '#fef2f2', color: '#b91c1c', fontWeight: 600 }}>
          Could not load users.{' '}
          <button type="button" style={{ ...adminUi.btnPrimary, marginTop: 10 }} onClick={() => void usersQuery.refetch()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={adminUi.page}>
      <header style={adminUi.pageHeader}>
        <h1 style={adminUi.h1}>Users</h1>
        <p style={adminUi.sub}>{users.length} registered workers</p>
      </header>

      <div style={adminUi.tableScroll}>
        <table style={{ ...adminUi.table, minWidth: 1000 }}>
          <thead>
            <tr>
              <th style={adminUi.th}>ID</th>
              <th style={adminUi.th}>Phone</th>
              <th style={adminUi.th}>Name</th>
              <th style={adminUi.th}>City</th>
              <th style={adminUi.th}>Occupation</th>
              <th style={adminUi.th}>Avg Income</th>
              <th style={adminUi.th}>Trust Score</th>
              <th style={adminUi.th}>Total Payouts</th>
              <th style={adminUi.th}>Status</th>
              <th style={adminUi.th}>Joined</th>
              <th style={adminUi.th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 ? (
              <tr>
                <td colSpan={11} style={adminUi.td}>
                  <div style={adminUi.empty}>{usersQuery.isLoading ? 'Loading…' : 'No users found.'}</div>
                </td>
              </tr>
            ) : null}
            {users.map((u) => {
              const trust = typeof u.profile?.trust_score === 'number' ? u.profile.trust_score : null;
              const trustDisplay = trust !== null ? (trust <= 1.0 ? trust * 100 : trust) : null;
              const income = Number(u.profile?.avg_daily_income ?? 0);
              const payouts = Number(u.profile?.total_payouts ?? 0);
              return (
                <tr
                  key={u.id}
                  style={adminUi.trHover}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--admin-bg-subtle)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <td style={adminUi.td}>{u.id}</td>
                  <td style={adminUi.td}>{String(u.phone || '—')}</td>
                  <td style={adminUi.td}>{String(u.profile?.name || '—')}</td>
                  <td style={adminUi.td}>{String(u.profile?.city || '—')}</td>
                  <td style={adminUi.td}>{String(u.profile?.occupation || '—')}</td>
                  <td style={adminUi.td}>₹{Number.isFinite(income) ? income.toFixed(0) : '—'}</td>
                  <td style={adminUi.td}>
                    {trustDisplay !== null ? (
                      <span style={{
                        fontWeight: 700,
                        color: trustDisplay >= 70 ? '#16a34a' : trustDisplay >= 40 ? '#d97706' : '#dc2626',
                      }}>
                        {trustDisplay.toFixed(1)}
                      </span>
                    ) : '—'}
                  </td>
                  <td style={adminUi.td}>₹{Number.isFinite(payouts) ? payouts.toFixed(0) : '0'}</td>
                  <td style={adminUi.td}>
                    <span style={{
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      padding: '4px 8px',
                      borderRadius: 6,
                      background: u.is_active ? 'rgba(22,163,74,0.12)' : 'rgba(220,38,38,0.1)',
                      color: u.is_active ? '#15803d' : '#b91c1c',
                    }}>
                      {u.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td style={adminUi.td}>{u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}</td>
                  <td style={adminUi.td}>
                    {confirmDeleteId === u.id ? (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          type="button"
                          style={adminUi.btnDanger}
                          disabled={deleteMutation.isPending}
                          onClick={() => deleteMutation.mutate(u.id)}
                        >
                          {deleteMutation.isPending ? 'Deleting…' : 'Confirm'}
                        </button>
                        <button type="button" style={adminUi.btnMuted} onClick={() => setConfirmDeleteId(null)}>
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button type="button" style={adminUi.btnDanger} onClick={() => setConfirmDeleteId(u.id)}>
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
