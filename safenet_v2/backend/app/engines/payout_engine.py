import httpx
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.worker import Profile
from app.models.zone import Zone
from app.models.policy import Policy
from app.models.pool_balance import ZonePoolBalance
from app.models.claim import ClaimLifecycle
from app.models.payout import PayoutRecord
from app.services.earnings_dna_service import IST
from app.core.config import settings
from app.services.cache_service import cache_set_json
from app.services.forecast_shield_service import payout_message_suffix
from app.services.realtime_service import publish_claim_update, publish_payout_credited, publish_pool_health
from app.utils.logger import get_logger

log = get_logger(__name__)

PAYOUT_RATE = 0.6

_DOW = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")


def _slot_label_ist(start_dt: datetime) -> str:
    start_ist = start_dt.astimezone(IST)
    h = start_ist.hour
    if h == 0:
        hm = "12 AM"
    elif h < 12:
        hm = f"{h} AM"
    elif h == 12:
        hm = "12 PM"
    else:
        hm = f"{h - 12} PM"
    return f"{_DOW[start_ist.weekday()]} {hm} IST"


class PayoutEngine:
    @staticmethod
    def compute(loss: float, trust_score: float) -> tuple[float, str]:
        payout = round(float(loss) * PAYOUT_RATE * float(trust_score), 2)
        reason_code = "PAYOUT_FROM_LOSS_TRUST"
        log.info(
            "payout_computed",
            engine_name="payout_engine",
            decision=str(payout),
            reason_code=reason_code,
            payout=payout,
            loss=loss,
            trust_score=trust_score,
        )
        return payout, reason_code

    @staticmethod
    async def compute_db_payout(
        *,
        db: AsyncSession,
        user_id: int,
        profile: Profile,
        zone_id: str,
        disruption_hours: float,
        severity: float,
        simulation_id: Optional[int],
        disruption_start: Optional[datetime] = None,
        claim_id: Optional[str] = None,
        correlation_id: Optional[str] = None,
        disruption_type: Optional[str] = None,
    ) -> tuple[float, dict[str, Any], str]:
        from app.engines.earnings_engine import get_expected_hourly_rate
        from app.engines.pool_engine import update_pool_on_payout

        if disruption_hours <= 0:
            return 0.0, {"disruption_hours": 0, "final_payout": 0.0}, "ZERO_DISRUPTION_HOURS"

        # Exact pipeline formula:
        # payout = earnings_dna_hourly_rate × disruption_hours × coverage_multiplier
        # constraints: disruption_hours min 1, max 8
        disruption_hours = max(1.0, min(float(disruption_hours), 8.0))

        # Anchor start time - use disruption_start if provided, else now
        start_dt = disruption_start or datetime.now(timezone.utc).astimezone(IST)
        if start_dt.tzinfo is None:
            start_dt = start_dt.replace(tzinfo=timezone.utc)

        # 1) DNA hourly rate for current slot, with explicit zone baseline fallback.
        hourly_rate = await get_expected_hourly_rate(db, user_id, start_dt)
        zone_baseline = None
        zone_row = (
            await db.execute(select(Zone).where(Zone.city_code == zone_id))
        ).scalar_one_or_none()
        if hourly_rate <= 1:
            rt = str(getattr(zone_row, "risk_tier", "medium") or "medium").lower()
            if rt == "high":
                zone_baseline = 120.0
            elif rt == "low":
                zone_baseline = 80.0
            else:
                zone_baseline = 100.0
            hourly_rate = zone_baseline

        # 2) Coverage multiplier from tier
        coverage_multiplier = 0.85
        tier = str(getattr(profile, "coverage_tier", "") or "").strip().lower()
        if not tier:
            p_tier = (
                await db.execute(
                    select(Policy.tier)
                    .where(Policy.user_id == user_id, Policy.status == "active")
                    .order_by(Policy.created_at.desc())
                )
            ).scalar_one_or_none()
            tier = str(p_tier or "").strip().lower()
        if tier == "basic":
            coverage_multiplier = 0.7
        elif tier == "pro":
            coverage_multiplier = 1.0

        # 3) Weekly cap (policy coverage cap)
        policy_row = (
            await db.execute(
                select(Policy)
                .where(Policy.user_id == user_id, Policy.status == "active")
                .order_by(Policy.created_at.desc())
            )
        ).scalar_one_or_none()
        weekly_cap = float(policy_row.coverage_cap) if (policy_row and policy_row.coverage_cap) else 700.0

        raw_payout = float(hourly_rate) * float(disruption_hours) * float(coverage_multiplier)
        final_payout = round(min(raw_payout, weekly_cap), 2)

        reason_code = "PAYOUT_DB_FORMULA"
        slot_label = _slot_label_ist(start_dt)
        tier_disp = (tier or "standard").strip().title() if tier else "Standard"
        breakdown: dict[str, Any] = {
            "hourly_rate": round(float(hourly_rate), 2),
            "disruption_hours": disruption_hours,
            "coverage_multiplier": coverage_multiplier,
            "tier": tier or "standard",
            "tier_display": tier_disp,
            "slot_label": slot_label,
            "raw_payout": round(raw_payout, 2),
            "weekly_cap": round(float(weekly_cap), 2),
            "zone_baseline_used": zone_baseline,
            "final_payout": final_payout,
            "explanation": {
                "formula": "hourly_rate * disruption_hours * coverage_multiplier",
                "hourly_rate": round(float(hourly_rate), 2),
                "disruption_hours": disruption_hours,
                "coverage_multiplier": coverage_multiplier,
                "weekly_cap": round(float(weekly_cap), 2),
            },
        }

        log.info(
            "payout_db_computed",
            engine_name="payout_engine",
            decision=str(final_payout),
            reason_code=reason_code,
            worker_id=user_id,
            zone_id=zone_id,
            expected_loss=raw_payout,
            severity=severity,
            pool_factor=1.0,
            zone_factor=1.0,
            coverage_cap=weekly_cap,
            final_payout=final_payout,
        )

        # ── 7. Persist PayoutRecord + upsert ClaimLifecycle (only if simulation_id known) ───────────────────
        if simulation_id is not None:
            db.add(PayoutRecord(
                simulation_id=simulation_id,
                amount=final_payout,
                currency="INR",
                payment_type="payout",
                status="completed",
            ))

            lc_row = (
                await db.execute(
                    select(ClaimLifecycle).where(
                        ClaimLifecycle.claim_id == (claim_id or str(simulation_id))
                    )
                )
            ).scalar_one_or_none()

            if lc_row is None:
                db.add(ClaimLifecycle(
                    claim_id=claim_id or str(simulation_id),
                    correlation_id=correlation_id or str(simulation_id),
                    user_id=user_id,
                    zone_id=zone_id,
                    disruption_type=disruption_type or "",
                    status="PAYOUT",
                    message=f"Payout ₹{int(round(final_payout))} — {disruption_hours}h disruption",
                    payout_amount=final_payout,
                ))
            else:
                lc_row.status = "PAYOUT"
                lc_row.payout_amount = final_payout
                lc_row.message = f"Payout ₹{int(round(final_payout))} — {disruption_hours}h disruption"

            # Flush all pending writes before pool commit
            await db.flush()
            await update_pool_on_payout(db, zone_id, final_payout)

        return final_payout, breakdown, reason_code

    @staticmethod
    async def publish_payout_after_disbursement(
        *,
        redis: Any,
        claim_id: Any,
        worker_id: int,
        payout_amount: float,
        zone_id: str | None = None,
        disruption_type: str | None = None,
        correlation_id: str | None = None,
        forecast_shields: dict[str, Any] | None = None,
    ) -> None:
        # Razorpay test-mode ping (best-effort). If unavailable, continue with recorded payout event.
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                await client.post(
                    "https://api.razorpay.com/v1/orders",
                    auth=(settings.RAZORPAY_KEY_ID, settings.RAZORPAY_KEY_SECRET),
                    json={
                        "amount": int(max(1, round(float(payout_amount) * 100))),
                        "currency": "INR",
                        "receipt": f"claim_{claim_id}",
                        "notes": {"worker_id": worker_id},
                    },
                )
        except Exception as exc:
            log.warning(
                "razorpay_test_call_failed",
                engine_name="payout_engine",
                reason_code="RAZORPAY_TEST_FAIL",
                error=str(exc),
                worker_id=worker_id,
            )

        fs = forecast_shields if isinstance(forecast_shields, dict) else None
        fs_suffix = payout_message_suffix(fs, zone_id, datetime.now(timezone.utc))
        await publish_claim_update(
            redis=redis,
            worker_id=worker_id,
            claim_id=claim_id,
            status="PAYOUT",
            message="Payout disbursed" + fs_suffix,
            payout_amount=payout_amount,
            zone_id=zone_id,
            disruption_type=disruption_type,
            correlation_id=correlation_id,
        )
        await publish_payout_credited(
            redis=redis,
            worker_id=worker_id,
            claim_id=claim_id,
            payout_amount=payout_amount,
            message=(
                f"✅ ₹{int(round(payout_amount))} credited — disruption verified in your zone{fs_suffix}"
            ),
            zone_id=zone_id,
            disruption_type=disruption_type,
            correlation_id=correlation_id,
        )
        try:
            from app.db.session import AsyncSessionLocal
            async with AsyncSessionLocal() as _db:
                pool_row = (
                    await _db.execute(
                        select(ZonePoolBalance)
                        .where(ZonePoolBalance.zone_id == (zone_id or "unknown_zone"))
                        .order_by(ZonePoolBalance.week_start.desc())
                    )
                ).scalar_one_or_none()
            if pool_row is not None:
                est_balance = float(pool_row.current_balance or 0.0)
                premiums = float(pool_row.total_premiums_collected or 0.0)
                payouts = float(pool_row.total_payouts_disbursed or 0.0)
                util = round(min(100.0, (payouts / premiums * 100.0)) if premiums > 0 else 0.0, 2)
            else:
                est_balance = 0.0
                util = 0.0
            zone_key = f"zone_pool:{zone_id or 'unknown_zone'}"
            risk_level = "HIGH" if util >= 80 else ("MEDIUM" if util >= 50 else "LOW")
            await cache_set_json(
                redis,
                zone_key,
                {"balance": est_balance, "utilization_pct": util, "risk_level": risk_level},
                ttl_seconds=300,
            )
            await publish_pool_health(
                redis=redis,
                zone_id=zone_id or "unknown_zone",
                balance=est_balance,
                utilization_pct=util,
                risk_level=risk_level,
                correlation_id=correlation_id,
            )
        except Exception:
            pass
