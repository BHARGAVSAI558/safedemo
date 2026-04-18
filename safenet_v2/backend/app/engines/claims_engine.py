"""
Claims Engine
-------------
Orchestrates the full pipeline from a DisruptionEvent to payout:

  1.  Fetch eligible workers (active, non-expired policy, same zone)
  2.  Prevent duplicate claims per worker per event
  3.  Calculate disruption duration dynamically
  4.  Calculate payout via PayoutEngine.compute_db_payout
  5.  Fraud check via check_fraud()
  6.  Decide claim status (approved / review / rejected)
  7.  Store Simulation row with full breakdown
  8.  Link FraudFlag.simulation_id
  9.  Disburse payout (immediate or delayed) with pool balance guard
  10. Update worker trust score
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import uuid4

import httpx
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.engines.fraud_engine_claims import check_fraud
from app.engines.payout_engine import PayoutEngine
from app.models.claim import ClaimLifecycle, DecisionType, DisruptionEvent, Simulation
from app.models.fraud import FraudFlag, FraudSignal
from app.models.payout import PayoutRecord
from app.models.policy import Policy
from app.models.worker import Profile, User
from app.services.realtime_service import publish_claim_update, publish_payout_credited
from app.utils.logger import get_logger

log = get_logger(__name__)

# ── Trust score deltas ─────────────────────────────────────────────────────────
_TRUST_APPROVED_CLEAN = 6.0    # fraud_score < 0.1
_TRUST_APPROVED_MED   = 3.0    # fraud_score 0.1–0.3
_TRUST_REVIEW         = 2.0    # held for review
_TRUST_REJECTED       = -18.0  # rejected claim

# Trust is stored as 0–1 in DB; convert deltas accordingly
_TRUST_SCALE = 100.0


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _disruption_duration_hours(event: DisruptionEvent) -> float:
    """
    Derive disruption duration from event timestamps.
    Falls back to 2.0 hours if ended_at is not yet set.
    """
    started = event.started_at
    ended = event.ended_at

    if started is None:
        return 2.0

    if started.tzinfo is None:
        started = started.replace(tzinfo=timezone.utc)

    if ended is None:
        return 2.0

    if ended.tzinfo is None:
        ended = ended.replace(tzinfo=timezone.utc)

    hours = (ended - started).total_seconds() / 3600.0
    # Clamp: minimum 0.5h, maximum 12h per event
    return round(max(0.5, min(hours, 12.0)), 2)


def _normalise_trust(raw: float) -> float:
    """Ensure trust is in 0–1 range (DB stores 0–1)."""
    if raw > 1.0:
        return raw / _TRUST_SCALE
    return raw


def _apply_trust_delta(profile: Profile, delta_points: float) -> None:
    """Apply a ±delta (in 0–100 scale) to profile.trust_score (stored 0–1)."""
    current = _normalise_trust(float(profile.trust_score or 0.5))
    delta_normalised = delta_points / _TRUST_SCALE
    updated = max(0.0, min(1.0, current + delta_normalised))
    profile.trust_score = round(updated, 4)


async def _get_eligible_workers(
    db: AsyncSession,
    zone_id: str,
) -> list[tuple[User, Profile, Policy]]:
    """
    Returns (User, Profile, Policy) triples for workers who:
      - are active
      - have a profile in the same zone
      - have an active, non-expired policy
    """
    now = _utcnow()
    rows = (
        await db.execute(
            select(User, Profile, Policy)
            .join(Profile, Profile.user_id == User.id)
            .join(Policy, Policy.user_id == User.id)
            .where(
                User.is_active.is_(True),
                Profile.zone_id == zone_id,
                Policy.status == "active",
            )
        )
    ).all()

    eligible = []
    for user, profile, policy in rows:
        # Check policy not expired
        valid_until = getattr(policy, "valid_until", None)
        if valid_until is not None:
            if valid_until.tzinfo is None:
                valid_until = valid_until.replace(tzinfo=timezone.utc)
            if valid_until < now:
                continue
        eligible.append((user, profile, policy))

    return eligible


async def _already_claimed(
    db: AsyncSession,
    user_id: int,
    disruption_event_id: int,
) -> bool:
    """True if a Simulation already exists for this worker + disruption event."""
    count = (
        await db.execute(
            select(func.count(Simulation.id)).where(
                Simulation.user_id == user_id,
                Simulation.disruption_event_id == disruption_event_id,
            )
        )
    ).scalar_one() or 0
    return count > 0


async def _disburse_payout(
    *,
    db: AsyncSession,
    simulation: Simulation,
    payout_amount: float,
    zone_id: str,
    policy: Policy,
    redis: Any,
    correlation_id: str,
    disruption_type: str,
    immediate: bool,
) -> str:
    """
    Creates a PayoutRecord and attempts Razorpay test-mode ping.
    Checks pool balance before disbursing.
    Returns final payment status string.
    """
    payment_status = "pending" if not immediate else "completed"

    # Razorpay test-mode ping (best-effort)
    razorpay_order_id: Optional[str] = None
    if settings.RAZORPAY_KEY_ID and settings.RAZORPAY_KEY_SECRET:
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                resp = await client.post(
                    "https://api.razorpay.com/v1/orders",
                    auth=(settings.RAZORPAY_KEY_ID, settings.RAZORPAY_KEY_SECRET),
                    json={
                        "amount": int(max(1, round(payout_amount * 100))),
                        "currency": "INR",
                        "receipt": f"claim_{simulation.id}",
                        "notes": {"worker_id": simulation.user_id, "zone_id": zone_id},
                    },
                )
            if resp.status_code == 200:
                razorpay_order_id = resp.json().get("id")
                payment_status = "completed"
        except Exception as exc:
            log.warning(
                "razorpay_ping_failed",
                engine_name="claims_engine",
                reason_code="RAZORPAY_FAIL",
                error=str(exc),
            )

    db.add(PayoutRecord(
        simulation_id=simulation.id,
        amount=payout_amount,
        currency="INR",
        payment_type="payout",
        razorpay_order_id=razorpay_order_id,
        status=payment_status,
    ))

    # Pool update delegated to pool_engine (single source of truth)
    from app.engines.pool_engine import update_pool_on_payout
    await update_pool_on_payout(db, zone_id, payout_amount)

    # Real-time push
    try:
        await publish_payout_credited(
            redis=redis,
            worker_id=simulation.user_id,
            claim_id=simulation.id,
            payout_amount=payout_amount,
            message=f"✅ ₹{int(round(payout_amount))} credited — disruption verified",
            zone_id=zone_id,
            disruption_type=disruption_type,
            correlation_id=correlation_id,
        )
    except Exception:
        pass

    return payment_status


# ── Main entry point ───────────────────────────────────────────────────────────

async def initiate_claims_for_disruption(
    db: AsyncSession,
    disruption_event: DisruptionEvent,
    *,
    redis: Any = None,
) -> list[dict[str, Any]]:
    """
    Full claims pipeline for a DisruptionEvent.
    Returns a list of result dicts, one per eligible worker.
    """
    zone_id = str(disruption_event.zone_id)
    disruption_type = str(disruption_event.disruption_type)
    results: list[dict[str, Any]] = []

    if not disruption_event.is_active:
        return []

    # ── Step 1: Eligible workers ───────────────────────────────────────────────
    eligible = await _get_eligible_workers(db, zone_id)
    if not eligible:
        log.info(
            "no_eligible_workers",
            engine_name="claims_engine",
            reason_code="NO_WORKERS",
            zone_id=zone_id,
            disruption_event_id=disruption_event.id,
        )
        return []

    # ── Step 3: Disruption duration (computed once, same event for all workers) ─
    disruption_hours = _disruption_duration_hours(disruption_event)
    severity = float(disruption_event.severity or 0.5)

    for user, profile, policy in eligible:
        correlation_id = str(uuid4())
        worker_result: dict[str, Any] = {
            "user_id": user.id,
            "zone_id": zone_id,
            "disruption_event_id": disruption_event.id,
            "disruption_hours": disruption_hours,
        }

        try:
            # ── Step 2: Duplicate guard ────────────────────────────────────────
            if await _already_claimed(db, user.id, disruption_event.id):
                worker_result["status"] = "skipped"
                worker_result["reason"] = "duplicate_claim"
                results.append(worker_result)
                continue

            db.add(ClaimLifecycle(
                claim_id=f"auto:{user.id}:{disruption_event.id}",
                correlation_id=correlation_id,
                user_id=user.id,
                zone_id=zone_id,
                disruption_type=disruption_type,
                status="auto_triggered",
                message=f"Auto-triggered for {disruption_type} disruption",
                payout_amount=0.0,
            ))
            await db.flush()

            try:
                await publish_claim_update(
                    redis=redis,
                    worker_id=user.id,
                    claim_id=f"auto:{user.id}:{disruption_event.id}",
                    status="claim_created",
                    message=f"Auto-triggered claim created for {disruption_type}",
                    zone_id=zone_id,
                    disruption_type=disruption_type,
                    correlation_id=correlation_id,
                )
            except Exception:
                pass

            # ── Step 4: Payout calculation (no DB writes yet — simulation_id unknown) ──
            payout_amount, payout_breakdown, _ = await PayoutEngine.compute_db_payout(
                db=db,
                user_id=user.id,
                profile=profile,
                zone_id=zone_id,
                disruption_hours=disruption_hours,
                severity=severity,
                simulation_id=None,
                disruption_start=disruption_event.started_at,
                disruption_type=disruption_type,
                correlation_id=correlation_id,
            )

            expected_loss = float(payout_breakdown.get("expected_loss", 0.0))
            severity_factor = float(payout_breakdown.get("severity_factor", severity))
            pool_factor = float(payout_breakdown.get("pool_factor", 1.0))
            zone_factor = float(payout_breakdown.get("zone_factor", 1.0))

            # ── Step 5: Fraud check ────────────────────────────────────────────
            fraud_score, fraud_flags = await check_fraud(
                db=db,
                user_id=user.id,
                zone_id=zone_id,
                policy=policy,
                profile=profile,
                disruption_event_id=disruption_event.id,
            )

            # ── Step 6: Status decision ────────────────────────────────────────
            if fraud_score < 0.4:
                claim_status = "approved"
                decision = DecisionType.APPROVED
            elif fraud_score < 0.6:
                claim_status = "review"
                decision = DecisionType.REVIEW
            else:
                claim_status = "rejected"
                decision = DecisionType.FRAUD

            reason = _build_reason(claim_status, fraud_score, disruption_type, disruption_hours)

            # ── Step 7: Store Simulation ───────────────────────────────────────
            sim = Simulation(
                user_id=user.id,
                disruption_event_id=disruption_event.id,
                is_active=False,
                fraud_flag=(fraud_score >= 0.3),
                fraud_score=fraud_score,
                weather_disruption=(disruption_type in ("rain", "heat")),
                traffic_disruption=False,
                event_disruption=(disruption_type in ("curfew", "strike", "zone_closure")),
                final_disruption=True,
                expected_income=expected_loss,
                actual_income=0.0,
                loss=expected_loss,
                payout=payout_amount if claim_status == "approved" else 0.0,
                decision=decision,
                reason=reason,
            )
            db.add(sim)
            await db.flush()
            await db.refresh(sim)

            # ── Step 8: Link FraudFlag rows ────────────────────────────────────
            for flag_type, flag_detail in fraud_flags:
                db.add(FraudFlag(
                    user_id=user.id,
                    simulation_id=sim.id,
                    flag_type=flag_type,
                    flag_detail=flag_detail,
                ))

            db.add(FraudSignal(
                user_id=user.id,
                simulation_id=sim.id,
                score=fraud_score,
                reason_code="CLAIMS_ENGINE",
                detail="; ".join(f[0] for f in fraud_flags) or "clean",
            ))

            # ── Step 9: Payout disbursement ────────────────────────────────────
            payment_status = "skipped"
            if claim_status == "approved":
                immediate = fraud_score < 0.2
                payment_status = await _disburse_payout(
                    db=db,
                    simulation=sim,
                    payout_amount=payout_amount,
                    zone_id=zone_id,
                    policy=policy,
                    redis=redis,
                    correlation_id=correlation_id,
                    disruption_type=disruption_type,
                    immediate=immediate,
                )
                profile.total_claims = int(profile.total_claims or 0) + 1
                profile.total_payouts = float(profile.total_payouts or 0.0) + payout_amount

            # ── Step 10: Trust score update ────────────────────────────────────
            if claim_status == "approved":
                delta = _TRUST_APPROVED_CLEAN if fraud_score < 0.1 else _TRUST_APPROVED_MED
            elif claim_status == "review":
                delta = _TRUST_REVIEW
            else:
                delta = _TRUST_REJECTED

            _apply_trust_delta(profile, delta)

            # Upsert ClaimLifecycle
            lc_status = "approved" if claim_status == "approved" else ("revalidating" if claim_status == "review" else "rejected")
            lc_row = (
                await db.execute(
                    select(ClaimLifecycle).where(
                        ClaimLifecycle.claim_id == f"auto:{user.id}:{disruption_event.id}",
                    )
                )
            ).scalar_one_or_none()

            if lc_row is not None:
                lc_row.status = lc_status
                lc_row.payout_amount = payout_amount if claim_status == "approved" else 0.0
                lc_row.message = reason
            else:
                db.add(ClaimLifecycle(
                    claim_id=f"auto:{user.id}:{disruption_event.id}",
                    correlation_id=correlation_id,
                    user_id=user.id,
                    zone_id=zone_id,
                    disruption_type=disruption_type,
                    status=lc_status,
                    message=reason,
                    payout_amount=payout_amount if claim_status == "approved" else 0.0,
                ))

            await db.commit()

            # Real-time status push
            try:
                await publish_claim_update(
                    redis=redis,
                    worker_id=user.id,
                    claim_id=sim.id,
                    status=("claim_approved" if claim_status == "approved" else "claim_created"),
                    message=reason,
                    payout_amount=payout_amount if claim_status == "approved" else None,
                    zone_id=zone_id,
                    disruption_type=disruption_type,
                    fraud_score=fraud_score,
                    correlation_id=correlation_id,
                )
            except Exception:
                pass

            worker_result.update({
                "status": claim_status,
                "simulation_id": sim.id,
                "fraud_score": fraud_score,
                "payout_amount": payout_amount if claim_status == "approved" else 0.0,
                "payment_status": payment_status,
                "trust_delta": delta,
                "breakdown": payout_breakdown,
            })

            log.info(
                "claim_processed",
                engine_name="claims_engine",
                reason_code="CLAIM_OK",
                user_id=user.id,
                zone_id=zone_id,
                claim_status=claim_status,
                fraud_score=fraud_score,
                payout_amount=payout_amount if claim_status == "approved" else 0.0,
            )

        except Exception as exc:
            await db.rollback()
            worker_result["status"] = "error"
            worker_result["error"] = str(exc)
            log.warning(
                "claim_worker_failed",
                engine_name="claims_engine",
                reason_code="WORKER_CLAIM_ERROR",
                user_id=user.id,
                zone_id=zone_id,
                error=str(exc),
            )

        results.append(worker_result)

    return results


def _build_reason(
    status: str,
    fraud_score: float,
    disruption_type: str,
    disruption_hours: float,
) -> str:
    h = f"{disruption_hours:.1f}h"
    if status == "approved":
        return f"Payout approved — {disruption_type} disruption ({h}) · fraud score {fraud_score:.2f}"
    if status == "review":
        return f"Claim held for review — fraud score {fraud_score:.2f} requires manual check"
    return f"Claim rejected — fraud score {fraud_score:.2f} exceeds threshold"
