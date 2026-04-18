from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models.zone import Zone
from app.services.aqi_service import AQIService
from app.services.weather_service import WeatherService

router = APIRouter()


def _slugify(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", value.strip().lower()).strip("_")


async def _resolve_zone(zone_id: str, db: AsyncSession) -> Zone | None:
    rows = (await db.execute(select(Zone).where(Zone.lat.is_not(None), Zone.lng.is_not(None)))).scalars().all()
    if not rows:
        return None
    key = str(zone_id or "").strip()
    normalized = _slugify(key)
    for row in rows:
        aliases = {
            str(row.city_code or "").strip(),
            str(row.city_code or "").strip().lower(),
            _slugify(str(row.city_code or "")),
            _slugify(str(row.name or "")),
        }
        if key in aliases or normalized in aliases:
            return row
    return rows[0]


@router.get("/weather/current")
async def weather_current(zone_id: str, db: AsyncSession = Depends(get_db)):
    zone = await _resolve_zone(zone_id, db)
    if zone is None:
        raise HTTPException(status_code=404, detail="No zones configured")
    weather = await WeatherService(redis=None).get_weather(float(zone.lat), float(zone.lng))
    return {
        "zone_id": zone_id,
        "zone_name": zone.name,
        "temp_c": weather.temp_c,
        "rainfall_mm_hr": weather.rainfall_mm_hr,
        "condition": weather.alert_type or "normal",
        "source": weather.source,
    }


@router.get("/aqi/current")
async def aqi_current(zone_id: str, db: AsyncSession = Depends(get_db)):
    zone = await _resolve_zone(zone_id, db)
    if zone is None:
        raise HTTPException(status_code=404, detail="No zones configured")
    aqi = await AQIService(redis=None).get_aqi(zone.city, zone_id)
    return {
        "zone_id": zone_id,
        "zone_name": zone.name,
        "aqi": aqi.aqi_value,
        "category": aqi.category,
        "pm25": aqi.pm25,
        "pm10": aqi.pm10,
        "source": aqi.source,
    }
