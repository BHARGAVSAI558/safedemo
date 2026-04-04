from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, List, Optional, Tuple

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.engines.fraud.pipeline import MasterFraudPipeline, new_claim_id, run_fraud_pipeline
from app.engines.fraud.types import AppActivityEvent, FraudResult, GPSPoint, GPSZone
from app.models.claim import Simulation
from app.utils.logger import get_logger

log = get_logger(__name__)

FRAUD_THRESHOLD = 0.7


def build_gps_zone(zone_id: str, center_lat: float, center_lon: float, radius_km: float = 25.0) -> GPSZone:
    return GPSZone(zone_id=zone_id, center_lat=center_lat, center_lon=center_lon, radius_km=radius_km)


class FraudEngine:
    """Legacy entrypoint + 4-layer pipeline orchestration."""

    @staticmethod
    async def evaluate(
        user_id: int,
        fraud_flag: bool,
        db: AsyncSession,
        *,
        claim_id: Optional[str] = None,
        mongo_db: Any = None,
        redis: Any = None,
        zone_id: str = "default",
        enrollment_timestamp: Optional[datetime] = None,
        first_claim_at: Optional[datetime] = None,
        gps_trail: Optional[List[GPSPoint]] = None,
        app_activity: Optional[List[AppActivityEvent]] = None,
        confidence_level: Optional[str] = None,
        confidence_signals_active: Optional[List[str]] = None,
        weather_signal: Any = None,
        aqi_signal: Any = None,
        platform_drop_pct: float = 0.0,
        zone_gps: Optional[GPSZone] = None,
        city_avg_lat: float = 17.385,
        city_avg_lon: float = 78.4867,
    ) -> FraudResult:
        _ = db
        cid = claim_id or new_claim_id()
        trail = list(gps_trail or [])
        app_log = list(app_activity or [])
        zg = zone_gps or build_gps_zone(zone_id, city_avg_lat, city_avg_lon)

        enr = enrollment_timestamp or datetime.now(timezone.utc)
        if enr.tzinfo is None:
            enr = enr.replace(tzinfo=timezone.utc)

        sig = list(confidence_signals_active or [])

        fr = await run_fraud_pipeline(
            cid,
            user_id,
            trail,
            app_log,
            zone_id,
            enrollment_timestamp=enr,
            first_claim_at=first_claim_at,
            fraud_flag_sim=fraud_flag,
            confidence_level=confidence_level,
            confidence_signals_active=sig,
            weather_signal=weather_signal,
            aqi_signal=aqi_signal,
            platform_drop_pct=platform_drop_pct,
            zone_gps=zg,
            city_avg_lat=city_avg_lat,
            city_avg_lon=city_avg_lon,
            mongo_db=mongo_db,
            redis=redis,
        )

        log.info(
            "fraud_pipeline_scored",
            engine_name="fraud_engine",
            fraud_score=fr.fraud_score,
            overall=fr.overall_decision,
            worker_id=user_id,
        )
        return fr

    @staticmethod
    async def score(
        user_id: int,
        fraud_flag: bool,
        db: AsyncSession,
        **kwargs: Any,
    ) -> Tuple[float, str]:
        fr = await FraudEngine.evaluate(user_id, fraud_flag, db, **kwargs)
        reason = "; ".join(fr.reason_codes) if fr.reason_codes else "pipeline_complete"
        return fr.fraud_score, reason

    @staticmethod
    async def run_pipeline_full(
        *,
        claim_id: str,
        worker_id: int,
        zone_id: str,
        enrollment_timestamp: datetime,
        first_claim_at: Optional[datetime],
        gps_trail: List[GPSPoint],
        app_log: List[AppActivityEvent],
        fraud_flag_sim: bool,
        confidence_level: Optional[str],
        confidence_signals_active: List[str],
        weather_signal: Any,
        aqi_signal: Any,
        platform_drop_pct: float,
        zone_gps: GPSZone,
        city_avg_lat: float,
        city_avg_lon: float,
        mongo_db: Any,
        redis: Any,
    ):
        return await run_fraud_pipeline(
            claim_id,
            worker_id,
            gps_trail,
            app_log,
            zone_id,
            enrollment_timestamp=enrollment_timestamp,
            first_claim_at=first_claim_at,
            fraud_flag_sim=fraud_flag_sim,
            confidence_level=confidence_level,
            confidence_signals_active=confidence_signals_active,
            weather_signal=weather_signal,
            aqi_signal=aqi_signal,
            platform_drop_pct=platform_drop_pct,
            zone_gps=zone_gps,
            city_avg_lat=city_avg_lat,
            city_avg_lon=city_avg_lon,
            mongo_db=mongo_db,
            redis=redis,
        )


async def first_simulation_time(db: AsyncSession, user_id: int) -> Optional[datetime]:
    q = (
        select(Simulation.created_at)
        .where(Simulation.user_id == user_id)
        .order_by(Simulation.created_at.asc())
        .limit(1)
    )
    r = await db.execute(q)
    row = r.scalar_one_or_none()
    return row
