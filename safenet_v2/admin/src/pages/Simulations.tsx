import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '../api';
import { adminUi } from '../theme/adminUi';
import { formatIstDateTime } from '../utils/adminDate';

export default function Simulations() {
  const fallbackTxn = (id: number) => {
    const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let x = Math.max(1, Number(id || 0)) * 7919 + 97;
    let out = '';
    while (x > 0) {
      const r = x % 36;
      out = chars[r] + out;
      x = Math.floor(x / 36);
    }
    return `CLM-${out || '0'}`;
  };
  const [zoneId, setZoneId] = useState('hyd_central');
  const [disruptionType, setDisruptionType] = useState('Heavy Rain');
  const [fraudScenario, setFraudScenario] = useState('none');
  const [workers, setWorkers] = useState(10);
  const [running, setRunning] = useState(false);

  const simulationsQuery = useQuery({
    queryKey: ['admin', 'simulations'],
    queryFn: async () => {
      try {
        const res = await api.get('/admin/simulations?limit=100');
        return Array.isArray(res.data) ? res.data : [];
      } catch (err) {
        console.error('Simulations fetch failed:', err);
        return [];
      }
    },
    refetchInterval: 20_000,
    retry: 1,
  });

  const runSimulation = async () => {
    setRunning(true);
    try {
      await api.post('/admin/simulations/run', {
        zone_id: zoneId,
        disruption_type: disruptionType,
        fraud_scenario: fraudScenario,
        workers,
      });
      await simulationsQuery.refetch();
    } finally {
      setRunning(false);
    }
  };

  const sims = useMemo(() => Array.isArray(simulationsQuery.data) ? simulationsQuery.data : [], [simulationsQuery.data]);

  return (
    <div style={adminUi.page}>
      <header style={adminUi.pageHeader}>
        <h1 style={adminUi.h1}>Simulations</h1>
        <p style={adminUi.sub}>Run scenario batches and inspect recent outcomes. List auto-refreshes.</p>
      </header>

      <div style={{ ...adminUi.card, marginBottom: 20 }}>
        <div style={adminUi.cardTitle}>Run scenario</div>
        <div style={{ ...adminUi.cardSub, marginBottom: 12 }}>Zone, disruption, fraud pattern, worker count.</div>
        <div className="admin-sim-form">
          <input
            style={{ ...adminUi.input, flex: '1 1 160px', minWidth: 0 }}
            value={zoneId}
            onChange={(e) => setZoneId(e.target.value)}
            placeholder="Zone ID"
            aria-label="Zone ID"
          />
          <select style={adminUi.select} value={disruptionType} onChange={(e) => setDisruptionType(e.target.value)}>
            <option>Heavy Rain</option>
            <option>Extreme Heat</option>
            <option>AQI Spike</option>
            <option>Curfew</option>
            <option>Platform Outage</option>
          </select>
          <select style={adminUi.select} value={fraudScenario} onChange={(e) => setFraudScenario(e.target.value)}>
            <option value="none">No fraud scenario</option>
            <option value="gps_spoof">GPS spoof</option>
            <option value="ring_fraud">Ring fraud</option>
          </select>
          <input
            style={{ ...adminUi.input, flex: '0 0 100px', minWidth: 80 }}
            type="number"
            min={1}
            max={100}
            value={workers}
            onChange={(e) => setWorkers(Number(e.target.value))}
            aria-label="Worker count"
          />
          <button type="button" style={adminUi.btnPrimary} disabled={running} onClick={() => void runSimulation()}>
            {running ? 'Running…' : 'Run simulation'}
          </button>
        </div>
      </div>

      <div style={adminUi.cardTitle}>Recent simulations</div>
      <p style={{ ...adminUi.cardSub, marginTop: 4, marginBottom: 12 }}>Latest 100 from API.</p>

      <div style={adminUi.tableScroll}>
        <table style={{ ...adminUi.table, minWidth: 720 }}>
          <thead>
            <tr>
              <th style={adminUi.th}>ID</th>
              <th style={adminUi.th}>Transaction</th>
              <th style={adminUi.th}>User</th>
              <th style={adminUi.th}>Decision</th>
              <th style={adminUi.th}>Payout</th>
              <th style={adminUi.th}>Fraud</th>
              <th style={adminUi.th}>Reason</th>
              <th style={adminUi.th}>Created</th>
            </tr>
          </thead>
          <tbody>
            {sims.map((s: { id: number; transaction_id?: string; user_id: number; decision: string; payout: number; fraud_score: number; reason?: string; created_at: string }) => {
              const payout = Number(s.payout ?? 0);
              const fraud = Number(s.fraud_score ?? 0);
              return (
                <tr key={s.id}>
                  <td style={adminUi.td}>{s.id}</td>
                  <td style={adminUi.td}>{s.transaction_id || fallbackTxn(s.id)}</td>
                  <td style={adminUi.td}>{s.user_id}</td>
                  <td style={adminUi.td}>
                    <span
                      style={{
                        fontSize: '0.75rem',
                        fontWeight: 700,
                        padding: '4px 8px',
                        borderRadius: 6,
                        background:
                          String(s.decision).toUpperCase().includes('APPROV')
                            ? 'rgba(22, 163, 74, 0.14)'
                            : String(s.decision).toUpperCase().includes('FRAUD')
                              ? 'rgba(220, 38, 38, 0.12)'
                              : 'var(--admin-bg-subtle)',
                        color:
                          String(s.decision).toUpperCase().includes('APPROV')
                            ? '#15803d'
                            : String(s.decision).toUpperCase().includes('FRAUD')
                              ? '#b91c1c'
                              : 'var(--admin-text)',
                      }}
                    >
                      {s.decision}
                    </span>
                  </td>
                  <td style={adminUi.td}>₹{Number.isFinite(payout) ? payout.toFixed(0) : '0'}</td>
                  <td style={adminUi.td}>{Number.isFinite(fraud) ? fraud.toFixed(2) : '0.00'}</td>
                  <td style={adminUi.td}>{String(s.reason || '—')}</td>
                  <td style={{ ...adminUi.td, whiteSpace: 'nowrap' }}>{formatIstDateTime(s.created_at)}</td>
                </tr>
              );
            })}
            {sims.length === 0 ? (
              <tr>
                <td colSpan={8} style={adminUi.td}>
                  <div style={adminUi.empty}>{simulationsQuery.isLoading ? 'Loading simulations...' : 'No simulations yet.'}</div>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
