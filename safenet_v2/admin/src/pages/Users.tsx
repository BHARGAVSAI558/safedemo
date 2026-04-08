import React, { useEffect, useState } from 'react';
import api from '../api';

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
  const [users, setUsers] = useState<UserAdminResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const loadUsers = () => {
    setLoading(true);
    api
      .get('/admin/users')
      .then((r) => {
        setUsers(r.data);
      })
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.error(e);
      })
      .finally(() => {
        setLoading(false);
      });
  };

  useEffect(() => {
    let mounted = true;
    if (!mounted) return;
    loadUsers();
    return () => {
      mounted = false;
    };
  }, []);

  const onDeleteUser = async (id: number) => {
    if (!window.confirm(`Delete user ${id} and all related data? This cannot be undone.`)) return;
    setDeletingId(id);
    try {
      await api.delete(`/admin/users/${id}`);
      loadUsers();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(e);
      window.alert('Could not delete user. Try again.');
    } finally {
      setDeletingId(null);
    }
  };

  if (loading) return <div style={styles.loading}>Loading users...</div>;

  return (
    <div>
      <h1 style={styles.title}>Users</h1>
      <p style={styles.sub}>{users.length} registered workers</p>

      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr style={styles.thead}>
              <th style={styles.th}>ID</th>
              <th style={styles.th}>Phone</th>
              <th style={styles.th}>Name</th>
              <th style={styles.th}>City</th>
              <th style={styles.th}>Occupation</th>
              <th style={styles.th}>Avg Income</th>
              <th style={styles.th}>Trust Score</th>
              <th style={styles.th}>Total Payouts</th>
              <th style={styles.th}>Status</th>
              <th style={styles.th}>Joined</th>
              <th style={styles.th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} style={styles.tr}>
                <td style={styles.td}>{u.id}</td>
                <td style={styles.td}>{u.phone}</td>
                <td style={styles.td}>{u.profile?.name || '—'}</td>
                <td style={styles.td}>{u.profile?.city || '—'}</td>
                <td style={styles.td}>{u.profile?.occupation || '—'}</td>
                <td style={styles.td}>Rs.{u.profile?.avg_daily_income || '—'}</td>
                <td style={styles.td}>
                  <span
                    style={{
                      color: (u.profile?.trust_score ?? 0) >= 0.8 ? '#2e7d32' : '#e65100',
                      fontWeight: 700,
                    }}
                  >
                    {typeof u.profile?.trust_score === 'number' ? u.profile.trust_score.toFixed(2) : '—'}
                  </span>
                </td>
                <td style={styles.td}>Rs.{typeof u.profile?.total_payouts === 'number' ? u.profile.total_payouts.toFixed(0) : 0}</td>
                <td style={styles.td}>
                  <span
                    style={{
                      ...styles.badge,
                      backgroundColor: u.is_active ? '#e8f5e9' : '#ffebee',
                      color: u.is_active ? '#2e7d32' : '#c62828',
                    }}
                  >
                    {u.is_active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td style={styles.td}>{u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}</td>
                <td style={styles.td}>
                  <button
                    type="button"
                    style={styles.deleteBtn}
                    disabled={deletingId === u.id}
                    onClick={() => onDeleteUser(u.id)}
                  >
                    {deletingId === u.id ? 'Deleting…' : 'Delete'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  title: { fontSize: 24, fontWeight: 800, color: '#1a1a2e', margin: 0 },
  sub: { color: '#888', fontSize: 14, marginBottom: 24 },
  tableWrap: {
    backgroundColor: '#fff',
    borderRadius: 12,
    overflow: 'hidden',
    boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
  },
  table: { width: '100%', borderCollapse: 'collapse' },
  thead: { backgroundColor: '#f5f5f5' },
  th: { padding: '12px 16px', textAlign: 'left', fontSize: 12, fontWeight: 700, color: '#555', textTransform: 'uppercase' },
  tr: { borderBottom: '1px solid #f0f0f0' },
  td: { padding: '12px 16px', fontSize: 13, color: '#333' },
  badge: { padding: '3px 10px', borderRadius: 20, fontSize: 12, fontWeight: 700 },
  deleteBtn: {
    backgroundColor: '#fee2e2',
    color: '#b91c1c',
    border: '1px solid #fecaca',
    borderRadius: 8,
    padding: '6px 10px',
    fontWeight: 700,
    cursor: 'pointer',
  },
  loading: { textAlign: 'center', padding: 60, color: '#888' },
};

