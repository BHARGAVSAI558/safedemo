import json
import csv
import io
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
import httpx
from sqlalchemy import delete, func, or_, select, and_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.core.security import get_user_id_from_token, verify_admin_token
from app.core.rate_limit import limiter
from app.db.session import get_db
from app.db.session import _seed_local_dataset, _seed_zones
from app.models.claim import ClaimLifecycle, DecisionType, DisruptionEvent, Log, Simulation
from app.models.device_fingerprint import DeviceFingerprint
from app.models.fraud import FraudFlag, FraudSignal
from app.models.notification import Notification
from app.models.payout import PayoutRecord
from app.models.support import SupportQuery
from app.models.pool_balance import ZonePoolBalance
from app.models.policy import Policy
from app.models.worker import Profile, User
from app.models.zone import Zone
from app.services.notification_service import create_notification
from app.schemas.admin import AnalyticsResponse, UserAdminResponse, ZoneAlertsInjectBody
from app.engines.actuarial_pricing import compute_pool_health_payload, persist_pool_health_snapshot, run_full_weekly_pricing
from app.services.earnings_dna_service import admin_aggregate_earnings_analytics
from app.services.income_loss_receipt import build_income_loss_receipt_pdf
from app.services.event_service import government_alert_store
from app.utils.logger import get_logger

log = get_logger(__name__)
router = APIRouter()
_SIM_CLUSTER_ACTIONS: Dict[str, str] = {}

def _to_base36(n: int) -> str:
    chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    x = max(0, int(n))
    if x == 0:
        return "0"
    out = ""
    while x:
        x, r = divmod(x, 36)
        out = chars[r] + out
    return out


def _public_tx_id(prefix: str, row_id: int) -> str:
    seed = max(1, int(row_id)) * 7919 + 97
    return f"{prefix}-{_to_base36(seed)}"


# Hyderabad zones for admin GeoJSON (lon/lat bbox corners per product spec)
HYDERABAD_ZONES_GEO: List[Dict[str, Any]] = [
    {"zone_id": "kukatpally", "zone_name": "Kukatpally", "bbox": (78.37, 17.47, 78.42, 17.52)},
    {"zone_id": "hitec_city", "zone_name": "HITEC City", "bbox": (78.36, 17.42, 78.40, 17.46)},
    {"zone_id": "secunderabad", "zone_name": "Secunderabad", "bbox": (78.48, 17.42, 78.52, 17.46)},
    {"zone_id": "gachibowli", "zone_name": "Gachibowli", "bbox": (78.32, 17.42, 78.37, 17.46)},
    {"zone_id": "lb_nagar", "zone_name": "LB Nagar", "bbox": (78.52, 17.32, 78.56, 17.36)},
    {"zone_id": "hyd_central", "zone_name": "Hyderabad Central", "bbox": (78.45, 17.36, 78.50, 17.40)},
]

# Map profile.city -> canonical zone_id (Hyderabad micro-zones)
PROFILE_CITY_TO_ZONE: Dict[str, str] = {
    "Kukatpally": "kukatpally",
    "HITEC City": "hitec_city",
    "Secunderabad": "secunderabad",
    "Gachibowli": "gachibowli",
    "LB Nagar": "lb_nagar",
    "Hyderabad": "hyd_central",
    "Hyderabad Central": "hyd_central",
}

# Seed/demo pools may use legacy ids — resolve to canonical for KPIs/heatmap
ZONE_POOL_ALIASES: Dict[str, Tuple[str, ...]] = {
    "kukatpally": ("kukatpally", "hyd_kukatpally"),
    "hitec_city": ("hitec_city", "hyd_hitec"),
    "secunderabad": ("secunderabad", "hyd_secunderabad"),
    "gachibowli": ("gachibowli", "hyd_gachibowli"),
    "lb_nagar": ("lb_nagar",),
    "hyd_central": ("hyd_central",),
}


def _ring_bbox(min_lon: float, min_lat: float, max_lon: float, max_lat: float) -> List[List[float]]:
    return [
        [min_lon, min_lat],
        [max_lon, min_lat],
        [max_lon, max_lat],
        [min_lon, max_lat],
        [min_lon, min_lat],
    ]


def _utc_day_bounds() -> Tuple[datetime, datetime]:
    now = datetime.now(timezone.utc)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=1)
    return start, end


def _parse_zone_from_simulation(s: Simulation) -> Optional[str]:
    if not s.weather_data:
        return None
    try:
        d = json.loads(s.weather_data) if isinstance(s.weather_data, str) else s.weather_data
        z = d.get("zone_id")
        return str(z).strip() if z else None
    except Exception:
        return None


def _canonicalize_zone(z: Optional[str]) -> Optional[str]:
    if not z:
        return None
    z = str(z).strip()
    for canonical, aliases in ZONE_POOL_ALIASES.items():
        if z == canonical or z in aliases:
            return canonical
    # legacy seed
    if z == "hyd_demo":
        return "hyd_central"
    return z


async def _latest_pools_by_zone_raw(db: AsyncSession) -> Dict[str, ZonePoolBalance]:
    r = await db.execute(select(ZonePoolBalance).order_by(ZonePoolBalance.week_start.desc(), ZonePoolBalance.id.desc()))
    rows = r.scalars().all()
    out: Dict[str, ZonePoolBalance] = {}
    for p in rows:
        if p.zone_id not in out:
            out[p.zone_id] = p
    return out


def _pool_row_for_canonical(pools: Dict[str, ZonePoolBalance], canonical_id: str) -> Optional[ZonePoolBalance]:
    for key in ZONE_POOL_ALIASES.get(canonical_id, (canonical_id,)):
        if key in pools:
            return pools[key]
    return None


# Deterministic per-zone seed values — no random, stable across restarts
_ZONE_SEED_PARAMS: Dict[str, tuple] = {
    "kukatpally":   (98_000.0, 58.4),
    "hitec_city":   (112_000.0, 51.2),
    "secunderabad": (95_000.0, 63.7),
    "gachibowli":   (108_000.0, 49.8),
    "lb_nagar":     (89_000.0, 67.1),
    "hyd_central":  (102_000.0, 55.3),
}


async def _ensure_demo_zone_pools(db: AsyncSession) -> None:
    pools = await _latest_pools_by_zone_raw(db)
    now = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    added = 0
    for z in HYDERABAD_ZONES_GEO:
        zid = str(z["zone_id"])
        if _pool_row_for_canonical(pools, zid) is not None:
            continue
        bal, util = _ZONE_SEED_PARAMS.get(zid, (100_000.0, 55.0))
        payouts = round(bal * (util / 100.0), 2)
        row = ZonePoolBalance(
            zone_id=zid,
            week_start=now,
            pool_balance_start_of_week=bal,
            total_premiums_collected=bal,
            total_payouts_this_week=payouts,
            total_payouts_disbursed=payouts,
            current_balance=round(bal - payouts, 2),
            utilization_pct=util,
            loss_ratio=round(payouts / bal, 4) if bal > 0 else 0.0,
            flagged_reinsurance=util > 68.0,
            risk_note=f"{z['zone_name']} seeded",
        )
        db.add(row)
        pools[zid] = row
        added += 1
    if added:
        await db.commit()
        log.info("zone_pools_auto_seeded", engine_name="admin_route", reason_code="POOLS_PARTIAL", added=added)


def _load_zone_centers() -> Dict[str, Dict[str, Any]]:
    path = Path(__file__).resolve().parents[3] / "data" / "zone_coordinates.json"
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        out: Dict[str, Dict[str, Any]] = {}
        for city, payload in data.items():
            out[str(payload.get("zone_id", city))] = {
                "city": city,
                "lat": float(payload.get("lat", 0)),
                "lon": float(payload.get("lon", 0)),
            }
        return out
    except Exception:
        return {}


def _mask_phone(phone: str | None) -> str:
    if not phone or len(phone) < 4:
        return "****"
    return f"****{phone[-4:]}"


def _coverage_tier_from_product(product_code: str | None) -> str:
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


