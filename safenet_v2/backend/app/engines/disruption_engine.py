"""
Disruption Engine
-----------------
Detects active environmental disruptions for a zone using live APIs:
  - Open-Meteo weather
  - Open-Meteo air-quality (pm2_5)

Stores / updates DisruptionEvent rows in the DB.
Returns the list of currently active events for the zone.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.claim import DisruptionEvent
from app.models.zone import Zone
from app.utils.logger import get_logger

log = get_logger(__name__)

# ── Thresholds ─────────────────────────────────────────────────────────────────
RAIN_THRESHOLD_MM_HR: float = 15.0
HEAT_THRESHOLD_C: float = 42.0
PM25_THRESHOLD: float = 300.0

# ── Confidence weights per signal type ────────────────────────────────────────
_CONFIDENCE_WEIGHTS: dict[str, float] = {
    "rain":   1.0,
    "heat":   0.8,
    "aqi":    0.9,
    "curfew": 1.2,
    "strike": 1.2,
}

_HTTP_TIMEOUT = httpx.Timeout(connect=5.0, read=10.0, write=5.0, pool=5.0)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


# ── 1. Weather fetch ───────────────────────────────────────────────────────────

def fetch_weather_for_zone(lat: float, lng: float) -> dict[str, Any]:
    """
    Calls Open-Meteo and returns temperature + precipitation.
    Falls back to safe zeros on any failure.
    """
    url = "https://api.open-meteo.com/v1/forecast"
    params = {
        "latitude": lat,
        "longitude": lng,
        "hourly": "precipitation,temperature_2m",
        "current_weather": "true",
        "timezone": "auto",
        "forecast_days": 1,
    }
    try:
        with httpx.Client(timeout=_HTTP_TIMEOUT) as client:
            r = client.get(url, params=params)
            r.raise_for_status()
            data = r.json()

        temperature = float(
            (data.get("current_weather") or {}).get("temperature", 0.0) or 0.0
        )

        # Use first available hourly precipitation as current approximation
        hourly = data.get("hourly") or {}
        precip_list = hourly.get("precipitation") or []
        rain_mm_hr = float(precip_list[0]) if precip_list else 0.0

        log.info(
            "weather_fetched",
            engine_name="disruption_engine",
            reason_code="WEATHER_OK",
            lat=lat,
            lng=lng,
            temperature=temperature,
            rain_mm_hr=rain_mm_hr,
        )
        return {
            "temperature_celsius": temperature,
            "rain_mm_per_hr": rain_mm_hr,
            "source": "open-meteo",
        }

    except Exception as exc:
        log.warning(
            "weather_fetch_failed",
            engine_name="disruption_engine",
            reason_code="WEATHER_ERROR",
            lat=lat,
            lng=lng,
            error=str(exc),
        )
        return {"temperature_celsius": 0.0, "rain_mm_per_hr": 0.0, "source": "open-meteo-fallback"}


# ── 2. AQI fetch ───────────────────────────────────────────────────────────────

def fetch_aqi_for_zone(lat: float, lng: float) -> dict[str, Any]:
    """
    Uses Open-Meteo air quality endpoint and returns latest PM2.5 value.
    Falls back to 0 on any failure or empty result.
    """
    url = "https://air-quality-api.open-meteo.com/v1/air-quality"
    params = {
        "latitude": lat,
        "longitude": lng,
        "hourly": "pm2_5",
        "timezone": "auto",
        "forecast_days": 1,
    }
    try:
        with httpx.Client(timeout=_HTTP_TIMEOUT) as client:
            r = client.get(url, params=params)
            r.raise_for_status()
            data = r.json()

        hourly = data.get("hourly") or {}
        pm25_series = hourly.get("pm2_5") or []
        pm25_value = 0.0
        for v in reversed(pm25_series):
            if isinstance(v, (int, float)):
                pm25_value = max(0.0, float(v))
                break

        log.info(
            "aqi_fetched",
            engine_name="disruption_engine",
            reason_code="AQI_OK",
            lat=lat,
            lng=lng,
            pm25_value=pm25_value,
        )
        return {"pm25_value": pm25_value, "source": "open-meteo-aqi"}

    except Exception as exc:
        log.warning(
            "aqi_fetch_failed",
            engine_name="disruption_engine",
            reason_code="AQI_ERROR",
            lat=lat,
            lng=lng,
            error=str(exc),
        )
        return {"pm25_value": 0.0, "source": "aqi-fallback"}


# ── 3. Severity helpers ────────────────────────────────────────────────────────

def _clamp_severity(raw: float) -> float:
    return round(max(0.3, min(raw, 1.0)), 4)


def _rain_severity(rain_mm_hr: float) -> Optional[float]:
    if rain_mm_hr > RAIN_THRESHOLD_MM_HR:
        return _clamp_severity(rain_mm_hr / 30.0)
    return None


def _heat_severity(temp_c: float) -> Optional[float]:
    if temp_c > HEAT_THRESHOLD_C:
        return _clamp_severity((temp_c - HEAT_THRESHOLD_C) / 6.0)
    return None


def _aqi_severity(pm25: float) -> Optional[float]:
    if pm25 > PM25_THRESHOLD:
        return _clamp_severity(pm25 / 500.0)
    return None


# ── 4. Main detection function ─────────────────────────────────────────────────

async def check_disruptions_for_zone(
    db: AsyncSession,
    zone: Zone,
) -> list[DisruptionEvent]:
    """
    Detects all active disruptions for a zone.

    Steps:
      1. Fetch weather + AQI
      2. Evaluate rain / heat / AQI signals
      3. Query active SocialEvents (curfew / strike)
      4. Compute weighted confidence score
      5. Upsert or expire DisruptionEvent rows
      6. Return list of active events

    Returns [] if confidence score < 1.0 (no credible disruption).
    """
    lat = float(zone.lat or 17.385)
    lng = float(zone.lng or 78.4867)
    zone_id = str(zone.city_code)

    # ── Step 1: Fetch signals ──────────────────────────────────────────────────
    weather = fetch_weather_for_zone(lat, lng)
    aqi_data = fetch_aqi_for_zone(lat, lng)

    rain_mm_hr = float(weather.get("rain_mm_per_hr") or 0.0)
    temp_c = float(weather.get("temperature_celsius") or 0.0)
    pm25 = float(aqi_data.get("pm25_value") or 0.0)

    # ── Step 2: Evaluate environmental signals ─────────────────────────────────
    # Each entry: (disruption_type, severity, raw_value, threshold, api_source)
    triggered: list[tuple[str, float, float, float, str]] = []

    rain_sev = _rain_severity(rain_mm_hr)
    if rain_sev is not None:
        triggered.append(("rain", rain_sev, rain_mm_hr, RAIN_THRESHOLD_MM_HR, weather["source"]))

    heat_sev = _heat_severity(temp_c)
    if heat_sev is not None:
        triggered.append(("heat", heat_sev, temp_c, HEAT_THRESHOLD_C, weather["source"]))

    aqi_sev = _aqi_severity(pm25)
    if aqi_sev is not None:
        triggered.append(("aqi", aqi_sev, pm25, PM25_THRESHOLD, aqi_data["source"]))

    # ── Step 3: Social events (curfew / strike) ────────────────────────────────
    try:
        from app.models.claim import DisruptionEvent as _DE  # already imported above
        # SocialEvent is stored as DisruptionEvent with type curfew/strike
        social_rows = (
            await db.execute(
                select(DisruptionEvent).where(
                    DisruptionEvent.zone_id == zone_id,
                    DisruptionEvent.is_active.is_(True),
                    DisruptionEvent.disruption_type.in_(["curfew", "strike", "zone_closure"]),
                )
            )
        ).scalars().all()

        for se in social_rows:
            triggered.append((
                str(se.disruption_type),
                1.0,
                1.0,
                0.0,
                "admin",
            ))
    except Exception as exc:
        log.warning(
            "social_event_query_failed",
            engine_name="disruption_engine",
            reason_code="SOCIAL_QUERY_ERROR",
            zone_id=zone_id,
            error=str(exc),
        )

    # ── Step 4: Confidence scoring ─────────────────────────────────────────────
    confidence_score = sum(
        _CONFIDENCE_WEIGHTS.get(dtype, 0.5)
        for dtype, *_ in triggered
    )

    if confidence_score >= 2.0:
        confidence_label = "HIGH"
    elif confidence_score >= 1.0:
        confidence_label = "MEDIUM"
    else:
        # No credible disruption — expire any stale active events and return
        await _expire_stale_events(db, zone_id, active_types=set())
        return []

    log.info(
        "disruption_confidence",
        engine_name="disruption_engine",
        reason_code="CONFIDENCE_SCORED",
        zone_id=zone_id,
        confidence_score=confidence_score,
        confidence_label=confidence_label,
        triggered_types=[t[0] for t in triggered],
    )

    # ── Step 5: Upsert DisruptionEvent rows ────────────────────────────────────
    now = _utcnow()
    active_types: set[str] = set()
    active_events: list[DisruptionEvent] = []

    for dtype, severity, raw_val, threshold_val, api_src in triggered:
        active_types.add(dtype)

        existing = (
            await db.execute(
                select(DisruptionEvent).where(
                    DisruptionEvent.zone_id == zone_id,
                    DisruptionEvent.disruption_type == dtype,
                    DisruptionEvent.is_active.is_(True),
                )
            )
        ).scalar_one_or_none()

        if existing is not None:
            # Update severity and timestamp — no duplicate created
            existing.severity = severity
            existing.raw_value = raw_val
            existing.confidence = confidence_label
            # Extend ended_at if it was set (re-triggered event)
            if existing.ended_at is not None:
                existing.ended_at = None
                existing.is_active = True
            active_events.append(existing)
            log.info(
                "disruption_event_updated",
                engine_name="disruption_engine",
                reason_code="EVENT_UPDATED",
                zone_id=zone_id,
                disruption_type=dtype,
                severity=severity,
            )
        else:
            event = DisruptionEvent(
                zone_id=zone_id,
                disruption_type=dtype,
                severity=severity,
                confidence=confidence_label,
                api_source=api_src,
                raw_value=raw_val,
                threshold_value=threshold_val,
                started_at=now,
                is_active=True,
            )
            db.add(event)
            await db.flush()
            active_events.append(event)
            log.info(
                "disruption_event_created",
                engine_name="disruption_engine",
                reason_code="EVENT_CREATED",
                zone_id=zone_id,
                disruption_type=dtype,
                severity=severity,
                raw_value=raw_val,
            )

    # ── Step 6: Expire signals no longer present ───────────────────────────────
    await _expire_stale_events(db, zone_id, active_types=active_types)

    await db.commit()
    return active_events


async def _expire_stale_events(
    db: AsyncSession,
    zone_id: str,
    active_types: set[str],
) -> None:
    """
    Mark any active DisruptionEvent whose type is no longer triggered as ended.
    Skips social events (curfew/strike) — those are managed by admin.
    """
    admin_managed = {"curfew", "strike", "zone_closure"}
    now = _utcnow()

    stale_rows = (
        await db.execute(
            select(DisruptionEvent).where(
                DisruptionEvent.zone_id == zone_id,
                DisruptionEvent.is_active.is_(True),
            )
        )
    ).scalars().all()

    for row in stale_rows:
        if row.disruption_type in admin_managed:
            continue  # admin controls these
        if row.disruption_type not in active_types:
            row.is_active = False
            row.ended_at = now
            log.info(
                "disruption_event_expired",
                engine_name="disruption_engine",
                reason_code="EVENT_EXPIRED",
                zone_id=zone_id,
                disruption_type=row.disruption_type,
                event_id=row.id,
            )
