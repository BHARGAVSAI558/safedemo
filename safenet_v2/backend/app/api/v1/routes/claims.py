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
from app.models.worker import User
from app.schemas.claim import SimulationRequest, SimulationResponse
from app.services.simulation_labels import disruption_from_simulation
from app.utils.logger import get_logger

log = get_logger(__name__)
router = APIRouter()

IST = ZoneInfo("Asia/Kolkata")


def _ui_status_from_decision(decision: Any) -> str:
    v = decision.value if hasattr(decision, "value") else str(decision or "")
    u = str(v).upper()
    if u == "APPROVED":
        return "APPROVED"
    if u == "FRAUD":
        return "BLOCKED"
    if u == "REJECTED":
        return "REJECTED"
    return "PENDING"


def _history_reason(s: Simulation, ui_status: str, payout_amt: float) -> str:
    if ui_status == "APPROVED":
        return f"Disruption verified · GPS clean · Paid ₹{int(round(payout_amt))}"
    if ui_status == "BLOCKED":
        return "GPS anomaly detected · Claim blocked"
    if ui_status == "REJECTED":
        return "Disruption signal too weak · No payout"
    return (s.reason or "")[:500]


def _history_row(s: Simulation) -> dict[str, Any]:
    label, _icon = disruption_from_simulation(s)
    ui_status = _ui_status_from_decision(s.decision)
    payout_amt = float(s.payout or 0.0) if ui_status == "APPROVED" else 0.0
    created = s.created_at
    created_iso = created.isoformat() if created is not None else ""
    return {
        "id": s.id,
        "disruption_type": label,
        "status": ui_status,
        "payout_amount": round(payout_amt, 2),
        "created_at": created_iso,
        "fraud_score": float(s.fraud_score or 0.0),
        "reason": _history_reason(s, ui_status, float(s.payout or 0.0) if ui_status == "APPROVED" else 0.0),
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


def _payout_row_from_simulation(s: Simulation) -> dict[str, Any]:
    label, icon = disruption_from_simulation(s)
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
    limit: int = 50,
):
    """All simulations for this user, newest first — mobile-friendly claim history."""
    limit = max(1, min(100, int(limit)))
    total_count = (
        await db.execute(select(func.count(Simulation.id)).where(Simulation.user_id == current_user.id))
    ).scalar_one() or 0
    stmt = (
        select(Simulation)
        .where(Simulation.user_id == current_user.id)
        .order_by(Simulation.created_at.desc(), Simulation.id.desc())
        .limit(limit + 1)
    )
    if cursor is not None:
        stmt = stmt.where(Simulation.id < int(cursor))
    result = await db.execute(stmt)
    sims = result.scalars().all()
    has_more = len(sims) > limit
    sims = sims[:limit]
    out: List[dict[str, Any]] = [_history_row(s) for s in sims]
    next_cursor = sims[-1].id if has_more and sims else None
    return {"data": out, "next_cursor": str(next_cursor) if next_cursor is not None else None, "total_count": int(total_count)}


@router.get("/payouts")
async def payout_history(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    cursor: int | None = None,
    limit: int = 10,
):
    """Last N APPROVED simulations as payout rows (credited), newest first by simulation time."""
    limit = max(1, min(100, int(limit)))
    sim_stmt = (
        select(Simulation)
        .where(
            Simulation.user_id == current_user.id,
            Simulation.decision == DecisionType.APPROVED,
        )
        .order_by(Simulation.created_at.desc(), Simulation.id.desc())
        .limit(limit + 1)
    )
    if cursor is not None:
        sim_stmt = sim_stmt.where(Simulation.id < int(cursor))
    sims = (await db.execute(sim_stmt)).scalars().all()
    has_more = len(sims) > limit
    sims = sims[:limit]
    data: List[dict[str, Any]] = [_payout_row_from_simulation(s) for s in sims]
    total_count = (
        await db.execute(
            select(func.count(Simulation.id)).where(
                Simulation.user_id == current_user.id,
                Simulation.decision == DecisionType.APPROVED,
            )
        )
    ).scalar_one() or 0
    next_cursor = sims[-1].id if has_more and sims else None
    return {
        "data": data,
        "next_cursor": str(next_cursor) if next_cursor is not None else None,
        "total_count": int(total_count),
    }
