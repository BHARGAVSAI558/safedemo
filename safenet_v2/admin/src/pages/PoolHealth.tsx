import React from 'react';
import { useQuery } from '@tanstack/react-query';

import api from '../api';
import { adminUi } from '../theme/adminUi';

type ZoneRow = {
  zone_name: string;
  city: string;
  risk_level: string;
  active_policies: number;
  premiums_week: number;
  payouts_week: number;
  loss_ratio: number;
  status: string;
};

type PoolHealthResponse = {
  total_premiums_week: number;
  total_payouts_week: number;
  reserve_pool: number;
  loss_ratio: number;
  loss_ratio_pct: number;
  status: string;
  zone_breakdown: ZoneRow[];
};

function statusPill(status: string) {
  const u = String(status || '').toUpperCase();
  if (u === 'HEALTHY') return { bg: '#dcfce7', fg: '#166534', label: 'HEALTHY' };
  if (u === 'WATCH') return { bg: '#fef9c3', fg: '#854d0e', label: 'WATCH' };
  if (u === 'CRITICAL') return { bg: '#fee2e2', fg: '#991b1b', label: 'CRITICAL' };
  return { bg: '#e5e7eb', fg: '#374151', label: status || '—' };
}

export default function PoolHealth() {
  const q = useQuery({
    queryKey: ['admin', 'pool-health'],
    queryFn: async (): Promise<PoolHealthResponse> => {
      const res = await api.get('/admin/pool-health');
      return res.data as PoolHealthResponse;
    },
    refetchInterval: 30_000,
    retry: 1,
  });

  const d = q.data;
  const lr = Number(d?.loss_ratio ?? 0);
  const lrPct = Math.min(100, Math.max(0, lr * 100));
  const barColor = lr < 0.5 ? '#22c55e' : lr < 0.65 ? '#eab308' : '#ef4444';
  const overall = statusPill(String(d?.status ?? ''));

  return (
    <div style={adminUi.page}>
      <p style={{ ...adminUi.sub, marginTop: 0 }}>
        Rolling 7-day payouts vs active policy weekly premiums (real database aggregates).
      </p>

      {q.isLoading ? (
        <div style={adminUi.card}>Loading pool health…</div>
      ) : q.isError ? (
        <div style={{ ...adminUi.card, borderColor: '#fecaca', background: '#fef2f2', color: '#b91c1c' }}>
          Could not load pool health.
        </div>
      ) : (
        <>
          <div style={{ ...adminUi.card, marginBottom: 20 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#64748b' }}>Loss ratio (payouts ÷ premiums book)</div>
                <div style={{ fontSize: 36, fontWeight: 900, color: '#0f172a', marginTop: 4 }}>
                  {lrPct.toFixed(1)}%
                </div>
              </div>
              <span
                style={{
                  padding: '6px 14px',
                  borderRadius: 999,
                  fontWeight: 800,
                  fontSize: 12,
                  background: overall.bg,
                  color: overall.fg,
                }}
              >
                {overall.label}
              </span>
            </div>
            <div style={{ position: 'relative', marginTop: 20 }}>
              <div style={{ height: 16, borderRadius: 8, background: '#f1f5f9', overflow: 'hidden' }}>
                <div
                  style={{
                    height: '100%',
                    width: `${lrPct}%`,
                    borderRadius: 8,
                    background: barColor,
                    transition: 'width 0.4s ease',
                  }}
                />
              </div>
              <div
                style={{
                  position: 'absolute',
                  left: '65%',
                  top: -4,
                  bottom: -4,
                  width: 2,
                  background: '#64748b',
                  pointerEvents: 'none',
                }}
              />
              <div style={{ fontSize: 11, color: '#64748b', marginTop: 6, fontWeight: 600 }}>
                Critical threshold marker at 65%
              </div>
            </div>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: 16,
              marginBottom: 24,
            }}
          >
            <div style={{ ...adminUi.card, background: '#eff6ff', borderColor: '#bfdbfe' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#1e40af' }}>Premiums This Week</div>
              <div style={{ fontSize: 24, fontWeight: 900, color: '#1e3a8a', marginTop: 8 }}>
                ₹{Number(d?.total_premiums_week ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
              </div>
              <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>Sum of weekly_premium on active policies</div>
            </div>
            <div style={{ ...adminUi.card, background: '#fff7ed', borderColor: '#fed7aa' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#c2410c' }}>Payouts This Week</div>
              <div style={{ fontSize: 24, fontWeight: 900, color: '#9a3412', marginTop: 8 }}>
                ₹{Number(d?.total_payouts_week ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
              </div>
              <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>Successful payout payments (7 days)</div>
            </div>
            <div style={{ ...adminUi.card, background: '#ecfdf5', borderColor: '#bbf7d0' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#166534' }}>Reserve Pool</div>
              <div style={{ fontSize: 28, fontWeight: 900, color: '#14532d', marginTop: 8 }}>
                ₹{Number(d?.reserve_pool ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
              </div>
              <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>Premiums book − payouts (window)</div>
            </div>
          </div>

          <div style={{ ...adminUi.card, padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--admin-border)' }}>
              <div style={adminUi.cardTitle}>Zone breakdown</div>
              <div style={{ ...adminUi.cardSub, marginBottom: 0 }}>Sorted by loss ratio (highest first)</div>
            </div>
            <div style={{ ...adminUi.tableScroll, maxHeight: 'min(560px, 60vh)' }}>
              <table style={{ ...adminUi.table, minWidth: 960 }}>
                <thead>
                  <tr>
                    <th style={adminUi.th}>Zone</th>
                    <th style={adminUi.th}>City</th>
                    <th style={adminUi.th}>Risk</th>
                    <th style={adminUi.th}>Policies</th>
                    <th style={adminUi.th}>Premiums</th>
                    <th style={adminUi.th}>Payouts</th>
                    <th style={adminUi.th}>Loss ratio</th>
                    <th style={adminUi.th}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(d?.zone_breakdown ?? []).map((row) => {
                    const zr = Number(row.loss_ratio ?? 0);
                    const zPct = Math.min(100, zr * 100);
                    const st = statusPill(row.status);
                    const critical = String(row.status).toUpperCase() === 'CRITICAL';
                    return (
                      <tr
                        key={`${row.zone_name}-${row.city}`}
                        style={critical ? { background: 'rgba(254, 226, 226, 0.55)' } : undefined}
                      >
                        <td style={{ ...adminUi.td, fontWeight: 700 }}>{row.zone_name}</td>
                        <td style={adminUi.td}>{row.city}</td>
                        <td style={adminUi.td}>{row.risk_level}</td>
                        <td style={adminUi.td}>{row.active_policies}</td>
                        <td style={adminUi.td}>₹{Number(row.premiums_week).toFixed(0)}</td>
                        <td style={adminUi.td}>₹{Number(row.payouts_week).toFixed(0)}</td>
                        <td style={adminUi.td}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div style={{ flex: 1, maxWidth: 120, height: 8, borderRadius: 4, background: '#e2e8f0' }}>
                              <div
                                style={{
                                  width: `${zPct}%`,
                                  height: '100%',
                                  borderRadius: 4,
                                  background: zr < 0.5 ? '#22c55e' : zr < 0.65 ? '#eab308' : '#ef4444',
                                }}
                              />
                            </div>
                            <span style={{ fontSize: 12, fontWeight: 700 }}>{(zr * 100).toFixed(1)}%</span>
                          </div>
                        </td>
                        <td style={adminUi.td}>
                          <span
                            style={{
                              padding: '4px 10px',
                              borderRadius: 999,
                              fontSize: 11,
                              fontWeight: 800,
                              background: st.bg,
                              color: st.fg,
                            }}
                          >
                            {st.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
