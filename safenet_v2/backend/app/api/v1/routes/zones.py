from __future__ import annotations

import asyncio
import json
import math
import re

import httpx
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.routes.workers import get_current_user
from app.db.session import get_db
from app.models.claim import DisruptionEvent
from app.models.zone import Zone
from app.models.worker import User
from app.services.aqi_service import AQIService
from app.services.cache_service import cache_get_json, cache_set_json
from app.services.event_service import default_event_signals, government_alert_store
from app.services.forecast_shield_service import active_shields_next_48h, enrich_shield_for_client
from app.services.signal_types import UnavailableSignal
from app.services.weather_service import WeatherService
from app.services.zone_match import disruption_zone_candidates
from app.utils.logger import get_logger

IST = ZoneInfo("Asia/Kolkata")

router = APIRouter()
log = get_logger(__name__)

MOCK_WEATHER_HYDERABAD: dict[str, Any] = {
    "temp_c": 28.0,
    "rainfall_mm_hr": 0.0,
    "condition": "Partly Cloudy",
    "icon_code": "cloudy",
    "source": "fallback",
}

MOCK_AQI: dict[str, Any] = {"value": 145.0, "category": "Moderate", "color": "#ca8a04"}


def _load_zone_coords() -> dict[str, dict[str, Any]]:
    p = Path(__file__).resolve().parents[3] / "data" / "zone_coordinates.json"
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}
    out: dict[str, dict[str, Any]] = {}
    for zone_name, row in raw.items():
        zid = str(row.get("zone_id", "")).strip()
        if not zid:
            continue
        out[zid] = {
            "zone_name": str(zone_name),
            "lat": float(row.get("lat")),
            "lon": float(row.get("lon")),
        }
    return out


ZONE_COORDS = _load_zone_coords()


