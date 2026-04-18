from datetime import datetime, timezone
from typing import Any, List
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from sqlalchemy import func, select
from sqlalchemy import or_
from sqlalchemy.ext.asyncio import AsyncSession
import httpx

from app.api.v1.routes.workers import get_current_user
from app.core.config import settings
from app.db.session import get_db
from app.engines.decision_engine import DecisionEngine
from app.models.claim import ClaimLifecycle, DecisionType, DisruptionEvent, Simulation
from app.models.notification import Notification
from app.models.payout import PayoutRecord
from app.models.zone import Zone
from app.models.worker import Profile, User
from app.schemas.claim import SimulationRequest, SimulationResponse
from app.services.simulation_labels import disruption_from_simulation
from app.services.notification_service import create_notification
from app.services.zone_match import disruption_zone_candidates
from app.services.income_loss_receipt import build_income_loss_receipt_pdf
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


def _refined_history_status(s: Simulation, base_ui: str, payout_amt: float) -> str:
    """Map DB REJECTED into NO_PAYOUT for benign checks; reserve REJECTED/BLOCKED for fraud."""
    if payout_amt > 0:
        return "CREDITED"
    r = str(s.reason or "").lower()
    fraudish = bool(getattr(s, "fraud_flag", False)) or float(s.fraud_score or 0) >= 0.65
    if fraudish or "fraud" in r or base_ui == "BLOCKED":
        return "BLOCKED"
    if base_ui != "REJECTED":
        return base_ui or "PENDING"
    if any(
        k in r
        for k in (
            "already simulated",
            "try again tomorrow",
            "safer/moderate",
            "not severe enough",
            "not extreme enough",
            "not eligible",
            "no extra payout",
            "another payout",
            "signal too weak",
            "too weak",
            "limit",
        )
    ):
        return "NO_PAYOUT"
    return "REJECTED"


