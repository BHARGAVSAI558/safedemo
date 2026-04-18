from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from structlog.contextvars import bind_contextvars

from app.api.v1.routes.workers import get_current_user
from app.db.session import get_db
from app.engines.earnings_engine import build_earnings_dna_from_onboarding
from app.models.worker import OccupationType as OrmOccupation
from app.models.worker import Profile, RiskProfile as OrmRisk, User
from app.schemas.profile import GigProfileResponse, GigProfileUpsert, ProfileBootstrapResponse
from app.services.cache_service import cache_invalidate
from app.services.onboarding_pricing import (
    TIER_MAX_DAILY,
    ZONE_RISK_LABEL,
    ZONE_TO_RISK,
    compute_risk_score,
    compute_weekly_premium,
    normalize_zone,
)
from app.utils.logger import get_logger

log = get_logger(__name__)
router = APIRouter()


def _mask_phone(phone: str | None) -> str:
    if not phone or len(str(phone)) < 4:
        return "****"
    p = str(phone)
    return f"****{p[-4:]}"


def _trust_display(trust_raw: float | None) -> float:
    t = float(trust_raw or 0.0)
    if t <= 1.0:
        return round(min(100.0, max(0.0, t * 100.0)), 2)
    return round(min(100.0, max(0.0, t)), 2)


@router.get("", response_model=ProfileBootstrapResponse)
async def get_profile_bootstrap(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Lightweight profile row for onboarding: defaults when no `profiles` row yet."""
    row = (await db.execute(select(Profile).where(Profile.user_id == current_user.id))).scalar_one_or_none()
    if row is None:
        return ProfileBootstrapResponse(
            id=current_user.id,
            phone_number=_mask_phone(current_user.phone),
            is_profile_complete=False,
        )
    complete = bool(str(row.zone_id or "").strip()) and bool(str(row.platform or "").strip())
    loc_disp = getattr(row, "location_display", None)
    loc_disp = (str(loc_disp).strip() or None) if loc_disp else None
    return ProfileBootstrapResponse(
        id=current_user.id,
        phone_number=_mask_phone(current_user.phone),
        name=(row.name or None) if str(row.name or "").strip() else None,
        city=(row.city or None) if str(row.city or "").strip() else None,
        zone_id=(row.zone_id or None) if str(row.zone_id or "").strip() else None,
        platform=(row.platform or None) if str(row.platform or "").strip() else None,
        location_display=loc_disp,
        avg_daily_income=float(row.avg_daily_income or 650.0),
        trust_score=_trust_display(row.trust_score),
        is_profile_complete=complete,
    )


@router.post("", response_model=GigProfileResponse)
async def upsert_gig_profile(
    request: Request,
    body: GigProfileUpsert,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    bind_contextvars(worker_id=current_user.id)
    zone_key = normalize_zone(body.zone_id)
    risk = ZONE_TO_RISK.get(zone_key, OrmRisk.medium)
    tier = body.coverage_tier.strip()
    if tier not in TIER_MAX_DAILY:
        raise HTTPException(status_code=422, detail="Invalid coverage_tier — use Basic, Standard, or Pro")

    weekly = compute_weekly_premium(zone_key, body.working_hours_preset, tier)

    row = (await db.execute(select(Profile).where(Profile.user_id == current_user.id))).scalar_one_or_none()
    prior_claims = int(row.total_claims or 0) if row else 0
    risk_score_computed = float(compute_risk_score(zone_key, body.working_hours_preset, body.platform))
    risk_score = risk_score_computed if prior_claims > 0 else 0.0
    loc_disp = (body.location_display or "").strip()[:255] if body.location_display else None

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
            coverage_tier=tier,
            risk_score=float(risk_score),
            weekly_premium=float(weekly),
            trust_score=0.0,
            location_display=loc_disp,
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
        row.coverage_tier = tier
        row.risk_score = float(risk_score)
        row.weekly_premium = float(weekly)
        row.location_display = loc_disp

    await db.commit()
    await db.refresh(row)

    # Build / rebuild EarningsDNA matrix from onboarding data
    try:
        avg_daily = float(body.avg_daily_income or 600.0)
        # Derive active hours from working_hours_preset
        _hours_map = {"morning": 4.0, "afternoon": 4.0, "evening": 5.0, "full_day": 10.0, "flexible": 8.0}
        active_hours = _hours_map.get((body.working_hours_preset or "flexible").strip().lower(), 8.0)
        await build_earnings_dna_from_onboarding(db, current_user.id, avg_daily, active_hours)
        await db.commit()
    except Exception as _dna_exc:
        log.warning(
            "earnings_dna_build_failed",
            engine_name="profile_route",
            reason_code="DNA_BUILD_FAIL",
            worker_id=current_user.id,
            error=str(_dna_exc),
        )

    await cache_invalidate(getattr(request.app.state, "redis", None), f"trust:{current_user.id}")

    log.info(
        "gig_profile_saved",
        engine_name="profile_route",
        decision="ok",
        reason_code="GIG_PROFILE",
        worker_id=current_user.id,
        tier=tier,
        risk_score=risk_score,
        weekly_premium=weekly,
    )

    return GigProfileResponse(
        success=True,
        profile_id=row.id,
        risk_score=risk_score,
        weekly_premium=weekly,
        coverage_tier=tier,
        zone_id=body.zone_id.strip(),
        zone_risk_level=ZONE_RISK_LABEL.get(zone_key, "Medium Risk"),
        max_coverage_per_day=TIER_MAX_DAILY.get(tier, 500.0),
        platform=body.platform.strip(),
        working_hours_preset=body.working_hours_preset.strip(),
        name=body.name.strip(),
        city=body.city.strip() or "Hyderabad",
        location_display=loc_disp,
    )
