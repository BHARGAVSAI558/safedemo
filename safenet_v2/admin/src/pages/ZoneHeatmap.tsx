import React, { useMemo, useState, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { GeoJSON, MapContainer, Popup, TileLayer } from 'react-leaflet';
import type { FeatureCollection } from 'geojson';
import 'leaflet/dist/leaflet.css';

import api from '../api';
import { adminUi } from '../theme/adminUi';
import { useZoneEventsStore } from '../stores/zoneEvents';

type ZoneSummary = {
  zone_id: string;
  city: string;
  active_workers: number;
  pool_balance: number;
  utilization_pct: number;
  last_disruption: string;
  claim_density_per_hr: number;
};

export default function ZoneHeatmap() {
  const [showWeather, setShowWeather] = useState(true);
  const [showAqi, setShowAqi] = useState(true);
  const [showFraudClusters, setShowFraudClusters] = useState(true);
  const zoneEvents = useZoneEventsStore((s) => s.latestByZone);

  const geoQuery = useQuery({
    queryKey: ['admin', 'zones', 'geojson'],
    queryFn: async (): Promise<FeatureCollection> => (await api.get('/admin/zones/geojson')).data,
  });

  const summaryQuery = useQuery({
    queryKey: ['admin', 'zones', 'summary'],
    queryFn: async (): Promise<ZoneSummary[]> => (await api.get('/admin/zones/summary')).data,
    refetchInterval: 30_000,
  });

  const summaryByZone = useMemo(() => {
    const by: Record<string, ZoneSummary> = {};
    for (const row of summaryQuery.data ?? []) by[row.zone_id] = row;
    return by;
  }, [summaryQuery.data]);

  const fillForFeature = (feature: { properties?: Record<string, unknown> }) => {
    const p = feature?.properties ?? {};
    const risk = String(p.risk_level ?? '').toUpperCase();
    if (risk === 'HIGH') return '#dc2626';
    if (risk === 'MEDIUM') return '#d97706';
    if (risk === 'LOW') return '#16a34a';
    const cc = Number(p.claim_count ?? summaryByZone[String(p.zone_id)]?.claim_density_per_hr ?? 0);
    const util = Number(p.utilization_pct ?? summaryByZone[String(p.zone_id)]?.utilization_pct ?? 0);
    if (util >= 80 || cc >= 8) return '#dc2626';
    if (util >= 55 || cc >= 3) return '#d97706';
    return '#16a34a';
  };

  if (geoQuery.isLoading || summaryQuery.isLoading) {
    return (
      <div style={{ ...adminUi.page, ...adminUi.empty, minHeight: 320 }}>
        Loading map and zone summaries…
      </div>
    );
  }
  if (geoQuery.error || summaryQuery.error || !geoQuery.data) {
    return (
      <div style={{ ...adminUi.page, ...adminUi.empty, color: '#b91c1c' }}>
        Could not load heatmap. Check API and try again.
      </div>
    );
  }

  return (
    <div style={adminUi.page}>
      <header style={adminUi.pageHeader}>
        <h1 style={adminUi.h1}>Zone heatmap</h1>
        <p style={adminUi.sub}>Hyderabad-centered zones. Color reflects risk / claim density. Popups show live summary; toggles reserve future layers.</p>
        <p style={{ fontSize: 12, color: 'var(--admin-muted)', fontWeight: 700 }}>
          Legend: <span style={{ color: '#16a34a' }}>Green</span> low, <span style={{ color: '#d97706' }}>Orange</span> medium, <span style={{ color: '#dc2626' }}>Red</span> high
        </p>
      </header>

      <div style={{ ...adminUi.card, marginBottom: 16 }}>
        <div style={adminUi.cardTitle}>Map layers</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 12 }}>
          <label style={toggleLabel}>
            <input type="checkbox" checked={showWeather} onChange={(e) => setShowWeather(e.target.checked)} />
            <span>Weather layer (reserved)</span>
          </label>
          <label style={toggleLabel}>
            <input type="checkbox" checked={showAqi} onChange={(e) => setShowAqi(e.target.checked)} />
            <span>AQI layer (reserved)</span>
          </label>
          <label style={toggleLabel}>
            <input type="checkbox" checked={showFraudClusters} onChange={(e) => setShowFraudClusters(e.target.checked)} />
            <span>Fraud clusters (reserved)</span>
          </label>
        </div>
        <p style={{ fontSize: 12, color: 'var(--admin-muted)', margin: '12px 0 0', fontWeight: 600 }}>
          Toggles are placeholders for upcoming overlays; the base zone polygons always render.
        </p>
      </div>

      <div
        style={{
          height: 'min(70vh, 640px)',
          minHeight: 360,
          borderRadius: 14,
          overflow: 'hidden',
          border: '1px solid var(--admin-border)',
          boxShadow: 'var(--admin-shadow-sm)',
        }}
      >
        <MapContainer center={[17.385, 78.4867]} zoom={10} style={{ height: '100%', width: '100%' }} scrollWheelZoom>
          <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          <GeoJSON
            data={geoQuery.data as object}
            style={(feature) => ({
              color: '#1e293b',
              weight: 1.5,
              fillColor: fillForFeature(feature as { properties?: Record<string, unknown> }),
              fillOpacity: 0.42,
            })}
            onEachFeature={(feature, layer) => {
              const p = (feature as { properties?: Record<string, unknown> }).properties ?? {};
              const zoneId = String(p.zone_id ?? '');
              const zname = String(p.zone_name ?? zoneId);
              const workers = p.active_workers ?? summaryByZone[zoneId]?.active_workers ?? '—';
              const bal = p.pool_balance ?? summaryByZone[zoneId]?.pool_balance ?? 0;
              const last = p.last_disruption ?? summaryByZone[zoneId]?.last_disruption ?? '—';
              const cc = p.claim_count ?? '—';
              const liveEvent = zoneEvents[zoneId];
              layer.bindPopup(
                `<div style="font-family:Inter,system-ui,sans-serif;font-size:13px;line-height:1.5;color:#0f172a;">
                  <div style="font-weight:800;margin-bottom:6px">${zname} <span style="color:#64748b;font-weight:600">(${zoneId})</span></div>
                  <div>Claims: <b>${cc}</b></div>
                  <div>Active workers: <b>${workers}</b></div>
                  <div>Pool balance: <b>₹${Number(bal).toFixed(0)}</b></div>
                  <div>Last disruption: <b>${last}</b></div>
                  <div>Live event: <b>${liveEvent?.event_type ?? 'none'}</b></div>
                </div>`
              );
            }}
          />
        </MapContainer>
      </div>
    </div>
  );
}

const toggleLabel: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 10,
  fontSize: '0.875rem',
  fontWeight: 600,
  color: 'var(--admin-text)',
  padding: '10px 14px',
  borderRadius: 10,
  border: '1px solid var(--admin-border)',
  background: 'var(--admin-bg-subtle)',
  cursor: 'pointer',
};