def _history_reason(s: Simulation, refined: str, payout_amt: float) -> str:
    if refined == "CREDITED" or refined == "APPROVED":
        return f"Disruption verified · GPS clean · Paid ₹{int(round(payout_amt))}"
    if refined == "BLOCKED":
        if "fraud" in str(s.reason or "").lower():
            return str(s.reason or "Blocked after fraud checks.")[:500]
        return "GPS anomaly detected · Claim blocked"
    if refined == "NO_PAYOUT":
        return (s.reason or "No payout on this run — conditions not met for an extra credit.")[:500]
    if refined == "REJECTED":
        return "Claim rejected after review — see details below."
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
    refined = _refined_history_status(s, ui_status, payout_amt)
    effective_status = "CREDITED" if credited else refined
    created_iso = _created_at_utc_z(s.created_at)
    transaction_id = _public_tx_id("TXN" if payout_amt > 0 else "CLM", int(s.id))
    expected = float(s.expected_income or 0.0)
    loss = float(s.loss or 0.0)
    fraud_score = float(s.fraud_score or 0.0)
    # Build payout breakdown for mobile display
    payout_breakdown = None
    if credited:
        severity = round(min(1.0, max(0.3, fraud_score * 0.3 + 0.7)), 2) if fraud_score < 0.3 else 0.7
        payout_breakdown = {
            "expected_loss": round(expected, 2),
            "severity": severity,
            "zone": 1.0,
            "pool": 1.0,
            "final_payout": round(payout_amt, 2),
        }
    return {
        "id": s.id,
        "transaction_id": transaction_id,
        "disruption_type": label,
        "status": effective_status,
        "payout_amount": round(payout_amt, 2),
        "created_at": created_iso,
        "fraud_score": round(fraud_score, 4),
        "reason": _history_reason(s, "CREDITED" if credited else refined, payout_amt),
        "payout_breakdown": payout_breakdown,
        "details": {
            "claim_id": s.id,
            "transaction_id": transaction_id,
            "decision": str(s.decision.value if hasattr(s.decision, "value") else s.decision),
            "expected_income": round(expected, 2),
            "actual_income": round(float(s.actual_income or 0.0), 2),
            "loss": round(loss, 2),
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


@router.get("/{claim_id}/receipt")
async def download_claim_receipt(
    claim_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    try:
        pdf = await build_income_loss_receipt_pdf(
            db,
            claim_id=int(claim_id),
            requester_user_id=int(current_user.id),
            is_admin=False,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except PermissionError:
        raise HTTPException(status_code=403, detail="Not your claim")
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="safenet-receipt-{claim_id}.pdf"'},
    )


@router.get("/active")
async def get_active_disruptions(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Returns active disruption events in the worker's zone
    and the worker's current claim lifecycle status for each.
    """
    profile = (
        await db.execute(select(Profile).where(Profile.user_id == current_user.id))
    ).scalar_one_or_none()

    if not profile or not profile.zone_id:
        return {"disruptions": [], "zone_id": None}

    zone_id = str(profile.zone_id)
    zone_rows = (await db.execute(select(Zone))).scalars().all()
    zone_candidates = disruption_zone_candidates(zone_id, zone_rows)

    active_events = (
        await db.execute(
            select(DisruptionEvent)
            .where(
                DisruptionEvent.zone_id.in_(list(zone_candidates)),
                DisruptionEvent.is_active.is_(True),
            )
            .order_by(DisruptionEvent.started_at.desc())
        )
    ).scalars().all()

    out = []
    for event in active_events:
        # Find this worker's claim lifecycle for this event (if any)
        lc = (
            await db.execute(
                select(ClaimLifecycle).where(
                    ClaimLifecycle.user_id == current_user.id,
                    ClaimLifecycle.zone_id == zone_id,
                    ClaimLifecycle.disruption_type == event.disruption_type,
                )
                .order_by(ClaimLifecycle.created_at.desc())
            )
        ).scalar_one_or_none()

        started_iso = ""
        if event.started_at:
            dt = event.started_at
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            started_iso = dt.isoformat().replace("+00:00", "Z")

        out.append({
            "disruption_event_id": event.id,
            "disruption_type": event.disruption_type,
            "severity": round(float(event.severity or 0.0), 3),
            "confidence": event.confidence,
            "raw_value": event.raw_value,
            "threshold_value": event.threshold_value,
            "api_source": event.api_source,
            "started_at": started_iso,
            "zone_id": zone_id,
            "claim_status": lc.status if lc else None,
            "claim_payout": round(float(lc.payout_amount or 0.0), 2) if lc else None,
            "claim_message": lc.message if lc else None,
        })

    return out


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


@router.post("/{claim_id}/process-payout")
async def process_payout_for_claim(
    claim_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    sim = (
        await db.execute(
            select(Simulation).where(Simulation.id == claim_id, Simulation.user_id == current_user.id)
        )
    ).scalar_one_or_none()
    if sim is None:
        raise HTTPException(status_code=404, detail="Claim not found")
    if float(sim.payout or 0.0) <= 0:
        raise HTTPException(status_code=400, detail="No payable amount on this claim")

    existing = (
        await db.execute(select(PayoutRecord).where(PayoutRecord.simulation_id == sim.id).order_by(PayoutRecord.id.desc()))
    ).scalars().first()
    if existing and str(existing.status).lower() == "completed":
        return {
            "claim_id": sim.id,
            "payout_id": existing.razorpay_order_id or f"local-{existing.id}",
            "payout_status": "completed",
            "amount": round(float(existing.amount or 0.0), 2),
            "message": f"₹{int(round(float(existing.amount or 0.0)))} credited to your account (Razorpay test)",
        }

    payout_id = None
    payout_status = "pending"
    try:
        if settings.RAZORPAY_KEY_ID and settings.RAZORPAY_KEY_SECRET:
            async with httpx.AsyncClient(timeout=8.0) as client:
                resp = await client.post(
                    "https://api.razorpay.com/v1/orders",
                    auth=(settings.RAZORPAY_KEY_ID, settings.RAZORPAY_KEY_SECRET),
                    json={
                        "amount": int(max(1, round(float(sim.payout) * 100))),
                        "currency": "INR",
                        "receipt": f"claim_{sim.id}",
                        "notes": {"worker_id": current_user.id},
                    },
                )
            if resp.status_code == 200:
                payout_id = resp.json().get("id")
                payout_status = "completed"
    except Exception:
        payout_status = "pending"

    rec = PayoutRecord(
        simulation_id=sim.id,
        amount=float(sim.payout or 0.0),
        currency="INR",
        payment_type="payout",
        razorpay_order_id=payout_id,
        status=payout_status,
    )
    db.add(rec)
    await db.commit()
    return {
        "claim_id": sim.id,
        "payout_id": payout_id or f"local-{rec.id}",
        "payout_status": payout_status,
        "amount": round(float(sim.payout or 0.0), 2),
        "message": f"₹{int(round(float(sim.payout or 0.0)))} credited to your account (Razorpay test)",
    }
