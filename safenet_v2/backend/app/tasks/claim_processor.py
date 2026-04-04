from __future__ import annotations

import asyncio
import traceback
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from uuid import uuid4

from celery import Celery
from sqlalchemy import select

from app.core.config import settings
from app.db.mongo import connect_mongo
from app.db.session import AsyncSessionLocal
from app.engines.behavioral_engine import BehavioralEngine
from app.engines.confidence_engine import ConfidenceEngine
from app.engines.decision_engine import DecisionEngine
from app.engines.fraud_engine import FraudEngine
from app.engines.fraud.types import AppActivityEvent, GPSPoint
from app.engines.fraud_engine import build_gps_zone, first_simulation_time
from app.engines.fraud_engine import FRAUD_THRESHOLD
from app.models.claim import ClaimLifecycle, DecisionType
from app.models.worker import Profile
from app.services.realtime_service import publish_claim_update, publish_zone_event
from app.services.zone_resolver import resolve_city_to_zone
from app.schemas.claim import SimulationRequest
from app.utils.logger import get_logger

log = get_logger(__name__)


def _redis_url_for_celery(url: str, db: int = 0) -> str:
    # Celery expects explicit /<db>. `settings.REDIS_URL` might be redis://host:6379
    if "/"+str(db) in url:
        return url
    if url.endswith("/"):
        return url + str(db)
    return url + f"/{db}"


celery_broker = _redis_url_for_celery(settings.REDIS_URL, 0)
celery_backend = _redis_url_for_celery(settings.REDIS_URL, 1)

celery_app = Celery(
    "safenet_background_tasks",
    broker=celery_broker,
    backend=celery_backend,
)

celery_app.conf.update(
    task_acks_late=True,
    worker_prefetch_multiplier=1,
    timezone="Asia/Kolkata",
    enable_utc=False,
)


