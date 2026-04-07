from __future__ import annotations

import asyncio
import json
import traceback
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo
from uuid import uuid4

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger
from sqlalchemy import func, select

from app.db.session import AsyncSessionLocal
from app.engines.confidence_engine import ConfidenceEngine
from app.engines.fraud_engine import FRAUD_THRESHOLD
from app.engines.payout_engine import PayoutEngine
from app.engines.premium_engine import PremiumEngine
from app.engines.fraud_engine import first_simulation_time
from app.models.claim import ClaimLifecycle, DecisionType, Simulation
from app.models.fraud import FraudSignal
from app.models.payout import PayoutRecord
from app.models.policy import Policy
from app.models.pool_balance import ZonePoolBalance
from app.models.worker import Profile, User
from app.models.zone import Zone
from app.services.realtime_service import publish_claim_update, publish_pool_health, publish_zone_event
from app.tasks.claim_processor import process_claim
from app.services.zone_resolver import resolve_city_to_zone
from app.services.forecast_shield_service import refresh_forecast_shields
from app.services.notification_service import create_notification
from app.utils.logger import logger as struct_logger

from app.utils.logger import get_logger

get_log = get_logger(__name__)

IST = ZoneInfo("Asia/Kolkata")

_FAILURES_CONSECUTIVE: Dict[str, int] = {}
_PAUSED: Dict[str, datetime] = {}
_LOCAL_LOCKS: Dict[str, asyncio.Lock] = {}


def _ist_now() -> datetime:
    return datetime.now(tz=IST)


def _bucket_key(d: datetime, step_minutes: int) -> str:
    minute_bucket = (d.minute // step_minutes) * step_minutes
    return d.strftime(f"%Y%m%d%H{minute_bucket:02d}")


async def _acquire_job_lock(redis: Any, lock_key: str, ttl_seconds: int) -> bool:
    if redis is None:
        lock = _LOCAL_LOCKS.setdefault(lock_key, asyncio.Lock())
        if lock.locked():
            return False
        await lock.acquire()
        return True
    try:
        res = await redis.set(lock_key, "1", nx=True, ex=ttl_seconds)
        return bool(res)
    except Exception:
        return False


async def _release_job_lock(redis: Any, lock_key: str) -> None:
    if redis is None:
        lock = _LOCAL_LOCKS.get(lock_key)
        if lock is not None and lock.locked():
            lock.release()
        return
    try:
        await redis.delete(lock_key)
    except Exception:
        pass


async def _admin_job_alert(redis: Any, *, zone_id: str, job_id: str, error: str) -> None:
    try:
        await publish_zone_event(
            redis=redis,
            zone_id=zone_id,
            event_type="ADMIN_JOB_ALERT",
            details={"job_id": job_id, "error": error},
        )
    except Exception:
        pass


async def _safe_job_run(
    *,
    scheduler: AsyncIOScheduler,
    app: Any,
    job_id: str,
    lock_key: str,
    lock_ttl_seconds: int,
    coro_fn: Any,
) -> None:
    redis = getattr(app.state, "redis", None)
    if job_id in _PAUSED:
        if _ist_now() < _PAUSED[job_id]:
            return
        _PAUSED.pop(job_id, None)

    acquired = await _acquire_job_lock(redis, lock_key, lock_ttl_seconds)
    if not acquired:
        return

    try:
        await coro_fn()
        _FAILURES_CONSECUTIVE[job_id] = 0
    except Exception as exc:
        _FAILURES_CONSECUTIVE[job_id] = _FAILURES_CONSECUTIVE.get(job_id, 0) + 1
        err = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
        struct_logger.exception(
            "scheduler_job_failed",
            engine_name="background_scheduler",
            reason_code="JOB_CRASH",
            job_id=job_id,
            error=str(exc),
        )
        await _admin_job_alert(redis, zone_id="global", job_id=job_id, error=err)

        if _FAILURES_CONSECUTIVE[job_id] >= 3:
            _PAUSED[job_id] = _ist_now() + timedelta(minutes=15)
            try:
                scheduler.pause_job(job_id)
            except Exception:
                pass
            # Resume after 15 minutes (best-effort)
            resume_at = _ist_now() + timedelta(minutes=15)

            def _resume_job() -> None:
                _PAUSED.pop(job_id, None)
                try:
                    scheduler.resume_job(job_id)
                except Exception:
                    pass

            scheduler.add_job(
                _resume_job,
                "date",
                run_date=resume_at,
                id=f"{job_id}_resume",
                replace_existing=True,
            )
    finally:
        await _release_job_lock(redis, lock_key)


def _load_zone_coordinates() -> Dict[str, Dict[str, Any]]:
    # Returns {city: {zone_id, lat, lon}}
    import os

    base = os.path.dirname(os.path.dirname(__file__))
    path = os.path.join(base, "data", "zone_coordinates.json")
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"Hyderabad": {"zone_id": "default", "lat": 17.385, "lon": 78.4867}}


