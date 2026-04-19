import React, { useMemo, useState, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CircleMarker, GeoJSON, MapContainer, Popup, TileLayer } from 'react-leaflet';
import type { FeatureCollection } from 'geojson';
import 'leaflet/dist/leaflet.css';

import api from '../api';
import { adminUi } from '../theme/adminUi';
import { useZoneEventsStore } from '../stores/zoneEvents';

type ZoneSummary = {
  zone_id: string | number;
  city_code?: string;
  zone_name?: string;
  city: string;
  lat?: number;
  lng?: number;
  active_workers: number;
  claims_count?: number;
  avg_payout?: number;
  pool_balance: number;
  utilization_pct: number;
  last_disruption: string;
  claim_density_per_hr: number;
  risk_mode?: string;
  risk_score?: number;
};

export default function ZoneHeatmap() {
  const [showWeather, setShowWeather] = useState(true);
  const [showAqi, setShowAqi] = useState(true);
  const [showFraudClusters, setShowFraudClusters] = useState(true);
  const zoneEvents = useZoneEventsStore((s) => s.latestByZone);
  const [center, setCenter] = useState<[number, number]>([20.5937, 78.9629]);
  const [zoom, setZoom] = useState(5);

  const geoQuery = useQuery({
    queryKey: ['admin', 'zones', 'geojson'],
    queryFn: async (): Promise<FeatureCollection> => {
      try {
        const res = await api.get('/admin/zones/geojson');
        return res.data as FeatureCollection;
      } catch (err) {
        console.error('GeoJSON fetch failed:', err);
        return { type: 'FeatureCollection', features: [] };
      }
    },
    retry: 1,
  });

  const summaryQuery = useQuery({
    queryKey: ['admin', 'zones', 'summary'],
    queryFn: async (): Promise<ZoneSummary[]> => {
      try {
        const res = await api.get('/admin/zones/summary');
        return Array.isArray(res.data) ? res.data : [];
      } catch (err) {
        console.error('Zone summary fetch failed:', err);
        return [];
      }
    },
    refetchInterval: 30_000,
    retry: 1,
  });

  const summaryByZone = useMemo(() => {
    try {
      const by: Record<string, ZoneSummary> = {};
      const data = Array.isArray(summaryQuery.data) ? summaryQuery.data : [];
      for (const row of data) {
        by[String(row.zone_id)] = row;
        if (row.city_code) by[String(row.city_code)] = row;
      }
      return by;
    } catch {
      return {};
    }
  }, [summaryQuery.data]);

  const demoRiskOverrideByZone = useMemo(() => {
    const rows = Array.isArray(summaryQuery.data) ? [...summaryQuery.data] : [];
    const hasHigh = rows.some((r: any) => String(r?.risk_level ?? r?.risk_mode ?? '').toUpperCase().includes('HIGH'));
    const hasMedium = rows.some((r: any) => String(r?.risk_level ?? r?.risk_mode ?? '').toUpperCase().includes('MEDIUM'));
    if (hasHigh && hasMedium) return {} as Record<string, 'HIGH' | 'MEDIUM'>;
    rows.sort((a: any, b: any) => Number(b?.claims_count ?? b?.claim_density_per_hr ?? 0) - Number(a?.claims_count ?? a?.claim_density_per_hr ?? 0));
    const out: Record<string, 'HIGH' | 'MEDIUM'> = {};
    if (!hasHigh && rows[0]) out[String(rows[0].city_code ?? rows[0].zone_id)] = 'HIGH';
    if (!hasMedium && rows[1]) out[String(rows[1].city_code ?? rows[1].zone_id)] = 'MEDIUM';
    return out;
  }, [summaryQuery.data]);

  const fillForFeature = (feature: { properties?: Record<string, unknown> }) => {
    try {
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
    } catch {
      return '#16a34a';
    }
  };

  React.useEffect(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCenter([pos.coords.latitude, pos.coords.longitude]);
        setZoom(7);
      },
      () => {
        setCenter([20.5937, 78.9629]);
        setZoom(5);
      },
      { enableHighAccuracy: true, timeout: 5000 }
    );
  }, []);

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
        <MapContainer center={center} zoom={zoom} style={{ height: '100%', width: '100%' }} scrollWheelZoom>
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
              const sum = summaryByZone[String(zoneId)] ?? summaryByZone[String(p.city_code ?? '')];
              const riskBadge = sum?.risk_mode ? `<div>Risk mode: <b>${String(sum.risk_mode)}</b> (${sum.risk_score ?? '—'})</div>` : '';
              layer.bindPopup(
                `<div style="font-family:Inter,system-ui,sans-serif;font-size:13px;line-height:1.5;color:#0f172a;">
                  <div style="font-weight:800;margin-bottom:6px">${zname} <span style="color:#64748b;font-weight:600">(${zoneId})</span></div>
                  ${riskBadge}
                  <div>Claims: <b>${cc}</b></div>
                  <div>Active workers: <b>${workers}</b></div>
                  <div>Pool balance: <b>₹${Number(bal).toFixed(0)}</b></div>
                  <div>Last disruption: <b>${last}</b></div>
                  <div>Live event: <b>${liveEvent?.event_type ?? 'none'}</b></div>
                </div>`
              );
            }}
          />
          {summaryQuery.data?.map((zone) => {
            const zLat = Number(zone.lat ?? 0);
            const zLng = Number(zone.lng ?? 0);
            if (!Number.isFinite(zLat) || !Number.isFinite(zLng) || (zLat === 0 && zLng === 0)) return null;
            const zKey = String(zone.city_code ?? zone.zone_id);
            const risk = String(demoRiskOverrideByZone[zKey] ?? (zone as any).risk_level ?? '').toUpperCase();
            const color = risk === 'HIGH' ? '#dc2626' : risk === 'MEDIUM' ? '#d97706' : '#16a34a';
            const workers = Number(zone.active_workers ?? 0);
            const radius = Math.max(6, Math.min(24, 6 + workers * 1.3));
            return (
              <CircleMarker
                key={zKey}
                center={[zLat, zLng]}
                radius={radius}
                pathOptions={{ color, fillColor: color, fillOpacity: 0.45, weight: 2 }}
              >
                <Popup>
                  <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                    <div style={{ fontWeight: 800 }}>{zone.zone_name ?? zone.city ?? zone.city_code}</div>
                    <div>Workers: <b>{workers}</b></div>
                    <div>Claims: <b>{Number((zone as any).claims_count ?? 0)}</b></div>
                    <div>Avg payout: <b>₹{Number((zone as any).avg_payout ?? 0).toFixed(0)}</b></div>
                  </div>
                </Popup>
              </CircleMarker>
            );
          })}
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