async def process_claim_async(
    worker_id: int,
    zone_id: str,
    gps_trail: Optional[List[Dict[str, Any]]],
    app_log: Optional[List[Dict[str, Any]]],
    disruption_type: str,
    claim_id: Optional[str] = None,
    correlation_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Production-oriented orchestration for a claim.
    This uses the existing engines as an end-to-end pipeline.
    """
    claim_id = claim_id or f"claim:{worker_id}:{int(datetime.now(tz=timezone.utc).timestamp())}"
    correlation_id = correlation_id or str(uuid4())
    redis = None
    mongo_db = await connect_mongo()

    # Attempt to create redis client for realtime + progress.
    try:
        import redis.asyncio as aioredis

        redis = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
        await redis.ping()
    except Exception:
        redis = None

    async def _set_lifecycle_status(db: Any, status: str, message: str, payout_amount: Optional[float] = None, error_detail: Optional[str] = None) -> None:
        row = (
            await db.execute(select(ClaimLifecycle).where(ClaimLifecycle.claim_id == claim_id))
        ).scalar_one_or_none()
        if row is None:
            row = ClaimLifecycle(
                claim_id=claim_id,
                correlation_id=correlation_id,
                user_id=worker_id,
                zone_id=zone_id,
                disruption_type=disruption_type,
                status=status,
                message=message,
                payout_amount=float(payout_amount or 0.0),
                error_detail=error_detail,
            )
            db.add(row)
        else:
            row.status = status
            row.message = message
            if payout_amount is not None:
                row.payout_amount = float(payout_amount)
            if error_detail is not None:
                row.error_detail = error_detail
        await db.commit()

    async def _publish(step_status: str, message: str, payout_amount: Optional[float] = None) -> None:
        try:
            await publish_claim_update(
                redis=redis,
                worker_id=worker_id,
                claim_id=claim_id,
                status=step_status,
                message=message,
                payout_amount=payout_amount,
                zone_id=zone_id,
                disruption_type=disruption_type,
                correlation_id=correlation_id,
            )
        except Exception:
            pass

    gps_trail_typed: List[GPSPoint] = []
    for p in gps_trail or []:
        ts = p.get("timestamp")
        if isinstance(ts, str):
            ts_dt = datetime.fromisoformat(ts)
        elif isinstance(ts, datetime):
            ts_dt = ts
        else:
            ts_dt = datetime.now(tz=timezone.utc)
        gps_trail_typed.append(
            GPSPoint(
                lat=float(p.get("lat", 0.0)),
                lon=float(p.get("lon", 0.0)),
                timestamp=ts_dt,
                cell_tower_id=str(p.get("cell_tower_id", "")),
                accelerometer_magnitude=float(p.get("accelerometer_magnitude", 1.0)),
            )
        )

    app_log_typed: List[AppActivityEvent] = []
    for a in app_log or []:
        ts = a.get("timestamp")
        if isinstance(ts, str):
            ts_dt = datetime.fromisoformat(ts)
        elif isinstance(ts, datetime):
            ts_dt = ts
        else:
            ts_dt = datetime.now(tz=timezone.utc)
        app_log_typed.append(AppActivityEvent(timestamp=ts_dt, event_type=str(a.get("event_type", "heartbeat"))))

    async with AsyncSessionLocal() as db:
        await _set_lifecycle_status(db, "VERIFYING", "Claim verification started")
        await _publish("VERIFYING", "Disruption detected, verifying signals")
        try:
            # Step 1: Run ConfidenceEngine — if LOW, return NO_PAYOUT immediately

            # Resolve a representative lat/lon for the zone using city mapping fallback.
            try:
                city_name = "Hyderabad"
                zid, lat, lon = resolve_city_to_zone(city_name)
                lat = float(lat)
                lon = float(lon)
            except Exception:
                lat = 17.385
                lon = 78.4867

            ce = ConfidenceEngine(redis=redis, mongo_db=mongo_db)
            conf = await ce.evaluate(zone_id, lat, lon, city="Hyderabad")
            await _publish("VERIFYING", f"Confidence level: {conf.level}")

            if conf.level == "LOW":
                await _set_lifecycle_status(db, "DECISION", "No payout: low confidence")
                await _publish("CLAIM_REJECTED", "Confidence LOW: no payout", payout_amount=None)
                return {"claim_id": claim_id, "status": "NO_PAYOUT", "confidence_level": conf.level}

            # Step 2: Run BehavioralEngine — compute deviation_score
            await _publish("VERIFYING", "Loading worker baseline and deviation score")
            worker_profile = await db.execute(
                select(Profile).where(Profile.user_id == worker_id)  # type: ignore[name-defined]
            )
            profile = worker_profile.scalars().first()
            if profile is None:
                await _set_lifecycle_status(db, "ERROR", "Worker profile missing")
                await _publish("ERROR", "Worker profile not found", payout_amount=None)
                return {"claim_id": claim_id, "status": "ERROR"}

            expected, actual, loss = BehavioralEngine.income_outcome(profile, is_active=False, is_disruption=True)
            deviation_score = float(loss) / float(expected) if expected else 1.0
            if deviation_score < 0.2:
                await _set_lifecycle_status(db, "DECISION", "No payout: deviation below threshold")
                await _publish("CLAIM_REJECTED", "Deviation below threshold: no payout", payout_amount=None)
                return {"claim_id": claim_id, "status": "NO_PAYOUT", "deviation_score": deviation_score}

            # Step 4: Run FraudEngine full pipeline
            await _set_lifecycle_status(db, "FRAUD_CHECK", "Running fraud checks")
            await _publish("FRAUD_CHECK", "Running fraud integrity + corroboration")
            first_ts = await first_simulation_time(db, worker_id)
            enrollment_ts = profile.created_at if profile.created_at is not None else datetime.now(tz=timezone.utc)
            zg = build_gps_zone(zone_id, lat, lon)

        # ConfidenceResult doesn't include platform demand signal; pass 0.0 as fallback.
            fr = await FraudEngine.evaluate(
            worker_id,
            False,
            db,
            claim_id=claim_id,
            mongo_db=mongo_db,
            redis=redis,
            zone_id=zone_id,
            enrollment_timestamp=enrollment_ts,
            first_claim_at=first_ts,
            gps_trail=gps_trail_typed,
            app_activity=app_log_typed,
            confidence_level=conf.level,
            confidence_signals_active=list(conf.signals_active),
            weather_signal=conf.weather,
            aqi_signal=conf.aqi,
            platform_drop_pct=0.0,
            zone_gps=zg,
            city_avg_lat=lat,
            city_avg_lon=lon,
        )
            await _publish("FRAUD_CHECK", f"Fraud result: {fr.overall_decision}", payout_amount=None)

            # Step 5: Pass inputs to DecisionEngine (DecisionEngine will recompute signals end-to-end)
            await _set_lifecycle_status(db, "DECISION", "Computing final decision")
            await _publish("DECISION", "Computing final decision + payout decision")
            req = SimulationRequest(
            is_active=False,
            fraud_flag=False,
            gps_trail=[
                {
                    "lat": p.lat,
                    "lon": p.lon,
                    "timestamp": p.timestamp,
                    "cell_tower_id": p.cell_tower_id,
                    "accelerometer_magnitude": p.accelerometer_magnitude,
                }
                for p in gps_trail_typed
            ],
            app_activity=[{"timestamp": a.timestamp, "event_type": a.event_type} for a in app_log_typed],
        )
            sim = await DecisionEngine.run(worker_id, req, db, redis=redis, mongo_db=mongo_db)

            if sim.decision == DecisionType.APPROVED:
                await _set_lifecycle_status(db, "PAYOUT", "Payout credited", payout_amount=float(sim.payout or 0.0))
                await _publish("PAYOUT_CREDITED", "Payout processed", payout_amount=float(sim.payout or 0.0))
            elif str(sim.reason).lower().find("manual review") >= 0:
                await _set_lifecycle_status(db, "REVALIDATING", "Claim moved to revalidation queue")
                await _publish("REVALIDATING", "Claim flagged, revalidation in progress", payout_amount=None)
            else:
                await _set_lifecycle_status(db, "CLAIM_REJECTED", "Claim rejected")
                await _publish("CLAIM_REJECTED", "No payout for this claim", payout_amount=None)

            return {"claim_id": claim_id, "status": "PROCESSED", "decision": sim.decision, "payout": sim.payout}
        except Exception as exc:
            err = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
            await _set_lifecycle_status(db, "ERROR", "Claim processing failed", error_detail=err)
            await _publish("ERROR", "Claim processing failed. Our team has been notified.")
            try:
                await publish_zone_event(
                    redis=redis,
                    zone_id=zone_id,
                    event_type="ADMIN_CLAIM_ERROR",
                    details={"claim_id": claim_id, "worker_id": worker_id, "error": str(exc)},
                    correlation_id=correlation_id,
                )
            except Exception:
                pass
            return {"claim_id": claim_id, "status": "ERROR", "error": str(exc)}


@celery_app.task(
    bind=True,
    max_retries=3,
    name="process_claim",
    autoretry_for=(Exception,),
)
def process_claim(
    self,
    worker_id: int,
    zone_id: str,
    gps_trail: Optional[List[Dict[str, Any]]] = None,
    app_log: Optional[List[Dict[str, Any]]] = None,
    disruption_type: str = "",
    claim_id: Optional[str] = None,
    correlation_id: Optional[str] = None,
) -> Dict[str, Any]:
    try:
        return asyncio.run(
            process_claim_async(
                worker_id=worker_id,
                zone_id=zone_id,
                gps_trail=gps_trail,
                app_log=app_log,
                disruption_type=disruption_type,
                claim_id=claim_id,
                correlation_id=correlation_id,
            )
        )
    except Exception as exc:
        retries = int(getattr(self.request, "retries", 0))
        if retries < 3:
            try:
                raise self.retry(exc=exc, countdown=60)
            except Exception:
                pass
        raise