def _zones_from_coordinates() -> List[Tuple[str, str, float, float]]:
    coords = _load_zone_coordinates()
    out: list[tuple[str, str, float, float]] = []
    for city, v in coords.items():
        zid = str(v.get("zone_id", "default"))
        out.append((city, zid, float(v.get("lat", 0.0)), float(v.get("lon", 0.0))))
    # unique by zone_id
    uniq: Dict[str, Tuple[str, str, float, float]] = {}
    for city, zid, lat, lon in out:
        if zid not in uniq:
            uniq[zid] = (city, zid, lat, lon)
    return list(uniq.values())


def _zone_risk_multiplier(risk_tier: str) -> float:
    rt = (risk_tier or "").lower()
    if rt == "high":
        return 0.8
    if rt == "low":
        return 0.2
    return 0.5


async def _get_active_workers_in_zone(zone_id: str, session: Any) -> List[User]:
    # Map worker by profile.city → zone_id using resolve_city_to_zone.
    rows = await session.execute(
        select(User, Profile).join(Profile, Profile.user_id == User.id).where(User.is_active.is_(True))
    )
    users: List[User] = []
    for user, profile in rows.all():
        zid, _, _ = resolve_city_to_zone(profile.city)
        if zid == zone_id:
            users.append(user)
    return users


async def _worker_has_active_policy(user_id: int, session: Any) -> bool:
    active = await session.execute(
        select(func.count(Policy.id)).where(Policy.user_id == user_id, Policy.status == "active")
    )
    return bool(active.scalar_one() or 0)


def _deviation_detected_from_baseline(profile: Profile) -> bool:
    # Deterministic heuristic until full telemetry-baseline joins are added.
    trust = float(getattr(profile, "trust_score", 0.7) or 0.7)
    claims = int(getattr(profile, "total_claims", 0) or 0)
    return (trust < 0.85) or (claims % 3 == 0 and claims > 0)


