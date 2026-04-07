import React, { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import api from '../api';
import { WorkerDetailPanel, type WorkerDetailData } from '../components/WorkerDetailPanel';
import { adminUi } from '../theme/adminUi';
import { formatTierLabel } from '../utils/tier';

type WorkerRow = {
  worker_id: number;
  phone: string;
  phone_masked: string;
  zone: string;
  trust_score: number;
  coverage_tier: string;
  weekly_premium: number;
  claims_total: number;
  fraud_flags: number;
  status: string;
};

type WorkerListResponse = {
  data: WorkerRow[];
  total_count: number;
  page_size: number;
  next_cursor?: string | null;
};

export default function Workers() {
  const [q, setQ] = useState('');
  const [zone, setZone] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [debouncedZone, setDebouncedZone] = useState('');
  const [page, setPage] = useState(1);
  const [selectedWorkerId, setSelectedWorkerId] = useState<number | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedZone(zone), 300);
    return () => clearTimeout(t);
  }, [zone]);

  const workersQuery = useQuery({
    queryKey: ['admin', 'workers', debouncedQ, debouncedZone, page],
    queryFn: async (): Promise<WorkerListResponse> =>
      (await api.get('/admin/workers', { params: { q: debouncedQ, zone: debouncedZone, page, page_size: 200 } })).data,
    placeholderData: (prev) => prev,
  });

  const detailQuery = useQuery({
    queryKey: ['admin', 'workers', 'detail', selectedWorkerId],
    queryFn: async () => (await api.get(`/admin/workers/${selectedWorkerId}`)).data,
    enabled: selectedWorkerId !== null,
  });

  const rows = workersQuery.data?.data ?? [];
  const totalPages = Math.max(
    1,
    Math.ceil((workersQuery.data?.total_count ?? 0) / (workersQuery.data?.page_size ?? 12))
  );

  return (
    <div style={adminUi.page}>
      <header style={adminUi.pageHeader}>
        <h1 style={adminUi.h1}>Workers</h1>
        <p style={adminUi.sub}>Search and filter the worker registry. Select a row for profile, claims, and device data.</p>
      </header>

      {workersQuery.isError ? (
        <div
          style={{
            ...adminUi.card,
            marginBottom: 16,
            borderColor: '#fecaca',
            background: '#fef2f2',
            color: '#b91c1c',
            fontWeight: 600,
            fontSize: '0.875rem',
          }}
        >
          Could not load workers.{' '}
          <button type="button" style={{ ...adminUi.btnPrimary, marginTop: 10, display: 'inline-block' }} onClick={() => void workersQuery.refetch()}>
            Retry
          </button>
        </div>
      ) : null}

      <div style={{ ...adminUi.toolbar, marginBottom: 8 }}>
        <input
          style={adminUi.input}
          placeholder="Search phone or worker ID"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search workers"
        />
        <input
          style={{ ...adminUi.input, flex: '0 1 220px' }}
          placeholder="Zone filter (e.g. hyd)"
          value={zone}
          onChange={(e) => setZone(e.target.value)}
          aria-label="Filter by zone"
        />
        <button type="button" style={adminUi.btnPrimary} onClick={() => setPage(1)}>
          Apply filters
        </button>
      </div>

      <div style={adminUi.tableScroll}>
        <table style={{ ...adminUi.table, minWidth: 900 }}>
          <thead>
            <tr>
              <th style={adminUi.th}>Phone</th>
              <th style={adminUi.th}>Zone</th>
              <th style={adminUi.th}>Trust</th>
              <th style={adminUi.th}>Tier</th>
              <th style={adminUi.th}>Premium / wk</th>
              <th style={adminUi.th}>Claims</th>
              <th style={adminUi.th}>Fraud flags</th>
              <th style={adminUi.th}>Status</th>
            </tr>
          </thead>
          <tbody>
            {workersQuery.isFetching && rows.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ ...adminUi.td, textAlign: 'center', padding: 32 }}>
                  Loading…
                </td>
              </tr>
            ) : null}
            {rows.map((row) => (
              <tr
                key={row.worker_id}
                style={adminUi.trHover}
                onClick={() => setSelectedWorkerId(row.worker_id)}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--admin-row-hover)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                }}
              >
                <td style={adminUi.td}>{row.phone_masked}</td>
                <td style={adminUi.td}>{row.zone}</td>
                <td style={adminUi.td}>{row.trust_score.toFixed(2)}</td>
                <td style={adminUi.td}>{formatTierLabel(row.coverage_tier)}</td>
                <td style={adminUi.td}>₹{row.weekly_premium.toFixed(0)}</td>
                <td style={adminUi.td}>{row.claims_total}</td>
                <td style={adminUi.td}>{row.fraud_flags}</td>
                <td style={adminUi.td}>
                  <span
                    style={{
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      padding: '4px 8px',
                      borderRadius: 6,
                      background: 'var(--admin-bg-subtle)',
                      border: '1px solid var(--admin-border)',
                    }}
                  >
                    {row.status}
                  </span>
                </td>
              </tr>
            ))}
            {!workersQuery.isFetching && rows.length === 0 ? (
              <tr>
                <td colSpan={8} style={adminUi.td}>
                  <div style={adminUi.empty}>No workers match your filters.</div>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div style={{ ...adminUi.toolbar, marginTop: 16, justifyContent: 'flex-start' }}>
        <button type="button" style={adminUi.btn} disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
          Previous
        </button>
        <span style={{ fontSize: '0.875rem', fontWeight: 700, color: 'var(--admin-muted)' }}>
          Page {page} of {totalPages}
        </span>
        <button type="button" style={adminUi.btn} disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
          Next
        </button>
      </div>

      {selectedWorkerId ? (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.45)',
            zIndex: 50,
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'stretch',
          }}
          onClick={() => setSelectedWorkerId(null)}
          role="presentation"
        >
          <div
            style={{
              width: 'min(560px, 100vw)',
              height: '100%',
              overflow: 'auto',
              background: 'var(--admin-drawer-surface)',
              padding: 24,
              borderLeft: '1px solid var(--admin-border)',
              boxShadow: '-8px 0 32px rgba(15,23,42,0.18)',
            }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="worker-drawer-title"
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 20,
                paddingBottom: 16,
                borderBottom: '1px solid var(--admin-border)',
              }}
            >
              <h2 id="worker-drawer-title" style={{ margin: 0, fontSize: '1.125rem', fontWeight: 800, color: 'var(--admin-text)' }}>
                Worker #{selectedWorkerId}
              </h2>
              <button type="button" style={adminUi.btn} onClick={() => setSelectedWorkerId(null)}>
                Close
              </button>
            </div>

            {detailQuery.isLoading ? (
              <p style={{ color: 'var(--admin-muted)', fontWeight: 600 }}>Loading details…</p>
            ) : detailQuery.error ? (
              <p style={{ color: '#b91c1c', fontWeight: 600 }}>
                Failed to load.{' '}
                <button type="button" style={adminUi.btnPrimary} onClick={() => void detailQuery.refetch()}>
                  Retry
                </button>
              </p>
            ) : detailQuery.data ? (
              <WorkerDetailPanel data={detailQuery.data as WorkerDetailData} />
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
