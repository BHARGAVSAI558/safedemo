from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Request

from app.api.v1.routes.workers import get_current_user
from app.models.worker import User
from app.services.aqi_service import AQIService
from app.services.cache_service import cache_get_json, cache_set_json
from app.services.event_service import default_event_signals, government_alert_store
from app.services.forecast_shield_service import active_shields_next_48h, enrich_shield_for_client
from app.services.signal_types import UnavailableSignal
from app.services.weather_service import WeatherService
from app.utils.logger import get_logger

IST = ZoneInfo("Asia/Kolkata")

router = APIRouter()
log = get_logger(__name__)

MOCK_WEATHER_HYDERABAD: dict[str, Any] = {
    "temp_c": 28.0,
    "rainfall_mm_hr": 0.0,
    "condition": "Partly Cloudy",
    "icon_code": "cloudy",
    "source": "mock_hyderabad",
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


@router.get("/zones/{zone_id}/status")
async def zone_status(
    zone_id: str,
    request: Request,
    current_user: User = Depends(get_current_user),
):
    redis = getattr(request.app.state, "redis", None)
    await _limit_zone_status(redis, current_user.id)

    cache_key = f"zone_status:{zone_id}"
    cached = await cache_get_json(redis, cache_key)
    if cached is not None:
        return cached

    z = ZONE_COORDS.get(zone_id)
    if z is None:
        raise HTTPException(status_code=404, detail="Unknown zone_id")

    lat = float(z["lat"])
    lon = float(z["lon"])
    zone_name = str(z["zone_name"])

    weather_service = WeatherService(redis=redis)
    aqi_service = AQIService(redis=redis)
    event_service = default_event_signals()

    try:
        weather_sig, aqi_sig, gov_sig = await asyncio.wait_for(
            asyncio.gather(
                weather_service.get_weather(lat, lon),
                aqi_service.get_aqi("Hyderabad", zone_id),
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
    await cache_set_json(redis, cache_key, payload, ttl_seconds=120)
    last_map = getattr(request.app.state, "zone_status_last", None)
    if not isinstance(last_map, dict):
        last_map = {}
        request.app.state.zone_status_last = last_map
    last_map[zone_id] = payload
    return payload


@router.get("/zones/{zone_id}/forecast-shield")
async def forecast_shield(
    zone_id: str,
    request: Request,
    current_user: User = Depends(get_current_user),
):
    redis = getattr(request.app.state, "redis", None)
    await _limit_zone_status(redis, current_user.id)

    z = ZONE_COORDS.get(zone_id)
    if z is None:
        raise HTTPException(status_code=404, detail="Unknown zone_id")

    lat = float(z["lat"])
    lon = float(z["lon"])

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