async def confidence_monitor(app: Any) -> None:
    """
    confidence_monitor: runs every 30 minutes between 6 AM – 11 PM IST.
    """
    redis = getattr(app.state, "redis", None)
    mongo_db = getattr(app.state, "mongo_db", None)

    ist_now = _ist_now()
    if not (6 <= ist_now.hour <= 23):
        return

    zones = _zones_from_coordinates()
    async with AsyncSessionLocal() as session:
        # Resolve zone rows if present (optional).
        zone_rows = {}
        try:
            zrows = await session.execute(select(Zone))
            for z in zrows.scalars().all():
                zone_rows[str(z.city_code)] = z
        except Exception:
            zone_rows = {}

        for city, zone_id, lat, lon in zones:
            prev_key = f"confidence_level_high:{zone_id}"
            prev = None
            if redis is not None:
                try:
                    prev = await redis.get(prev_key)
                except Exception:
                    prev = None

            ce = ConfidenceEngine(redis=redis, mongo_db=mongo_db)
            conf = await ce.evaluate(zone_id, lat, lon, city=city)
            level = str(conf.level)

            if level == "HIGH":
                if redis is not None:
                    try:
                        await redis.set(prev_key, "HIGH", ex=3600)
                    except Exception:
                        pass

                workers = await _get_active_workers_in_zone(zone_id, session)
                worker_ids = [w.id for w in workers]
                if worker_ids:
                    await publish_zone_event(
                        redis=redis,
                        zone_id=zone_id,
                        event_type="WORKER_IMPACT_CHECK_TRIGGERED",
                        details={"worker_ids": worker_ids, "level": level},
                    )
                for worker in workers:
                    if not worker.profile:
                        continue
                    if not await _worker_has_active_policy(worker.id, session):
                        continue
                    if not _deviation_detected_from_baseline(worker.profile):
                        continue

                    correlation_id = str(uuid4())
                    claim_id = f"lifecycle:{worker.id}:{int(_ist_now().timestamp())}"
                    lifecycle = ClaimLifecycle(
                        claim_id=claim_id,
                        correlation_id=correlation_id,
                        user_id=worker.id,
                        zone_id=zone_id,
                        disruption_type=str(conf.disruption_type or "zone_disruption"),
                        status="INITIATED",
                        message="Disruption detected in your zone",
                    )
                    session.add(lifecycle)
                    await session.commit()

                    await publish_claim_update(
                        redis=redis,
                        worker_id=worker.id,
                        claim_id=claim_id,
                        status="INITIATED",
                        message="Disruption detected. Starting verification.",
                        zone_id=zone_id,
                        disruption_type=str(conf.disruption_type or "zone_disruption"),
                        confidence_level=level,
                        correlation_id=correlation_id,
                    )

                    process_claim.delay(
                        worker_id=worker.id,
                        zone_id=zone_id,
                        gps_trail=[],
                        app_log=[],
                        disruption_type=str(conf.disruption_type or "zone_disruption"),
                        claim_id=claim_id,
                        correlation_id=correlation_id,
                    )
            else:
                # If dropping from HIGH → MIXED/LOW, publish cleared.
                if prev == "HIGH":
                    await publish_zone_event(
                        redis=redis,
                        zone_id=zone_id,
                        event_type="DISRUPTION_CLEARED",
                        details={"from": "HIGH", "to": level},
                    )
                if redis is not None:
                    try:
                        await redis.delete(prev_key)
                    except Exception:
                        pass


async def premium_recalculator(app: Any) -> None:
    """
    premium_recalculator: every Monday at 00:00 IST
    """
    redis = getattr(app.state, "redis", None)
    async with AsyncSessionLocal() as session:
        users = (await session.execute(select(User).where(User.is_active.is_(True)))).scalars().all()
        now = _ist_now()
        week_start = (now - timedelta(days=now.weekday() + 7)).replace(hour=0, minute=0, second=0, microsecond=0)
        # Last full week window:
        w0 = now - timedelta(days=7)

        zones = _zones_from_coordinates()
        zone_by_city = {city: (zid, lat, lon) for city, zid, lat, lon in zones}

        from app.services.notification_service import NotificationService

        for user in users:
            if not user.profile:
                continue
            profile = user.profile
            zone_id, _, _ = resolve_city_to_zone(profile.city)

            zone_risk = None
            try:
                zone_row = await session.execute(select(Zone).where(Zone.city_code == profile.city))
                zr = zone_row.scalars().first()
                if zr is not None:
                    zone_risk = _zone_risk_multiplier(zr.risk_tier)
            except Exception:
                zone_risk = None
            if zone_risk is None:
                zone_risk = _zone_risk_multiplier(profile.risk_profile.value if hasattr(profile.risk_profile, "value") else "medium")

            tenure_days = max(0.0, (now - (user.created_at or now)).total_seconds() / 86400.0)  # type: ignore[operator]

            premium_result = await PremiumEngine.calculate(user.id)
            weekly_premium = float(premium_result.get("weekly_premium", 35))

            # Update policy: best effort if weekly_premium column exists.
            policies = await session.execute(
                select(Policy).where(Policy.user_id == user.id, Policy.status == "active")
            )
            policy = policies.scalars().first()
            if policy is None:
                continue

            try:
                setattr(policy, "weekly_premium", weekly_premium)
                # Keep monthly_premium aligned in case DB column is missing elsewhere.
                if not hasattr(policy, "weekly_premium"):
                    policy.monthly_premium = weekly_premium
                await session.commit()
            except Exception:
                # Fallback: store into monthly_premium.
                try:
                    policy.monthly_premium = weekly_premium
                    await session.commit()
                except Exception:
                    await session.rollback()

            try:
                await NotificationService.send_push(
                    user_id=user.id,
                    title="Premium updated",
                    body="Your weekly premium has been updated",
                    data={"weekly_premium": weekly_premium},
                )
            except Exception:
                pass


