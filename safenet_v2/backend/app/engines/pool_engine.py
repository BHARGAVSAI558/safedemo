"""
Pool Engine
-----------
Manages zone-level insurance pool balances and computes worker premiums
from DB-sourced zone risk multipliers.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.pool_balance import ZonePoolBalance
from app.models.worker import Profile
from app.models.zone import Zone
from app.models.zone_actuarial import ZoneActuarialSettings
from app.utils.logger import get_logger

log = get_logger(__name__)

# ── Tier base premiums (₹/week) ───────────────────────────────────────────────
_TIER_BASE: dict[str, float] = {
    "Basic":    35.0,
    "Standard": 49.0,
    "Pro":      70.0,
    # lowercase aliases
    "basic":    35.0,
    "standard": 49.0,
    "pro":      70.0,
}

# ── Tier coverage caps (₹/week) ───────────────────────────────────────────────
_TIER_COVERAGE_CAP: dict[str, float] = {
    "Basic":    350.0,
    "Standard": 500.0,
    "Pro":      700.0,
    "basic":    350.0,
    "standard": 500.0,
    "pro":      700.0,
}


def _current_week_start() -> datetime:
    now = datetime.now(timezone.utc)
    return now.replace(hour=0, minute=0, second=0, microsecond=0) - __import__("datetime").timedelta(days=now.weekday())


def _recalc_loss_ratio(pool: ZonePoolBalance) -> float:
    premiums = float(pool.total_premiums_collected or 0.0)
    payouts = float(pool.total_payouts_disbursed or 0.0)
    return round(payouts / premiums, 4) if premiums > 0 else 0.0


async def _get_or_create_pool(db: AsyncSession, zone_id: str) -> ZonePoolBalance:
    """Fetch the current week's pool row, creating it if absent."""
    week_start = _current_week_start()
    row = (
        await db.execute(
            select(ZonePoolBalance)
            .where(
                ZonePoolBalance.zone_id == zone_id,
                ZonePoolBalance.week_start == week_start,
            )
        )
    ).scalar_one_or_none()

    if row is None:
        # Fetch previous week's row to carry forward balance
        prev_row = (
            await db.execute(
                select(ZonePoolBalance)
                .where(ZonePoolBalance.zone_id == zone_id)
                .order_by(ZonePoolBalance.week_start.desc())
            )
        ).scalar_one_or_none()
        prev_balance = float(prev_row.current_balance or 0.0) if prev_row else 0.0

        row = ZonePoolBalance(
            zone_id=zone_id,
            week_start=week_start,
            pool_balance_start_of_week=prev_balance,
            total_premiums_collected=0.0,
            total_payouts_this_week=0.0,
            total_payouts_disbursed=0.0,
            current_balance=prev_balance,
            utilization_pct=0.0,
            loss_ratio=0.0,
        )
        db.add(row)
        await db.flush()

    return row


async def update_pool_on_premium(
    db: AsyncSession,
    zone_id: str,
    amount: float,
) -> None:
    """
    Called when a worker pays a premium.
    Increments total_premiums_collected and current_balance, recalculates loss_ratio.
    """
    pool = await _get_or_create_pool(db, zone_id)
    pool.total_premiums_collected = float(pool.total_premiums_collected or 0.0) + amount
    pool.current_balance = float(pool.current_balance or 0.0) + amount
    pool.loss_ratio = _recalc_loss_ratio(pool)
    pool.utilization_pct = _calc_utilization(pool)
    await db.commit()

    log.info(
        "pool_premium_collected",
        engine_name="pool_engine",
        decision="ok",
        reason_code="POOL_PREMIUM",
        zone_id=zone_id,
        amount=amount,
        new_balance=pool.current_balance,
        loss_ratio=pool.loss_ratio,
    )


