from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.routes.workers import get_current_user
from app.db.session import get_db
from app.models.policy import Policy
from app.models.worker import OccupationType as OrmOccupation
from app.models.worker import Profile, RiskProfile as OrmRisk, User
from app.schemas.profile import GigProfileUpsert
from app.services.cache_service import cache_invalidate
from app.engines.premium_engine import PremiumEngine
from app.utils.logger import get_logger
from structlog.contextvars import bind_contextvars

log = get_logger(__name__)
router = APIRouter()

TIER_TO_PRODUCT = {
    "Basic": "income_shield_basic",
    "Standard": "income_shield_standard",
    "Pro": "income_shield_pro",
}

TIER_MULT = {
    "Basic": 0.92,
    "Standard": 1.0,
    "Pro": 1.12,
}

# Normalized zone_id (lowercase snake) → risk tier for pricing / engine
ZONE_TO_RISK: dict[str, OrmRisk] = {
    "kukatpally": OrmRisk.high,
    "hitec_city": OrmRisk.low,
    "secunderabad": OrmRisk.medium,
    "gachibowli": OrmRisk.medium,
    "lb_nagar": OrmRisk.high,
    "ameerpet": OrmRisk.medium,
    "other": OrmRisk.medium,
}


def _normalize_zone(zone_id: str) -> str:
    z = (zone_id or "").strip().lower().replace(" ", "_")
    if z == "hitec_city" or z == "hitec":
        return "hitec_city"
    return z


@router.post("")
async def upsert_gig_profile(
    request: Request,
    body: GigProfileUpsert,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    bind_contextvars(worker_id=current_user.id)
    zone_key = _normalize_zone(body.zone_id)
    risk = ZONE_TO_RISK.get(zone_key, OrmRisk.medium)

    row = (await db.execute(select(Profile).where(Profile.user_id == current_user.id))).scalar_one_or_none()
    if row is None:
        row = Profile(
            user_id=current_user.id,
            name=body.name.strip(),
            city=body.city.strip() or "Hyderabad",
            occupation=OrmOccupation.delivery,
            avg_daily_income=float(body.avg_daily_income),
            risk_profile=risk,
            platform=body.platform.strip(),
            zone_id=body.zone_id.strip(),
            working_hours_preset=body.working_hours_preset.strip(),
            coverage_tier=body.coverage_tier.strip(),
        )
        db.add(row)
    else:
        row.name = body.name.strip()
        row.city = body.city.strip() or "Hyderabad"
        row.avg_daily_income = float(body.avg_daily_income)
        row.risk_profile = risk
        row.platform = body.platform.strip()
        row.zone_id = body.zone_id.strip()
        row.working_hours_preset = body.working_hours_preset.strip()
        row.coverage_tier = body.coverage_tier.strip()

    await db.commit()
    await db.refresh(row)

    tier = body.coverage_tier.strip()
    if tier not in TIER_TO_PRODUCT:
        raise HTTPException(status_code=422, detail="Invalid coverage_tier — use Basic, Standard, or Pro")

    product_code = TIER_TO_PRODUCT[tier]
    try:
        calc = await PremiumEngine.calculate(current_user.id, db=db, profile=row, user=current_user)
    except Exception as exc:
        log.warning(
            "premium_calculate_failed",
            engine_name="profile_route",
            worker_id=current_user.id,
            error=str(exc),
        )
        calc = {"weekly_premium": 35.0}
    base_weekly = float(calc.get("weekly_premium") or 35.0)
    mult = TIER_MULT.get(tier, 1.0)
    weekly = int(max(35, min(85, round(base_weekly * mult))))
    monthly = round(weekly * 4.33, 2)
    now = datetime.now(timezone.utc)

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
        existing.weekly_premium = float(weekly)
        existing.monthly_premium = monthly
        existing.status = "active"
        existing.updated_at = now
    else:
        db.add(
            Policy(
                user_id=current_user.id,
                product_code=product_code,
                status="active",
                monthly_premium=monthly,
                weekly_premium=float(weekly),
                updated_at=now,
            )
        )

    await db.commit()
    await cache_invalidate(getattr(request.app.state, "redis", None), f"trust:{current_user.id}")
    await cache_invalidate(getattr(request.app.state, "redis", None), f"policy_active:{current_user.id}")

    log.info(
        "gig_profile_saved",
        engine_name="profile_route",
        decision="ok",
        reason_code="GIG_PROFILE",
        worker_id=current_user.id,
        tier=tier,
    )
    return {"success": True, "profile_id": row.id, "policy_activated": True, "weekly_premium": weekly}
