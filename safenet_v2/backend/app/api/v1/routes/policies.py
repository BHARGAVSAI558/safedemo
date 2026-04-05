from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.routes.workers import get_current_user
from app.db.session import get_db
from app.engines.premium_engine import PremiumEngine
from app.models.policy import Policy
from app.models.pool_balance import ZonePoolBalance
from app.models.worker import Profile, User
from app.schemas.policy import (
    PolicyActivateRequest,
    PolicyActivatedFullResponse,
    PolicyCreate,
    PolicyCurrentResponse,
    PolicyResponse,
)
from app.services.onboarding_pricing import (
    TIER_MAX_DAILY,
    TIER_TO_PRODUCT,
    ZONE_LABEL,
    ZONE_RISK_LABEL,
    compute_risk_score,
    compute_weekly_premium,
    normalize_zone,
)
from app.services.cache_service import cache_invalidate
from app.services.zone_resolver import resolve_city_to_zone
from app.utils.logger import get_logger

log = get_logger(__name__)
router = APIRouter()

TIER_MULT: Dict[str, float] = {
    "Basic": 0.92,
    "Standard": 1.0,
    "Pro": 1.12,
}


def _product_to_tier(product_code: str | None) -> str:
    if not product_code:
        return "Standard"
    pc = product_code.lower()
    if "basic" in pc:
        return "Basic"
    if "standard" in pc:
        return "Standard"
    if "pro" in pc:
        return "Pro"
    return "Standard"


def _policy_period_end(policy: Policy) -> datetime:
    vu = getattr(policy, "valid_until", None)
    if vu is not None:
        if vu.tzinfo is None:
            vu = vu.replace(tzinfo=timezone.utc)
        return vu
    base = policy.updated_at or policy.created_at
    if base is None:
        base = datetime.now(timezone.utc)
    if base.tzinfo is None:
        base = base.replace(tzinfo=timezone.utc)
    return base + timedelta(days=7)


def _risk_score_0_100(profile: Profile) -> float:
    t = float(profile.trust_score or 0.0)
    if t <= 1.0:
        t *= 100.0
    return max(0.0, min(100.0, t))