async def update_pool_on_payout(
    db: AsyncSession,
    zone_id: str,
    amount: float,
) -> None:
    """
    Called when a claim payout is disbursed.
    Increments total_payouts_disbursed, reduces current_balance, recalculates loss_ratio.
    """
    pool = await _get_or_create_pool(db, zone_id)
    pool.total_payouts_disbursed = float(pool.total_payouts_disbursed or 0.0) + amount
    pool.total_payouts_this_week = float(pool.total_payouts_this_week or 0.0) + amount
    pool.current_balance = max(0.0, float(pool.current_balance or 0.0) - amount)
    pool.loss_ratio = _recalc_loss_ratio(pool)
    pool.utilization_pct = _calc_utilization(pool)

    # Flag for reinsurance if loss_ratio exceeds 0.85
    if pool.loss_ratio > 0.85:
        pool.flagged_reinsurance = True
        pool.risk_note = f"Loss ratio {pool.loss_ratio:.2%} — reinsurance threshold breached"

    await db.commit()

    log.info(
        "pool_payout_disbursed",
        engine_name="pool_engine",
        decision="ok",
        reason_code="POOL_PAYOUT",
        zone_id=zone_id,
        amount=amount,
        new_balance=pool.current_balance,
        loss_ratio=pool.loss_ratio,
    )


def _calc_utilization(pool: ZonePoolBalance) -> float:
    premiums = float(pool.total_premiums_collected or 0.0)
    payouts = float(pool.total_payouts_disbursed or 0.0)
    if premiums <= 0:
        return 0.0
    return round(min(100.0, (payouts / premiums) * 100.0), 2)


async def calculate_weekly_premium(
    db: AsyncSession,
    user_id: int,
    tier: str,
) -> dict[str, Any]:
    """
    Computes the worker's weekly premium and coverage cap.

    Formula:
        premium = base_tier × zone_risk_multiplier × worker_adjustment

    worker_adjustment:
        trust_score > 70  → 0.90  (loyalty discount)
        trust_score 40–70 → 1.00
        trust_score < 40  → 1.15  (high-risk surcharge)

    Returns dict with: weekly_premium, coverage_cap, zone_risk_multiplier,
                        worker_adjustment, tier, breakdown
    """
    base = _TIER_BASE.get(tier, 49.0)
    coverage_cap = _TIER_COVERAGE_CAP.get(tier, 500.0)

    # Fetch profile for trust score and zone
    profile = (
        await db.execute(select(Profile).where(Profile.user_id == user_id))
    ).scalar_one_or_none()

    trust_score = 50.0
    zone_id_str: str | None = None
    if profile is not None:
        raw_trust = float(profile.trust_score or 50.0)
        # Normalise: stored as 0–1 or 0–100
        trust_score = raw_trust * 100.0 if raw_trust <= 1.0 else raw_trust
        zone_id_str = profile.zone_id

    # Worker adjustment from trust
    if trust_score > 70:
        worker_adjustment = 0.90
    elif trust_score >= 40:
        worker_adjustment = 1.00
    else:
        worker_adjustment = 1.15

    # Zone risk multiplier from DB Zone table
    zone_risk_multiplier = 1.0
    if zone_id_str:
        zone_row = (
            await db.execute(
                select(Zone).where(Zone.city_code == zone_id_str)
            )
        ).scalar_one_or_none()
        if zone_row is not None:
            zone_risk_multiplier = float(zone_row.zone_risk_multiplier or 1.0)

    load = 1.0
    if zone_id_str:
        zas = (
            await db.execute(
                select(ZoneActuarialSettings).where(ZoneActuarialSettings.pool_zone_id == zone_id_str)
            )
        ).scalar_one_or_none()
        if zas is not None:
            load = float(zas.actuarial_load_factor or 1.0)
    raw_premium = base * zone_risk_multiplier * worker_adjustment * load
    weekly_premium = round(max(28.0, min(150.0, raw_premium)), 2)

    log.info(
        "premium_calculated",
        engine_name="pool_engine",
        decision=str(weekly_premium),
        reason_code="PREMIUM_CALC",
        user_id=user_id,
        tier=tier,
        base=base,
        zone_risk_multiplier=zone_risk_multiplier,
        worker_adjustment=worker_adjustment,
        weekly_premium=weekly_premium,
    )

    return {
        "weekly_premium": weekly_premium,
        "coverage_cap": coverage_cap,
        "zone_risk_multiplier": zone_risk_multiplier,
        "worker_adjustment": worker_adjustment,
        "tier": tier,
        "breakdown": {
            "base_tier_premium": base,
            "zone_risk_multiplier": zone_risk_multiplier,
            "worker_adjustment": worker_adjustment,
            "actuarial_load_factor": round(load, 4),
            "trust_score": round(trust_score, 1),
        },
    }
