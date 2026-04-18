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
from app.engines.actuarial_pricing import persist_pool_health_snapshot, run_full_weekly_pricing
from app.engines.trust_payout import trust_score_points
from app.engines.fraud_engine import first_simulation_time
from app.models.claim import ClaimLifecycle, DecisionType, DisruptionEvent, Simulation
from app.models.fraud import FraudSignal
from app.models.payout import PayoutRecord
from app.models.policy import Policy
from app.models.pool_balance import ZonePoolBalance
from app.models.weekly_summary import WeeklySummary
from app.models.worker import Profile, User
from app.models.zone import Zone
from app.services.realtime_service import publish_claim_update, publish_pool_health, publish_zone_event, publish_disruption_alert
from app.tasks.claim_processor import process_claim
from app.services.zone_resolver import resolve_city_to_zone
from app.services.forecast_shield_service import refresh_forecast_shields
from app.services.notification_service import create_notification
from app.engines.disruption_engine import check_disruptions_for_zone
from app.engines.claims_engine import initiate_claims_for_disruption
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
    get_log.info(
        "confidence_monitor_batch_start",
        zone_count=len(zones),
        reason="scheduled_all_configured_markets",
        note="not_user_specific_hyderabad_only",
    )
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
                # Rate limit: max 50 workers per zone per run to prevent overload
                MAX_WORKERS_PER_RUN = 50
                eligible_workers = []
                for worker in workers:
                    if not worker.profile:
                        continue
                    if not await _worker_has_active_policy(worker.id, session):
                        continue
                    if not _deviation_detected_from_baseline(worker.profile):
                        continue
                    eligible_workers.append(worker)
                    if len(eligible_workers) >= MAX_WORKERS_PER_RUN:
                        break

                for worker in eligible_workers:
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
                    try:
                        await session.commit()
                    except Exception:
                        await session.rollback()
                        continue

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
    shields = getattr(app.state, "forecast_shields", None)
    async with AsyncSessionLocal() as session:
        try:
            await run_full_weekly_pricing(session, redis=getattr(app.state, "redis", None))
            await persist_pool_health_snapshot(session, shields if isinstance(shields, dict) else None)
        except Exception:
            await session.rollback()
            raise


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


async def weekly_worker_summary(app: Any) -> None:
    """Sunday 20:00 IST — persisted WeeklySummary + in-app notification per worker."""
    shields = getattr(app.state, "forecast_shields", None) or {}
    from app.engines.actuarial_pricing import _ist_week_bounds
    from app.services.notification_service import NotificationService

    async with AsyncSessionLocal() as session:
        now_ist = _ist_now()
        monday_this, _ = _ist_week_bounds(now_ist)
        review_start_ist = monday_this - timedelta(days=7)
        review_end_ist = monday_this
        rs_utc = review_start_ist.astimezone(timezone.utc)
        re_utc = review_end_ist.astimezone(timezone.utc)

        profiles = (await session.execute(select(Profile))).scalars().all()
        for p in profiles:
            uid = int(p.user_id)
            if (
                await session.execute(select(User.id).where(User.id == uid, User.is_active.is_(True)).limit(1))
            ).scalar_one_or_none() is None:
                continue
            exists = (
                await session.execute(
                    select(WeeklySummary.id).where(
                        WeeklySummary.user_id == uid,
                        WeeklySummary.week_start == rs_utc,
                    ).limit(1)
                )
            ).scalar_one_or_none()
            if exists is not None:
                continue

            zid = str(p.zone_id or "").strip()
            hours_prot = round(float(p.active_hours_per_day or 8.0) * 7.0, 1)
            dcnt = 0
            if zid:
                dcnt = int(
                    (
                        await session.execute(
                            select(func.count(DisruptionEvent.id)).where(
                                DisruptionEvent.zone_id == zid,
                                DisruptionEvent.started_at >= rs_utc,
                                DisruptionEvent.started_at < re_utc,
                            )
                        )
                    ).scalar_one()
                    or 0
                )
            pay = float(
                (
                    await session.execute(
                        select(func.coalesce(func.sum(Simulation.payout), 0.0)).where(
                            Simulation.user_id == uid,
                            Simulation.decision == DecisionType.APPROVED,
                            Simulation.created_at >= rs_utc,
                            Simulation.created_at < re_utc,
                        )
                    )
                ).scalar_one()
                or 0.0
            )
            prem_row = (
                await session.execute(
                    select(Policy.weekly_premium).where(Policy.user_id == uid, Policy.status == "active").limit(1)
                )
            ).scalar_one_or_none()
            prem = float(prem_row or p.weekly_premium or 49.0)
            peace = round(prem, 2) if pay <= 0 else 0.0
            risk = "MEDIUM"
            zl = zid.lower().replace("-", "_") if zid else ""
            if isinstance(shields, dict):
                for sh in shields.values():
                    if not isinstance(sh, dict):
                        continue
                    szz = str(sh.get("zone_id") or "").lower().replace("-", "_")
                    if zl and szz and zl not in szz and szz not in zl:
                        continue
                    pr = float(sh.get("probability") or 0.5)
                    if pr >= 0.75:
                        risk = "HIGH"
                    elif pr >= 0.45:
                        risk = "MEDIUM"
                    else:
                        risk = "LOW"
            trust_delta = 3 if pay > 0 else 1
            title = "Your SafeNet Week in Review"
            if pay > 0:
                body = (
                    f"Hours protected this week: {hours_prot:.0f}. "
                    f"Disruptions in your zone: {dcnt}. "
                    f"Payout received: Rs {pay:.0f}. "
                    f"Your zone risk next week: {risk}. "
                    f"Trust score change: +{trust_delta} this week."
                )
            else:
                body = (
                    f"Hours protected this week: {hours_prot:.0f}. "
                    f"Disruptions in your zone: {dcnt}. "
                    f"No disruptions — your savings: Rs {peace:.0f} in premiums bought peace of mind. "
                    f"Your zone risk next week: {risk}. "
                    f"Trust score change: +{trust_delta} this week."
                )
            session.add(
                WeeklySummary(
                    user_id=uid,
                    week_start=rs_utc,
                    hours_protected=hours_prot,
                    disruptions_in_zone=dcnt,
                    payout_inr=pay,
                    premium_peace_inr=peace if pay <= 0 else 0.0,
                    zone_risk_next_week=risk,
                    trust_delta_points=trust_delta,
                    title=title,
                    body=body,
                )
            )
            await create_notification(
                session,
                user_id=uid,
                ntype="weekly_summary",
                title=title,
                message=body[:900],
            )
            try:
                await NotificationService.send_push(
                    user_id=uid,
                    title=title,
                    body="Open the app for your SafeNet week in review.",
                    data={"type": "weekly_summary"},
                )
            except Exception:
                pass
        await session.commit()


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
            old_pts = trust_score_points(trust_score)

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
                new_pts = trust_score_points(trust_score)
                await session.commit()
                if old_pts < 70 <= new_pts:
                    await create_notification(
                        session,
                        user_id=user.id,
                        ntype="trust",
                        title="Reliable status unlocked",
                        message="You've reached Reliable status — faster payouts unlocked.",
                    )
                    await session.commit()
                if old_pts < 90 <= new_pts:
                    await create_notification(
                        session,
                        user_id=user.id,
                        ntype="trust",
                        title="Elite status achieved",
                        message="Elite status achieved — instant payouts enabled.",
                    )
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
            # Check fraud signals before auto-approving
            fraud_count = (
                await session.execute(
                    select(func.count(FraudSignal.id)).where(
                        FraudSignal.user_id == lc.user_id,
                        FraudSignal.score >= FRAUD_THRESHOLD,
                    )
                )
            ).scalar_one() or 0
            if fraud_count > 0:
                lc.status = "REJECTED"
                lc.message = "Auto-rejected: fraud signals present during revalidation"
            else:
                lc.status = "APPROVED"
                lc.message = "Auto-approved after stale revalidation window"
            await session.commit()
            if lc.status == "APPROVED":
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
                Simulation.decision == DecisionType.REVIEW,
                Simulation.created_at <= two_hours_ago,
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


