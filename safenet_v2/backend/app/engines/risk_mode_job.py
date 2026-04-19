"""Periodic refresh of zone risk_score / risk_mode and worker counts."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.engines.risk_mode_engine import compute_zone_risk_score, get_risk_mode
from app.models.worker import Profile
from app.models.zone import Zone
from app.services.weather_service import WeatherService


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


async def run_zone_risk_refresh(db: AsyncSession, *, redis: Any = None) -> None:
    """Recompute risk score + mode for every zone; update online/total worker counts."""
    ws = WeatherService(redis=redis)
    online_cutoff = _utcnow() - timedelta(minutes=15)
    zones = (await db.execute(select(Zone))).scalars().all()

    for z in zones:
        zid = str(z.city_code)
        total = int(
            (await db.execute(select(func.count(Profile.id)).where(func.lower(Profile.zone_id) == zid.lower())))
            .scalar_one()
            or 0
        )
        online = int(
            (
                await db.execute(
                    select(func.count(Profile.id)).where(
                        func.lower(Profile.zone_id) == zid.lower(),
                        or_(Profile.last_api_call >= online_cutoff, Profile.last_seen >= online_cutoff),
                    )
                )
            ).scalar_one()
            or 0
        )
        z.total_registered_workers = total
        z.current_online_workers = online

        weather_data: Optional[dict[str, Any]] = None
        aqi_data: Optional[dict[str, Any]] = None
        if z.lat is not None and z.lng is not None:
            try:
                w = await ws.fetch_weather(float(z.lat), float(z.lng))
                if hasattr(w, "rainfall_mm_hr"):
                    weather_data = {
                        "rain_1h": float(getattr(w, "rainfall_mm_hr", 0) or 0),
                        "temp": float(getattr(w, "temp_c", 30) or 30),
                    }
            except Exception:
                pass

        score = compute_zone_risk_score(z, weather_data, aqi_data, None)
        mode_obj = get_risk_mode(score)
        z.risk_score = int(score)
        z.risk_mode = str(mode_obj.get("mode", "NORMAL"))
        z.risk_mode_updated_at = _utcnow()

        # Rolling EMA for order baseline (lightweight proxy)
        base = float(z.zone_baseline_orders or 100.0)
        cur = float(z.orders_last_hour or base)
        z.zone_baseline_orders = round(base * 0.95 + cur * 0.05, 2)

    await db.commit()