def _slugify(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", value.strip().lower()).strip("_")


def _zone_aliases(zone: Zone) -> set[str]:
    aliases = {
        str(zone.city_code or "").strip(),
        str(zone.city_code or "").strip().lower(),
        _slugify(str(zone.city_code or "")),
        _slugify(str(zone.name or "")),
    }
    return {a for a in aliases if a}


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _detect_zone_from_coords(lat: float, lon: float) -> dict[str, Any] | None:
    best_zone_id: str | None = None
    best_dist = float("inf")
    for zone_id, z in ZONE_COORDS.items():
        dist = _haversine_km(lat, lon, float(z["lat"]), float(z["lon"]))
        if dist < best_dist:
            best_dist = dist
            best_zone_id = zone_id
    if best_zone_id is None:
        return None
    z = ZONE_COORDS[best_zone_id]
    risk = "High Risk" if best_dist < 5 else "Low Risk" if best_dist > 20 else "Medium Risk"
    return {
        "zone_id": best_zone_id,
        "zone_name": z["zone_name"],
        "city": z["zone_name"],
        "distance_km": round(best_dist, 2),
        "risk_level": risk,
        "lat": z["lat"],
        "lon": z["lon"],
    }


def _aqi_color(category: str) -> str:
    c = str(category or "").strip().lower()
    if c == "good":
        return "#16a34a"
    if c == "moderate":
        return "#ca8a04"
    if c == "poor":
        return "#ea580c"
    if c == "very poor":
        return "#ea580c"
    return "#dc2626"


def _derive_condition_icon(
    temp_c: float | None,
    rainfall_mm_hr: float | None,
) -> tuple[str, str]:
    rain = float(rainfall_mm_hr or 0.0)
    t = float(temp_c) if temp_c is not None else 28.0
    if rain > 0.5:
        return "Rain", "rain"
    if rain > 0.05:
        return "Light rain", "rain"
    if t >= 38.0:
        return "Hot", "hot"
    if t >= 33.0:
        return "Warm", "sunny"
    if t <= 22.0:
        return "Mild", "cloudy"
    return "Partly cloudy", "cloudy"


async def _coordinates_for_zone(db: AsyncSession, zone_id: str) -> dict[str, Any]:
    """
    Resolve lat/lon for any zone_id returned by /zones/detect (slug of DB name, e.g. benz_circle)
    or keys from zone_coordinates.json (e.g. hyd_central).
    """
    key = str(zone_id or "").strip()
    z = ZONE_COORDS.get(key)
    if z is not None:
        zn = str(z["zone_name"])
        return {
            "lat": float(z["lat"]),
            "lon": float(z["lon"]),
            "zone_name": zn,
            "zone_city": str(z.get("zone_name") or "India"),
            "place_label": zn,
        }
    rows = (await db.execute(select(Zone).where(Zone.lat.is_not(None), Zone.lng.is_not(None)))).scalars().all()
    normalized = _slugify(key)
    matched: Zone | None = None
    for row in rows:
        if key in _zone_aliases(row) or normalized in _zone_aliases(row):
            matched = row
            break
    if matched is None and rows:
        matched = min(
            rows,
            key=lambda row: _haversine_km(20.5937, 78.9629, float(row.lat or 0.0), float(row.lng or 0.0)),
        )
    if matched is None:
        raise HTTPException(status_code=404, detail="Unknown zone_id")
    name = str(matched.name or matched.city_code)
    return {
        "lat": float(matched.lat or 0.0),
        "lon": float(matched.lng or 0.0),
        "zone_name": name,
        "zone_city": str(matched.city or "India"),
        "place_label": name,
    }


async def _limit_zone_status(redis: Any, worker_id: int) -> None:
    if redis is None:
        return
    now_bucket = datetime.now(timezone.utc).strftime("%Y%m%d%H%M")
    key = f"rate:zone_status:{worker_id}:{now_bucket}"
    count = await redis.incr(key)
    if count == 1:
        await redis.expire(key, 60)
    if count > 60:
        raise HTTPException(status_code=429, detail="Too many zone status requests")


def _risk_label(multiplier: float) -> str:
    if multiplier > 1.3:
        return "HIGH"
    if multiplier > 1.1:
        return "MEDIUM"
    return "LOW"


@router.get("/zones/detect")
async def detect_zone_get(lat: float, lng: float, db: AsyncSession = Depends(get_db)):
    """
    Public zone detection for onboarding (no JWT required).
    Finds nearest zone from DB using haversine distance.
    """
    if not (-90 <= float(lat) <= 90) or not (-180 <= float(lng) <= 180):
        raise HTTPException(status_code=422, detail="Invalid coordinates")

    rows = (await db.execute(select(Zone).where(Zone.lat.is_not(None), Zone.lng.is_not(None)))).scalars().all()
    if not rows:
        legacy = _detect_zone_from_coords(float(lat), float(lng))
        if legacy:
            return {
                "zone_id": legacy["zone_id"],
                "zone_name": legacy["zone_name"],
                "city": legacy["city"],
                "flood_risk": 0.0,
                "heat_risk": 0.0,
                "aqi_risk": 0.0,
                "zone_risk_multiplier": 1.0,
                "risk_label": "MEDIUM",
                "distance_km": legacy.get("distance_km"),
                "within_50km": bool((legacy.get("distance_km") or 999999) <= 50),
                "is_temporary_zone": False,
            }
        return {
            "zone_id": "temp_zone",
            "zone_name": f"Temporary Zone ({round(float(lat), 4)}, {round(float(lng), 4)})",
            "city": "India",
            "flood_risk": 0.0,
            "heat_risk": 0.0,
            "aqi_risk": 0.0,
            "zone_risk_multiplier": 1.0,
            "risk_label": "MEDIUM",
            "distance_km": 0.0,
            "within_50km": True,
            "is_temporary_zone": True,
        }

    nearest = min(
        rows,
        key=lambda z: _haversine_km(float(lat), float(lng), float(z.lat or 0.0), float(z.lng or 0.0)),
    )
    nearest_alias = _slugify(str(nearest.name or "")) or str(nearest.city_code or "").lower()
    distance_km = _haversine_km(float(lat), float(lng), float(nearest.lat or 0.0), float(nearest.lng or 0.0))
    return {
        "zone_id": nearest_alias,
        "zone_name": nearest.name,
        "city": nearest.city,
        "flood_risk": float(nearest.flood_risk_score or 0.0),
        "heat_risk": float(nearest.heat_risk_score or 0.0),
        "aqi_risk": float(nearest.aqi_risk_score or 0.0),
        "zone_risk_multiplier": float(nearest.zone_risk_multiplier or 1.0),
        "risk_label": _risk_label(float(nearest.zone_risk_multiplier or 1.0)),
        "distance_km": round(distance_km, 3),
        "within_50km": bool(distance_km <= 50.0),
        "is_temporary_zone": False,
    }


@router.post("/zones/detect")
async def detect_zone_from_gps(
    body: dict = Body(...),
    current_user: User = Depends(get_current_user),
):
    """
    Detect zone from GPS coordinates.
    Uses bounding box pre-filter then haversine distance.
    Falls back to hyd_central if no zone found within 1 degree.
    """
    try:
        lat = float(body.get("lat", 0.0))
        lon = float(body.get("lng") or body.get("lon") or 0.0)
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail="lat and lng must be numbers")

    if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
        raise HTTPException(status_code=422, detail="Invalid coordinates")

    result = _detect_zone_from_coords(lat, lon)
    if result is None:
        # Fallback: return default zone rather than 404
        fallback = ZONE_COORDS.get("hyd_central") or next(iter(ZONE_COORDS.values()), None)
        if fallback:
            return {
                "zone_id": "hyd_central",
                "zone_name": fallback.get("zone_name", "Hyderabad Central"),
                "city": fallback.get("zone_name", "Hyderabad Central"),
                "distance_km": None,
                "risk_level": "Medium Risk",
                "fallback": True,
            }
        raise HTTPException(status_code=404, detail="No zones configured")

    return result