async def get_admin_user(
    authorization: Optional[str] = Header(None),
    db: AsyncSession = Depends(get_db),
) -> User:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Authorization required")
    token = authorization.split(" ", 1)[1]
    try:
        admin_payload = verify_admin_token(token)
        user_id = int(admin_payload.get("user_id"))
    except HTTPException:
        # Backwards compatibility: allow legacy access tokens that still map to admin users.
        user_id = get_user_id_from_token(token)
    result = await db.execute(select(User).where(User.id == user_id, User.is_admin.is_(True)))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


def _require_api_key(x_admin_key: Optional[str] = Header(None, alias="X-Admin-Key")) -> None:
    """
    Optional secondary auth via X-Admin-Key header.
    If ADMIN_API_KEY is set in env, this header must match.
    Falls through silently when ADMIN_API_KEY is not configured.
    """
    configured = (settings.ADMIN_API_KEY or "").strip()
    if not configured:
        return
    if not x_admin_key or x_admin_key.strip() != configured:
        raise HTTPException(status_code=403, detail="Invalid or missing X-Admin-Key")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: Optional[datetime]) -> Optional[str]:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat().replace("+00:00", "Z")


def _risk_from_loss_ratio(lr: float) -> str:
    if lr >= 0.85:
        return "HIGH"
    if lr >= 0.65:
        return "MEDIUM"
    return "LOW"


@router.get("/analytics", response_model=AnalyticsResponse)
async def get_analytics(admin: User = Depends(get_admin_user), db: AsyncSession = Depends(get_db)):
    total_users = (await db.execute(select(func.count(User.id)))).scalar_one() or 0
    total_simulations = (await db.execute(select(func.count(Simulation.id)))).scalar_one() or 0
    total_payouts = float((await db.execute(select(func.sum(Simulation.payout)))).scalar_one() or 0.0)
    fraud_cases = (
        await db.execute(select(func.count(Simulation.id)).where(Simulation.decision == DecisionType.FRAUD))
    ).scalar_one() or 0
    approved_cases = (
        await db.execute(select(func.count(Simulation.id)).where(Simulation.decision == DecisionType.APPROVED))
    ).scalar_one() or 0
    rejected_cases = (
        await db.execute(select(func.count(Simulation.id)).where(Simulation.decision == DecisionType.REJECTED))
    ).scalar_one() or 0
    disruption_count = (
        await db.execute(
            select(func.count(Simulation.id)).where(Simulation.final_disruption.is_(True))
        )
    ).scalar_one() or 0
    disruption_rate = round(disruption_count / total_simulations * 100, 1) if total_simulations > 0 else 0.0

    log.info(
        "admin_analytics",
        engine_name="admin_route",
        decision="ok",
        reason_code="ANALYTICS",
    )
    return AnalyticsResponse(
        total_users=total_users,
        total_simulations=total_simulations,
        total_payouts=round(total_payouts, 2),
        fraud_cases=fraud_cases,
        approved_cases=approved_cases,
        rejected_cases=rejected_cases,
        disruption_rate=disruption_rate,
    )


@router.get("/users", response_model=List[UserAdminResponse])
async def get_all_users(
    admin: User = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
    skip: int = 0,
    limit: int = 50,
):
    result = await db.execute(
        select(User).options(selectinload(User.profile)).offset(skip).limit(limit)
    )
    return result.scalars().unique().all()


@router.delete("/users/{user_id}")
async def delete_user_admin(
    user_id: int,
    admin: User = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    if int(user_id) == int(admin.id):
        raise HTTPException(status_code=400, detail="You cannot delete your own admin user")

    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    # Delete dependent rows first to avoid FK violations.
    sim_ids = (await db.execute(select(Simulation.id).where(Simulation.user_id == user_id))).scalars().all()
    if sim_ids:
        await db.execute(delete(PayoutRecord).where(PayoutRecord.simulation_id.in_(sim_ids)))
        await db.execute(delete(FraudSignal).where(FraudSignal.simulation_id.in_(sim_ids)))
        await db.execute(delete(FraudFlag).where(FraudFlag.simulation_id.in_(sim_ids)))
        await db.execute(delete(Log).where(Log.user_id == user_id))
        await db.execute(delete(Simulation).where(Simulation.id.in_(sim_ids)))
    await db.execute(delete(FraudFlag).where(FraudFlag.user_id == user_id))
    await db.execute(delete(Profile).where(Profile.user_id == user_id))
    await db.execute(delete(Policy).where(Policy.user_id == user_id))
    await db.execute(delete(SupportQuery).where(SupportQuery.user_id == user_id))
    await db.execute(delete(Notification).where(Notification.user_id == user_id))
    await db.execute(delete(User).where(User.id == user_id))
    await db.commit()
    return {"ok": True, "deleted_user_id": user_id}


@router.get("/simulations")
async def get_all_simulations(
    admin: User = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
    skip: int = 0,
    limit: int = 50,
):
    limit = max(1, min(100, int(limit)))
    skip = max(0, int(skip))
    result = await db.execute(
        select(Simulation).order_by(Simulation.created_at.desc()).offset(skip).limit(limit)
    )
    sims = result.scalars().all()
    out: List[Dict[str, Any]] = []
    for s in sims:
        z = _parse_zone_from_simulation(s)
        cz = _canonicalize_zone(z)
        out.append(
            {
                "id": s.id,
                "claim_id": s.id,
                "transaction_id": _public_tx_id("TXN" if float(s.payout or 0.0) > 0 else "CLM", int(s.id)),
                "user_id": s.user_id,
                "decision": s.decision.value if hasattr(s.decision, "value") else str(s.decision),
                "status": s.decision.value if hasattr(s.decision, "value") else str(s.decision),
                "payout": s.payout,
                "fraud_score": s.fraud_score,
                "final_disruption": s.final_disruption,
                "reason": s.reason,
                "message": s.reason,
                "zone_id": cz or z,
                "created_at": s.created_at.isoformat() if s.created_at else None,
            }
        )
    return out


@router.get("/fraud-alerts")
async def get_fraud_alerts(admin: User = Depends(get_admin_user), db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Simulation)
        .where(Simulation.fraud_score >= 0.7)
        .order_by(Simulation.created_at.desc())
        .limit(20)
    )
    fraud_sims = result.scalars().all()
    return [
        {
            "id": s.id,
            "user_id": s.user_id,
            "fraud_score": s.fraud_score,
            "reason": s.reason,
            "created_at": str(s.created_at),
        }
        for s in fraud_sims
    ]


@router.get("/logs")
async def get_logs(admin: User = Depends(get_admin_user), db: AsyncSession = Depends(get_db), limit: int = 100):
    result = await db.execute(select(Log).order_by(Log.created_at.desc()).limit(limit))
    logs = result.scalars().all()
    return [
        {
            "id": l.id,
            "user_id": l.user_id,
            "event_type": l.event_type,
            "detail": l.detail,
            "created_at": str(l.created_at),
        }
        for l in logs
    ]


@router.post("/zones/{zone_id}/alerts")
async def inject_zone_alerts(
    zone_id: str,
    body: ZoneAlertsInjectBody,
    admin: User = Depends(get_admin_user),
):
    raw = [a.model_dump() for a in body.alerts]
    if body.replace:
        government_alert_store.replace_zone_alerts(zone_id, raw)
    else:
        government_alert_store.append_zone_alerts(zone_id, raw)
    log.info(
        "zone_alerts_injected",
        engine_name="admin_route",
        decision=str(len(raw)),
        reason_code="ZONE_ALERTS",
        zone_id=zone_id,
    )
    return {"zone_id": zone_id, "count": len(raw)}


