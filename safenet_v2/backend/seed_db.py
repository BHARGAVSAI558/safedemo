"""
Reference zone geography + optional demo worker accounts.
No synthetic claims or payouts — use _seed_local_dataset() only when explicitly needed.
"""

from __future__ import annotations

import asyncio
import re
from typing import Any

from sqlalchemy import func, select

from app.db.session import AsyncSessionLocal, init_db
from app.models.worker import OccupationType, Profile, RiskProfile, User
from app.models.zone import Zone

ZONES_SPEC: list[dict[str, Any]] = [
    {"name": "Gachibowli", "city": "Hyderabad", "lat": 17.4401, "lng": 78.3489, "risk_level": "LOW", "base_premium": 69, "weekly_cap_basic": 1500, "weekly_cap_standard": 3000, "weekly_cap_pro": 5000, "historical_flood_risk": 0.15, "historical_heat_risk": 0.60, "historical_aqi_risk": 0.30, "historical_traffic_risk": 0.40},
    {"name": "Madhapur", "city": "Hyderabad", "lat": 17.4418, "lng": 78.3810, "risk_level": "LOW", "base_premium": 69, "weekly_cap_basic": 1500, "weekly_cap_standard": 3000, "weekly_cap_pro": 5000, "historical_flood_risk": 0.12, "historical_heat_risk": 0.60, "historical_aqi_risk": 0.30, "historical_traffic_risk": 0.50},
    {"name": "Banjara Hills", "city": "Hyderabad", "lat": 17.4156, "lng": 78.4347, "risk_level": "MEDIUM", "base_premium": 89, "weekly_cap_basic": 1500, "weekly_cap_standard": 3000, "weekly_cap_pro": 5000, "historical_flood_risk": 0.30, "historical_heat_risk": 0.65, "historical_aqi_risk": 0.40, "historical_traffic_risk": 0.60},
    {"name": "Kukatpally", "city": "Hyderabad", "lat": 17.4849, "lng": 78.3996, "risk_level": "MEDIUM", "base_premium": 89, "weekly_cap_basic": 1500, "weekly_cap_standard": 3000, "weekly_cap_pro": 5000, "historical_flood_risk": 0.35, "historical_heat_risk": 0.65, "historical_aqi_risk": 0.45, "historical_traffic_risk": 0.55},
    {"name": "LB Nagar", "city": "Hyderabad", "lat": 17.3439, "lng": 78.5519, "risk_level": "HIGH", "base_premium": 119, "weekly_cap_basic": 1500, "weekly_cap_standard": 3000, "weekly_cap_pro": 5000, "historical_flood_risk": 0.70, "historical_heat_risk": 0.75, "historical_aqi_risk": 0.60, "historical_traffic_risk": 0.70},
    {"name": "Secunderabad", "city": "Hyderabad", "lat": 17.4399, "lng": 78.4983, "risk_level": "MEDIUM", "base_premium": 89, "weekly_cap_basic": 1500, "weekly_cap_standard": 3000, "weekly_cap_pro": 5000, "historical_flood_risk": 0.30, "historical_heat_risk": 0.65, "historical_aqi_risk": 0.50, "historical_traffic_risk": 0.60},
    {"name": "Uppal", "city": "Hyderabad", "lat": 17.4010, "lng": 78.5590, "risk_level": "HIGH", "base_premium": 119, "weekly_cap_basic": 1500, "weekly_cap_standard": 3000, "weekly_cap_pro": 5000, "historical_flood_risk": 0.65, "historical_heat_risk": 0.70, "historical_aqi_risk": 0.55, "historical_traffic_risk": 0.65},
    {"name": "Dilsukhnagar", "city": "Hyderabad", "lat": 17.3686, "lng": 78.5247, "risk_level": "HIGH", "base_premium": 119, "weekly_cap_basic": 1500, "weekly_cap_standard": 3000, "weekly_cap_pro": 5000, "historical_flood_risk": 0.70, "historical_heat_risk": 0.70, "historical_aqi_risk": 0.60, "historical_traffic_risk": 0.70},
    {"name": "Ameerpet", "city": "Hyderabad", "lat": 17.4375, "lng": 78.4483, "risk_level": "MEDIUM", "base_premium": 89, "weekly_cap_basic": 1500, "weekly_cap_standard": 3000, "weekly_cap_pro": 5000, "historical_flood_risk": 0.25, "historical_heat_risk": 0.65, "historical_aqi_risk": 0.45, "historical_traffic_risk": 0.65},
    {"name": "Vijayawada Central", "city": "Vijayawada", "lat": 16.5062, "lng": 80.6480, "risk_level": "MEDIUM", "base_premium": 89, "weekly_cap_basic": 1500, "weekly_cap_standard": 3000, "weekly_cap_pro": 5000, "historical_flood_risk": 0.60, "historical_heat_risk": 0.80, "historical_aqi_risk": 0.40, "historical_traffic_risk": 0.55},
    {"name": "Benz Circle", "city": "Vijayawada", "lat": 16.5193, "lng": 80.6305, "risk_level": "MEDIUM", "base_premium": 89, "weekly_cap_basic": 1500, "weekly_cap_standard": 3000, "weekly_cap_pro": 5000, "historical_flood_risk": 0.55, "historical_heat_risk": 0.80, "historical_aqi_risk": 0.40, "historical_traffic_risk": 0.60},
    {"name": "Auto Nagar", "city": "Vijayawada", "lat": 16.4907, "lng": 80.6480, "risk_level": "HIGH", "base_premium": 119, "weekly_cap_basic": 1500, "weekly_cap_standard": 3000, "weekly_cap_pro": 5000, "historical_flood_risk": 0.70, "historical_heat_risk": 0.82, "historical_aqi_risk": 0.55, "historical_traffic_risk": 0.50},
    {"name": "Kanuru", "city": "Vijayawada", "lat": 16.5015, "lng": 80.6780, "risk_level": "LOW", "base_premium": 69, "weekly_cap_basic": 1500, "weekly_cap_standard": 3000, "weekly_cap_pro": 5000, "historical_flood_risk": 0.30, "historical_heat_risk": 0.75, "historical_aqi_risk": 0.30, "historical_traffic_risk": 0.35},
    {"name": "Patamata", "city": "Vijayawada", "lat": 16.5241, "lng": 80.6414, "risk_level": "MEDIUM", "base_premium": 89, "weekly_cap_basic": 1500, "weekly_cap_standard": 3000, "weekly_cap_pro": 5000, "historical_flood_risk": 0.50, "historical_heat_risk": 0.78, "historical_aqi_risk": 0.38, "historical_traffic_risk": 0.45},
    {"name": "Andheri", "city": "Mumbai", "lat": 19.1136, "lng": 72.8697, "risk_level": "HIGH", "base_premium": 129, "weekly_cap_basic": 1500, "weekly_cap_standard": 3000, "weekly_cap_pro": 5000, "historical_flood_risk": 0.85, "historical_heat_risk": 0.50, "historical_aqi_risk": 0.60, "historical_traffic_risk": 0.80},
    {"name": "Dadar", "city": "Mumbai", "lat": 19.0178, "lng": 72.8478, "risk_level": "HIGH", "base_premium": 129, "weekly_cap_basic": 1500, "weekly_cap_standard": 3000, "weekly_cap_pro": 5000, "historical_flood_risk": 0.80, "historical_heat_risk": 0.50, "historical_aqi_risk": 0.65, "historical_traffic_risk": 0.85},
    {"name": "Thane", "city": "Mumbai", "lat": 19.2183, "lng": 72.9781, "risk_level": "MEDIUM", "base_premium": 99, "weekly_cap_basic": 1500, "weekly_cap_standard": 3000, "weekly_cap_pro": 5000, "historical_flood_risk": 0.65, "historical_heat_risk": 0.50, "historical_aqi_risk": 0.50, "historical_traffic_risk": 0.70},
    {"name": "Bandra", "city": "Mumbai", "lat": 19.0596, "lng": 72.8295, "risk_level": "MEDIUM", "base_premium": 99, "weekly_cap_basic": 1500, "weekly_cap_standard": 3000, "weekly_cap_pro": 5000, "historical_flood_risk": 0.60, "historical_heat_risk": 0.48, "historical_aqi_risk": 0.55, "historical_traffic_risk": 0.75},
    {"name": "Koramangala", "city": "Bangalore", "lat": 12.9352, "lng": 77.6245, "risk_level": "LOW", "base_premium": 79, "weekly_cap_basic": 1500, "weekly_cap_standard": 3000, "weekly_cap_pro": 5000, "historical_flood_risk": 0.20, "historical_heat_risk": 0.25, "historical_aqi_risk": 0.35, "historical_traffic_risk": 0.65},
    {"name": "Whitefield", "city": "Bangalore", "lat": 12.9698, "lng": 77.7499, "risk_level": "LOW", "base_premium": 79, "weekly_cap_basic": 1500, "weekly_cap_standard": 3000, "weekly_cap_pro": 5000, "historical_flood_risk": 0.18, "historical_heat_risk": 0.22, "historical_aqi_risk": 0.30, "historical_traffic_risk": 0.70},
    {"name": "Indiranagar", "city": "Bangalore", "lat": 12.9784, "lng": 77.6408, "risk_level": "LOW", "base_premium": 79, "weekly_cap_basic": 1500, "weekly_cap_standard": 3000, "weekly_cap_pro": 5000, "historical_flood_risk": 0.20, "historical_heat_risk": 0.23, "historical_aqi_risk": 0.32, "historical_traffic_risk": 0.60},
    {"name": "HSR Layout", "city": "Bangalore", "lat": 12.9116, "lng": 77.6389, "risk_level": "LOW", "base_premium": 79, "weekly_cap_basic": 1500, "weekly_cap_standard": 3000, "weekly_cap_pro": 5000, "historical_flood_risk": 0.15, "historical_heat_risk": 0.20, "historical_aqi_risk": 0.28, "historical_traffic_risk": 0.55},
    {"name": "Connaught Place", "city": "Delhi", "lat": 28.6315, "lng": 77.2167, "risk_level": "HIGH", "base_premium": 129, "weekly_cap_basic": 1500, "weekly_cap_standard": 3000, "weekly_cap_pro": 5000, "historical_flood_risk": 0.40, "historical_heat_risk": 0.90, "historical_aqi_risk": 0.90, "historical_traffic_risk": 0.85},
    {"name": "Dwarka", "city": "Delhi", "lat": 28.5921, "lng": 77.0460, "risk_level": "MEDIUM", "base_premium": 99, "weekly_cap_basic": 1500, "weekly_cap_standard": 3000, "weekly_cap_pro": 5000, "historical_flood_risk": 0.35, "historical_heat_risk": 0.88, "historical_aqi_risk": 0.85, "historical_traffic_risk": 0.65},
    {"name": "T Nagar", "city": "Chennai", "lat": 13.0418, "lng": 80.2341, "risk_level": "MEDIUM", "base_premium": 89, "weekly_cap_basic": 1500, "weekly_cap_standard": 3000, "weekly_cap_pro": 5000, "historical_flood_risk": 0.60, "historical_heat_risk": 0.70, "historical_aqi_risk": 0.40, "historical_traffic_risk": 0.70},
    {"name": "Anna Nagar", "city": "Chennai", "lat": 13.0850, "lng": 80.2101, "risk_level": "LOW", "base_premium": 79, "weekly_cap_basic": 1500, "weekly_cap_standard": 3000, "weekly_cap_pro": 5000, "historical_flood_risk": 0.40, "historical_heat_risk": 0.68, "historical_aqi_risk": 0.35, "historical_traffic_risk": 0.60},
]


