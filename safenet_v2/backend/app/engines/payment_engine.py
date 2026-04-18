"""
Payment Engine
--------------
Handles Razorpay integration for:
  1. Premium collection  — create order → webhook confirms → activate policy
  2. Payout disbursement — idempotent disburse → update pool → mark claim resolved
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.engines.trust_payout import payout_delay_seconds, trust_points_from_profile
from app.engines.pool_engine import calculate_weekly_premium, update_pool_on_premium, update_pool_on_payout
from app.models.claim import ClaimLifecycle, Simulation
from app.models.payment import Payment
from app.models.policy import Policy
from app.models.pool_balance import ZonePoolBalance
from app.models.worker import Profile
from app.utils.logger import get_logger

log = get_logger(__name__)

_HTTP_TIMEOUT = httpx.Timeout(connect=5.0, read=10.0, write=5.0, pool=5.0)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _to_paise(inr: float) -> int:
    """Convert INR to paise (Razorpay uses smallest currency unit). Minimum ₹1."""
    return max(100, int(round(inr * 100)))


def _tier_from_payment_notes(notes: Optional[str]) -> str:
    for token in (notes or "").replace(";", " ").split():
        if token.startswith("tier="):
            t = token.split("=", 1)[1].strip().title()
            if t in {"Basic", "Standard", "Pro"}:
                return t
    return "Standard"


async def _upsert_active_policy_for_premium_payment(db: AsyncSession, payment: Payment) -> bool:
    """
    When premium is collected without a pre-linked policy row, create/update the worker's
    active policy the same way as POST /policies/activate (without a second pool credit).
    """
    from app.services.onboarding_pricing import (
        TIER_TO_PRODUCT,
        compute_risk_score,
        normalize_zone,
    )

    tier = _tier_from_payment_notes(payment.notes)
    user_id = int(payment.user_id)
    prof = (
        await db.execute(select(Profile).where(Profile.user_id == user_id))
    ).scalar_one_or_none()
    if prof is None:
        return False

    product_code = TIER_TO_PRODUCT.get(tier, "")
    premium_calc = await calculate_weekly_premium(db, user_id, tier)
    weekly = float(premium_calc["weekly_premium"])
    coverage_cap = float(premium_calc["coverage_cap"])
    zone_risk_multiplier = float(premium_calc["zone_risk_multiplier"])
    worker_risk_adjustment = float(premium_calc["worker_adjustment"])
    monthly = round(weekly * 4.33, 2)

    zone_key = normalize_zone(prof.zone_id or "other")
    hours = (prof.working_hours_preset or "flexible").strip()
    platform = (prof.platform or "other").strip()
    risk_score = float(compute_risk_score(zone_key, hours, platform))

    now = datetime.now(timezone.utc)
    valid_until_dt = now + timedelta(days=7)

    prof.coverage_tier = tier
    prof.risk_score = risk_score
    prof.weekly_premium = weekly

    existing = (
        await db.execute(
            select(Policy)
            .where(Policy.user_id == user_id, Policy.status == "active")
            .order_by(Policy.id.desc())
            .limit(1)
        )
    ).scalar_one_or_none()

    if existing:
        existing.product_code = product_code
        existing.tier = tier
        existing.weekly_premium = weekly
        existing.monthly_premium = monthly
        existing.coverage_cap = coverage_cap
        existing.zone_risk_multiplier = zone_risk_multiplier
        existing.worker_risk_adjustment = worker_risk_adjustment
        existing.status = "active"
        existing.valid_from = now
        existing.valid_until = valid_until_dt
        existing.updated_at = now
        policy_row = existing
    else:
        policy_row = Policy(
            user_id=user_id,
            product_code=product_code,
            tier=tier,
            status="active",
            monthly_premium=monthly,
            weekly_premium=weekly,
            coverage_cap=coverage_cap,
            zone_risk_multiplier=zone_risk_multiplier,
            worker_risk_adjustment=worker_risk_adjustment,
            valid_from=now,
            valid_until=valid_until_dt,
            updated_at=now,
        )
        db.add(policy_row)

    await db.flush()
    if policy_row.id:
        payment.policy_id = int(policy_row.id)
    return True


def _razorpay_configured() -> bool:
    return bool((settings.RAZORPAY_KEY_ID or "").strip() and (settings.RAZORPAY_KEY_SECRET or "").strip())


# ── Signature verification ─────────────────────────────────────────────────────

def verify_payment_signature(
    order_id: str,
    payment_id: str,
    signature: str,
) -> bool:
    """
    Verify Razorpay payment signature for checkout flow.
    HMAC-SHA256(order_id + "|" + payment_id, key_secret)
    """
    secret = (settings.RAZORPAY_KEY_SECRET or "").strip()
    if not secret:
        return True  # dev mode — skip verification
    # webhook_verified is a sentinel from webhook handler — already body-verified
    if signature == "webhook_verified":
        return True
    body = f"{order_id}|{payment_id}"
    expected = hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


def verify_webhook_signature(payload_bytes: bytes, received_signature: str) -> bool:
    """
    Verify Razorpay webhook signature.
    HMAC-SHA256(raw_body, webhook_secret)
    """
    secret = (settings.RAZORPAY_WEBHOOK_SECRET or "").strip()
    if not secret:
        return True  # dev mode — skip verification
    expected = hmac.new(secret.encode(), payload_bytes, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, received_signature)


# ── 1. Premium collection ──────────────────────────────────────────────────────

async def create_premium_order(
    db: AsyncSession,
    user_id: int,
    tier: str,
    policy_id: Optional[int] = None,
) -> dict[str, Any]:
    """
    Step 1 of premium collection:
      - Calculate premium via pool_engine
      - Create Razorpay order (test mode)
      - Store Payment record with status=pending
      - Return order_id + breakdown for mobile checkout

    Idempotent: if a pending order already exists for this user+tier, return it.
    """
    premium_calc = await calculate_weekly_premium(db, user_id, tier)
    weekly_premium = float(premium_calc["weekly_premium"])
    coverage_cap = float(premium_calc["coverage_cap"])

    # Idempotency: return existing pending order if present
    existing = (
        await db.execute(
            select(Payment).where(
                Payment.user_id == user_id,
                Payment.payment_type == "premium_collection",
                Payment.status == "pending",
                Payment.policy_id == policy_id,
                Payment.notes.contains(f"tier={tier}"),
            )
        )
    ).scalar_one_or_none()

    if existing and existing.razorpay_order_id:
        log.info(
            "premium_order_reused",
            engine_name="payment_engine",
            reason_code="IDEMPOTENT_REUSE",
            user_id=user_id,
            order_id=existing.razorpay_order_id,
        )
        return {
            "order_id": existing.razorpay_order_id,
            "payment_id": existing.id,
            "amount_inr": existing.amount,
            "amount_paise": _to_paise(existing.amount),
            "currency": "INR",
            "tier": tier,
            "coverage_cap": coverage_cap,
            "breakdown": premium_calc["breakdown"],
            "key_id": settings.RAZORPAY_KEY_ID,
            "reused": True,
        }

    # Create Razorpay order
    razorpay_order_id: Optional[str] = None
    receipt = f"premium_{user_id}_{tier}_{int(_utcnow().timestamp())}"

    if _razorpay_configured():
        try:
            async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
                resp = await client.post(
                    "https://api.razorpay.com/v1/orders",
                    auth=(settings.RAZORPAY_KEY_ID, settings.RAZORPAY_KEY_SECRET),
                    json={
                        "amount": _to_paise(weekly_premium),
                        "currency": "INR",
                        "receipt": receipt,
                        "notes": {
                            "user_id": str(user_id),
                            "tier": tier,
                            "type": "premium_collection",
                        },
                    },
                )
            if resp.status_code == 200:
                razorpay_order_id = resp.json().get("id")
            else:
                log.warning(
                    "razorpay_order_failed",
                    engine_name="payment_engine",
                    reason_code="RZP_ORDER_FAIL",
                    status=resp.status_code,
                    user_id=user_id,
                )
        except Exception as exc:
            log.warning(
                "razorpay_order_error",
                engine_name="payment_engine",
                reason_code="RZP_HTTP_ERROR",
                error=str(exc),
                user_id=user_id,
            )

    # Fallback: generate a local order ID for test/dev mode
    if not razorpay_order_id:
        razorpay_order_id = f"order_test_{uuid.uuid4().hex[:16]}"

    payment = Payment(
        user_id=user_id,
        policy_id=policy_id,
        payment_type="premium_collection",
        amount=weekly_premium,
        currency="INR",
        razorpay_order_id=razorpay_order_id,
        status="pending",
        notes=f"tier={tier} receipt={receipt}",
    )
    db.add(payment)
    await db.commit()
    await db.refresh(payment)

    log.info(
        "premium_order_created",
        engine_name="payment_engine",
        reason_code="ORDER_CREATED",
        user_id=user_id,
        order_id=razorpay_order_id,
        amount=weekly_premium,
        tier=tier,
    )

    return {
        "order_id": razorpay_order_id,
        "payment_id": payment.id,
        "amount_inr": weekly_premium,
        "amount_paise": _to_paise(weekly_premium),
        "currency": "INR",
        "tier": tier,
        "coverage_cap": coverage_cap,
        "breakdown": premium_calc["breakdown"],
        "key_id": settings.RAZORPAY_KEY_ID,
        "reused": False,
    }


async def confirm_premium_payment(
    db: AsyncSession,
    razorpay_order_id: str,
    razorpay_payment_id: str,
    razorpay_signature: str,
) -> dict[str, Any]:
    """
    Step 2 of premium collection (called from webhook or manual verify):
      - Verify signature
      - Find Payment by order_id
      - Idempotency guard: skip if already success
      - Mark payment success
      - Activate policy (valid_from=now, valid_until=+7 days)
      - Update pool balance
    """
    # Signature verification
    if not verify_payment_signature(razorpay_order_id, razorpay_payment_id, razorpay_signature):
        log.warning(
            "premium_signature_invalid",
            engine_name="payment_engine",
            reason_code="SIG_INVALID",
            order_id=razorpay_order_id,
        )
        return {"ok": False, "error": "Invalid payment signature"}

    payment = (
        await db.execute(
            select(Payment).where(Payment.razorpay_order_id == razorpay_order_id)
        )
    ).scalar_one_or_none()

    if payment is None:
        log.warning(
            "premium_payment_not_found",
            engine_name="payment_engine",
            reason_code="PAYMENT_NOT_FOUND",
            order_id=razorpay_order_id,
        )
        return {"ok": False, "error": "Payment record not found"}

    # ── Idempotency guard ──────────────────────────────────────────────────────
    if payment.status == "success":
        log.info(
            "premium_already_confirmed",
            engine_name="payment_engine",
            reason_code="ALREADY_SUCCESS",
            order_id=razorpay_order_id,
        )
        return {"ok": True, "already_processed": True, "payment_id": payment.id}

    # Mark payment success
    payment.status = "success"
    payment.razorpay_payment_id = razorpay_payment_id
    payment.razorpay_signature = razorpay_signature

    # Activate policy
    now = _utcnow()
    valid_until = now + timedelta(days=7)

    policy_touched = False
    if payment.policy_id:
        policy = (
            await db.execute(select(Policy).where(Policy.id == payment.policy_id))
        ).scalar_one_or_none()
        if policy:
            policy.status = "active"
            policy.valid_from = now
            policy.valid_until = valid_until
            policy_touched = True
    if not policy_touched:
        policy_touched = await _upsert_active_policy_for_premium_payment(db, payment)

    # Update pool — get zone from profile
    profile = (
        await db.execute(select(Profile).where(Profile.user_id == payment.user_id))
    ).scalar_one_or_none()
    zone_id = str(profile.zone_id or "default") if profile else "default"

    # Pool update before commit so both succeed or both roll back
    try:
        await update_pool_on_premium(db, zone_id, float(payment.amount))
    except Exception as exc:
        log.warning(
            "pool_premium_update_failed",
            engine_name="payment_engine",
            reason_code="POOL_UPDATE_FAIL",
            error=str(exc),
        )
        await db.commit()

    log.info(
        "premium_confirmed",
        engine_name="payment_engine",
        reason_code="PREMIUM_CONFIRMED",
        user_id=payment.user_id,
        order_id=razorpay_order_id,
        payment_id=razorpay_payment_id,
        amount=payment.amount,
        zone_id=zone_id,
    )

    return {
        "ok": True,
        "payment_id": payment.id,
        "user_id": payment.user_id,
        "amount": payment.amount,
        "policy_activated": policy_touched,
        "valid_until": valid_until.isoformat(),
    }


# ── 2. Payout disbursement ─────────────────────────────────────────────────────

async def disburse_claim_payout(
    db: AsyncSession,
    user_id: int,
    simulation_id: int,
    payout_amount: float,
    zone_id: str,
) -> dict[str, Any]:
    """
    Idempotent payout disbursement:
      - Check if payout already exists → return existing transaction
      - Create Payment record (status=processing)
      - Simulate Razorpay Payout API (test mode)
        NOTE: Production uses Razorpay Payout API (X-Payout-Idempotency header)
      - Check pool balance before disbursing
      - Update pool balance
      - Mark claim lifecycle resolved
      - Return transaction details

    All external calls wrapped in try/except.
    """
    # ── Idempotency: check for existing successful payout ─────────────────────
    existing = (
        await db.execute(
            select(Payment).where(
                Payment.simulation_id == simulation_id,
                Payment.payment_type == "payout",
                Payment.status == "success",
            )
        )
    ).scalar_one_or_none()

    if existing:
        log.info(
            "payout_already_disbursed",
            engine_name="payment_engine",
            reason_code="IDEMPOTENT_PAYOUT",
            simulation_id=simulation_id,
            transaction_id=existing.razorpay_payment_id,
        )
        return {
            "ok": True,
            "already_processed": True,
            "transaction_id": existing.razorpay_payment_id,
            "payment_id": existing.id,
            "amount": existing.amount,
        }

    prof_trust = (
        await db.execute(select(Profile).where(Profile.user_id == user_id))
    ).scalar_one_or_none()
    delay_sec = payout_delay_seconds(trust_points_from_profile(prof_trust))
    if delay_sec > 0:
        await asyncio.sleep(float(delay_sec))

    # ── Pool balance guard ─────────────────────────────────────────────────────
    pool_row = (
        await db.execute(
            select(ZonePoolBalance)
            .where(ZonePoolBalance.zone_id == zone_id)
            .order_by(ZonePoolBalance.week_start.desc())
        )
    ).scalar_one_or_none()

    pool_balance = float(pool_row.current_balance or 0.0) if pool_row else 0.0
    effective_payout = payout_amount

    if pool_balance > 0 and pool_balance < payout_amount:
        effective_payout = round(pool_balance, 2)
        log.warning(
            "payout_capped_by_pool",
            engine_name="payment_engine",
            reason_code="POOL_CAP",
            simulation_id=simulation_id,
            requested=payout_amount,
            available=pool_balance,
            effective=effective_payout,
        )

    # ── Create Payment record (processing) ────────────────────────────────────
    payment = Payment(
        user_id=user_id,
        simulation_id=simulation_id,
        payment_type="payout",
        amount=effective_payout,
        currency="INR",
        status="processing",
        notes=f"zone={zone_id} sim={simulation_id}",
    )
    db.add(payment)
    await db.flush()

    # ── Razorpay Payout API (test mode simulation) ─────────────────────────────
    # NOTE: Production uses Razorpay Payout API:
    #   POST https://api.razorpay.com/v1/payouts
    #   Headers: X-Payout-Idempotency: <unique_key>
    #   Body: { account_number, amount, currency, mode, purpose, fund_account, ... }
    # In test mode we generate a deterministic transaction ID.
    transaction_id: Optional[str] = None
    payout_success = False

    if _razorpay_configured():
        try:
            idempotency_key = f"payout_{simulation_id}_{user_id}"
            async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
                resp = await client.post(
                    "https://api.razorpay.com/v1/payouts",
                    auth=(settings.RAZORPAY_KEY_ID, settings.RAZORPAY_KEY_SECRET),
                    headers={"X-Payout-Idempotency": idempotency_key},
                    json={
                        "account_number": "2323230085595678",  # test account
                        "amount": _to_paise(effective_payout),
                        "currency": "INR",
                        "mode": "UPI",
                        "purpose": "payout",
                        "queue_if_low_balance": True,
                        "reference_id": idempotency_key,
                        "narration": f"SafeNet claim payout sim#{simulation_id}",
                        "notes": {"simulation_id": str(simulation_id), "user_id": str(user_id)},
                    },
                )
            if resp.status_code in (200, 201):
                data = resp.json()
                transaction_id = data.get("id") or data.get("utr")
                payout_success = True
            else:
                log.warning(
                    "razorpay_payout_api_failed",
                    engine_name="payment_engine",
                    reason_code="RZP_PAYOUT_FAIL",
                    status=resp.status_code,
                    simulation_id=simulation_id,
                )
        except Exception as exc:
            log.warning(
                "razorpay_payout_error",
                engine_name="payment_engine",
                reason_code="RZP_PAYOUT_HTTP_ERROR",
                error=str(exc),
                simulation_id=simulation_id,
            )

    # Test/dev mode: payout is queued, not auto-succeeded
    if not payout_success:
        payment.status = "pending"
        await db.commit()
        return {
            "ok": True,
            "queued": True,
            "payment_id": payment.id,
            "amount": effective_payout,
            "simulation_id": simulation_id,
        }

    # ── Update payment record ──────────────────────────────────────────────────
    if payout_success:
        payment.status = "success"
        payment.razorpay_payment_id = transaction_id
    else:
        payment.status = "failed"
        payment.error_message = "Razorpay payout API returned non-200"
        await db.commit()
        return {
            "ok": False,
            "error": "Payout disbursement failed",
            "payment_id": payment.id,
        }

    # ── Update pool balance ────────────────────────────────────────────────────
    try:
        await update_pool_on_payout(db, zone_id, effective_payout)
    except Exception as exc:
        log.warning(
            "pool_payout_update_failed",
            engine_name="payment_engine",
            reason_code="POOL_UPDATE_FAIL",
            error=str(exc),
        )

    # ── Mark claim lifecycle resolved (scoped to simulation_id) ──────────────
    sim_row = (
        await db.execute(
            select(Simulation).where(Simulation.id == simulation_id)
        )
    ).scalar_one_or_none()

    lc_row = None
    if sim_row is not None:
        lc_row = (
            await db.execute(
                select(ClaimLifecycle).where(
                    ClaimLifecycle.user_id == user_id,
                    ClaimLifecycle.claim_id == f"auto:{user_id}:{sim_row.disruption_event_id}",
                )
            )
        ).scalar_one_or_none()

    if lc_row is None:
        lc_row = (
            await db.execute(
                select(ClaimLifecycle).where(
                    ClaimLifecycle.user_id == user_id,
                    ClaimLifecycle.status.in_(["PAYOUT", "INITIATED", "VERIFYING"]),
                )
                .order_by(ClaimLifecycle.created_at.desc())
            )
        ).scalar_one_or_none()

    if lc_row:
        lc_row.status = "RESOLVED"
        lc_row.payout_amount = effective_payout
        lc_row.message = f"Payout ₹{int(round(effective_payout))} disbursed — txn {transaction_id}"

    await db.commit()

    log.info(
        "payout_disbursed",
        engine_name="payment_engine",
        reason_code="PAYOUT_SUCCESS",
        user_id=user_id,
        simulation_id=simulation_id,
        transaction_id=transaction_id,
        amount=effective_payout,
        zone_id=zone_id,
    )

    return {
        "ok": True,
        "transaction_id": transaction_id,
        "payment_id": payment.id,
        "amount": effective_payout,
        "zone_id": zone_id,
        "simulation_id": simulation_id,
    }