@router.post("/make-admin/{user_id}")
async def make_admin(user_id: int, admin: User = Depends(get_admin_user), db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    user.is_admin = True
    await db.commit()
    log.info(
        "admin_granted",
        engine_name="admin_route",
        decision=str(user_id),
        reason_code="ADMIN_GRANT",
    )
    return {"message": f"User {user_id} is now an admin"}


@router.post("/seed")
async def run_admin_seed(
    admin: User = Depends(get_admin_user),
    _key: None = Depends(_require_api_key),
):
    await _seed_zones()
    await _seed_local_dataset()
    return {"ok": True, "message": "Database seed completed"}


@router.get("/zones/geojson")
async def get_zone_geojson(admin: User = Depends(get_admin_user), db: AsyncSession = Depends(get_db)):
    await _ensure_demo_zone_pools(db)
    pools = await _latest_pools_by_zone_raw(db)
    sims = (await db.execute(select(Simulation))).scalars().all()
    sims_sorted = sorted(
        sims,
        key=lambda s: s.created_at or datetime.min.replace(tzinfo=timezone.utc),
        reverse=True,
    )
    claims_by_zone: Dict[str, int] = {}
    last_disruption: Dict[str, str] = {}
    for s in sims:
        cz = _canonicalize_zone(_parse_zone_from_simulation(s))
        if not cz:
            continue
        claims_by_zone[cz] = claims_by_zone.get(cz, 0) + 1
    for s in sims_sorted:
        cz = _canonicalize_zone(_parse_zone_from_simulation(s))
        if not cz or cz in last_disruption:
            continue
        wd = None
        try:
            if s.weather_data:
                wd = json.loads(s.weather_data) if isinstance(s.weather_data, str) else s.weather_data
        except Exception:
            wd = None
        dt = None
        if isinstance(wd, dict):
            dt = wd.get("disruption_type") or wd.get("scenario")
        if not dt and s.reason:
            dt = s.reason[:80]
        if dt:
            last_disruption[cz] = str(dt)

    active_by_zone: Dict[str, int] = {}
    pol_rows = (
        await db.execute(
            select(Profile.city, func.count(func.distinct(Policy.user_id)))
            .select_from(Policy)
            .join(Profile, Profile.user_id == Policy.user_id)
            .where(Policy.status == "active")
            .group_by(Profile.city)
        )
    ).all()
    for city, cnt in pol_rows:
        cz = PROFILE_CITY_TO_ZONE.get(str(city).strip())
        if cz:
            active_by_zone[cz] = active_by_zone.get(cz, 0) + int(cnt or 0)

    features: List[Dict[str, Any]] = []
    for z in HYDERABAD_ZONES_GEO:
        zid = str(z["zone_id"])
        min_lon, min_lat, max_lon, max_lat = z["bbox"]
        cc = claims_by_zone.get(zid, 0)
        prow = _pool_row_for_canonical(pools, zid)
        bal = float(getattr(prow, "pool_balance_start_of_week", 0.0) or 0.0) if prow else 0.0
        util = float(getattr(prow, "utilization_pct", 0.0) or 0.0) if prow else 0.0
        # Stronger live risk signals so map doesn't stay uniformly green.
        if util >= 80 or cc >= 8:
            risk = "HIGH"
        elif util >= 55 or cc >= 3:
            risk = "MEDIUM"
        else:
            risk = "LOW"
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "zone_id": zid,
                    "zone_name": z["zone_name"],
                    "claim_count": cc,
                    "risk_level": risk,
                    "pool_balance": bal,
                    "utilization_pct": util,
                    "active_workers": int(active_by_zone.get(zid, 0)),
                    "last_disruption": last_disruption.get(zid, "—"),
                },
                "geometry": {"type": "Polygon", "coordinates": [_ring_bbox(min_lon, min_lat, max_lon, max_lat)]},
            }
        )
    return {"type": "FeatureCollection", "features": features}


@router.get("/zones/summary")
async def get_zones_summary(
    admin: User = Depends(get_admin_user),
    _key: None = Depends(_require_api_key),
    db: AsyncSession = Depends(get_db),
):
    """
    Per-zone aggregated stats using DB aggregation queries.
    No Python loops over simulation lists.
    """
    day_start, day_end = _utc_day_bounds()
    week_start = day_start - timedelta(days=day_start.weekday())

    # ── Active workers per zone (profile.zone_id) ──────────────────────────────
    active_workers_sq = (
        await db.execute(
            select(Profile.zone_id, func.count(func.distinct(Profile.user_id)).label("cnt"))
            .join(Policy, Policy.user_id == Profile.user_id)
            .where(Policy.status == "active")
            .group_by(Profile.zone_id)
        )
    ).all()
    active_workers_map: Dict[str, int] = {str(r.zone_id): int(r.cnt) for r in active_workers_sq if r.zone_id}

    # ── Active policies per zone ───────────────────────────────────────────────
    active_policies_sq = (
        await db.execute(
            select(Profile.zone_id, func.count(Policy.id).label("cnt"))
            .join(Policy, Policy.user_id == Profile.user_id)
            .where(Policy.status == "active")
            .group_by(Profile.zone_id)
        )
    ).all()
    active_policies_map: Dict[str, int] = {str(r.zone_id): int(r.cnt) for r in active_policies_sq if r.zone_id}

    # ── Claims today per zone (via ClaimLifecycle.zone_id) ────────────────────
    claims_today_sq = (
        await db.execute(
            select(ClaimLifecycle.zone_id, func.count(ClaimLifecycle.id).label("cnt"))
            .where(ClaimLifecycle.created_at >= day_start, ClaimLifecycle.created_at < day_end)
            .group_by(ClaimLifecycle.zone_id)
        )
    ).all()
    claims_today_map: Dict[str, int] = {str(r.zone_id): int(r.cnt) for r in claims_today_sq}

    # ── Payouts today per zone ─────────────────────────────────────────────────
    payouts_today_sq = (
        await db.execute(
            select(ClaimLifecycle.zone_id, func.coalesce(func.sum(ClaimLifecycle.payout_amount), 0.0).label("total"))
            .where(
                ClaimLifecycle.created_at >= day_start,
                ClaimLifecycle.created_at < day_end,
                ClaimLifecycle.status.in_(["PAYOUT", "approved"]),
            )
            .group_by(ClaimLifecycle.zone_id)
        )
    ).all()
    payouts_today_map: Dict[str, float] = {str(r.zone_id): float(r.total) for r in payouts_today_sq}

    # ── Payouts this week per zone ─────────────────────────────────────────────
    payouts_week_sq = (
        await db.execute(
            select(ClaimLifecycle.zone_id, func.coalesce(func.sum(ClaimLifecycle.payout_amount), 0.0).label("total"))
            .where(
                ClaimLifecycle.created_at >= week_start,
                ClaimLifecycle.status.in_(["PAYOUT", "approved"]),
            )
            .group_by(ClaimLifecycle.zone_id)
        )
    ).all()
    payouts_week_map: Dict[str, float] = {str(r.zone_id): float(r.total) for r in payouts_week_sq}

    # ── Latest pool balance per zone ───────────────────────────────────────────
    pools = await _latest_pools_by_zone_raw(db)

    # ── Active disruptions per zone ────────────────────────────────────────────
    disruption_sq = (
        await db.execute(
            select(DisruptionEvent.zone_id, DisruptionEvent.disruption_type, DisruptionEvent.severity)
            .where(DisruptionEvent.is_active.is_(True))
            .order_by(DisruptionEvent.severity.desc())
        )
    ).all()
    disruption_map: Dict[str, tuple] = {}
    for r in disruption_sq:
        if str(r.zone_id) not in disruption_map:
            disruption_map[str(r.zone_id)] = (r.disruption_type, float(r.severity or 0.0))

    # ── Assemble per-zone output from Zone table ───────────────────────────────
    zone_rows = (await db.execute(select(Zone))).scalars().all()
    out: List[Dict[str, Any]] = []
    for z in zone_rows:
        zid = str(z.city_code)
        pool = _pool_row_for_canonical(pools, zid) or pools.get(zid)
        loss_ratio = float(getattr(pool, "loss_ratio", 0.0) or 0.0) if pool else 0.0
        dis = disruption_map.get(zid)
        claims_today = claims_today_map.get(zid, 0)
        payouts_today = payouts_today_map.get(zid, 0.0)
        workers = active_workers_map.get(zid, 0)
        out.append({
            "zone_id": z.id,
            "zone_name": z.name,
            "city": z.city,
            "city_code": zid,
            "lat": float(getattr(z, "lat", 0.0) or 0.0),
            "lng": float(getattr(z, "lng", 0.0) or 0.0),
            "total_active_workers": workers,
            "active_workers": workers,
            "active_policies": active_policies_map.get(zid, 0),
            "claims_today": claims_today,
            "claims_count": claims_today,
            "payouts_today": round(payouts_today, 2),
            "payouts_this_week": round(payouts_week_map.get(zid, 0.0), 2),
            "avg_payout": round((float(payouts_today) / float(claims_today)) if claims_today else 0.0, 2),
            "loss_ratio": round(loss_ratio, 4),
            "current_disruption": dis[0] if dis else None,
            "disruption_severity": round(dis[1], 3) if dis else None,
            "risk_level": _risk_from_loss_ratio(loss_ratio),
        })
    return out


