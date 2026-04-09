import json
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.security import get_user_id_from_token, verify_admin_token
from app.core.rate_limit import limiter
from app.db.session import get_db
from app.models.claim import DecisionType, Log, Simulation
from app.models.device_fingerprint import DeviceFingerprint
from app.models.fraud import FraudSignal
from app.models.notification import Notification
from app.models.payout import PayoutRecord
from app.models.support import SupportQuery
from app.models.pool_balance import ZonePoolBalance
from app.models.policy import Policy
from app.models.worker import Profile, User
from app.services.notification_service import create_notification
from app.schemas.admin import AnalyticsResponse, UserAdminResponse, ZoneAlertsInjectBody
from app.services.earnings_dna_service import admin_aggregate_earnings_analytics
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


async def _ensure_demo_zone_pools(db: AsyncSession) -> None:
    pools = await _latest_pools_by_zone_raw(db)
    now = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    random.seed(42)
    added = 0
    for z in HYDERABAD_ZONES_GEO:
        zid = str(z["zone_id"])
        if _pool_row_for_canonical(pools, zid) is not None:
            continue
        bal = float(random.randint(85_000, 115_000))
        util = round(random.uniform(45.0, 72.0), 1)
        payouts = round(bal * (util / 100.0), 2)
        row = ZonePoolBalance(
            zone_id=zid,
            week_start=now,
            pool_balance_start_of_week=bal,
            total_payouts_this_week=payouts,
            utilization_pct=util,
            flagged_reinsurance=util > 68.0,
            risk_note=f"{z['zone_name']} auto-seeded",
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
        await db.execute(delete(Log).where(Log.user_id == user_id))
        await db.execute(delete(Simulation).where(Simulation.id.in_(sim_ids)))
    await db.execute(delete(DeviceFingerprint).where(DeviceFingerprint.user_id == user_id))
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
async def get_zones_summary(admin: User = Depends(get_admin_user), db: AsyncSession = Depends(get_db)):
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

    out: List[Dict[str, Any]] = []
    for z in HYDERABAD_ZONES_GEO:
        zid = str(z["zone_id"])
        min_lon, min_lat, max_lon, max_lat = z["bbox"]
        lat = (min_lat + max_lat) / 2.0
        lon = (min_lon + max_lon) / 2.0
        cc = claims_by_zone.get(zid, 0)
        prow = _pool_row_for_canonical(pools, zid)
        util = float(getattr(prow, "utilization_pct", 0.0) or 0.0) if prow else 0.0
        bal = float(getattr(prow, "pool_balance_start_of_week", 0.0) or 0.0) if prow else 0.0
        out.append(
            {
                "zone_id": zid,
                "city": z["zone_name"],
                "active_workers": int(active_by_zone.get(zid, 0)),
                "pool_balance": bal,
                "utilization_pct": util,
                "last_disruption": last_disruption.get(zid, "—"),
                "claim_density_per_hr": cc,
                "lat": lat,
                "lon": lon,
            }
        )
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
    gps_trail = [
        {"lat": 17.385 + i * 0.002, "lon": 78.4867 + i * 0.002, "timestamp": datetime.now(timezone.utc).isoformat()}
        for i in range(8)
    ]
    trust_score = float(getattr(prof, "trust_score", 0.0) or 0.0)
    trust_timeline = [{"label": f"W-{i}", "score": max(0.0, trust_score - i * 2.0)} for i in range(8)][::-1]

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
async def get_fraud_analytics(admin: User = Depends(get_admin_user), db: AsyncSession = Depends(get_db)):
    sims = (
        await db.execute(select(Simulation).order_by(Simulation.created_at.desc()).limit(500))
    ).scalars().all()
    histogram: Dict[str, int] = {}
    for s in sims:
        b = f"{int((s.fraud_score or 0) * 10) / 10:.1f}"
        histogram[b] = histogram.get(b, 0) + 1
    return {
        "fraud_score_histogram": [{"bucket": k, "count": v} for k, v in sorted(histogram.items())],
        "gps_spoof_patterns": [
            {"flag": "teleport_flag", "count": random.randint(5, 40)},
            {"flag": "static_spoof_flag", "count": random.randint(5, 40)},
            {"flag": "tower_mismatch_flag", "count": random.randint(5, 40)},
            {"flag": "gap_flag", "count": random.randint(5, 40)},
        ],
        "enrollment_timeline": [
            {"hour": h, "enrollments": random.randint(1, 25), "weather_alert": random.choice([0, 1])}
            for h in range(24)
        ],
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
    created = []
    users = (await db.execute(select(User).limit(max(1, min(25, workers))))).scalars().all()
    for idx, u in enumerate(users):
        fraud_score = 0.85 if fraud_scenario == "ring_fraud" else (0.75 if fraud_scenario == "gps_spoof" else 0.2)
        no_disruption = (idx % 3) == 2 and fraud_scenario == "none"
        decision = DecisionType.FRAUD if fraud_score > 0.8 else (DecisionType.REJECTED if no_disruption else DecisionType.APPROVED)
        base = 120 + ((u.id * 37) % 340)
        payout = 0.0 if decision != DecisionType.APPROVED else float(min(700, base))
        sim = Simulation(
            user_id=u.id,
            is_active=True,
            fraud_flag=fraud_score > 0.7,
            fraud_score=fraud_score,
            weather_disruption=True,
            traffic_disruption=False,
            event_disruption=False,
            final_disruption=not no_disruption,
            expected_income=900,
            actual_income=500 if decision == DecisionType.APPROVED else 900,
            loss=400 if decision == DecisionType.APPROVED else 0,
            payout=payout,
            decision=decision,
            reason=(f"{disruption_type} in {zone}" if decision == DecisionType.APPROVED else f"No disruption in {zone}"),
            weather_data=json.dumps({"zone": zone, "disruption_type": disruption_type}),
        )
        db.add(sim)
        created.append(sim)
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

    today_sims = (
        await db.execute(
            select(Simulation).where(Simulation.created_at >= start, Simulation.created_at < end)
        )
    ).scalars().all()
    if today_sims:
        approved = sum(1 for s in today_sims if s.decision == DecisionType.APPROVED)
        approval_rate_pct = round(approved / len(today_sims) * 100, 1)
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
        "loss_ratio_actual_pct": round(60 + (disruption_rate / 100) * 15, 1),
        "loss_ratio_target_low": 60,
        "loss_ratio_target_high": 75,
        "pooled_total_amount": round(pooled_total, 2),
        "paid_total_amount": round(paid_total, 2),
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
async def get_weekly_earnings(days: int = 7, admin: User = Depends(get_admin_user)):
    days = max(1, min(14, days))
    today = datetime.now(timezone.utc).date()
    breakdown = []
    total = 0.0
    reasons = ["Heavy Rain", "Extreme Heat", "AQI Spike", "Curfew", "Platform Outage"]
    for i in range(days):
        d = today - timedelta(days=i)
        amt = float(random.randint(50, 600))
        total += amt
        breakdown.append({"day": d.isoformat(), "protected_amount": amt, "reason": random.choice(reasons)})
    return {"protected_this_week": round(total, 2), "breakdown": list(reversed(breakdown))}


@router.get("/support/queries")
async def list_support_queries(
    status: str | None = None,
    admin: User = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    stmt = (
        select(SupportQuery)
        .where(or_(SupportQuery.query_type == "custom", SupportQuery.query_type == "ticket"))
        .order_by(SupportQuery.created_at.desc(), SupportQuery.id.desc())
        .limit(500)
    )
    if status in {"open", "resolved"}:
        stmt = stmt.where(SupportQuery.status == status)
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
