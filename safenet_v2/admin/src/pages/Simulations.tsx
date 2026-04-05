import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '../api';
import { adminUi } from '../theme/adminUi';

export default function Simulations() {
  const [zoneId, setZoneId] = useState('hyd_central');
  const [disruptionType, setDisruptionType] = useState('Heavy Rain');
  const [fraudScenario, setFraudScenario] = useState('none');
  const [workers, setWorkers] = useState(10);
  const [running, setRunning] = useState(false);

  const simulationsQuery = useQuery({
    queryKey: ['admin', 'simulations'],
    queryFn: async () => (await api.get('/admin/simulations?limit=100')).data,
    refetchInterval: 20_000,
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

  const sims = useMemo(() => simulationsQuery.data ?? [], [simulationsQuery.data]);

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
              <th style={adminUi.th}>User</th>
              <th style={adminUi.th}>Decision</th>
              <th style={adminUi.th}>Payout</th>
              <th style={adminUi.th}>Fraud</th>
              <th style={adminUi.th}>Created</th>
            </tr>
          </thead>
          <tbody>
            {sims.map((s: { id: number; user_id: number; decision: string; payout: number; fraud_score: number; created_at: string }) => (
              <tr key={s.id}>
                <td style={adminUi.td}>{s.id}</td>
                <td style={adminUi.td}>{s.user_id}</td>
                <td style={adminUi.td}>
                  <span
                    style={{
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      padding: '4px 8px',
                      borderRadius: 6,
                      background: 'var(--admin-bg-subtle)',
                    }}
                  >
                    {s.decision}
                  </span>
                </td>
                <td style={adminUi.td}>₹{Number(s.payout).toFixed(0)}</td>
                <td style={adminUi.td}>{Number(s.fraud_score).toFixed(2)}</td>
                <td style={{ ...adminUi.td, whiteSpace: 'nowrap' }}>{new Date(s.created_at).toLocaleString()}</td>
              </tr>
            ))}
            {sims.length === 0 ? (
              <tr>
                <td colSpan={6} style={adminUi.td}>
                  <div style={adminUi.empty}>No simulations yet.</div>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
