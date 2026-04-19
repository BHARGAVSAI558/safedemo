from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from structlog.contextvars import bind_contextvars

from app.core.security import get_user_id_from_token
from app.db.session import get_db
from app.models.claim import DecisionType, Simulation
from app.models.device_fingerprint import DeviceFingerprint
from app.models.policy import Policy
from app.models.weekly_summary import WeeklySummary
from app.models.worker import OccupationType as OrmOccupation
from app.models.worker import Profile, RiskProfile as OrmRisk, User
from app.schemas.earnings_dna import EarningsDnaOut
from app.schemas.worker import PolicyWeekHistoryItem, ProfileCreate, ProfileResponse, ProfileUpdate, WorkerProfileOut
from app.services.simulation_labels import disruption_from_simulation
from app.services.cache_service import cache_invalidate
from app.services.earnings_dna_service import build_worker_earnings_dna
from app.services.onboarding_pricing import TIER_MAX_DAILY
from app.services.zone_resolver import resolve_city_to_zone
from app.engines.trust_payout import trust_score_points, trust_tier_label
from app.utils.logger import get_logger

log = get_logger(__name__)
router = APIRouter()
IST = ZoneInfo("Asia/Kolkata")

MAX_WEEKLY_COVERAGE_BY_PRODUCT = {
    "income_shield_basic": 2450.0,
    "income_shield_standard": 3500.0,
    "income_shield_pro": 4900.0,
}


def _product_plan_label(product_code: str) -> str:
    c = (product_code or "").lower()
    if "pro" in c and "standard" not in c:
        return "Pro"
    if "standard" in c:
        return "Standard"
    return "Basic"


def _week_bounds_utc(now: datetime | None = None) -> tuple[datetime, datetime]:
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    weekday = now.weekday()
    start = (now - timedelta(days=weekday)).replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=7)
    return start, end


def _week_monday_00_ist_to_now_utc() -> tuple[datetime, datetime]:
    """Current ISO week: Monday 00:00 Asia/Kolkata through now (UTC-aware end)."""
    now_utc = datetime.now(timezone.utc)
    now_ist = now_utc.astimezone(IST)
    d = now_ist.date()
    monday = d - timedelta(days=d.weekday())
    start_ist = datetime.combine(monday, datetime.min.time()).replace(tzinfo=IST)
    return start_ist.astimezone(timezone.utc), now_utc


def _mask_phone(phone: str | None) -> str:
    if not phone or len(str(phone)) < 4:
        return "****"
    p = str(phone)
    return f"****{p[-4:]}"


def _enum_or_str(v: Any, default: str) -> str:
    if v is None:
        return default
    if hasattr(v, "value"):
        return str(v.value)
    return str(v)


def _profile_response_from_orm(profile: Profile) -> ProfileResponse:
    """Avoid from_attributes edge cases (NULL numerics, driver-specific enums)."""
    name = (profile.name or "").strip() or "Worker"
    city = (profile.city or "Hyderabad").strip()
    loc = getattr(profile, "location_display", None)
    loc = (str(loc).strip() or None) if loc else None
    return ProfileResponse(
        id=int(profile.id),
        user_id=int(profile.user_id),
        name=name,
        city=city,
        occupation=_enum_or_str(profile.occupation, "delivery"),
        avg_daily_income=float(profile.avg_daily_income) if profile.avg_daily_income is not None else 1000.0,
        risk_profile=_enum_or_str(profile.risk_profile, "medium"),
        trust_score=float(profile.trust_score) if profile.trust_score is not None else 0.0,
        total_claims=int(profile.total_claims) if profile.total_claims is not None else 0,
        total_payouts=float(profile.total_payouts) if profile.total_payouts is not None else 0.0,
        platform=profile.platform,
        zone_id=profile.zone_id,
        location_display=loc,
        working_hours_preset=profile.working_hours_preset,
        coverage_tier=profile.coverage_tier,
        risk_score=float(profile.risk_score) if getattr(profile, "risk_score", None) is not None else None,
        weekly_premium=float(profile.weekly_premium) if getattr(profile, "weekly_premium", None) is not None else None,
        bank_account_number=(str(getattr(profile, "bank_account_number", "") or "").strip() or None),
        bank_ifsc=(str(getattr(profile, "bank_ifsc", "") or "").strip() or None),
        bank_upi_id=(str(getattr(profile, "bank_upi_id", "") or "").strip() or None),
        bank_account_name=(str(getattr(profile, "bank_account_name", "") or "").strip() or None),
        created_at=profile.created_at,
    )