@router.get("/zones/{zone_id}/status")
async def zone_status(
    zone_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    redis = getattr(request.app.state, "redis", None)
    await _limit_zone_status(redis, current_user.id)

    cache_key = f"zone_status:{zone_id}"
    cached = await cache_get_json(redis, cache_key)
    if cached is not None:
        return cached

    coords = await _coordinates_for_zone(db, zone_id)
    lat = float(coords["lat"])
    lon = float(coords["lon"])
    zone_name = str(coords["zone_name"])
    zone_city = str(coords["zone_city"])

    weather_service = WeatherService(redis=redis)
    aqi_service = AQIService(redis=redis)
    event_service = default_event_signals()

    try:
        weather_sig, aqi_sig, gov_sig = await asyncio.wait_for(
            asyncio.gather(
                weather_service.get_weather(lat, lon),
                aqi_service.get_aqi(zone_city, zone_id, lat=lat, lon=lon),
                event_service.get_government_alert(zone_id),
            ),
            timeout=5.0,
        )
    except (asyncio.TimeoutError, Exception) as exc:
        log.warning(
            "zone_status_upstream_timeout",
            zone_id=zone_id,
            error=str(exc),
        )
        last_map = getattr(request.app.state, "zone_status_last", None)
        if isinstance(last_map, dict) and zone_id in last_map:
            return last_map[zone_id]
        weather_sig = UnavailableSignal()
        aqi_sig = UnavailableSignal()
        gov_sig = await event_service.get_government_alert(zone_id)

    gov_rows = government_alert_store.get_raw(zone_id)

    weather_alert_active = bool(
        not isinstance(weather_sig, UnavailableSignal) and getattr(weather_sig, "alert_active", False)
    )
    rainfall_mm_hr: float | None = None
    temp_c: float | None = None

    if isinstance(weather_sig, UnavailableSignal):
        temp_c = MOCK_WEATHER_HYDERABAD["temp_c"]
        rainfall_mm_hr = MOCK_WEATHER_HYDERABAD["rainfall_mm_hr"]
        condition = MOCK_WEATHER_HYDERABAD["condition"]
        icon_code = MOCK_WEATHER_HYDERABAD["icon_code"]
        weather_source = MOCK_WEATHER_HYDERABAD["source"]
    else:
        temp_c = getattr(weather_sig, "temp_c", None)
        rainfall_mm_hr = getattr(weather_sig, "rainfall_mm_hr", None)
        if temp_c is None:
            temp_c = MOCK_WEATHER_HYDERABAD["temp_c"]
            rainfall_mm_hr = rainfall_mm_hr if rainfall_mm_hr is not None else MOCK_WEATHER_HYDERABAD["rainfall_mm_hr"]
            condition = MOCK_WEATHER_HYDERABAD["condition"]
            icon_code = MOCK_WEATHER_HYDERABAD["icon_code"]
            weather_source = MOCK_WEATHER_HYDERABAD["source"]
        else:
            condition, icon_code = _derive_condition_icon(temp_c, rainfall_mm_hr)
            weather_source = str(getattr(weather_sig, "source", "weather"))

    if isinstance(aqi_sig, UnavailableSignal):
        aqi_value = MOCK_AQI["value"]
        aqi_category = MOCK_AQI["category"]
        aqi_color = MOCK_AQI["color"]
    else:
        aqi_value = float(getattr(aqi_sig, "aqi_value", 0.0) or 0.0)
        aqi_category = str(getattr(aqi_sig, "category", "Moderate") or "Moderate")
        aqi_color = _aqi_color(aqi_category)

    active_alerts_count = len(gov_rows) + (1 if weather_alert_active else 0)

    rain_f = float(rainfall_mm_hr or 0.0)

    disruption_type = None
    if getattr(gov_sig, "alert_active", False):
        disruption_type = getattr(gov_sig, "alert_type", None) or "SOCIAL_ALERT"
    elif weather_alert_active:
        disruption_type = getattr(weather_sig, "alert_type", None) if not isinstance(weather_sig, UnavailableSignal) else "WEATHER_ALERT"
        if disruption_type is None:
            disruption_type = "WEATHER_ALERT"
    elif aqi_value > 300:
        disruption_type = "AQI_SPIKE"
    elif rain_f > 15.0:
        disruption_type = "HEAVY_RAIN"

    disruption_active = bool(disruption_type is not None)

    if disruption_active:
        safe_level = "DISRUPTED"
    elif active_alerts_count > 0 or aqi_value >= 101 or (rain_f >= 2.0 and rain_f <= 15.0):
        safe_level = "WATCH"
    else:
        safe_level = "SAFE"

    payload = {
        "zone_id": zone_id,
        "zone_name": zone_name,
        "weather": {
            "temp_c": round(float(temp_c), 1) if temp_c is not None else 28.0,
            "rainfall_mm_hr": round(rain_f, 2),
            "condition": condition,
            "icon_code": icon_code,
            "source": weather_source,
        },
        "aqi": {
            "value": round(float(aqi_value), 1),
            "category": aqi_category,
            "color": aqi_color,
        },
        "active_alerts_count": active_alerts_count,
        "disruption_active": disruption_active,
        "disruption_type": disruption_type,
        "safe_level": safe_level,
        "last_updated": datetime.now(timezone.utc).isoformat(),
    }
    await cache_set_json(redis, cache_key, payload, ttl_seconds=60)
    last_map = getattr(request.app.state, "zone_status_last", None)
    if not isinstance(last_map, dict):
        last_map = {}
        request.app.state.zone_status_last = last_map
    last_map[zone_id] = payload
    return payload


@router.get("/zones/{zone_id}/disruptions/active")
async def active_disruptions(zone_id: str, db: AsyncSession = Depends(get_db)):
    """
    Active disruptions for worker-facing mobile dashboard.
    """
    zone_rows = (await db.execute(select(Zone))).scalars().all()
    zone_candidates = disruption_zone_candidates(zone_id, zone_rows)

    rows = (
        await db.execute(
            select(DisruptionEvent)
            .where(DisruptionEvent.zone_id.in_(list(zone_candidates)), DisruptionEvent.is_active.is_(True))
            .order_by(DisruptionEvent.started_at.desc())
        )
    ).scalars().all()

    return [
        {
            "type": r.disruption_type,
            "disruption_type": r.disruption_type,
            "severity": round(float(r.severity or 0.0), 3),
            "confidence": r.confidence,
            "started_at": r.started_at.isoformat().replace("+00:00", "Z") if r.started_at else None,
            "raw_value": r.raw_value,
            "threshold_value": r.threshold_value,
            "api_source": r.api_source,
        }
        for r in rows
    ]


@router.get("/zones/{zone_id}/forecast-daily")
async def forecast_daily(
    zone_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    ~14-day daily max/min temperature for the zone center (Open-Meteo, no API key).
    """
    redis = getattr(request.app.state, "redis", None)
    await _limit_zone_status(redis, current_user.id)

    coords = await _coordinates_for_zone(db, zone_id)
    lat = float(coords["lat"])
    lon = float(coords["lon"])
    place_label = str(coords.get("place_label") or coords["zone_name"] or zone_id)

    cache_key = f"forecast_daily:{zone_id}"
    cached = await cache_get_json(redis, cache_key)
    if isinstance(cached, dict) and isinstance(cached.get("days"), list):
        return cached

    url = "https://api.open-meteo.com/v1/forecast"
    params = {
        "latitude": lat,
        "longitude": lon,
        "daily": "temperature_2m_max,temperature_2m_min,weathercode,precipitation_probability_max",
        "forecast_days": 14,
        "timezone": "Asia/Kolkata",
    }
    try:
        async with httpx.AsyncClient(timeout=12.0) as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()
    except Exception as exc:
        log.warning("forecast_daily_upstream_failed", zone_id=zone_id, error=str(exc))
        raise HTTPException(status_code=502, detail="Weather forecast temporarily unavailable") from exc

    daily = data.get("daily") or {}
    dates = daily.get("time") or []
    tmax = daily.get("temperature_2m_max") or []
    tmin = daily.get("temperature_2m_min") or []
    precip = daily.get("precipitation_probability_max") or []
    days_out = []
    for i, day in enumerate(dates):
        pp = None
        if i < len(precip) and precip[i] is not None:
            try:
                pp = int(round(float(precip[i])))
            except (TypeError, ValueError):
                pp = None
        days_out.append(
            {
                "date": str(day),
                "temp_max_c": round(float(tmax[i]), 1) if i < len(tmax) and tmax[i] is not None else None,
                "temp_min_c": round(float(tmin[i]), 1) if i < len(tmin) and tmin[i] is not None else None,
                "precip_prob_pct": pp,
            }
        )

    payload = {
        "zone_id": zone_id,
        "location_label": place_label,
        "latitude": lat,
        "longitude": lon,
        "source": "open-meteo",
        "days": days_out,
    }
    await cache_set_json(redis, cache_key, payload, ttl_seconds=900)
    return payload


@router.get("/zones/{zone_id}/forecast-shield")
async def forecast_shield(
    zone_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    redis = getattr(request.app.state, "redis", None)
    await _limit_zone_status(redis, current_user.id)

    coords = await _coordinates_for_zone(db, zone_id)
    lat = float(coords["lat"])
    lon = float(coords["lon"])

    raw = getattr(request.app.state, "forecast_shields", None) or {}
    if not isinstance(raw, dict):
        raw = {}
    active = active_shields_next_48h(raw, zone_id)
    now_ist = datetime.now(tz=IST)
    shields = [enrich_shield_for_client(s, now_ist) for s in active]

    weather_service = WeatherService(redis=redis)
    weather_sig = await weather_service.get_weather(lat, lon)

    if isinstance(weather_sig, UnavailableSignal):
        weather = {
            "temp_c": MOCK_WEATHER_HYDERABAD["temp_c"],
            "rainfall_mm_hr": MOCK_WEATHER_HYDERABAD["rainfall_mm_hr"],
            "condition": MOCK_WEATHER_HYDERABAD["condition"],
            "icon_code": MOCK_WEATHER_HYDERABAD["icon_code"],
            "source": MOCK_WEATHER_HYDERABAD["source"],
        }
    else:
        temp_c = getattr(weather_sig, "temp_c", None)
        rainfall_mm_hr = getattr(weather_sig, "rainfall_mm_hr", None)
        if temp_c is None:
            temp_c = MOCK_WEATHER_HYDERABAD["temp_c"]
            rainfall_mm_hr = rainfall_mm_hr if rainfall_mm_hr is not None else MOCK_WEATHER_HYDERABAD["rainfall_mm_hr"]
            condition = MOCK_WEATHER_HYDERABAD["condition"]
            icon_code = MOCK_WEATHER_HYDERABAD["icon_code"]
            w_src = MOCK_WEATHER_HYDERABAD["source"]
        else:
            condition, icon_code = _derive_condition_icon(temp_c, rainfall_mm_hr)
            w_src = str(getattr(weather_sig, "source", "weather"))
        rain_f = float(rainfall_mm_hr or 0.0)
        weather = {
            "temp_c": round(float(temp_c), 1) if temp_c is not None else 28.0,
            "rainfall_mm_hr": round(rain_f, 2),
            "condition": condition,
            "icon_code": icon_code,
            "source": w_src,
        }

    return {
        "zone_id": zone_id,
        "shields": shields,
        "weather": weather,
        "last_updated": datetime.now(timezone.utc).isoformat(),
    }