async def disruption_scan(app: Any) -> None:
    """
    disruption_scan: every 30 minutes, 6 AM – 11 PM IST.

    For each zone in the DB:
      1. Run check_disruptions_for_zone (live weather + AQI + social events)
      2. If active events found, trigger claim pipeline for affected workers

    Each zone is isolated — one zone failure never stops the others.
    """
    ist_now = _ist_now()
    if not (6 <= ist_now.hour <= 23):
        return

    redis = getattr(app.state, "redis", None)

    zone_ids: List[str] = []
    async with AsyncSessionLocal() as session:
        zone_rows = (await session.execute(select(Zone))).scalars().all()
        zone_ids = [str(z.city_code) for z in zone_rows]
        zone_map = {str(z.city_code): z for z in zone_rows}

    get_log.info(
        "disruption_scan_batch_start",
        zone_count=len(zone_ids),
        reason="all_zones_in_database",
    )
    for zone_id in zone_ids:
        try:
            async with AsyncSessionLocal() as session:
                zone = zone_map[zone_id]
                events = await check_disruptions_for_zone(session, zone)

                if not events:
                    continue

                disruption_type = str(events[0].disruption_type)
                confidence_label = str(events[0].confidence)
                eligible_rows = (
                    await session.execute(
                        select(User.id)
                        .join(Profile, Profile.user_id == User.id)
                        .join(Policy, Policy.user_id == User.id)
                        .where(
                            User.is_active.is_(True),
                            Profile.zone_id == zone_id,
                            Policy.status == "active",
                        )
                    )
                ).all()
                affected_workers = [int(r[0]) for r in eligible_rows]

                await publish_zone_event(
                    redis=redis,
                    zone_id=zone_id,
                    event_type="disruption_alert",
                    details={
                        "disruption_types": [e.disruption_type for e in events],
                        "confidence": confidence_label,
                        "severities": [round(e.severity, 3) for e in events],
                    },
                )
                if affected_workers:
                    await publish_disruption_alert(
                        redis=redis,
                        zone_id=zone_id,
                        disruption_type=disruption_type,
                        affected_workers=affected_workers,
                    )

                if confidence_label != "HIGH":
                    continue

                for event in events:
                    await initiate_claims_for_disruption(
                        db=session,
                        disruption_event=event,
                        redis=redis,
                    )

        except Exception as exc:
            get_log.warning(
                "disruption_scan_zone_failed",
                engine_name="background_scheduler",
                reason_code="ZONE_SCAN_ERROR",
                zone_id=zone_id,
                error=str(exc),
            )
            continue


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
        JobDef(
            job_id="weekly_worker_summary",
            trigger=CronTrigger(day_of_week="sun", hour=20, minute=0, timezone=str(IST)),
            func=lambda: weekly_worker_summary(app),
            lock_ttl_seconds=90 * 60,
        ),
        JobDef(
            job_id="disruption_scan",
            trigger=CronTrigger(minute="*/30", hour="6-23", timezone=str(IST)),
            func=lambda: disruption_scan(app),
            lock_ttl_seconds=25 * 60,
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
            misfire_grace_time=60,
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