async def pool_health_auditor(app: Any) -> None:
    """
    pool_health_auditor: every Sunday at 23:59 IST
    """
    redis = getattr(app.state, "redis", None)
    now = _ist_now()

    # Week start = last Monday 00:00 IST
    week_start = (now - timedelta(days=now.weekday() + 7)).replace(hour=0, minute=0, second=0, microsecond=0)
    week_end = now
    async with AsyncSessionLocal() as session:
        # Aggregate payouts by worker city.
        rows = await session.execute(
            select(Profile.city, func.sum(PayoutRecord.amount)).select_from(PayoutRecord)
            .join(Simulation, Simulation.id == PayoutRecord.simulation_id)
            .join(User, User.id == Simulation.user_id)
            .join(Profile, Profile.user_id == User.id)
            .where(PayoutRecord.created_at >= week_start)
            .group_by(Profile.city)
        )
        city_sums = rows.all()

        zones = _zones_from_coordinates()
        for city, zid, lat, lon in zones:
            # total payouts this week for zone = sum over matching city (1:1 mapping).
            total = 0.0
            for c, s in city_sums:
                if c == city:
                    total = float(s or 0.0)

            # Load or create zone pool balance snapshot.
            db_row = await session.execute(
                select(ZonePoolBalance).where(
                    ZonePoolBalance.zone_id == zid,
                    ZonePoolBalance.week_start == week_start,
                )
            )
            existing = db_row.scalars().first()
            if existing is None:
                # Start-of-week balance: keep stable baseline, seeded from total.
                baseline = max(100000.0, total * 1.7)
                existing = ZonePoolBalance(
                    zone_id=zid,
                    week_start=week_start,
                    pool_balance_start_of_week=baseline,
                    total_payouts_this_week=total,
                    utilization_pct=(total / baseline * 100.0) if baseline > 0 else 0.0,
                    flagged_reinsurance=((total / baseline * 100.0) if baseline > 0 else 0.0) > 80.0,
                    risk_note="weekly_snapshot",
                )
                session.add(existing)
                await session.commit()
            else:
                existing.total_payouts_this_week = total
                existing.utilization_pct = (total / existing.pool_balance_start_of_week * 100.0) if existing.pool_balance_start_of_week > 0 else 0.0
                existing.flagged_reinsurance = existing.utilization_pct > 80.0
                existing.risk_note = "weekly_snapshot_updated"
                await session.commit()

            if existing.flagged_reinsurance:
                await publish_zone_event(
                    redis=redis,
                    zone_id=zid,
                    event_type="REINSURANCE_TRIGGER",
                    details={"utilization_pct": existing.utilization_pct, "week_start": str(week_start)},
                )


async def trust_score_updater(app: Any) -> None:
    """
    trust_score_updater: daily at 02:00 IST
    """
    now = _ist_now()
    w0 = now - timedelta(days=7)
    inactive_cutoff = now - timedelta(days=14)
    async with AsyncSessionLocal() as session:
        users = (await session.execute(select(User).where(User.is_active.is_(True)))).scalars().all()
        for user in users:
            if not user.profile:
                continue
            profile = user.profile

            policy_active = (
                await session.execute(
                    select(func.count(Policy.id)).where(
                        Policy.user_id == user.id,
                        Policy.status == "active",
                        Policy.created_at <= w0,
                    )
                )
            ).scalar_one() or 0

            flagged_in_week = (
                await session.execute(
                    select(func.count(Simulation.id)).where(
                        Simulation.user_id == user.id,
                        Simulation.created_at >= w0,
                        Simulation.decision == DecisionType.REJECTED,
                    )
                )
            ).scalar_one() or 0

            last_activity = (
                await session.execute(
                    select(func.max(Simulation.created_at)).where(Simulation.user_id == user.id)
                )
            ).scalar_one_or_none()

            updated = False
            trust_score = float(profile.trust_score)

            if policy_active > 0 and flagged_in_week == 0:
                # +2 points → +0.02 in this codebase's 0..1 scale.
                trust_score = min(1.0, trust_score + 0.02)
                updated = True

            if last_activity is None or (last_activity < inactive_cutoff):
                # trust_score = max(50, trust_score - 1) → min 0.5 in this codebase's 0..1 scale.
                trust_score = max(0.5, trust_score - 0.01)
                updated = True

            if updated:
                profile.trust_score = trust_score
                await session.commit()


