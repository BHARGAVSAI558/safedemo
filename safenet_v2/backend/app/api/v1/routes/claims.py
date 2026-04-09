from datetime import datetime, timezone
from typing import Any, List
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func, select
from sqlalchemy import or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.routes.workers import get_current_user
from app.db.session import get_db
from app.engines.decision_engine import DecisionEngine
from app.models.claim import DecisionType, Simulation
from app.models.notification import Notification
from app.models.worker import User
from app.schemas.claim import SimulationRequest, SimulationResponse
from app.services.simulation_labels import disruption_from_simulation
from app.services.notification_service import create_notification
from app.utils.logger import get_logger

log = get_logger(__name__)
router = APIRouter()

IST = ZoneInfo("Asia/Kolkata")


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
    core = _to_base36(seed)
    return f"{prefix}-{core}"


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


def _created_at_utc_z(created: datetime | None) -> str:
    """Serialize for mobile: naive DB times are UTC; always include Z so JS parses one instant."""
    if created is None:
        return ""
    if created.tzinfo is None:
        dt = created.replace(tzinfo=timezone.utc)
    else:
        dt = created.astimezone(timezone.utc)
    return dt.isoformat().replace("+00:00", "Z")


def _history_row(s: Simulation) -> dict[str, Any]:
    try:
        label, _icon = disruption_from_simulation(s)
    except Exception:
        label = "Disruption"
    ui_status = _ui_status_from_decision(s.decision)
    payout_amt = float(s.payout or 0.0)
    credited = payout_amt > 0
    effective_status = "CREDITED" if credited else ui_status
    created = s.created_at
    created_iso = _created_at_utc_z(created)
    transaction_id = _public_tx_id("TXN" if payout_amt > 0 else "CLM", int(s.id))
    return {
        "id": s.id,
        "transaction_id": transaction_id,
        "disruption_type": label,
        "status": effective_status,
        "payout_amount": round(payout_amt, 2),
        "created_at": created_iso,
        "fraud_score": float(s.fraud_score or 0.0),
        "reason": _history_reason(s, "APPROVED" if credited else ui_status, payout_amt if credited else 0.0),
        "details": {
            "claim_id": s.id,
            "transaction_id": transaction_id,
            "decision": str(s.decision.value if hasattr(s.decision, "value") else s.decision),
            "expected_income": round(float(s.expected_income or 0.0), 2),
            "actual_income": round(float(s.actual_income or 0.0), 2),
            "loss": round(float(s.loss or 0.0), 2),
            "payout": round(payout_amt, 2),
            "reason": str(s.reason or ""),
        },
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
    transaction_id = _public_tx_id("TXN", int(s.id))
    return {
        "date": _format_payout_date_display(s.created_at),
        "disruption_type": label,
        "amount": round(amt, 2),
        "status": "credited",
        "icon": icon,
        "claim_id": s.id,
        "transaction_id": transaction_id,
        "timestamp": _created_at_utc_z(s.created_at),
        "reason": str(s.reason or "Disruption verified and payout credited."),
        "source": "simulation",
        "details": {
            "claim_id": s.id,
            "transaction_id": transaction_id,
            "decision": str(s.decision.value if hasattr(s.decision, "value") else s.decision),
            "expected_income": round(float(s.expected_income or 0.0), 2),
            "actual_income": round(float(s.actual_income or 0.0), 2),
            "loss": round(float(s.loss or 0.0), 2),
            "payout": round(amt, 2),
            "reason": str(s.reason or ""),
        },
    }


def _amount_from_title(title: str | None) -> float:
    t = str(title or "")
    digits = "".join(ch for ch in t if ch.isdigit() or ch == ".")
    try:
        return float(digits) if digits else 0.0
    except Exception:
        return 0.0


@router.post("/run", response_model=SimulationResponse, status_code=201)
async def run_claim(
    request: Request,
    body: SimulationRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    try:
        fs = getattr(request.app.state, "forecast_shields", None)
        out = await DecisionEngine.run(
            current_user.id,
            body,
            db,
            redis=getattr(request.app.state, "redis", None),
            mongo_db=getattr(request.app.state, "mongo_db", None),
            forecast_shields=fs if isinstance(fs, dict) else None,
        )
        decision = str(getattr(out, "decision", "")).upper()
        if decision == "APPROVED":
            await create_notification(
                db,
                user_id=current_user.id,
                ntype="payout",
                title=f"₹{int(round(float(getattr(out, 'payout', 0.0) or 0.0)))} credited",
                message="Your claim was approved and payout has been processed.",
            )
        else:
            await create_notification(
                db,
                user_id=current_user.id,
                ntype="system",
                title="Claim update",
                message=str(getattr(out, "reason", "Your claim status changed.")),
            )
        await db.commit()
        return out
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
    out: List[dict[str, Any]] = []
    for s in sims:
        try:
            out.append(_history_row(s))
        except Exception:
            # Never fail the whole history response because one row is malformed.
            continue
    next_cursor = sims[-1].id if has_more and sims else None
    if not out:
        notif_rows = (
            await db.execute(
                select(Notification)
                .where(Notification.user_id == current_user.id, Notification.type == "payout")
                .order_by(Notification.created_at.desc(), Notification.id.desc())
                .limit(limit)
            )
        ).scalars().all()
        out = [
            {
                "id": int(n.id) * -1,
                "transaction_id": _public_tx_id("NTX", int(n.id)),
                "disruption_type": "Disruption",
                "status": "CREDITED",
                "payout_amount": round(_amount_from_title(n.title), 2),
                "created_at": _created_at_utc_z(n.created_at),
                "fraud_score": 0.0,
                "reason": str(n.message or "Payout credited."),
                "details": {
                    "claim_id": int(n.id) * -1,
                    "transaction_id": _public_tx_id("NTX", int(n.id)),
                    "decision": "APPROVED",
                    "expected_income": 0.0,
                    "actual_income": 0.0,
                    "loss": 0.0,
                    "payout": round(_amount_from_title(n.title), 2),
                    "reason": str(n.message or "Payout credited."),
                },
            }
            for n in notif_rows
        ]
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
            or_(Simulation.decision == DecisionType.APPROVED, Simulation.payout > 0),
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
                or_(Simulation.decision == DecisionType.APPROVED, Simulation.payout > 0),
            )
        )
    ).scalar_one() or 0
    next_cursor = sims[-1].id if has_more and sims else None
    if not data:
        notif_rows = (
            await db.execute(
                select(Notification)
                .where(Notification.user_id == current_user.id, Notification.type == "payout")
                .order_by(Notification.created_at.desc(), Notification.id.desc())
                .limit(limit)
            )
        ).scalars().all()
        data = [
            {
                "date": _format_payout_date_display(n.created_at),
                "disruption_type": "Disruption",
                "amount": round(_amount_from_title(n.title), 2),
                "status": "credited",
                "icon": "cloudy",
                "claim_id": int(n.id) * -1,
                "transaction_id": _public_tx_id("NTX", int(n.id)),
                "timestamp": _created_at_utc_z(n.created_at),
                "reason": str(n.message or "Payout credited."),
                "source": "notification_fallback",
                "details": {
                    "claim_id": int(n.id) * -1,
                    "transaction_id": _public_tx_id("NTX", int(n.id)),
                    "decision": "APPROVED",
                    "expected_income": 0.0,
                    "actual_income": 0.0,
                    "loss": 0.0,
                    "payout": round(_amount_from_title(n.title), 2),
                    "reason": str(n.message or "Payout credited."),
                },
            }
            for n in notif_rows
        ]
    return {
        "data": data,
        "next_cursor": str(next_cursor) if next_cursor is not None else None,
        "total_count": int(total_count),
    }
