import React from 'react';

import { formatIstDateTime } from '../utils/adminDate';

type Profile = {
  name?: string;
  city?: string;
  occupation?: string;
  risk_profile?: string;
  avg_daily_income?: number;
  trust_score?: number;
  total_claims?: number;
  total_payouts?: number;
};

type ClaimRow = {
  id?: number;
  claim_id?: number;
  decision?: string;
  payout?: number;
  fraud_score?: number;
  fraud_flag?: boolean;
  reason?: string;
  expected_income?: number;
  actual_income?: number;
  loss?: number;
  final_disruption?: boolean;
  weather_data?: unknown;
  created_at?: string | null;
};

type GpsPoint = { lat: number; lon: number; timestamp: string };
type TrustPoint = { label: string; score: number };

export type WorkerDetailData = {
  worker_id: number;
  phone?: string;
  phone_masked?: string;
  profile?: Profile | Record<string, unknown>;
  claim_history?: ClaimRow[];
  gps_trail?: GpsPoint[];
  trust_timeline?: TrustPoint[];
  device_fingerprint?: Record<string, unknown> | null;
};

const sectionShell: React.CSSProperties = {
  borderRadius: 12,
  border: '1px solid rgba(59, 130, 246, 0.18)',
  background: 'linear-gradient(145deg, rgba(255,255,255,0.95) 0%, rgba(241,245,249,0.92) 100%)',
  borderLeft: '3px solid var(--admin-primary)',
  padding: '14px 16px',
  boxShadow: '0 2px 8px rgba(15, 23, 42, 0.06)',
};

const sectionTitle: React.CSSProperties = {
  fontSize: '0.6875rem',
  fontWeight: 800,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: 'var(--admin-muted)',
  margin: '0 0 12px',
};

const labelStyle: React.CSSProperties = {
  fontSize: '0.75rem',
  fontWeight: 700,
  color: 'var(--admin-muted)',
  marginBottom: 4,
};

const valueStyle: React.CSSProperties = {
  fontSize: '0.875rem',
  fontWeight: 600,
  color: 'var(--admin-text)',
};

function decisionTone(d: string): { bg: string; color: string } {
  const u = d.toUpperCase();
  if (u.includes('APPROV')) return { bg: 'rgba(22, 163, 74, 0.14)', color: '#15803d' };
  if (u.includes('FRAUD') || u.includes('BLOCK')) return { bg: 'rgba(220, 38, 38, 0.12)', color: '#b91c1c' };
  if (u.includes('REJECT')) return { bg: 'rgba(234, 179, 8, 0.18)', color: '#a16207' };
  return { bg: 'var(--admin-bg-subtle)', color: 'var(--admin-text)' };
}

