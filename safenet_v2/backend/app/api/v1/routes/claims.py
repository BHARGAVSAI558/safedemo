import json
from datetime import datetime, timezone
from typing import Any, List
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.routes.workers import get_current_user
from app.db.session import get_db
from app.engines.decision_engine import DecisionEngine
from app.models.claim import DecisionType, Simulation
from app.models.payout import PayoutRecord
from app.models.worker import User
from app.schemas.claim import DisruptionData, SimulationRequest, SimulationResponse
from app.utils.logger import get_logger

log = get_logger(__name__)
router = APIRouter()

IST = ZoneInfo("Asia/Kolkata")

SCENARIO_TO_UI = {
    "HEAVY_RAIN": ("Heavy Rain", "rain"),
    "EXTREME_HEAT": ("Extreme Heat", "hot"),
    "AQI_SPIKE": ("AQI Spike", "cloudy"),
    "CURFEW": ("Curfew", "cloudy"),
}


def _format_payout_date_display(created_at: datetime | None) -> str:
    if created_at is None:
        return "Recently"
    if created_at.tzinfo is None:
        dt = created_at.replace(tzinfo=timezone.utc).astimezone(IST)
    else:
        dt = created_at.astimezone(IST)
    now = datetime.now(IST)
    if dt.date() == now.date():
        h = dt.hour % 12 or 12
        ampm = "AM" if dt.hour < 12 else "PM"
        return f"Today {h}:{dt.minute:02d} {ampm}"
    yesterday = now.date().toordinal() - 1
    if dt.date().toordinal() == yesterday:
        h = dt.hour % 12 or 12
        ampm = "AM" if dt.hour < 12 else "PM"
        return f"Yesterday {h}:{dt.minute:02d} {ampm}"
    return dt.strftime("%d %b %Y")


def _disruption_from_simulation(s: Simulation) -> tuple[str, str]:
    if s.weather_data:
        try:
            wd = json.loads(s.weather_data)
            key = str(wd.get("scenario") or wd.get("disruption_type") or "").upper()
            if key in SCENARIO_TO_UI:
                return SCENARIO_TO_UI[key]
        except (json.JSONDecodeError, TypeError):
            pass
    if s.weather_disruption:
        return "Heavy Rain", "rain"
    if getattr(s, "event_disruption", False):
        return "Curfew", "cloudy"
    return "Disruption", "cloudy"


def _payout_row_from_simulation(s: Simulation) -> dict[str, Any]:
    label, icon = _disruption_from_simulation(s)
    amt = float(s.payout or 0.0)
    return {
        "date": _format_payout_date_display(s.created_at),
        "disruption_type": label,
        "amount": round(amt, 2),
        "status": "credited",
        "icon": icon,
        "claim_id": s.id,
        "source": "simulation",
    }


def _payout_row_from_record(p: PayoutRecord, s: Simulation) -> dict[str, Any]:
    label, icon = _disruption_from_simulation(s)
    st = str(p.status or "").lower()
    status_ui = "credited" if st in ("completed", "credited", "paid") else st or "pending"
    return {
        "date": _format_payout_date_display(p.created_at),
        "disruption_type": label,
        "amount": round(float(p.amount), 2),
        "status": status_ui,
        "icon": icon,
        "claim_id": s.id,
        "id": p.id,
        "source": "payout_record",
    }


@router.post("/run", response_model=SimulationResponse, status_code=201)
async def run_claim(
    request: Request,
    body: SimulationRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    try:
        fs = getattr(request.app.state, "forecast_shields", None)
        return await DecisionEngine.run(
            current_user.id,
            body,
            db,
            redis=getattr(request.app.state, "redis", None),
            mongo_db=getattr(request.app.state, "mongo_db", None),
            forecast_shields=fs if isinstance(fs, dict) else None,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        log.error(
            "claim_run_failed",
            engine_name="claims_route",
            decision="error",
            reason_code="CLAIM_ERROR",
            worker_id=current_user.id,
            error=str(e),
        )
        raise HTTPException(status_code=500, detail=f"Claim processing failed: {str(e)}")


@router.get("/history")
async def claim_history(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    cursor: int | None = None,
    limit: int = 20,
):
    limit = max(1, min(100, int(limit)))
    total_count = (
        await db.execute(select(func.count(Simulation.id)).where(Simulation.user_id == current_user.id))
    ).scalar_one() or 0
    stmt = (
        select(Simulation)
        .where(Simulation.user_id == current_user.id)
        .order_by(Simulation.id.desc())
        .limit(limit + 1)
    )
    if cursor is not None:
        stmt = stmt.where(Simulation.id < cursor)
    result = await db.execute(
        stmt
    )
    sims = result.scalars().all()
    has_more = len(sims) > limit
    sims = sims[:limit]
    out: List[dict[str, Any]] = []
    for s in sims:
        wd = None
        if s.weather_data:
            try:
                wd = json.loads(s.weather_data)
            except json.JSONDecodeError:
                wd = None
        out.append(
            SimulationResponse(
            id=s.id,
            disruption=DisruptionData(
                weather=s.weather_disruption,
                traffic=s.traffic_disruption,
                event=s.event_disruption,
                final_disruption=s.final_disruption,
            ),
            decision=s.decision.value if hasattr(s.decision, "value") else str(s.decision),
            reason=s.reason,
            fraud_score=s.fraud_score,
            expected_income=s.expected_income,
            actual_income=s.actual_income,
            loss=s.loss,
            payout=s.payout,
            weather_data=wd,
            created_at=s.created_at,
            ).model_dump()
        )
    next_cursor = sims[-1].id if has_more and sims else None
    return {"data": out, "next_cursor": str(next_cursor) if next_cursor is not None else None, "total_count": int(total_count)}


@router.get("/payouts")
async def payout_history(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    cursor: int | None = None,
    limit: int = 20,
):
    """Recent payouts for the worker app: mobile-friendly rows; falls back to APPROVED simulations if no payout rows."""
    limit = max(1, min(100, int(limit)))
    stmt = (
        select(PayoutRecord, Simulation)
        .join(Simulation, Simulation.id == PayoutRecord.simulation_id)
        .where(Simulation.user_id == current_user.id)
        .order_by(PayoutRecord.id.desc())
        .limit(limit + 1)
    )
    if cursor is not None:
        stmt = stmt.where(PayoutRecord.id < cursor)
    rows = (await db.execute(stmt)).all()
    has_more = len(rows) > limit
    rows = rows[:limit]
    data: List[dict[str, Any]] = [_payout_row_from_record(p, s) for p, s in rows]

    if not data:
        sim_stmt = (
            select(Simulation)
            .where(
                Simulation.user_id == current_user.id,
                Simulation.decision == DecisionType.APPROVED,
                Simulation.payout > 0,
            )
            .order_by(Simulation.id.desc())
            .limit(limit)
        )
        sims = (await db.execute(sim_stmt)).scalars().all()
        data = [_payout_row_from_simulation(s) for s in sims]
        total_count = len(data)
        return {"data": data, "next_cursor": None, "total_count": int(total_count)}

    total_count = (
        await db.execute(
            select(func.count(PayoutRecord.id))
            .select_from(PayoutRecord)
            .join(Simulation, Simulation.id == PayoutRecord.simulation_id)
            .where(Simulation.user_id == current_user.id)
        )
    ).scalar_one() or 0
    next_cursor = rows[-1][0].id if has_more and rows else None
    return {"data": data, "next_cursor": str(next_cursor) if next_cursor else None, "total_count": int(total_count)}
