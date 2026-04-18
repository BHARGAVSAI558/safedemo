"""Zone-level actuarial load adjustments and weekly premium recalculation."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from statistics import mean
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.engines.pool_engine import calculate_weekly_premium
from app.models.claim import DecisionType, Simulation
from app.models.policy import Policy
from app.models.pool_balance import ZonePoolBalance
from app.models.pool_health_weekly import PoolHealthWeeklySnapshot
from app.models.worker import User
from app.models.zone_actuarial import ZoneActuarialSettings
from app.services.notification_service import NotificationService, create_notification
from app.utils.logger import get_logger

log = get_logger(__name__)
IST = ZoneInfo("Asia/Kolkata")


def _quarter_key(d: datetime) -> str:
    q = (d.month - 1) // 3 + 1
    return f"{d.year}-Q{q}"


def _ist_week_bounds(now_ist: datetime | None = None) -> tuple[datetime, datetime]:
    now_ist = now_ist or datetime.now(tz=IST)
    d = now_ist.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = d - timedelta(days=d.weekday())
    week_end = week_start + timedelta(days=7)
    return week_start, week_end


async def _distinct_pool_zones(db: AsyncSession) -> list[str]:
    r = await db.execute(select(ZonePoolBalance.zone_id).distinct())
    return [str(x[0]) for x in r.all() if x[0]]


async def _last_n_pool_rows(db: AsyncSession, pool_zone: str, n: int = 4) -> list[ZonePoolBalance]:
    r = await db.execute(
        select(ZonePoolBalance)
        .where(ZonePoolBalance.zone_id == pool_zone)
        .order_by(ZonePoolBalance.week_start.desc())
        .limit(n)
    )
    return list(r.scalars().all())


async def _get_or_create_actuarial(db: AsyncSession, pool_zone: str) -> ZoneActuarialSettings:
    row = (
        await db.execute(
            select(ZoneActuarialSettings).where(ZoneActuarialSettings.pool_zone_id == pool_zone)
        )
    ).scalar_one_or_none()
    if row is None:
        row = ZoneActuarialSettings(pool_zone_id=pool_zone, actuarial_load_factor=1.0)
        db.add(row)
        await db.flush()
    return row


async def run_zone_actuarial_adjustments(db: AsyncSession) -> dict[str, Any]:
    now_ist = datetime.now(tz=IST)
    qk = _quarter_key(now_ist)
    zones = await _distinct_pool_zones(db)
    adjusted = 0
    for z in zones:
        rows = await _last_n_pool_rows(db, z, 4)
        if not rows:
            continue
        lrs = [float(r.loss_ratio or 0.0) for r in rows[:4]]
        avg_lr = float(mean(lrs)) if lrs else 0.0
        st = await _get_or_create_actuarial(db, z)
        if (st.actuarial_quarter_key or "") != qk:
            st.actuarial_quarter_key = qk
            st.premium_increases_this_quarter = 0
        if avg_lr > 0.65 and int(st.premium_increases_this_quarter or 0) < 2:
            st.actuarial_load_factor = min(1.35, float(st.actuarial_load_factor or 1.0) * 1.1)
            st.premium_increases_this_quarter = int(st.premium_increases_this_quarter or 0) + 1
            adjusted += 1
            log.info(
                "actuarial_zone_increase",
                engine_name="actuarial_pricing",
                zone_id=z,
                avg_lr=avg_lr,
                new_load=st.actuarial_load_factor,
            )
        elif len(rows) >= 4 and all(float(r.loss_ratio or 0.0) < 0.3 for r in rows[:4]):
            st.actuarial_load_factor = max(0.85, float(st.actuarial_load_factor or 1.0) * 0.95)
            adjusted += 1
            log.info(
                "actuarial_zone_decrease",
                engine_name="actuarial_pricing",
                zone_id=z,
                new_load=st.actuarial_load_factor,
            )
    await db.commit()
    return {"zones_scanned": len(zones), "zones_adjusted": adjusted}


def _tier_from_policy(pol: Policy | None) -> str:
    if pol is None:
        return "Standard"
    t = str(pol.tier or pol.product_code or "standard").strip()
    low = t.lower()
    if "basic" in low:
        return "Basic"
    if "pro" in low:
        return "Pro"
    return "Standard"


async def run_full_weekly_pricing(db: AsyncSession, redis: Any = None) -> dict[str, Any]:
    """Monday job + manual trigger: actuarial zones, then refresh each active policy's weekly premium."""
    ar = await run_zone_actuarial_adjustments(db)
    users = (
        await db.execute(
            select(User)
            .where(User.is_active.is_(True))
            .options(selectinload(User.profile))
        )
    ).scalars().all()
    updated = 0
    for user in users:
        if not user.profile:
            continue
        pol = (
            await db.execute(
                select(Policy)
                .where(Policy.user_id == user.id, Policy.status == "active")
                .order_by(Policy.id.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        if pol is None:
            continue
        tier = _tier_from_policy(pol)
        try:
            prem = await calculate_weekly_premium(db, user.id, tier)
            weekly_premium = float(prem.get("weekly_premium", 49.0))
        except Exception:
            weekly_premium = float(getattr(user.profile, "weekly_premium", None) or 49.0)
        try:
            pol.weekly_premium = weekly_premium
            user.profile.weekly_premium = weekly_premium
            await db.commit()
        except Exception:
            await db.rollback()
            continue
        updated += 1
        try:
            await create_notification(
                db,
                user_id=user.id,
                ntype="premium",
                title="Weekly premium updated",
                message=(
                    f"Your SafeNet plan for next week: ₹{int(round(weekly_premium))} "
                    "(adjusted for zone conditions — real actuarial pricing)."
                ),
            )
            await db.commit()
        except Exception:
            await db.rollback()
        try:
            await NotificationService.send_push(
                user_id=user.id,
                title="SafeNet premium",
                body=f"Next week: ₹{int(round(weekly_premium))} — adjusted for your zone's loss experience.",
                data={"weekly_premium": weekly_premium, "actuarial": True},
            )
        except Exception:
            pass
    return {**ar, "policies_updated": updated}


async def compute_pool_health_payload(db: AsyncSession, forecast_shields: dict[str, Any] | None) -> dict[str, Any]:
    week_start_ist, week_end_ist = _ist_week_bounds()
    ws_utc = week_start_ist.astimezone(timezone.utc)
    we_utc = week_end_ist.astimezone(timezone.utc)

    prem_rows = (
        await db.execute(
            select(func.coalesce(func.sum(Policy.weekly_premium), 0.0)).where(Policy.status == "active")
        )
    ).scalar_one()
    total_weekly_premiums_booked = float(prem_rows or 0.0)

    pay_sum = (
        await db.execute(
            select(func.coalesce(func.sum(Simulation.payout), 0.0)).where(
                Simulation.decision == DecisionType.APPROVED,
                Simulation.created_at >= ws_utc,
                Simulation.created_at < we_utc,
            )
        )
    ).scalar_one()
    total_payouts_week = float(pay_sum or 0.0)

    loss_ratio = round(total_payouts_week / total_weekly_premiums_booked, 4) if total_weekly_premiums_booked > 0 else 0.0

    pools = (
        await db.execute(select(ZonePoolBalance).order_by(ZonePoolBalance.week_start.desc(), ZonePoolBalance.id.desc()))
    ).scalars().all()
    latest: dict[str, ZonePoolBalance] = {}
    for p in pools:
        if p.zone_id not in latest:
            latest[p.zone_id] = p
    reserve_pool_total = round(sum(float(x.current_balance or 0.0) for x in latest.values()), 2)

    active_policies = int(
        (await db.execute(select(func.count(Policy.id)).where(Policy.status == "active"))).scalar_one() or 0
    )
    avg_p = (
        await db.execute(
            select(func.coalesce(func.avg(Simulation.payout), 0.0)).where(
                Simulation.decision == DecisionType.APPROVED,
                Simulation.created_at >= datetime.now(timezone.utc) - timedelta(days=30),
            )
        )
    ).scalar_one()
    avg_payout = float(avg_p or 0.0)
    if avg_payout <= 0:
        avg_payout = 220.0

    risk_weight = _forecast_disruption_weight(forecast_shields, days=5)
    estimated_next_week_payout = round(active_policies * avg_payout * risk_weight, 2)

    gauge = "green" if loss_ratio < 0.5 else ("yellow" if loss_ratio <= 0.7 else "red")
    alert = None
    if loss_ratio > 0.7:
        alert = "Consider premium adjustment for HIGH risk zones"

    snap = (
        await db.execute(
            select(PoolHealthWeeklySnapshot).where(PoolHealthWeeklySnapshot.week_start == ws_utc)
        )
    ).scalar_one_or_none()

    return {
        "week_start_ist": week_start_ist.isoformat(),
        "week_end_ist": week_end_ist.isoformat(),
        "total_premiums_collected_this_week": round(total_weekly_premiums_booked, 2),
        "total_payouts_this_week": round(total_payouts_week, 2),
        "loss_ratio": loss_ratio,
        "loss_ratio_gauge": gauge,
        "target_loss_ratio": 0.7,
        "reserve_pool": reserve_pool_total,
        "estimated_next_week_payout": estimated_next_week_payout,
        "premium_adjustment_alert": alert,
        "active_policies": active_policies,
        "avg_recent_payout": round(avg_payout, 2),
        "forecast_payout_weight": round(risk_weight, 4),
        "last_snapshot_at": snap.created_at.isoformat() if snap and snap.created_at else None,
    }


def _forecast_disruption_weight(shields: dict[str, Any] | None, days: int = 5) -> float:
    if not shields or not isinstance(shields, dict):
        return 0.35
    now = datetime.now(timezone.utc)
    horizon = now + timedelta(days=days)
    risky_hours = 0.0
    for _k, v in shields.items():
        if not isinstance(v, dict):
            continue
        try:
            st = v.get("start_dt") or v.get("start")
            en = v.get("end_dt") or v.get("end")
            if not st or not en:
                continue
            if isinstance(st, str):
                sdt = datetime.fromisoformat(st.replace("Z", "+00:00"))
            else:
                continue
            if isinstance(en, str):
                edt = datetime.fromisoformat(en.replace("Z", "+00:00"))
            else:
                continue
            if edt < now or sdt > horizon:
                continue
            seg_start = max(sdt, now)
            seg_end = min(edt, horizon)
            hrs = max(0.0, (seg_end - seg_start).total_seconds() / 3600.0)
            prob = float(v.get("probability") or 0.65)
            risky_hours += hrs * prob
        except Exception:
            continue
    max_h = float(days * 24)
    base = min(1.0, risky_hours / max_h) if max_h > 0 else 0.0
    return max(0.12, min(0.92, 0.18 + base * 0.85))


async def persist_pool_health_snapshot(db: AsyncSession, forecast_shields: dict[str, Any] | None) -> None:
    payload = await compute_pool_health_payload(db, forecast_shields)
    week_start_ist, _ = _ist_week_bounds()
    ws_utc = week_start_ist.astimezone(timezone.utc)
    row = (
        await db.execute(select(PoolHealthWeeklySnapshot).where(PoolHealthWeeklySnapshot.week_start == ws_utc))
    ).scalar_one_or_none()
    if row is None:
        row = PoolHealthWeeklySnapshot(week_start=ws_utc)
        db.add(row)
    row.total_weekly_premiums_booked = float(payload["total_premiums_collected_this_week"])
    row.total_payouts_week = float(payload["total_payouts_this_week"])
    row.loss_ratio = float(payload["loss_ratio"])
    row.reserve_pool_total = float(payload["reserve_pool"])
    row.estimated_next_week_payout = float(payload["estimated_next_week_payout"])
    await db.commit()