@router.get("/workers")
async def list_workers(
    admin: User = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
    q: str = "",
    zone: str = "",
    page: int = 1,
    page_size: int = 20,
    cursor: int | None = None,
    limit: int | None = None,
):
    page = max(1, page)
    page_size = min(max(5, page_size), 100)
    if limit is not None:
        page_size = min(max(1, int(limit)), 100)

    sim_count_sq = (
        select(Simulation.user_id.label("uid"), func.count(Simulation.id).label("sim_cnt")).group_by(Simulation.user_id)
    ).subquery()
    fraud_count_sq = (
        select(FraudSignal.user_id.label("uid"), func.count(FraudSignal.id).label("fraud_cnt")).group_by(FraudSignal.user_id)
    ).subquery()
    latest_policy_sq = (
        select(Policy.user_id.label("puid"), func.max(Policy.id).label("max_policy_id")).group_by(Policy.user_id)
    ).subquery()

    stmt = (
        select(User, Profile, sim_count_sq.c.sim_cnt, fraud_count_sq.c.fraud_cnt, Policy)
        .select_from(User)
        .join(Profile, User.id == Profile.user_id)
        .outerjoin(sim_count_sq, User.id == sim_count_sq.c.uid)
        .outerjoin(fraud_count_sq, User.id == fraud_count_sq.c.uid)
        .outerjoin(latest_policy_sq, User.id == latest_policy_sq.c.puid)
        .outerjoin(Policy, Policy.id == latest_policy_sq.c.max_policy_id)
    )
    result = await db.execute(stmt)
    raw_rows = result.all()

    def _coverage_state(pol: Policy | None) -> str:
        if pol is None:
            return "NO_COVERAGE"
        now = datetime.now(timezone.utc)
        st = str(pol.status or "").lower()
        vu = getattr(pol, "valid_until", None)
        if vu is not None and getattr(vu, "tzinfo", None) is None:
            vu = vu.replace(tzinfo=timezone.utc)
        if st == "active" and (vu is None or vu > now):
            return "ACTIVE"
        return "EXPIRED"

    rows: List[Dict[str, Any]] = []
    for u, prof, sim_cnt, fraud_cnt, pol in raw_rows:
        claims_total = int(sim_cnt or 0)
        fraud_flags = int(fraud_cnt or 0)
        weekly = float(getattr(pol, "weekly_premium", 0.0) or 0.0) if pol else 0.0
        tier = _coverage_tier_from_product(getattr(pol, "product_code", None) if pol else None)
        status = _coverage_state(pol)
        row = {
            "worker_id": u.id,
            "phone": u.phone,
            "phone_masked": _mask_phone(u.phone),
            "zone": prof.city or "—",
            "trust_score": float(prof.trust_score or 0.0),
            "coverage_tier": tier,
            "weekly_premium": weekly,
            "claims_total": claims_total,
            "claims": claims_total,
            "fraud_flags": fraud_flags,
            "status": status,
        }
        rows.append(row)

    if q:
        ql = q.lower()
        rows = [r for r in rows if ql in str(r["phone"]).lower() or ql in str(r["worker_id"])]
    if zone:
        zl = zone.lower()
        rows = [r for r in rows if zl in str(r["zone"]).lower()]

    rows = sorted(rows, key=lambda x: int(x["worker_id"]), reverse=True)
    if cursor is not None:
        rows = [r for r in rows if int(r["worker_id"]) < int(cursor)]
    total = len(rows)
    paged = rows[:page_size]
    next_cursor = str(paged[-1]["worker_id"]) if len(rows) > page_size and paged else None
    return {"data": paged, "next_cursor": next_cursor, "total_count": total, "page": page, "page_size": page_size}


@router.get("/workers/{worker_id}")
async def get_worker_detail(worker_id: int, admin: User = Depends(get_admin_user), db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(User).where(User.id == worker_id).options(selectinload(User.profile), selectinload(User.simulations))
    )
    u = result.scalar_one_or_none()
    if not u:
        raise HTTPException(status_code=404, detail="Worker not found")
    prof = u.profile
    sims = sorted(u.simulations, key=lambda x: x.id, reverse=True)
    claim_history: List[Dict[str, Any]] = []
    for s in sims:
        wd = None
        if s.weather_data:
            try:
                wd = json.loads(s.weather_data)
            except json.JSONDecodeError:
                wd = s.weather_data
        claim_history.append(
            {
                "id": s.id,
                "claim_id": s.id,
                "transaction_id": _public_tx_id("TXN" if float(s.payout or 0.0) > 0 else "CLM", int(s.id)),
                "decision": s.decision.value if hasattr(s.decision, "value") else str(s.decision),
                "payout": s.payout,
                "fraud_score": s.fraud_score,
                "fraud_flag": s.fraud_flag,
                "reason": s.reason,
                "expected_income": s.expected_income,
                "actual_income": s.actual_income,
                "loss": s.loss,
                "final_disruption": s.final_disruption,
                "weather_data": wd,
                "created_at": s.created_at.isoformat() if s.created_at else None,
            }
        )
    gps_trail: List[Dict[str, Any]] = []
    trust_score = float(getattr(prof, "trust_score", 0.0) or 0.0)
    trust_timeline_sims = (
        await db.execute(
            select(Simulation.created_at, Simulation.fraud_score)
            .where(Simulation.user_id == worker_id)
            .order_by(Simulation.created_at.asc())
            .limit(8)
        )
    ).all()
    trust_timeline: List[Dict[str, Any]] = [
        {
            "label": _iso(r.created_at),
            "score": round(max(0.0, trust_score - float(r.fraud_score or 0.0) * 10.0), 1),
        }
        for r in trust_timeline_sims
    ]

    fp_row = (await db.execute(select(DeviceFingerprint).where(DeviceFingerprint.worker_id == worker_id))).scalar_one_or_none()
    device_fingerprint: Optional[Dict[str, Any]] = None
    if fp_row:
        device_fingerprint = {
            "fingerprint_hash": fp_row.fingerprint_hash,
            "model_name": fp_row.model_name,
            "os_version": fp_row.os_version,
            "platform_api_level": fp_row.platform_api_level,
            "screen_width": fp_row.screen_width,
            "screen_height": fp_row.screen_height,
            "app_version": fp_row.app_version,
            "network_type_at_enrollment": fp_row.network_type_at_enrollment,
            "battery_level": fp_row.battery_level,
            "updated_at": fp_row.updated_at.isoformat() if fp_row.updated_at else None,
            "created_at": fp_row.created_at.isoformat() if fp_row.created_at else None,
        }

    profile_out: Dict[str, Any] = {}
    if prof:
        occ = prof.occupation
        risk = prof.risk_profile
        profile_out = {
            "name": prof.name,
            "city": prof.city,
            "occupation": occ.value if hasattr(occ, "value") else str(occ),
            "risk_profile": risk.value if hasattr(risk, "value") else str(risk),
            "avg_daily_income": prof.avg_daily_income,
            "trust_score": trust_score,
            "total_claims": prof.total_claims,
            "total_payouts": prof.total_payouts,
        }

    return {
        "worker_id": u.id,
        "phone": u.phone,
        "phone_masked": _mask_phone(u.phone),
        "profile": profile_out,
        "claim_history": claim_history,
        "gps_trail": gps_trail,
        "trust_timeline": trust_timeline,
        "device_fingerprint": device_fingerprint,
    }