async def _fetch_latest_pool(zone_id: str, db: AsyncSession) -> tuple[float, float]:
    row = (
        await db.execute(
            select(ZonePoolBalance)
            .where(ZonePoolBalance.zone_id == zone_id)
            .order_by(ZonePoolBalance.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if not row:
        return 0.0, 0.0
    return float(row.pool_balance_start_of_week or 0.0), float(row.utilization_pct or 0.0)


async def build_policy_current(
    current_user: User,
    db: AsyncSession,
) -> PolicyCurrentResponse:
    prof = (await db.execute(select(Profile).where(Profile.user_id == current_user.id))).scalar_one_or_none()
    if not prof:
        return PolicyCurrentResponse(
            status="inactive",
            message="No active coverage",
            tier=None,
            weekly_premium=0.0,
            valid_until=None,
            days_remaining=0,
            max_coverage_per_day=0.0,
            risk_score=0.0,
            zone="",
            pool_balance=0.0,
            pool_utilization_pct=0.0,
            policy_id=None,
        )

    zone_id, _lat, _lon = resolve_city_to_zone(prof.city)
    pool_balance, pool_util = await _fetch_latest_pool(zone_id, db)

    result = await db.execute(
        select(Policy)
        .where(Policy.user_id == current_user.id, Policy.status == "active")
        .order_by(Policy.id.desc())
        .limit(1)
    )
    pol = result.scalar_one_or_none()

    risk = float(prof.risk_score) if getattr(prof, "risk_score", None) is not None else _risk_score_0_100(prof)
    now = datetime.now(timezone.utc)

    if not pol:
        return PolicyCurrentResponse(
            status="inactive",
            message="No active coverage",
            tier=None,
            weekly_premium=0.0,
            valid_until=None,
            days_remaining=0,
            max_coverage_per_day=0.0,
            risk_score=risk,
            zone=str(prof.city or ""),
            pool_balance=pool_balance,
            pool_utilization_pct=pool_util,
            policy_id=None,
        )

    tier = _product_to_tier(pol.product_code)
    max_day = TIER_MAX_DAILY.get(tier, 1000.0)
    end = _policy_period_end(pol)
    days_left = max(0, int(math.ceil((end - now).total_seconds() / 86400.0)))

    if days_left <= 0:
        status = "inactive"
    elif days_left < 3:
        status = "expiring"
    else:
        status = "active"

    return PolicyCurrentResponse(
        status=status,
        tier=tier,  # type: ignore[arg-type]
        weekly_premium=float(pol.weekly_premium or 0.0),
        valid_until=end.isoformat(),
        days_remaining=days_left,
        max_coverage_per_day=max_day,
        risk_score=risk,
        zone=str(prof.city or ""),
        pool_balance=pool_balance,
        pool_utilization_pct=pool_util,
        policy_id=pol.id,
    )


@router.get("/current", response_model=PolicyCurrentResponse)
async def get_policy_current(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    out = await build_policy_current(current_user, db)
    log.info(
        "policy_current",
        engine_name="policies_route",
        decision=out.status,
        reason_code="POLICY_CURRENT",
        worker_id=current_user.id,
    )
    return out


@router.get("", response_model=List[PolicyResponse])
async def list_policies(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Policy).where(Policy.user_id == current_user.id))
    rows = result.scalars().all()
    log.info(
        "policies_listed",
        engine_name="policies_route",
        decision=str(len(rows)),
        reason_code="POLICY_LIST",
        worker_id=current_user.id,
    )
    return rows


@router.post("/activate", response_model=PolicyActivatedFullResponse, status_code=201)
async def activate_policy(
    request: Request,
    body: PolicyActivateRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    prof = (await db.execute(select(Profile).where(Profile.user_id == current_user.id))).scalar_one_or_none()
    if not prof:
        raise HTTPException(status_code=400, detail="Create a worker profile before activating coverage")

    tier = body.tier
    product_code = TIER_TO_PRODUCT.get(tier, "")
    if not product_code:
        raise HTTPException(status_code=422, detail="Invalid tier")

    zone_key = normalize_zone(prof.zone_id or "other")
    hours = (prof.working_hours_preset or "flexible").strip()
    platform = (prof.platform or "other").strip()
    risk_score = compute_risk_score(zone_key, hours, platform)
    weekly = float(compute_weekly_premium(zone_key, hours, tier))
    monthly = round(weekly * 4.33, 2)
    max_day = TIER_MAX_DAILY.get(tier, 500.0)

    now = datetime.now(timezone.utc)
    valid_until_dt = now + timedelta(days=7)

    prof.coverage_tier = tier
    prof.risk_score = float(risk_score)
    prof.weekly_premium = weekly

    existing = (
        await db.execute(
            select(Policy)
            .where(Policy.user_id == current_user.id, Policy.status == "active")
            .order_by(Policy.id.desc())
            .limit(1)
        )
    ).scalar_one_or_none()

    if existing:
        existing.product_code = product_code
        existing.weekly_premium = weekly
        existing.monthly_premium = monthly
        existing.status = "active"
        existing.valid_from = now
        existing.valid_until = valid_until_dt
        existing.updated_at = now
        pol = existing
    else:
        pol = Policy(
            user_id=current_user.id,
            product_code=product_code,
            status="active",
            monthly_premium=monthly,
            weekly_premium=weekly,
            valid_from=now,
            valid_until=valid_until_dt,
            updated_at=now,
        )
        db.add(pol)

    await db.commit()
    await db.refresh(pol)
    await cache_invalidate(getattr(request.app.state, "redis", None), f"policy_active:{current_user.id}")
    await cache_invalidate(getattr(request.app.state, "redis", None), f"trust:{current_user.id}")

    log.info(
        "policy_activated",
        engine_name="policies_route",
        decision=tier,
        reason_code="POLICY_ACTIVATE",
        worker_id=current_user.id,
        weekly_premium=weekly,
        risk_score=risk_score,
    )

    zid = (prof.zone_id or zone_key).strip()
    return PolicyActivatedFullResponse(
        id=pol.id,
        user_id=pol.user_id,
        product_code=pol.product_code,
        status=pol.status,
        tier=tier,
        monthly_premium=float(pol.monthly_premium or monthly),
        weekly_premium=float(pol.weekly_premium or weekly),
        valid_from=now.isoformat(),
        valid_until=valid_until_dt.isoformat(),
        max_coverage_per_day=max_day,
        risk_score=risk_score,
        zone_id=zid,
        zone_label=ZONE_LABEL.get(zone_key, zid),
        zone_risk_level=ZONE_RISK_LABEL.get(zone_key, "Medium Risk"),
        city=(prof.city or "Hyderabad").strip(),
        name=(prof.name or "Worker").strip(),
        trust_level="Newcomer",
    )


@router.post("", response_model=PolicyResponse, status_code=201)
async def create_policy(
    request: Request,
    body: PolicyCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    prof_res = await db.execute(select(Profile).where(Profile.user_id == current_user.id))
    profile = prof_res.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=400, detail="Create a worker profile before adding a policy")

    premium, _ = PremiumEngine.monthly_premium(profile)
    calc = await PremiumEngine.calculate(current_user.id, db=db, profile=profile, user=current_user)
    weekly = float(calc.get("weekly_premium") or 35.0)
    now = datetime.now(timezone.utc)
    policy = Policy(
        user_id=current_user.id,
        product_code=body.product_code,
        status="active",
        monthly_premium=premium,
        weekly_premium=weekly,
        updated_at=now,
    )
    db.add(policy)
    await db.commit()
    await db.refresh(policy)
    await cache_invalidate(getattr(request.app.state, "redis", None), f"policy_active:{current_user.id}")
    log.info(
        "policy_created",
        engine_name="policies_route",
        decision="created",
        reason_code="POLICY_OK",
        worker_id=current_user.id,
    )
    return policy