function ProfileSection({ profile }: { profile: Profile | Record<string, unknown> }) {
  const p = profile as Profile;
  const rows: { label: string; value: React.ReactNode }[] = [
    { label: 'Name', value: p.name ?? '—' },
    { label: 'City / zone', value: p.city ?? '—' },
    { label: 'Occupation', value: p.occupation ?? '—' },
    { label: 'Risk profile', value: p.risk_profile ?? '—' },
    {
      label: 'Avg. daily income',
      value: typeof p.avg_daily_income === 'number' ? `₹${p.avg_daily_income.toLocaleString('en-IN')}` : '—',
    },
    {
      label: 'Trust score',
      value: typeof p.trust_score === 'number' ? p.trust_score.toFixed(2) : '—',
    },
    {
      label: 'Total claims',
      value: typeof p.total_claims === 'number' ? String(p.total_claims) : '—',
    },
    {
      label: 'Total payouts',
      value: typeof p.total_payouts === 'number' ? `₹${Number(p.total_payouts).toLocaleString('en-IN')}` : '—',
    },
  ];

  return (
    <section style={sectionShell}>
      <h3 style={sectionTitle}>Profile</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 20px' }}>
        {rows.map((row) => (
          <div key={row.label}>
            <div style={labelStyle}>{row.label}</div>
            <div style={valueStyle}>{row.value}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ClaimHistorySection({ claims }: { claims: ClaimRow[] }) {
  if (!claims.length) {
    return (
      <section style={sectionShell}>
        <h3 style={sectionTitle}>Claim history</h3>
        <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--admin-muted)', fontWeight: 600 }}>No claims yet.</p>
      </section>
    );
  }

  return (
    <section style={sectionShell}>
      <h3 style={sectionTitle}>Claim history</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {claims.map((c) => {
          const id = c.claim_id ?? c.id ?? '—';
          const dec = String(c.decision ?? '—');
          const tone = decisionTone(dec);
          return (
            <div
              key={String(id)}
              style={{
                padding: 12,
                borderRadius: 10,
                background: 'rgba(255,255,255,0.7)',
                border: '1px solid var(--admin-border-subtle)',
              }}
            >
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontWeight: 800, fontSize: '0.8125rem', color: 'var(--admin-text)' }}>Claim #{id}</span>
                <span
                  style={{
                    fontSize: '0.6875rem',
                    fontWeight: 800,
                    padding: '4px 8px',
                    borderRadius: 6,
                    background: tone.bg,
                    color: tone.color,
                  }}
                >
                  {dec}
                </span>
                <span style={{ fontSize: '0.8125rem', fontWeight: 700, color: 'var(--admin-text)' }}>
                  ₹{Number(c.payout ?? 0).toFixed(0)}
                </span>
                <span style={{ fontSize: '0.75rem', color: 'var(--admin-muted)' }}>
                  Fraud {Number(c.fraud_score ?? 0).toFixed(2)}
                </span>
              </div>
              {c.reason ? (
                <p style={{ margin: '0 0 8px', fontSize: '0.8125rem', lineHeight: 1.45, color: 'var(--admin-text)' }}>
                  {c.reason}
                </p>
              ) : null}
              <div style={{ fontSize: '0.75rem', color: 'var(--admin-muted)', fontWeight: 600 }}>
                {formatIstDateTime(c.created_at ?? undefined)}
              </div>
              {c.weather_data != null && typeof c.weather_data === 'object' && Object.keys(c.weather_data as object).length ? (
                <details style={{ marginTop: 8 }}>
                  <summary style={{ cursor: 'pointer', fontSize: '0.75rem', fontWeight: 700, color: 'var(--admin-primary)' }}>
                    Weather context
                  </summary>
                  <pre
                    style={{
                      margin: '8px 0 0',
                      padding: 10,
                      fontSize: 11,
                      borderRadius: 8,
                      background: 'var(--admin-bg-subtle)',
                      overflow: 'auto',
                      maxHeight: 120,
                    }}
                  >
                    {JSON.stringify(c.weather_data, null, 2)}
                  </pre>
                </details>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function GpsSection({ points }: { points: GpsPoint[] }) {
  if (!points.length) {
    return (
      <section style={sectionShell}>
        <h3 style={sectionTitle}>GPS trail</h3>
        <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--admin-muted)', fontWeight: 600 }}>No trail data.</p>
      </section>
    );
  }

  return (
    <section style={sectionShell}>
      <h3 style={sectionTitle}>GPS trail (sample)</h3>
      <div style={{ overflow: 'auto', maxHeight: 200 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '6px 8px', color: 'var(--admin-muted)', fontWeight: 800 }}>Lat</th>
              <th style={{ textAlign: 'left', padding: '6px 8px', color: 'var(--admin-muted)', fontWeight: 800 }}>Lon</th>
              <th style={{ textAlign: 'left', padding: '6px 8px', color: 'var(--admin-muted)', fontWeight: 800 }}>Time (IST)</th>
            </tr>
          </thead>
          <tbody>
            {points.map((pt, i) => (
              <tr key={i}>
                <td style={{ padding: '6px 8px', borderTop: '1px solid var(--admin-border-subtle)' }}>{pt.lat.toFixed(5)}</td>
                <td style={{ padding: '6px 8px', borderTop: '1px solid var(--admin-border-subtle)' }}>{pt.lon.toFixed(5)}</td>
                <td style={{ padding: '6px 8px', borderTop: '1px solid var(--admin-border-subtle)', whiteSpace: 'nowrap' }}>
                  {formatIstDateTime(pt.timestamp)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TrustSection({ points }: { points: TrustPoint[] }) {
  if (!points.length) {
    return (
      <section style={sectionShell}>
        <h3 style={sectionTitle}>Trust timeline</h3>
        <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--admin-muted)', fontWeight: 600 }}>No trust history.</p>
      </section>
    );
  }
  const max = Math.max(...points.map((p) => p.score), 1);

  return (
    <section style={sectionShell}>
      <h3 style={sectionTitle}>Trust timeline</h3>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 100, paddingTop: 8 }}>
        {points.map((pt, i) => (
          <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <div
              title={`${pt.label}: ${pt.score.toFixed(1)}`}
              style={{
                width: '100%',
                maxWidth: 40,
                height: `${Math.max(8, (pt.score / max) * 72)}px`,
                borderRadius: '6px 6px 0 0',
                background: 'linear-gradient(180deg, var(--admin-primary) 0%, #1e3a8a 100%)',
              }}
            />
            <span style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--admin-muted)' }}>{pt.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

const DEVICE_LABELS: Record<string, string> = {
  fingerprint_hash: 'Fingerprint hash',
  model_name: 'Model',
  os_version: 'OS',
  platform_api_level: 'API level',
  screen_width: 'Screen W',
  screen_height: 'Screen H',
  app_version: 'App version',
  network_type_at_enrollment: 'Network at enrollment',
  battery_level: 'Battery',
  updated_at: 'Updated',
  created_at: 'Registered',
};

function DeviceSection({ device }: { device: Record<string, unknown> | null | undefined }) {
  if (!device || typeof device !== 'object') {
    return (
      <section style={sectionShell}>
        <h3 style={sectionTitle}>Device fingerprint</h3>
        <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--admin-muted)', fontWeight: 600 }}>No device on file.</p>
      </section>
    );
  }

  const entries = Object.entries(device).filter(([, v]) => v != null && v !== '');

  return (
    <section style={sectionShell}>
      <h3 style={sectionTitle}>Device fingerprint</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 16px' }}>
        {entries.map(([k, v]) => (
          <div key={k}>
            <div style={labelStyle}>{DEVICE_LABELS[k] ?? k.replace(/_/g, ' ')}</div>
            <div style={valueStyle}>
              {k.endsWith('_at') && typeof v === 'string' ? formatIstDateTime(v) : String(v)}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function WorkerDetailPanel({ data }: { data: WorkerDetailData }) {
  const profile = data.profile && Object.keys(data.profile).length ? data.profile : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div
        style={{
          padding: '12px 14px',
          borderRadius: 10,
          background: 'rgba(29, 78, 216, 0.08)',
          border: '1px solid rgba(29, 78, 216, 0.2)',
        }}
      >
        <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--admin-muted)' }}>Contact</div>
        <div style={{ fontSize: '0.9375rem', fontWeight: 800, color: 'var(--admin-text)', marginTop: 4 }}>{data.phone_masked ?? '—'}</div>
        {data.phone ? (
          <div style={{ fontSize: '0.8125rem', color: 'var(--admin-muted)', marginTop: 4, fontWeight: 600 }}>Full: {data.phone}</div>
        ) : null}
      </div>

      {profile ? <ProfileSection profile={profile} /> : (
        <section style={sectionShell}>
          <h3 style={sectionTitle}>Profile</h3>
          <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--admin-muted)', fontWeight: 600 }}>No profile data.</p>
        </section>
      )}

      <ClaimHistorySection claims={Array.isArray(data.claim_history) ? data.claim_history : []} />
      <GpsSection points={Array.isArray(data.gps_trail) ? data.gps_trail : []} />
      <TrustSection points={Array.isArray(data.trust_timeline) ? data.trust_timeline : []} />
      <DeviceSection device={data.device_fingerprint} />
    </div>
  );
}