@router.get("/fraud/analytics")
async def get_fraud_analytics(
    admin: User = Depends(get_admin_user),
    _key: None = Depends(_require_api_key),
    db: AsyncSession = Depends(get_db),
):
    """Real fraud analytics from DB — no mock data."""
    day_start, day_end = _utc_day_bounds()

    # Fraud score histogram from actual simulations
    sims = (
        await db.execute(
            select(Simulation.fraud_score)
            .order_by(Simulation.created_at.desc())
            .limit(2000)
        )
    ).scalars().all()
    histogram: Dict[str, int] = {}
    for score in sims:
        b = f"{int(float(score or 0) * 10) / 10:.1f}"
        histogram[b] = histogram.get(b, 0) + 1

    # Real GPS flag counts from FraudSignal reason_codes
    flag_counts_sq = (
        await db.execute(
            select(FraudSignal.reason_code, func.count(FraudSignal.id).label("cnt"))
            .group_by(FraudSignal.reason_code)
        )
    ).all()
    gps_flags = [
        {"flag": r.reason_code, "count": int(r.cnt)}
        for r in flag_counts_sq
        if r.reason_code not in ("DEMO_SIM", "POST_RUN", "CLAIMS_ENGINE", "ASSESSMENT")
    ]

    # Enrollment timeline: enrollments per hour today
    if settings.is_sqlite:
        hour_expr = func.strftime("%H", User.created_at)
    else:
        hour_expr = func.to_char(User.created_at, "HH24")
    enrollment_sq = (
        await db.execute(
            select(
                hour_expr.label("hr"),
                func.count(User.id).label("cnt"),
            )
            .where(User.created_at >= day_start, User.created_at < day_end)
            .group_by(hour_expr)
        )
    ).all()
    enrollment_by_hour: Dict[int, int] = {int(r.hr): int(r.cnt) for r in enrollment_sq if r.hr}
    enrollment_timeline = [
        {"hour": h, "enrollments": enrollment_by_hour.get(h, 0)}
        for h in range(24)
    ]

    return {
        "fraud_score_histogram": [{"bucket": k, "count": v} for k, v in sorted(histogram.items())],
        "gps_spoof_patterns": gps_flags,
        "enrollment_timeline": enrollment_timeline,
    }


@router.post("/fraud/{cluster_id}/action")
async def fraud_action(
    cluster_id: str,
    body: Dict[str, str],
    admin: User = Depends(get_admin_user),
):
    action = str(body.get("action", "")).upper()
    if action not in {"CONFIRM_FRAUD", "CLEAR_CLUSTER", "MANUAL_REVIEW"}:
        raise HTTPException(status_code=400, detail="Invalid action")
    _SIM_CLUSTER_ACTIONS[cluster_id] = action
    return {"cluster_id": cluster_id, "action": action, "ok": True}


@router.post("/simulations/run")
@limiter.limit("10/hour")
async def run_admin_simulation(
    request: Request,
    body: Dict[str, Any],
    admin: User = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    zone = str(body.get("zone_id") or "hyd_central")
    disruption_type = str(body.get("disruption_type") or "Heavy Rain")
    workers = int(body.get("workers", 10))
    fraud_scenario = str(body.get("fraud_scenario") or "none")
    disruption_hours = float(body.get("disruption_hours", 3.0))
    severity = float(body.get("severity", 0.7))
    created = []
    users = (await db.execute(select(User).limit(max(1, min(25, workers))))).scalars().all()
    for idx, u in enumerate(users):
        fraud_score = 0.85 if fraud_scenario == "ring_fraud" else (0.75 if fraud_scenario == "gps_spoof" else 0.2)
        no_disruption = (idx % 3) == 2 and fraud_scenario == "none"
        decision = DecisionType.FRAUD if fraud_score > 0.8 else (DecisionType.REJECTED if no_disruption else DecisionType.APPROVED)

        payout = 0.0
        expected_loss = 0.0
        if decision == DecisionType.APPROVED:
            try:
                prof = (await db.execute(select(Profile).where(Profile.user_id == u.id))).scalar_one_or_none()
                if prof:
                    from app.engines.payout_engine import PayoutEngine
                    _payout, _breakdown, _ = await PayoutEngine.compute_db_payout(
                        db=db,
                        user_id=u.id,
                        profile=prof,
                        zone_id=zone,
                        disruption_hours=disruption_hours,
                        severity=severity,
                        simulation_id=None,
                        disruption_type=disruption_type,
                    )
                    payout = _payout
                    expected_loss = float(_breakdown.get("expected_loss", 0.0))
            except Exception:
                payout = 0.0
                expected_loss = 0.0

        sim = Simulation(
            user_id=u.id,
            is_active=True,
            fraud_flag=fraud_score > 0.7,
            fraud_score=fraud_score,
            weather_disruption=True,
            traffic_disruption=False,
            event_disruption=False,
            final_disruption=not no_disruption,
            expected_income=expected_loss or 900.0,
            actual_income=0.0 if decision == DecisionType.APPROVED else (expected_loss or 900.0),
            loss=expected_loss or 0.0,
            payout=payout,
            decision=decision,
            reason=(f"{disruption_type} in {zone}" if decision == DecisionType.APPROVED else f"No disruption in {zone}"),
            weather_data=json.dumps({"zone": zone, "disruption_type": disruption_type}),
        )
        db.add(sim)
        created.append(sim)
    await db.flush()
    # Now persist PayoutRecords with real simulation IDs
    for sim in created:
        if sim.payout and float(sim.payout) > 0:
            from app.models.payout import PayoutRecord as _PR
            db.add(_PR(simulation_id=sim.id, amount=float(sim.payout), currency="INR", status="completed"))
    await db.commit()
    return {"ok": True, "created_count": len(created), "zone_id": zone, "fraud_scenario": fraud_scenario}


@router.get("/kpis")
async def get_dashboard_kpis(admin: User = Depends(get_admin_user), db: AsyncSession = Depends(get_db)):
    await _ensure_demo_zone_pools(db)
    start, end = _utc_day_bounds()

    active_workers = (
        await db.execute(select(func.count(Policy.id)).where(Policy.status == "active"))
    ).scalar_one() or 0

    claims_today = (
        await db.execute(
            select(func.count(Simulation.id)).where(Simulation.created_at >= start, Simulation.created_at < end)
        )
    ).scalar_one() or 0

    fraud_blocked = (
        await db.execute(
            select(func.count(Simulation.id)).where(
                Simulation.created_at >= start,
                Simulation.created_at < end,
                Simulation.decision.in_([DecisionType.FRAUD, DecisionType.REJECTED]),
            )
        )
    ).scalar_one() or 0

    today_sims_count = (
        await db.execute(
            select(func.count(Simulation.id)).where(Simulation.created_at >= start, Simulation.created_at < end)
        )
    ).scalar_one() or 0
    today_approved = (
        await db.execute(
            select(func.count(Simulation.id)).where(
                Simulation.created_at >= start,
                Simulation.created_at < end,
                Simulation.decision == DecisionType.APPROVED,
            )
        )
    ).scalar_one() or 0
    if today_sims_count > 0:
        approval_rate_pct = round(today_approved / today_sims_count * 100, 1)
    else:
        total_s = (await db.execute(select(func.count(Simulation.id)))).scalar_one() or 0
        appr = (await db.execute(select(func.count(Simulation.id)).where(Simulation.decision == DecisionType.APPROVED))).scalar_one() or 0
        approval_rate_pct = round((appr / total_s * 100) if total_s else 0.0, 1)

    pools_map = await _latest_pools_by_zone_raw(db)
    ratios: List[float] = []
    pooled_total = 0.0
    paid_total = 0.0
    for z in HYDERABAD_ZONES_GEO:
        zid = str(z["zone_id"])
        p = _pool_row_for_canonical(pools_map, zid)
        if not p:
            continue
        bal = float(p.pool_balance_start_of_week or 0.0)
        pay = float(p.total_payouts_this_week or 0.0)
        pooled_total += bal
        paid_total += pay
        if bal > 0:
            ratios.append(pay / bal)
    pool_utilization_pct = round(sum(ratios) / len(ratios) * 100.0, 1) if ratios else 0.0

    util_for_risk = pool_utilization_pct / 100.0 if pool_utilization_pct else 0.0
    if util_for_risk >= 0.8:
        pool_risk_level = "HIGH"
    elif util_for_risk >= 0.5:
        pool_risk_level = "MEDIUM"
    else:
        pool_risk_level = "LOW"

    disruption_count = (
        await db.execute(select(func.count(Simulation.id)).where(Simulation.final_disruption.is_(True)))
    ).scalar_one() or 0
    total_sim = (await db.execute(select(func.count(Simulation.id)))).scalar_one() or 0
    disruption_rate = round(disruption_count / total_sim * 100, 1) if total_sim else 0.0

    return {
        "active_workers": int(active_workers),
        "claims_today": int(claims_today),
        "approval_rate_pct": float(approval_rate_pct),
        "fraud_blocked": int(fraud_blocked),
        "pool_utilization_pct": float(pool_utilization_pct),
        "pool_risk_level": pool_risk_level,
        "loss_ratio_actual_pct": round(paid_total / pooled_total * 100.0, 1) if pooled_total > 0 else 0.0,
        "loss_ratio_target_low": 60,
        "loss_ratio_target_high": 75,
        "pooled_total_amount": round(pooled_total, 2),
        "paid_total_amount": round(paid_total, 2),
    }


@router.get("/stats")
async def get_dashboard_stats(admin: User = Depends(get_admin_user), db: AsyncSession = Depends(get_db)):
    kpis = await get_dashboard_kpis(admin=admin, db=db)
    now = datetime.now(timezone.utc)
    week_start = now.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=now.weekday())
    week_premiums = (
        await db.execute(
            select(func.coalesce(func.sum(Policy.weekly_premium), 0.0)).where(
                Policy.status == "active",
                Policy.created_at >= week_start,
            )
        )
    ).scalar_one() or 0.0
    return {
        "active_workers_this_week": int(kpis.get("active_workers", 0)),
        "claims_today": int(kpis.get("claims_today", 0)),
        "fraud_blocked_today": int(kpis.get("fraud_blocked", 0)),
        "pool_utilization_pct": float(kpis.get("pool_utilization_pct", 0.0)),
        "total_premiums_collected_this_week": round(float(week_premiums), 2),
    }