async def forecast_shield_job(app: Any) -> None:
    """Refresh OpenWeather 48h risk windows into app.state.forecast_shields (startup + every 6h)."""
    await refresh_forecast_shields(app)


async def weather_alert_notifier(app: Any) -> None:
    """
    Daily notifier: if forecast shield indicates rain risk in worker's zone,
    enqueue a lightweight proactive alert notification.
    """
    shields = getattr(app.state, "forecast_shields", None) or {}
    if not isinstance(shields, dict) or not shields:
        return
    async with AsyncSessionLocal() as session:
        rows = (await session.execute(select(Profile))).scalars().all()
        for p in rows:
            zone = str(getattr(p, "zone_id", "") or "").strip().lower()
            if not zone:
                continue
            sh = shields.get(zone) or shields.get(zone.replace("-", "_"))
            if not sh:
                continue
            text = str((sh.get("subtitle") or sh.get("coverage_line") or "")).lower()
            if "rain" not in text:
                continue
            await create_notification(
                session,
                user_id=int(p.user_id),
                ntype="alert",
                title="Weather Alert",
                message="Heavy rain expected tomorrow. Stay prepared.",
            )
        await session.commit()


async def stale_claim_resolver(app: Any) -> None:
    """
    stale_claim_resolver: every 5 minutes
    """
    redis = getattr(app.state, "redis", None)
    two_hours_ago = _ist_now().astimezone(timezone.utc) - timedelta(hours=2)  # type: ignore[name-defined]
    async with AsyncSessionLocal() as session:
        # Resolve lifecycle claims that have been stuck in REVALIDATING for >2 hours.
        life_rows = await session.execute(
            select(ClaimLifecycle).where(
                ClaimLifecycle.status == "REVALIDATING",
                ClaimLifecycle.created_at <= two_hours_ago,
            )
        )
        for lc in life_rows.scalars().all():
            lc.status = "APPROVED"
            lc.message = "Auto-approved after stale revalidation window"
            await session.commit()
            try:
                await publish_claim_update(
                    redis=redis,
                    worker_id=lc.user_id,
                    claim_id=lc.claim_id,
                    status="APPROVED",
                    message="Auto-approved after stale revalidation",
                    payout_amount=lc.payout_amount or 0.0,
                    zone_id=lc.zone_id,
                    disruption_type=lc.disruption_type,
                    correlation_id=lc.correlation_id,
                )
            except Exception:
                pass

        rows = await session.execute(
            select(Simulation).where(
                Simulation.decision == DecisionType.REJECTED,
                Simulation.created_at >= two_hours_ago,
            ).order_by(Simulation.created_at.asc())
        )
        sims = rows.scalars().all()
        for sim in sims:
            # Only process those that were previously flagged (via weather_data fraud payload).
            is_flagged = False
            if sim.weather_data:
                try:
                    wd = json.loads(sim.weather_data)
                    fraud = wd.get("fraud") or {}
                    is_flagged = fraud.get("overall_decision") == "FLAGGED"
                except Exception:
                    is_flagged = False
            if not is_flagged:
                continue

            # Strong fraud evidence?
            strong = await session.execute(
                select(func.count(FraudSignal.id)).where(
                    FraudSignal.simulation_id == sim.id,
                    FraudSignal.score >= FRAUD_THRESHOLD,
                )
            )
            strong_count = strong.scalar_one() or 0
            if strong_count > 0:
                continue

            # Auto-approve and trigger payout
            user_profile = await session.execute(select(Profile).where(Profile.user_id == sim.user_id))
            profile = user_profile.scalars().first()
            if profile is None:
                continue

            payout_amount, _ = PayoutEngine.compute(sim.loss, profile.trust_score)
            sim.decision = DecisionType.APPROVED
            sim.payout = payout_amount
            sim.reason = "Auto-approved after stale FLAGGED resolution"
            session.add(PayoutRecord(simulation_id=sim.id, amount=payout_amount, currency="INR", status="completed"))
            profile.total_claims = int(profile.total_claims) + 1
            profile.total_payouts = float(profile.total_payouts) + float(payout_amount)
            await session.commit()

            try:
                await publish_claim_update(
                    redis=redis,
                    worker_id=sim.user_id,
                    claim_id=sim.id,
                    status="APPROVED",
                    message="Auto-approved after review",
                    payout_amount=payout_amount,
                )
            except Exception:
                pass