async def _worker_profile_payload(profile: Profile, current_user: User, db: AsyncSession) -> WorkerProfileOut:
    stored_zone = str(profile.zone_id or "").strip()
    if stored_zone and stored_zone.lower() not in ("default", "unknown"):
        zone_id = stored_zone
    else:
        zone_id, _lat, _lon = resolve_city_to_zone(profile.city or "")
    start, end = _week_bounds_utc()
    weekly_protected = 0.0
    try:
        weekly_sum = (
            await db.execute(
                select(func.coalesce(func.sum(Simulation.payout), 0.0)).where(
                    Simulation.user_id == current_user.id,
                    or_(Simulation.decision == DecisionType.APPROVED, Simulation.payout > 0),
                    Simulation.created_at.isnot(None),
                    Simulation.created_at >= start,
                    Simulation.created_at < end,
                )
            )
        ).scalar_one()
        weekly_protected = float(weekly_sum or 0.0)
    except Exception as exc:
        log.warning(
            "worker_weekly_payout_sum_failed",
            engine_name="workers_route",
            worker_id=current_user.id,
            error=str(exc),
        )

    pol_row = None
    hist_policies: list[Policy] = []
    try:
        pol_row = (
            await db.execute(
                select(Policy)
                .where(Policy.user_id == current_user.id, Policy.status == "active")
                .order_by(Policy.id.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        hist_policies = list(
            (
                await db.execute(
                    select(Policy).where(Policy.user_id == current_user.id).order_by(Policy.id.desc()).limit(3)
                )
            ).scalars().all()
        )
    except Exception as exc:
        log.warning(
            "worker_policy_fetch_failed",
            engine_name="workers_route",
            worker_id=current_user.id,
            error=str(exc),
        )

    product_code = (pol_row.product_code if pol_row else None) or "income_shield_basic"
    max_weekly = MAX_WEEKLY_COVERAGE_BY_PRODUCT.get(product_code, 2450.0)

    policy_history: list[PolicyWeekHistoryItem] = []
    for p in hist_policies:
        started = p.created_at.isoformat() if getattr(p, "created_at", None) else None
        wp_raw = getattr(p, "weekly_premium", None)
        policy_history.append(
            PolicyWeekHistoryItem(
                started_at=started,
                plan=_product_plan_label(getattr(p, "product_code", None)),
                status=str(getattr(p, "status", None) or "unknown"),
                weekly_premium=float(wp_raw or 0.0),
            )
        )

    base = _profile_response_from_orm(profile)
    # WorkerProfileOut redefines zone_id (resolved from city); base.model_dump() already
    # includes zone_id from the profile row — duplicate kwargs raise TypeError → HTTP 500.
    payload = base.model_dump()
    payload.pop("zone_id", None)
    complete = bool(str(profile.zone_id or "").strip()) and bool(str(profile.platform or "").strip())
    tpts = trust_score_points(profile.trust_score)
    return WorkerProfileOut(
        **payload,
        zone_id=zone_id,
        earnings_protected_this_week=weekly_protected,
        max_weekly_coverage=max_weekly,
        policy_history=policy_history,
        is_profile_complete=complete,
        phone_number=_mask_phone(current_user.phone),
        trust_score_points=round(tpts, 1),
        trust_tier=trust_tier_label(tpts),
    )


async def _default_worker_profile_out(current_user: User, db: AsyncSession) -> WorkerProfileOut:
    start, end = _week_bounds_utc()
    weekly_protected = 0.0
    try:
        weekly_sum = (
            await db.execute(
                select(func.coalesce(func.sum(Simulation.payout), 0.0)).where(
                    Simulation.user_id == current_user.id,
                    or_(Simulation.decision == DecisionType.APPROVED, Simulation.payout > 0),
                    Simulation.created_at.isnot(None),
                    Simulation.created_at >= start,
                    Simulation.created_at < end,
                )
            )
        ).scalar_one()
        weekly_protected = float(weekly_sum or 0.0)
    except Exception as exc:
        log.warning(
            "default_worker_weekly_sum_failed",
            engine_name="workers_route",
            worker_id=current_user.id,
            error=str(exc),
        )
    zone_id, _lat, _lon = resolve_city_to_zone("")
    base = ProfileResponse(
        id=0,
        user_id=current_user.id,
        name="",
        city="",
        occupation="delivery",
        avg_daily_income=650.0,
        risk_profile="medium",
        trust_score=50.0,
        total_claims=0,
        total_payouts=0.0,
        platform=None,
        zone_id=None,
        working_hours_preset=None,
        coverage_tier=None,
        risk_score=None,
        weekly_premium=None,
        created_at=None,
    )
    payload = base.model_dump()
    payload.pop("zone_id", None)
    tpts = trust_score_points(50.0)
    return WorkerProfileOut(
        **payload,
        zone_id=zone_id,
        earnings_protected_this_week=weekly_protected,
        max_weekly_coverage=2450.0,
        policy_history=[],
        is_profile_complete=False,
        phone_number=_mask_phone(current_user.phone),
        trust_score_points=round(tpts, 1),
        trust_tier=trust_tier_label(tpts),
    )

INDIA_LAT_MIN = 6.5
INDIA_LAT_MAX = 37.5
INDIA_LON_MIN = 68.0
INDIA_LON_MAX = 97.5


class AccelerometerIn(BaseModel):
    mean_magnitude: float = 0.0
    variance: float = 0.0
    is_moving: bool = False


class GPSPointIn(BaseModel):
    lat: float
    lon: float
    accuracy: float = 0.0
    altitude: float | None = None
    timestamp: datetime
    cell_carrier_name: str | None = None
    network_type: str | None = None
    accelerometer: AccelerometerIn
    battery_level: float | None = None
    app_state: str | None = None
    gps_quality: str | None = None
    suspicious_motion: bool = False
    network_unstable: bool = False

    @field_validator("lat")
    @classmethod
    def valid_lat(cls, v: float) -> float:
        if not (INDIA_LAT_MIN <= float(v) <= INDIA_LAT_MAX):
            raise ValueError("lat must be inside India bounds")
        return float(v)

    @field_validator("lon")
    @classmethod
    def valid_lon(cls, v: float) -> float:
        if not (INDIA_LON_MIN <= float(v) <= INDIA_LON_MAX):
            raise ValueError("lon must be inside India bounds")
        return float(v)


class GPSBatchIn(BaseModel):
    points: list[GPSPointIn] = Field(default_factory=list, max_length=20)


class AppEventIn(BaseModel):
    event_type: str
    screen_name: str | None = None
    action: str | None = None
    duration_ms: int | None = None
    timestamp: datetime

    @field_validator("duration_ms")
    @classmethod
    def valid_duration(cls, v: int | None) -> int | None:
        if v is None:
            return v
        if v < 0:
            raise ValueError("duration_ms cannot be negative")
        return v


class AppEventsBatchIn(BaseModel):
    events: list[AppEventIn] = Field(default_factory=list, max_length=100)


class DeviceFingerprintIn(BaseModel):
    fingerprint_hash: str
    model_name: str | None = None
    os_version: str | None = None
    platform_api_level: int | None = None
    screen_width: int | None = None
    screen_height: int | None = None
    app_version: str | None = None
    network_type_at_enrollment: str | None = None
    battery_level: float | None = None



async def get_current_user(
    authorization: Optional[str] = Header(None),
    db: AsyncSession = Depends(get_db),
) -> User:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authorization header missing")
    token = authorization.split(" ", 1)[1]
    user_id = get_user_id_from_token(token)
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    bind_contextvars(worker_id=user.id)
    return user


@router.post("/create", response_model=ProfileResponse, status_code=201)
async def create_profile(
    request: Request,
    body: ProfileCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    existing = await db.execute(select(Profile).where(Profile.user_id == current_user.id))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Profile already exists. Use PUT /workers/update")

    profile = Profile(
        user_id=current_user.id,
        name=body.name,
        city=body.city,
        occupation=OrmOccupation(body.occupation.value),
        avg_daily_income=body.avg_daily_income,
        risk_profile=OrmRisk(body.risk_profile.value),
    )
    db.add(profile)
    await db.commit()
    await db.refresh(profile)
    await cache_invalidate(getattr(request.app.state, "redis", None), f"trust:{current_user.id}")
    log.info(
        "profile_created",
        engine_name="workers_route",
        decision="created",
        reason_code="PROFILE_OK",
        worker_id=current_user.id,
    )
    return profile


@router.get("/weekly-breakdown")
async def get_weekly_breakdown(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Per-day payout breakdown: Monday 00:00 IST through now, full Mon–Sun row (future days ₹0)."""
    start_utc, end_utc = _week_monday_00_ist_to_now_utc()

    rows = (
        await db.execute(
            select(Simulation).where(
                Simulation.user_id == current_user.id,
                or_(Simulation.decision == DecisionType.APPROVED, Simulation.payout > 0),
                Simulation.created_at.isnot(None),
                Simulation.created_at >= start_utc,
                Simulation.created_at <= end_utc,
            )
        )
    ).scalars().all()

    rows_sorted = sorted(
        rows,
        key=lambda s: s.created_at or datetime.min.replace(tzinfo=timezone.utc),
    )
    day_amount: dict[Any, float] = {}
    day_disruption: dict[Any, str] = {}
    for sim in rows_sorted:
        ca = sim.created_at
        if ca is None:
            continue
        if ca.tzinfo is None:
            ca = ca.replace(tzinfo=timezone.utc)
        di = ca.astimezone(IST).date()
        day_amount[di] = day_amount.get(di, 0.0) + float(sim.payout or 0.0)
        lab, _ = disruption_from_simulation(sim)
        day_disruption[di] = lab

    now_ist = end_utc.astimezone(IST)
    monday = now_ist.date() - timedelta(days=now_ist.weekday())
    day_labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    days: list[dict[str, Any]] = []
    weekly_breakdown: list[dict[str, Any]] = []
    for i in range(7):
        dd = monday + timedelta(days=i)
        amt = round(day_amount.get(dd, 0.0), 2)
        dis = day_disruption.get(dd) if amt > 0 else None
        date_str = f"{dd.strftime('%b')} {dd.day}"
        days.append({"day": day_labels[i], "date": date_str, "amount": amt, "disruption": dis})
        weekly_breakdown.append({"day": day_labels[i], "amount": amt, "disruption": dis})

    total = round(sum(day_amount.values()), 2)

    pol_row = (
        await db.execute(
            select(Policy)
            .where(Policy.user_id == current_user.id, Policy.status == "active")
            .order_by(Policy.id.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    tier = _product_plan_label((pol_row.product_code if pol_row else "") or "income_shield_basic")
    daily_cap = float(TIER_MAX_DAILY.get(tier, 500.0))
    max_coverage = round(daily_cap * 7.0, 2)

    return {
        "days": days,
        "weekly_breakdown": weekly_breakdown,
        "total_protected": total,
        "max_coverage": max_coverage,
    }


@router.get("/weekly-summaries")
async def list_weekly_summaries(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    rows = (
        await db.execute(
            select(WeeklySummary)
            .where(WeeklySummary.user_id == current_user.id)
            .order_by(WeeklySummary.week_start.desc())
            .limit(52)
        )
    ).scalars().all()
    return [
        {
            "id": r.id,
            "week_start": r.week_start.isoformat() if r.week_start else None,
            "title": r.title,
            "body": r.body,
            "hours_protected": r.hours_protected,
            "disruptions_in_zone": r.disruptions_in_zone,
            "payout_inr": r.payout_inr,
            "premium_peace_inr": r.premium_peace_inr,
            "zone_risk_next_week": r.zone_risk_next_week,
            "trust_delta_points": r.trust_delta_points,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]


@router.get("/me", response_model=WorkerProfileOut)
async def get_profile(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from datetime import datetime, timezone

    result = await db.execute(select(Profile).where(Profile.user_id == current_user.id))
    profile = result.scalar_one_or_none()
    if not profile:
        return await _default_worker_profile_out(current_user, db)
    now = datetime.now(timezone.utc)
    profile.last_api_call = now
    profile.last_seen = now
    await db.commit()
    await db.refresh(profile)
    return await _worker_profile_payload(profile, current_user, db)


@router.get("/profile", response_model=WorkerProfileOut)
async def get_profile_alias(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await get_profile(current_user=current_user, db=db)


@router.get("/{worker_id}/dashboard")
async def get_worker_dashboard(
    worker_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if worker_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="worker_id does not match JWT")

    from app.api.v1.routes.claims import claim_history
    from app.api.v1.routes.policies import build_policy_current

    result = await db.execute(select(Profile).where(Profile.user_id == current_user.id))
    profile = result.scalar_one_or_none()
    profile_payload = (
        await _worker_profile_payload(profile, current_user, db)
        if profile is not None
        else await _default_worker_profile_out(current_user, db)
    )
    policy_payload = await build_policy_current(current_user, db)
    claims_payload = await claim_history(current_user=current_user, db=db, cursor=None, limit=20)
    return {
        "worker_id": current_user.id,
        "profile": profile_payload,
        "policy": policy_payload,
        "claims": claims_payload.get("data", []),
        "claims_total_count": claims_payload.get("total_count", 0),
    }


@router.get("/{worker_id}/claims")
async def get_worker_claims(
    worker_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    cursor: int | None = None,
    limit: int = 50,
):
    if worker_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="worker_id does not match JWT")

    from app.api.v1.routes.claims import claim_history

    return await claim_history(current_user=current_user, db=db, cursor=cursor, limit=limit)


@router.put("/update", response_model=ProfileResponse)
async def update_profile(
    request: Request,
    body: ProfileUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Profile).where(Profile.user_id == current_user.id))
    profile = result.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    data = body.model_dump(exclude_none=True)
    if "occupation" in data and data["occupation"] is not None:
        data["occupation"] = OrmOccupation(data["occupation"].value)
    if "risk_profile" in data and data["risk_profile"] is not None:
        data["risk_profile"] = OrmRisk(data["risk_profile"].value)
    for field, value in data.items():
        setattr(profile, field, value)

    await db.commit()
    await db.refresh(profile)
    await cache_invalidate(getattr(request.app.state, "redis", None), f"trust:{current_user.id}")
    log.info(
        "profile_updated",
        engine_name="workers_route",
        decision="updated",
        reason_code="PROFILE_OK",
        worker_id=current_user.id,
    )
    return profile


async def _earnings_dna_payload(worker_id: int, db: AsyncSession) -> EarningsDnaOut:
    pr = await db.execute(select(Profile).where(Profile.user_id == worker_id))
    profile = pr.scalar_one_or_none()
    avg_income = 650.0 if profile is None else max(50.0, float(profile.avg_daily_income or 600.0))

    since = datetime.now(timezone.utc) - timedelta(days=30)
    approved = (
        (
            await db.execute(
                select(Simulation)
                .where(
                    Simulation.user_id == worker_id,
                    or_(Simulation.decision == DecisionType.APPROVED, Simulation.payout > 0),
                    Simulation.created_at >= since,
                )
                .order_by(Simulation.created_at.desc())
            )
        )
        .scalars()
        .all()
    )

    start, end = _week_bounds_utc()
    weekly_payout_sum = (
        await db.execute(
            select(func.coalesce(func.sum(Simulation.payout), 0.0)).where(
                Simulation.user_id == worker_id,
                or_(Simulation.decision == DecisionType.APPROVED, Simulation.payout > 0),
                Simulation.created_at >= start,
                Simulation.created_at < end,
            )
        )
    ).scalar_one()
    weekly_f = float(weekly_payout_sum or 0.0)

    payload = build_worker_earnings_dna(
        approved,
        avg_income,
        weekly_f,
    )
    return EarningsDnaOut.model_validate(payload)


@router.get("/earnings-dna", response_model=EarningsDnaOut)
async def get_earnings_dna_me(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """IST earnings heatmap + weekly rollups (APPROVED simulations, last 30 days)."""
    return await _earnings_dna_payload(current_user.id, db)


@router.get("/{worker_id}/earnings-dna", response_model=EarningsDnaOut)
async def get_earnings_dna(
    worker_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if worker_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="worker_id does not match JWT")
    return await _earnings_dna_payload(worker_id, db)


@router.post("/{worker_id}/gps-trail")
async def ingest_gps_trail(
    worker_id: int,
    body: GPSBatchIn,
    request: Request,
    current_user: User = Depends(get_current_user),
):
    if worker_id != current_user.id:
        raise HTTPException(status_code=403, detail="worker_id does not match JWT")
    if len(body.points) > 20:
        raise HTTPException(status_code=422, detail="max 20 points per batch")

    mongo_db = getattr(request.app.state, "mongo_db", None)
    if mongo_db is None:
        raise HTTPException(status_code=503, detail="Telemetry store unavailable")

    suspicious = any(bool(p.suspicious_motion) or str(p.gps_quality or "").upper() == "POOR" for p in body.points)
    if suspicious:
        log.warning(
            "gps_telemetry_suspicious_batch",
            engine_name="workers_route",
            decision="warning",
            reason_code="GPS_SUSPICIOUS",
            worker_id=worker_id,
            batch_size=len(body.points),
        )

    payload = {
        "worker_id": worker_id,
        "points": [p.model_dump(mode="json") for p in body.points],
        "received_at": datetime.now(timezone.utc),
    }
    await mongo_db["gps_trails"].insert_one(payload)
    return {"received": len(body.points), "stored": True}


@router.post("/{worker_id}/app-events")
async def ingest_app_events(
    worker_id: int,
    body: AppEventsBatchIn,
    request: Request,
    current_user: User = Depends(get_current_user),
):
    if worker_id != current_user.id:
        raise HTTPException(status_code=403, detail="worker_id does not match JWT")
    if len(body.events) > 100:
        raise HTTPException(status_code=422, detail="max 100 events per batch")

    mongo_db = getattr(request.app.state, "mongo_db", None)
    if mongo_db is None:
        raise HTTPException(status_code=503, detail="Events store unavailable")

    await mongo_db["app_event_logs"].insert_one(
        {
            "worker_id": worker_id,
            "events": [e.model_dump(mode="json") for e in body.events],
            "received_at": datetime.now(timezone.utc),
        }
    )
    return {"received": len(body.events), "stored": True}


@router.post("/{worker_id}/device-fingerprint")
async def upsert_device_fingerprint(
    worker_id: int,
    body: DeviceFingerprintIn,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if worker_id != current_user.id:
        raise HTTPException(status_code=403, detail="worker_id does not match JWT")

    row = (await db.execute(select(DeviceFingerprint).where(DeviceFingerprint.worker_id == worker_id))).scalar_one_or_none()
    if row is None:
        row = DeviceFingerprint(worker_id=worker_id)
        db.add(row)
    row.fingerprint_hash = body.fingerprint_hash
    row.model_name = body.model_name
    row.os_version = body.os_version
    row.platform_api_level = body.platform_api_level
    row.screen_width = body.screen_width
    row.screen_height = body.screen_height
    row.app_version = body.app_version
    row.network_type_at_enrollment = body.network_type_at_enrollment
    row.battery_level = body.battery_level
    await db.commit()
    return {"stored": True}