def _city_prefix(city: str) -> str:
    c = (city or "").strip().lower()
    if c == "hyderabad":
        return "HYD"
    if c == "vijayawada":
        return "VJA"
    if c == "mumbai":
        return "MUM"
    if c == "bangalore":
        return "BLR"
    if c == "delhi":
        return "DEL"
    if c == "chennai":
        return "CHE"
    return "ZNE"


def _slug_code(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", name.strip().lower()).strip("_")
    return s.upper() or "ZONE"


def _risk_tier(level: str) -> str:
    m = (level or "MEDIUM").strip().upper()
    if m == "LOW":
        return "low"
    if m == "HIGH":
        return "high"
    return "medium"


def _multiplier(z: dict[str, Any]) -> float:
    f = float(z["historical_flood_risk"])
    h = float(z["historical_heat_risk"])
    a = float(z["historical_aqi_risk"])
    t = float(z["historical_traffic_risk"])
    return round(f * 0.35 + h * 0.25 + a * 0.25 + t * 0.15, 4)


def zone_city_code(z: dict[str, Any]) -> str:
    return f"{_city_prefix(str(z['city']))}_{_slug_code(str(z['name']))}"


async def seed_zones() -> None:
    async with AsyncSessionLocal() as session:
        for z in ZONES_SPEC:
            cc = zone_city_code(z)
            flood = float(z["historical_flood_risk"])
            heat = float(z["historical_heat_risk"])
            aqi = float(z["historical_aqi_risk"])
            tier = _risk_tier(str(z["risk_level"]))
            mult = _multiplier(z)

            existing = (await session.execute(select(Zone).where(Zone.city_code == cc))).scalar_one_or_none()
            if existing:
                existing.name = str(z["name"])
                existing.city = str(z["city"])
                existing.lat = float(z["lat"])
                existing.lng = float(z["lng"])
                existing.flood_risk_score = flood
                existing.heat_risk_score = heat
                existing.aqi_risk_score = aqi
                existing.zone_risk_multiplier = mult
                existing.risk_tier = tier
            else:
                session.add(
                    Zone(
                        city_code=cc,
                        name=str(z["name"]),
                        city=str(z["city"]),
                        lat=float(z["lat"]),
                        lng=float(z["lng"]),
                        flood_risk_score=flood,
                        heat_risk_score=heat,
                        aqi_risk_score=aqi,
                        zone_risk_multiplier=mult,
                        risk_tier=tier,
                    )
                )
        await session.commit()


async def seed_demo_workers() -> None:
    """Create two demo users + profiles if phones are absent (same shape as POST /workers/create)."""
    demos: list[tuple[str, str, str, float, str, str]] = [
        ("9999999999", "Bhargav", "Zomato", 0.78, "Hyderabad", "HYD_GACHIBOWLI"),
        ("8888888888", "Demo Worker", "Swiggy", 0.62, "Hyderabad", "HYD_GACHIBOWLI"),
    ]
    async with AsyncSessionLocal() as session:
        for phone, name, platform, trust, city, zone_code in demos:
            exists = (await session.execute(select(User.id).where(User.phone == phone))).scalar_one_or_none()
            if exists is not None:
                continue
            user = User(phone=phone, is_active=True, is_admin=False)
            session.add(user)
            await session.flush()
            session.add(
                Profile(
                    user_id=user.id,
                    name=name,
                    city=city,
                    occupation=OccupationType.delivery,
                    avg_daily_income=900.0,
                    risk_profile=RiskProfile.medium,
                    trust_score=trust,
                    platform=platform,
                    zone_id=zone_code.lower(),
                )
            )
        await session.commit()


async def count_zones() -> int:
    async with AsyncSessionLocal() as session:
        n = (await session.execute(select(func.count()).select_from(Zone))).scalar_one()
        return int(n or 0)


async def main() -> None:
    await init_db()
    if await count_zones() == 0:
        await seed_zones()
    await seed_demo_workers()
    n = await count_zones()
    print(f"DB ready. Zones: {n}")


if __name__ == "__main__":
    asyncio.run(main())