@dataclass(frozen=True)
class JobDef:
    job_id: str
    trigger: Any
    func: Any
    lock_ttl_seconds: int


def start_background_scheduler(app: Any) -> AsyncIOScheduler:
    scheduler = AsyncIOScheduler(timezone=str(IST))

    job_defs: List[JobDef] = [
        JobDef(
            job_id="confidence_monitor",
            trigger=CronTrigger(minute="*/30", hour="6-23", timezone=str(IST)),
            func=lambda: confidence_monitor(app),
            lock_ttl_seconds=25 * 60,
        ),
        JobDef(
            job_id="premium_recalculator",
            trigger=CronTrigger(day_of_week="mon", hour=0, minute=0, timezone=str(IST)),
            func=lambda: premium_recalculator(app),
            lock_ttl_seconds=6 * 60 * 60,
        ),
        JobDef(
            job_id="pool_health_auditor",
            trigger=CronTrigger(day_of_week="sun", hour=23, minute=59, timezone=str(IST)),
            func=lambda: pool_health_auditor(app),
            lock_ttl_seconds=4 * 60 * 60,
        ),
        JobDef(
            job_id="trust_score_updater",
            trigger=CronTrigger(hour=2, minute=0, timezone=str(IST)),
            func=lambda: trust_score_updater(app),
            lock_ttl_seconds=3 * 60 * 60,
        ),
        JobDef(
            job_id="stale_claim_resolver",
            trigger=CronTrigger(minute="*/5", timezone=str(IST)),
            func=lambda: stale_claim_resolver(app),
            lock_ttl_seconds=4 * 60,
        ),
        JobDef(
            job_id="forecast_shield_job",
            trigger=IntervalTrigger(hours=6, timezone=str(IST)),
            func=lambda: forecast_shield_job(app),
            lock_ttl_seconds=25 * 60,
        ),
        JobDef(
            job_id="weather_alert_notifier",
            trigger=CronTrigger(hour=7, minute=10, timezone=str(IST)),
            func=lambda: weather_alert_notifier(app),
            lock_ttl_seconds=30 * 60,
        ),
    ]

    # APScheduler expects normal callables; we wrap in async-safe runner.
    for jd in job_defs:
        async def _runner(jd: JobDef = jd) -> None:
            ist_now = _ist_now()
            bucket = _bucket_key(ist_now, 5 if jd.job_id == "stale_claim_resolver" else 30)
            lock_key = f"job_lock:{jd.job_id}:{bucket}"
            await _safe_job_run(
                scheduler=scheduler,
                app=app,
                job_id=jd.job_id,
                lock_key=lock_key,
                lock_ttl_seconds=jd.lock_ttl_seconds,
                coro_fn=jd.func,
            )

        scheduler.add_job(
            _runner,
            jd.trigger,
            id=jd.job_id,
            replace_existing=True,
            max_instances=1,
            coalesce=True,
        )

    scheduler.start()
    app.state.scheduler = scheduler
    app.state.scheduler_running = scheduler.running
    get_log.info(
        "scheduler_started",
        engine_name="background_scheduler",
        decision="running",
        reason_code="SCHEDULER_OK",
    )

    try:
        loop = asyncio.get_running_loop()

        async def _forecast_shield_kick() -> None:
            await _safe_job_run(
                scheduler=scheduler,
                app=app,
                job_id="forecast_shield_job",
                lock_key="job_lock:forecast_shield_job:startup",
                lock_ttl_seconds=20 * 60,
                coro_fn=lambda: forecast_shield_job(app),
            )

        loop.create_task(_forecast_shield_kick())
    except RuntimeError:
        pass

    return scheduler


def shutdown_background_scheduler(app: Any) -> None:
    sched = getattr(app.state, "scheduler", None)
    if sched:
        sched.shutdown(wait=False)
        app.state.scheduler_running = False
        get_log.info(
            "scheduler_stopped",
            engine_name="background_scheduler",
            decision="stopped",
            reason_code="SCHEDULER_DOWN",
        )

