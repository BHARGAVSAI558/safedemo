"""
Payments API
------------
Endpoints:
  POST /payments/premium/order    — create Razorpay order for premium
  POST /payments/premium/verify   — verify payment after mobile checkout
  POST /payments/payout/{sim_id}  — disburse approved claim payout
  POST /payments/webhook          — Razorpay webhook (signature-verified)
  GET  /payments/history          — worker's payment history
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.routes.workers import get_current_user
from app.db.session import get_db
from app.engines.payment_engine import (
    confirm_premium_payment,
    create_premium_order,
    disburse_claim_payout,
    verify_webhook_signature,
)
from app.models.claim import Simulation
from app.models.payment import Payment
from app.models.policy import Policy
from app.models.worker import Profile, User
from app.utils.logger import get_logger

log = get_logger(__name__)
router = APIRouter()


# ── Request / Response schemas ─────────────────────────────────────────────────

class PremiumOrderRequest(BaseModel):
    tier: Literal["Basic", "Standard", "Pro"]
    policy_id: Optional[int] = None


class PremiumVerifyRequest(BaseModel):
    razorpay_order_id: str
    razorpay_payment_id: str
    razorpay_signature: str


class PayoutRequest(BaseModel):
    zone_id: str = Field(default="", max_length=64)


# ── Helpers ────────────────────────────────────────────────────────────────────

def _iso(dt: Optional[datetime]) -> Optional[str]:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat().replace("+00:00", "Z")


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.post("/premium/order", status_code=201)
async def create_order(
    body: PremiumOrderRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Create a Razorpay order for weekly premium payment.
    Returns order_id + amount for mobile Razorpay checkout SDK.
    Idempotent: returns existing pending order if one exists.
    """
    result = await create_premium_order(
        db=db,
        user_id=current_user.id,
        tier=body.tier,
        policy_id=body.policy_id,
    )
    return result


@router.post("/premium/verify")
async def verify_premium(
    body: PremiumVerifyRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Called by mobile after Razorpay checkout completes.
    Verifies signature, activates policy, updates pool.
    """
    row = (
        await db.execute(
            select(Payment).where(
                Payment.razorpay_order_id == body.razorpay_order_id,
                Payment.user_id == current_user.id,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Order not found")

    result = await confirm_premium_payment(
        db=db,
        razorpay_order_id=body.razorpay_order_id,
        razorpay_payment_id=body.razorpay_payment_id,
        razorpay_signature=body.razorpay_signature,
    )
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error", "Payment verification failed"))
    return result


@router.post("/payout/{simulation_id}", status_code=201)
async def trigger_payout(
    simulation_id: int,
    body: PayoutRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Disburse payout for an approved claim simulation.
    Idempotent: returns existing transaction if already disbursed.
    Only the owning worker can trigger their own payout.
    """
    sim = (
        await db.execute(
            select(Simulation).where(
                Simulation.id == simulation_id,
                Simulation.user_id == current_user.id,
            )
        )
    ).scalar_one_or_none()

    if sim is None:
        raise HTTPException(status_code=404, detail="Simulation not found")

    from app.models.claim import DecisionType
    if sim.decision != DecisionType.APPROVED:
        raise HTTPException(status_code=400, detail="Payout only available for approved claims")

    if float(sim.payout or 0.0) <= 0:
        raise HTTPException(status_code=400, detail="No payout amount on this claim")

    # Resolve zone_id from body or profile
    zone_id = body.zone_id.strip()
    if not zone_id:
        profile = (
            await db.execute(select(Profile).where(Profile.user_id == current_user.id))
        ).scalar_one_or_none()
        zone_id = str(profile.zone_id or "default") if profile else "default"

    result = await disburse_claim_payout(
        db=db,
        user_id=current_user.id,
        simulation_id=simulation_id,
        payout_amount=float(sim.payout),
        zone_id=zone_id,
    )

    if not result.get("ok"):
        raise HTTPException(status_code=500, detail=result.get("error", "Payout failed"))

    return result


@router.post("/webhook")
async def razorpay_webhook(request: Request, db: AsyncSession = Depends(get_db)):
    """
    Razorpay webhook endpoint.
    Verifies X-Razorpay-Signature header before processing.
    Handles: payment.captured → confirm premium payment.

    Configure in Razorpay dashboard:
      URL: https://your-api.onrender.com/api/v1/payments/webhook
      Events: payment.captured
    """
    raw_body = await request.body()
    signature = request.headers.get("X-Razorpay-Signature", "")

    if not verify_webhook_signature(raw_body, signature):
        log.warning(
            "webhook_signature_invalid",
            engine_name="payments_route",
            reason_code="WEBHOOK_SIG_FAIL",
        )
        raise HTTPException(status_code=400, detail="Invalid webhook signature")

    try:
        payload: Dict[str, Any] = json.loads(raw_body)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON payload")

    event = str(payload.get("event", ""))
    entity = (payload.get("payload") or {}).get("payment", {}).get("entity", {})

    log.info(
        "webhook_received",
        engine_name="payments_route",
        reason_code="WEBHOOK_OK",
        event=event,
        payment_id=entity.get("id"),
    )

    if event == "payment.captured":
        order_id = str(entity.get("order_id", ""))
        payment_id = str(entity.get("id", ""))
        result = await confirm_premium_payment(
            db=db,
            razorpay_order_id=order_id,
            razorpay_payment_id=payment_id,
            razorpay_signature="webhook_verified",
        )
        if not result.get("ok"):
            log.warning(
                "webhook_premium_confirm_failed",
                engine_name="payments_route",
                reason_code="WEBHOOK_CONFIRM_FAIL",
                order_id=order_id,
                error=result.get("error"),
            )
        else:
            log.info(
                "webhook_premium_confirmed",
                engine_name="payments_route",
                reason_code="WEBHOOK_PREMIUM",
                order_id=order_id,
                result_ok=result.get("ok"),
            )

    # Always return 200 to Razorpay to prevent retries
    return {"status": "ok", "event": event}


@router.get("/history")
async def payment_history(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    page: int = 1,
    limit: int = 20,
):
    """
    Worker's full payment history (premiums + payouts), newest first.
    """
    page = max(1, page)
    limit = max(1, min(50, limit))
    offset = (page - 1) * limit

    rows = (
        await db.execute(
            select(Payment)
            .where(Payment.user_id == current_user.id)
            .order_by(Payment.created_at.desc())
            .offset(offset)
            .limit(limit)
        )
    ).scalars().all()

    from sqlalchemy import func
    total = (
        await db.execute(
            select(func.count(Payment.id)).where(Payment.user_id == current_user.id)
        )
    ).scalar_one() or 0

    data = [
        {
            "payment_id": p.id,
            "payment_type": p.payment_type,
            "amount": round(float(p.amount or 0.0), 2),
            "currency": p.currency,
            "status": p.status,
            "razorpay_order_id": p.razorpay_order_id,
            "razorpay_payment_id": p.razorpay_payment_id,
            "policy_id": p.policy_id,
            "simulation_id": p.simulation_id,
            "created_at": _iso(p.created_at),
            "updated_at": _iso(p.updated_at),
        }
        for p in rows
    ]

    return {"data": data, "page": page, "limit": limit, "total_count": int(total)}