@router.get("/earnings-dna-analytics")
async def get_earnings_dna_analytics(
    days: int = 14,
    admin: User = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    """Cross-worker peak hours (IST) and average expected vs actual income from simulations."""
    days = max(1, min(60, int(days)))
    since = datetime.now(timezone.utc) - timedelta(days=days)
    sims = (
        (
            await db.execute(
                select(Simulation).where(Simulation.created_at >= since).order_by(Simulation.created_at.desc()).limit(8000)
            )
        )
        .scalars()
        .all()
    )
    return admin_aggregate_earnings_analytics(sims, days=days)


@router.get("/weekly-earnings")
async def get_weekly_earnings(
    days: int = 7,
    admin: User = Depends(get_admin_user),
    _key: None = Depends(_require_api_key),
    db: AsyncSession = Depends(get_db),
):
    """Real weekly payout breakdown from PayoutRecord table."""
    days = max(1, min(14, days))
    since = _utcnow() - timedelta(days=days)

    rows = (
        await db.execute(
            select(
                func.date(PayoutRecord.created_at).label("day"),
                func.sum(PayoutRecord.amount).label("total"),
            )
            .where(PayoutRecord.created_at >= since, PayoutRecord.status == "completed")
            .group_by(func.date(PayoutRecord.created_at))
            .order_by(func.date(PayoutRecord.created_at))
        )
    ).all()

    breakdown = [
        {"day": str(r.day), "protected_amount": round(float(r.total or 0.0), 2)}
        for r in rows
    ]
    total = round(sum(r["protected_amount"] for r in breakdown), 2)
    return {"protected_this_week": total, "breakdown": breakdown}


@router.get("/support/queries")
async def list_support_queries(
    status: str | None = None,
    priority: str | None = None,
    category: str | None = None,
    sort: str = "score_desc",
    admin: User = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    stmt = (
        select(SupportQuery)
        .where(or_(SupportQuery.query_type == "custom", SupportQuery.query_type == "ticket"))
    )
    if status in {"open", "resolved"}:
        stmt = stmt.where(SupportQuery.status == status)
    p = str(priority or "").upper()
    if p in {"HIGH", "MEDIUM", "LOW"}:
        stmt = stmt.where(SupportQuery.priority == p)
    c = str(category or "").strip().lower()
    if c in {"payment", "safety", "weather", "technical", "other"}:
        stmt = stmt.where(SupportQuery.category == c)
    if str(sort).lower() == "created_desc":
        stmt = stmt.order_by(SupportQuery.created_at.desc(), SupportQuery.id.desc())
    else:
        stmt = stmt.order_by(SupportQuery.score.desc(), SupportQuery.created_at.desc(), SupportQuery.id.desc())
    stmt = stmt.limit(500)
    rows = (await db.execute(stmt)).scalars().all()
    return [
        {
            "id": r.id,
            "user_id": r.user_id,
            "message": r.message,
            "reply": r.system_response,
            "admin_reply": r.admin_reply,
            "status": r.status,
            "query_type": r.query_type,
            "priority": getattr(r, "priority", "LOW"),
            "category": getattr(r, "category", "other"),
            "score": int(getattr(r, "score", 0) or 0),
            "reason": getattr(r, "reason", ""),
            "ticket_no": f"TKT-{int(r.id):06d}" if str(r.query_type) == "ticket" else None,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]


@router.post("/support/reply")
async def admin_support_reply(
    body: Dict[str, Any],
    admin: User = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    qid = int(body.get("query_id") or 0)
    text = str(body.get("admin_reply") or "").strip()
    if qid <= 0 or not text:
        raise HTTPException(status_code=400, detail="query_id and admin_reply are required")
    row = (await db.execute(select(SupportQuery).where(SupportQuery.id == qid))).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Support query not found")
    row.admin_reply = text
    row.status = "resolved"
    await create_notification(
        db,
        user_id=row.user_id,
        ntype="admin_reply",
        title="Admin replied",
        message=text,
    )
    await db.commit()
    return {"ok": True, "query_id": row.id, "status": row.status}


# ═══════════════════════════════════════════════════════════════════════════════
# NEW PRODUCTION ADMIN ENDPOINTS (all DB-backed, no mock data)
# ═══════════════════════════════════════════════════════════════════════════════

@router.get("/claims/live")
async def get_live_claims(
    admin: User = Depends(get_admin_user),
    _key: None = Depends(_require_api_key),
    db: AsyncSession = Depends(get_db),
    zone_id: Optional[str] = None,
    disruption_type: Optional[str] = None,
    page: int = 1,
    limit: int = 20,
):
    """Paginated live claim feed from ClaimLifecycle + Simulation join."""
    page = max(1, page)
    limit = max(1, min(100, limit))
    offset = (page - 1) * limit

    stmt = (
        select(
            ClaimLifecycle.id.label("claim_id"),
            ClaimLifecycle.user_id,
            Profile.name.label("worker_name"),
            ClaimLifecycle.zone_id,
            ClaimLifecycle.disruption_type,
            ClaimLifecycle.status,
            ClaimLifecycle.payout_amount,
            ClaimLifecycle.created_at,
        )
        .join(Profile, Profile.user_id == ClaimLifecycle.user_id)
        .order_by(ClaimLifecycle.created_at.desc())
    )
    if zone_id:
        stmt = stmt.where(ClaimLifecycle.zone_id == zone_id)
    if disruption_type:
        stmt = stmt.where(ClaimLifecycle.disruption_type == disruption_type)

    total_stmt = select(func.count(ClaimLifecycle.id))
    if zone_id:
        total_stmt = total_stmt.where(ClaimLifecycle.zone_id == zone_id)
    if disruption_type:
        total_stmt = total_stmt.where(ClaimLifecycle.disruption_type == disruption_type)

    total = (await db.execute(total_stmt)).scalar_one() or 0
    rows = (await db.execute(stmt.offset(offset).limit(limit))).all()

    # Fetch latest fraud_score per user in one query
    user_ids = list({r.user_id for r in rows})
    fraud_scores: Dict[int, float] = {}
    if user_ids:
        fs_rows = (
            await db.execute(
                select(Simulation.user_id, func.max(Simulation.fraud_score).label("fs"))
                .where(Simulation.user_id.in_(user_ids))
                .group_by(Simulation.user_id)
            )
        ).all()
        fraud_scores = {int(r.user_id): float(r.fs or 0.0) for r in fs_rows}

    # Zone name lookup
    zone_names: Dict[str, str] = {}
    zone_rows = (await db.execute(select(Zone.city_code, Zone.name))).all()
    for zr in zone_rows:
        zone_names[str(zr.city_code)] = str(zr.name)

    data = []
    for r in rows:
        data.append({
            "claim_id": int(r.claim_id),
            "worker_name": str(r.worker_name or "Worker"),
            "zone_name": zone_names.get(str(r.zone_id or ""), str(r.zone_id or "")),
            "disruption_type": str(r.disruption_type or ""),
            "confidence": "HIGH",
            "fraud_score": round(fraud_scores.get(int(r.user_id), 0.0), 3),
            "final_payout": round(float(r.payout_amount or 0.0), 2),
            "status": str(r.status or ""),
            "created_at": _iso(r.created_at),
        })

    return {"data": data, "page": page, "limit": limit, "total_count": int(total)}


@router.post("/run-weekly-pricing")
async def admin_run_weekly_pricing(
    request: Request,
    admin: User = Depends(get_admin_user),
    _key: None = Depends(_require_api_key),
    db: AsyncSession = Depends(get_db),
):
    """Manual trigger for Monday actuarial job (demo / operations)."""
    shields = getattr(request.app.state, "forecast_shields", None)
    out = await run_full_weekly_pricing(db, redis=getattr(request.app.state, "redis", None))
    await persist_pool_health_snapshot(db, shields if isinstance(shields, dict) else None)
    return out


@router.get("/claims/{claim_id}/receipt")
async def admin_download_claim_receipt(
    claim_id: int,
    admin: User = Depends(get_admin_user),
    _key: None = Depends(_require_api_key),
    db: AsyncSession = Depends(get_db),
):
    try:
        pdf = await build_income_loss_receipt_pdf(
            db, claim_id=int(claim_id), requester_user_id=int(admin.id), is_admin=True
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="safenet-receipt-{claim_id}.pdf"'},
    )


@router.get("/pool/stats")
async def get_pool_stats(
    request: Request,
    admin: User = Depends(get_admin_user),
    _key: None = Depends(_require_api_key),
    db: AsyncSession = Depends(get_db),
):
    """Financial health of all zone pools from ZonePoolBalance table."""
    pools = await _latest_pools_by_zone_raw(db)
    zone_rows = (await db.execute(select(Zone))).scalars().all()
    zone_name_map = {str(z.city_code): z.name for z in zone_rows}

    total_premiums = 0.0
    total_payouts = 0.0
    zone_breakdown: List[Dict[str, Any]] = []

    for zone_id, pool in pools.items():
        premiums = float(pool.total_premiums_collected or 0.0)
        payouts = float(pool.total_payouts_disbursed or 0.0)
        balance = float(pool.current_balance or 0.0)
        lr = float(pool.loss_ratio or 0.0)
        total_premiums += premiums
        total_payouts += payouts
        zone_breakdown.append({
            "zone_id": zone_id,
            "zone_name": zone_name_map.get(zone_id, zone_id),
            "total_premiums_collected": round(premiums, 2),
            "total_payouts_disbursed": round(payouts, 2),
            "current_balance": round(balance, 2),
            "loss_ratio": round(lr, 4),
            "risk_level": _risk_from_loss_ratio(lr),
            "flagged_reinsurance": bool(pool.flagged_reinsurance),
        })

    overall_lr = round(total_payouts / total_premiums, 4) if total_premiums > 0 else 0.0
    if overall_lr >= 0.85:
        status = "critical"
    elif overall_lr >= 0.70:
        status = "stressed"
    else:
        status = "healthy"

    shields = getattr(request.app.state, "forecast_shields", None)
    health = await compute_pool_health_payload(db, shields if isinstance(shields, dict) else None)

    return {
        "total_premiums_all_zones": round(total_premiums, 2),
        "total_payouts_all_zones": round(total_payouts, 2),
        "overall_loss_ratio": overall_lr,
        "target_loss_ratio": 0.70,
        "status": status,
        "zones": zone_breakdown,
        **health,
    }


@router.get("/fraud/signals")
async def get_fraud_signals(
    admin: User = Depends(get_admin_user),
    _key: None = Depends(_require_api_key),
    db: AsyncSession = Depends(get_db),
):
    """Fraud insights: flags today, suspicious workers, zone clusters."""
    day_start, day_end = _utc_day_bounds()

    # Flags today
    flags_today = (
        await db.execute(
            select(func.count(FraudFlag.id))
            .where(FraudFlag.created_at >= day_start, FraudFlag.created_at < day_end)
        )
    ).scalar_one() or 0

    # Suspicious workers: fraud_score >= 0.5, last 7 days
    week_ago = _utcnow() - timedelta(days=7)
    suspicious_sq = (
        await db.execute(
            select(
                Simulation.user_id,
                func.max(Simulation.fraud_score).label("max_score"),
                func.count(Simulation.id).label("claim_cnt"),
            )
            .where(
                Simulation.fraud_score >= 0.5,
                Simulation.created_at >= week_ago,
            )
            .group_by(Simulation.user_id)
            .order_by(func.max(Simulation.fraud_score).desc())
            .limit(20)
        )
    ).all()

    # Collect flag types per worker
    worker_ids = [r.user_id for r in suspicious_sq]
    flag_types_sq: Dict[int, List[str]] = {}
    if worker_ids:
        ft_rows = (
            await db.execute(
                select(FraudFlag.user_id, FraudFlag.flag_type)
                .where(FraudFlag.user_id.in_(worker_ids))
                .order_by(FraudFlag.created_at.desc())
            )
        ).all()
        for r in ft_rows:
            flag_types_sq.setdefault(int(r.user_id), []).append(str(r.flag_type))

    suspicious_workers = [
        {
            "worker_id": int(r.user_id),
            "fraud_score": round(float(r.max_score or 0.0), 3),
            "claim_count": int(r.claim_cnt),
            "flag_types": list(set(flag_types_sq.get(int(r.user_id), []))),
        }
        for r in suspicious_sq
    ]

    # Zone clusters: zones where claim count in last 1h > 8 (possible mass fraud)
    one_hour_ago = _utcnow() - timedelta(hours=1)
    cluster_sq = (
        await db.execute(
            select(
                ClaimLifecycle.zone_id,
                func.count(ClaimLifecycle.id).label("cnt"),
            )
            .where(ClaimLifecycle.created_at >= one_hour_ago)
            .group_by(ClaimLifecycle.zone_id)
            .having(func.count(ClaimLifecycle.id) > 8)
        )
    ).all()
    zone_clusters = [
        {"zone_id": str(r.zone_id), "claim_count_last_1h": int(r.cnt)}
        for r in cluster_sq
    ]

    return {
        "flags_today": int(flags_today),
        "suspicious_workers": suspicious_workers,
        "zone_clusters": zone_clusters,
    }


@router.get("/disruptions/active")
async def get_active_disruptions_detail(
    admin: User = Depends(get_admin_user),
    _key: None = Depends(_require_api_key),
    db: AsyncSession = Depends(get_db),
):
    """Active DisruptionEvents with zone name and workers_affected count."""
    active_events = (
        await db.execute(
            select(DisruptionEvent)
            .where(DisruptionEvent.is_active.is_(True))
            .order_by(DisruptionEvent.started_at.desc())
        )
    ).scalars().all()

    zone_name_map: Dict[str, str] = {}
    zone_rows = (await db.execute(select(Zone.city_code, Zone.name))).all()
    for zr in zone_rows:
        zone_name_map[str(zr.city_code)] = str(zr.name)

    # Workers affected = active policy holders in each disrupted zone
    affected_sq = (
        await db.execute(
            select(Profile.zone_id, func.count(func.distinct(Profile.user_id)).label("cnt"))
            .join(Policy, Policy.user_id == Profile.user_id)
            .where(Policy.status == "active")
            .group_by(Profile.zone_id)
        )
    ).all()
    affected_map: Dict[str, int] = {str(r.zone_id): int(r.cnt) for r in affected_sq if r.zone_id}

    return [
        {
            "event_id": e.id,
            "zone_id": e.zone_id,
            "zone_name": zone_name_map.get(str(e.zone_id), str(e.zone_id)),
            "disruption_type": e.disruption_type,
            "severity": round(float(e.severity or 0.0), 3),
            "confidence": e.confidence,
            "api_source": e.api_source,
            "raw_value": e.raw_value,
            "workers_affected": affected_map.get(str(e.zone_id), 0),
            "started_at": _iso(e.started_at),
            "ended_at": _iso(e.ended_at),
        }
        for e in active_events
    ]


@router.get("/payouts/monitor")
async def get_payout_monitor(
    admin: User = Depends(get_admin_user),
    _key: None = Depends(_require_api_key),
    db: AsyncSession = Depends(get_db),
):
    """Payout queue status: pending, failed, disbursed today."""
    day_start, day_end = _utc_day_bounds()

    pending_count = (
        await db.execute(
            select(func.count(PayoutRecord.id)).where(PayoutRecord.status == "pending")
        )
    ).scalar_one() or 0

    pending_amount = (
        await db.execute(
            select(func.coalesce(func.sum(PayoutRecord.amount), 0.0))
            .where(PayoutRecord.status == "pending")
        )
    ).scalar_one() or 0.0

    failed_count = (
        await db.execute(
            select(func.count(PayoutRecord.id)).where(PayoutRecord.status == "failed")
        )
    ).scalar_one() or 0

    disbursed_today = (
        await db.execute(
            select(func.coalesce(func.sum(PayoutRecord.amount), 0.0))
            .where(
                PayoutRecord.status == "completed",
                PayoutRecord.created_at >= day_start,
                PayoutRecord.created_at < day_end,
            )
        )
    ).scalar_one() or 0.0

    disbursed_count_today = (
        await db.execute(
            select(func.count(PayoutRecord.id))
            .where(
                PayoutRecord.status == "completed",
                PayoutRecord.created_at >= day_start,
                PayoutRecord.created_at < day_end,
            )
        )
    ).scalar_one() or 0

    # Recent pending payouts detail
    pending_rows = (
        await db.execute(
            select(PayoutRecord)
            .where(PayoutRecord.status == "pending")
            .order_by(PayoutRecord.created_at.desc())
            .limit(20)
        )
    ).scalars().all()

    return {
        "pending_count": int(pending_count),
        "pending_amount": round(float(pending_amount), 2),
        "failed_count": int(failed_count),
        "disbursed_today": round(float(disbursed_today), 2),
        "disbursed_count_today": int(disbursed_count_today),
        "pending_queue": [
            {
                "payout_id": p.id,
                "simulation_id": p.simulation_id,
                "amount": round(float(p.amount or 0.0), 2),
                "created_at": _iso(p.created_at),
            }
            for p in pending_rows
        ],
    }


@router.get("/disruptions")
async def list_active_disruptions(
    admin: User = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
    active_only: bool = True,
):
    """
    Returns all DisruptionEvent rows, optionally filtered to active only.
    Used by admin dashboard to monitor live zone disruptions.
    """
    stmt = select(DisruptionEvent).order_by(DisruptionEvent.started_at.desc()).limit(200)
    if active_only:
        stmt = stmt.where(DisruptionEvent.is_active.is_(True))
    rows = (await db.execute(stmt)).scalars().all()

    def _iso(dt: Optional[datetime]) -> Optional[str]:
        if dt is None:
            return None
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.isoformat().replace("+00:00", "Z")

    return [
        {
            "id": r.id,
            "zone_id": r.zone_id,
            "disruption_type": r.disruption_type,
            "severity": round(float(r.severity or 0.0), 3),
            "confidence": r.confidence,
            "api_source": r.api_source,
            "raw_value": r.raw_value,
            "threshold_value": r.threshold_value,
            "is_active": r.is_active,
            "started_at": _iso(r.started_at),
            "ended_at": _iso(r.ended_at),
        }
        for r in rows
    ]


@router.post("/disruptions/{event_id}/expire")
async def expire_disruption_event(
    event_id: int,
    admin: User = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Manually expire a DisruptionEvent (admin override).
    Sets is_active=False and ended_at=now.
    """
    row = (await db.execute(select(DisruptionEvent).where(DisruptionEvent.id == event_id))).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="DisruptionEvent not found")
    if not row.is_active:
        return {"ok": True, "already_expired": True, "event_id": event_id}
    row.is_active = False
    row.ended_at = datetime.now(timezone.utc)
    await db.commit()
    log.info(
        "disruption_manually_expired",
        engine_name="admin_route",
        reason_code="ADMIN_EXPIRE",
        event_id=event_id,
        admin_id=admin.id,
    )
    return {"ok": True, "event_id": event_id, "ended_at": row.ended_at.isoformat()}


@router.get("/claims/export")
async def export_claims_csv(
    format: str = "csv",
    week: str = "current",
    admin: User = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    if format.lower() != "csv":
        raise HTTPException(status_code=400, detail="Only csv format is supported")
    now = datetime.now(timezone.utc)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=now.weekday())
    end = start + timedelta(days=7)
    if week != "current":
        raise HTTPException(status_code=400, detail="Only week=current is supported")
    rows = (
        await db.execute(
            select(ClaimLifecycle, Profile.name)
            .join(Profile, Profile.user_id == ClaimLifecycle.user_id)
            .where(ClaimLifecycle.created_at >= start, ClaimLifecycle.created_at < end)
            .order_by(ClaimLifecycle.created_at.desc())
        )
    ).all()
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(["claim_id", "worker_name", "zone_id", "disruption_type", "status", "payout_amount", "created_at"])
    for c, name in rows:
        writer.writerow([
            c.claim_id,
            name or "Worker",
            c.zone_id,
            c.disruption_type or "",
            c.status,
            round(float(c.payout_amount or 0.0), 2),
            _iso(c.created_at) or "",
        ])
    out.seek(0)
    return StreamingResponse(
        iter([out.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=claims_current_week.csv"},
    )


@router.get("/risk/forecast")
async def get_risk_forecast(
    admin: User = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    zones = (await db.execute(select(Zone))).scalars().all()
    if not zones:
        return {"items": []}
    key = (settings.OPENWEATHER_API_KEY or "").strip()
    items: List[Dict[str, Any]] = []
    async with httpx.AsyncClient(timeout=10.0) as client:
        for z in zones[:8]:
            rain_prob = 0.0
            risk = "LOW"
            reserve = 0.0
            forecast_day = "N/A"
            if key:
                try:
                    resp = await client.get(
                        "https://api.openweathermap.org/data/2.5/forecast",
                        params={"lat": z.lat, "lon": z.lng, "appid": key, "units": "metric"},
                    )
                    if resp.status_code == 200:
                        data = resp.json()
                        best = None
                        for p in data.get("list", []):
                            pop = float(p.get("pop", 0.0) or 0.0)
                            if best is None or pop > best[0]:
                                best = (pop, p.get("dt_txt", "N/A"))
                        if best:
                            rain_prob = round(best[0] * 100.0, 1)
                            forecast_day = str(best[1])
                except Exception:
                    pass
            if rain_prob >= 75:
                risk = "HIGH"
            elif rain_prob >= 45:
                risk = "MEDIUM"
            workers = (
                await db.execute(
                    select(func.count(Profile.id)).where(Profile.zone_id == z.city_code)
                )
            ).scalar_one() or 0
            est_claims = int(max(1, round(workers * (0.35 if risk == "HIGH" else 0.18 if risk == "MEDIUM" else 0.08))))
            reserve = round(est_claims * 620.0, 2)
            items.append({
                "zone_id": z.city_code,
                "zone_name": z.name,
                "forecast_day": forecast_day,
                "rain_probability_pct": rain_prob,
                "risk": risk,
                "estimated_claims": est_claims,
                "estimated_reserve": reserve,
                "headline": f"{forecast_day} {risk} risk (rain {int(round(rain_prob))}% probability) — prepare ₹{int(round(reserve))} reserve",
            })
    return {"items": items}
