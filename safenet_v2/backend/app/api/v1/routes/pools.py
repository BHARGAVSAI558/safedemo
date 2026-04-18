from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.routes.workers import get_current_user
from app.db.session import get_db
from app.models.pool_balance import ZonePoolBalance
from app.models.worker import Profile, User
from app.schemas.policy import PoolHealthResponse
from app.services.zone_resolver import resolve_city_to_zone
from app.utils.logger import get_logger

log = get_logger(__name__)
router = APIRouter()


@router.get("/health", response_model=PoolHealthResponse)
async def get_pool_health(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    prof = (await db.execute(select(Profile).where(Profile.user_id == current_user.id))).scalar_one_or_none()
    if not prof:
        raise HTTPException(status_code=400, detail="Create a worker profile first")

    zone_id, _lat, _lon = resolve_city_to_zone(prof.city)
    row = (
        await db.execute(
            select(ZonePoolBalance)
            .where(ZonePoolBalance.zone_id == zone_id)
            .order_by(ZonePoolBalance.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()

    balance = float(row.current_balance or 0.0) if row else 0.0
    util = float(row.utilization_pct or 0.0) if row else 0.0
    loss_ratio = float(row.loss_ratio or 0.0) if row else 0.0
    premiums_collected = float(row.total_premiums_collected or 0.0) if row else 0.0
    payouts_disbursed = float(row.total_payouts_disbursed or 0.0) if row else 0.0

    log.info(
        "pool_health",
        engine_name="pools_route",
        decision="ok",
        reason_code="POOL_HEALTH",
        worker_id=current_user.id,
        zone_id=zone_id,
    )
    return PoolHealthResponse(
        zone_id=zone_id,
        zone_label=str(prof.city or zone_id),
        pool_balance=balance,
        pool_utilization_pct=util,
        loss_ratio=loss_ratio,
        total_premiums_collected=premiums_collected,
        total_payouts_disbursed=payouts_disbursed,
    )
