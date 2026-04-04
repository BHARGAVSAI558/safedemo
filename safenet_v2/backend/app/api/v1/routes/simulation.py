from __future__ import annotations

import asyncio
import json
import traceback
import uuid
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.routes.workers import get_current_user
from app.db.session import AsyncSessionLocal, get_db
from app.engines.payout_engine import PayoutEngine
from app.models.claim import DecisionType, Log, Simulation
from app.models.fraud import FraudSignal
from app.models.payout import PayoutRecord
from app.models.policy import Policy
from app.models.worker import Profile, User
from app.services.forecast_shield_service import payout_message_suffix
from app.services.realtime_service import publish_claim_update
from app.utils.logger import get_logger

log = get_logger(__name__)

router = APIRouter()

TIER_MAX_DAILY: dict[str, float] = {
    "Basic": 500.0,
    "Standard": 1000.0,
    "Pro": 2000.0,
}


def _product_to_tier(product_code: str | None) -> str:
    if not product_code:
        return "Standard"
    low = str(product_code).lower()
    if "pro" in low and "standard" not in low:
        return "Pro"
    if "basic" in low:
        return "Basic"
    return "Standard"


def _zone_label(zone_id: str) -> str:
    raw = zone_id.strip().replace("-", "_")
    segs = [s for s in raw.split("_") if s]
    if not segs:
        return zone_id
    if "hitec" in raw.lower():
        return "HITEC City"
    focus = segs[-1]
    return (focus[:1].upper() + focus[1:].lower()) if focus else zone_id


def _initiated_message(scenario: str, zone_label: str) -> str:
    if scenario == "HEAVY_RAIN":
        return f"Heavy rain detected in {zone_label} zone"
    if scenario == "EXTREME_HEAT":
        return f"Extreme heat detected in {zone_label} zone"
    if scenario == "AQI_SPIKE":
        return f"Hazardous AQI spike in {zone_label} zone"
    return f"Zone curfew active — {zone_label}"


def _approved_message(scenario: str, payout: float) -> str:
    p = int(round(float(payout)))
    if scenario == "HEAVY_RAIN":
        return f"₹{p} credited — rain verified in your zone"
    if scenario == "EXTREME_HEAT":
        return f"₹{p} credited — heat stress verified in your zone"
    if scenario == "AQI_SPIKE":
        return f"₹{p} credited — air quality hazard verified in your zone"
    return f"₹{p} credited — curfew disruption verified in your zone"


class SimulationRunRequest(BaseModel):
    scenario: Literal["HEAVY_RAIN", "EXTREME_HEAT", "AQI_SPIKE", "CURFEW"]
    zone_id: str = Field(..., min_length=1)
    worker_id: int | None = None
    fast_mode: bool = True
    fraud_mode: Literal["NONE", "GPS_SPOOF", "RING_FRAUD_5"] = "NONE"
    worker_count: int = Field(1, ge=1, le=50)


class SimulationStartedResponse(BaseModel):
    simulation_id: str


async def _demo_claim_pipeline(
    app: Any,
    body: SimulationRunRequest,
    run_id: str,
    worker_id: int,
) -> None:
    redis = getattr(app.state, "redis", None)
    step_delay = 1.5 if body.fast_mode else 3.0
    zone_id = body.zone_id.strip()
    zone_label = _zone_label(zone_id)

    try:
        async with AsyncSessionLocal() as db:
            prof_row = await db.execute(select(Profile).where(Profile.user_id == worker_id))
            profile = prof_row.scalar_one_or_none()
            if not profile:
                log.warning("demo_sim_no_profile", worker_id=worker_id)
                return

            pol = (
                await db.execute(
                    select(Policy)
                    .where(Policy.user_id == worker_id, Policy.status == "active")
                    .order_by(Policy.id.desc())
                    .limit(1)
                )
            ).scalar_one_or_none()
            tier = _product_to_tier(pol.product_code if pol else None)
            daily_cap = float(TIER_MAX_DAILY.get(tier, 1000.0))

            sims_for_dna = (
                (
                    await db.execute(
                        select(Simulation)
                        .where(Simulation.user_id == worker_id)
                        .order_by(Simulation.created_at.desc())
                        .limit(800)
                    )
                )
                .scalars()
                .all()
            )

            payout, breakdown, expected_slot = PayoutEngine.compute_demo_dna_payout(
                body.scenario,
                profile,
                daily_cap,
                sims_for_dna,
            )
            raw_loss = float(breakdown["loss"])
            actual_income = max(0.0, round(float(expected_slot) - raw_loss, 2))

            weather_payload = {"scenario": body.scenario, "zone_id": zone_id, "run_id": run_id}

            sim = Simulation(
                user_id=worker_id,
                is_active=False,
                fraud_flag=False,
                fraud_score=0.1,
                weather_disruption=body.scenario in ("HEAVY_RAIN", "EXTREME_HEAT"),
                traffic_disruption=False,
                event_disruption=body.scenario == "CURFEW",
                final_disruption=True,
                expected_income=float(expected_slot),
                actual_income=actual_income,
                loss=raw_loss,
                payout=payout,
                decision=DecisionType.APPROVED,
                reason=f"Demo approved — {body.scenario}",
                weather_data=json.dumps(weather_payload),
            )
            db.add(sim)
            await db.flush()
            await db.refresh(sim)
            cid = sim.id

            await publish_claim_update(
                redis=redis,
                worker_id=worker_id,
                claim_id=cid,
                status="INITIATED",
                message=_initiated_message(body.scenario, zone_label),
                zone_id=zone_id,
                disruption_type=body.scenario,
                correlation_id=run_id,
            )
            await asyncio.sleep(step_delay)

            await publish_claim_update(
                redis=redis,
                worker_id=worker_id,
                claim_id=cid,
                status="VERIFYING",
                message="Checking OpenWeatherMap signal...",
                zone_id=zone_id,
                disruption_type=body.scenario,
                correlation_id=run_id,
            )
            await asyncio.sleep(step_delay)

            await publish_claim_update(
                redis=redis,
                worker_id=worker_id,
                claim_id=cid,
                status="BEHAVIORAL_CHECK",
                message="Analyzing your activity pattern...",
                zone_id=zone_id,
                disruption_type=body.scenario,
                correlation_id=run_id,
            )
            await asyncio.sleep(step_delay)

            await publish_claim_update(
                redis=redis,
                worker_id=worker_id,
                claim_id=cid,
                status="FRAUD_CHECK",
                message="GPS integrity verified ✓",
                zone_id=zone_id,
                disruption_type=body.scenario,
                correlation_id=run_id,
                fraud_score=0.1,
            )
            await asyncio.sleep(step_delay)

            shields = getattr(app.state, "forecast_shields", None) or {}
            fs_suffix = payout_message_suffix(
                shields if isinstance(shields, dict) else {},
                zone_id,
                datetime.now(timezone.utc),
            )
            await publish_claim_update(
                redis=redis,
                worker_id=worker_id,
                claim_id=cid,
                status="APPROVED",
                message=_approved_message(body.scenario, payout) + fs_suffix,
                payout_amount=payout,
                zone_id=zone_id,
                disruption_type=body.scenario,
                fraud_score=0.1,
                correlation_id=run_id,
                payout_breakdown=breakdown,
                daily_coverage=daily_cap,
            )

            profile.total_claims = int(profile.total_claims or 0) + 1
            profile.total_payouts = float(profile.total_payouts or 0.0) + float(payout)
            db.add(PayoutRecord(simulation_id=cid, amount=payout, currency="INR", status="completed"))
            db.add(
                FraudSignal(
                    user_id=worker_id,
                    simulation_id=cid,
                    score=0.1,
                    reason_code="DEMO_SIM",
                    detail="judge_demo_pipeline",
                )
            )
            db.add(
                Log(
                    user_id=worker_id,
                    event_type="simulation_run",
                    detail=f"decision=APPROVED payout={payout} run={run_id}",
                )
            )
            await db.commit()

    except Exception as exc:
        log.error(
            "demo_sim_pipeline_failed",
            engine_name="simulation_route",
            simulation_id=run_id,
            error=str(exc),
            traceback=traceback.format_exc(),
        )


@router.post("/run", response_model=SimulationStartedResponse, status_code=202)
async def run_simulation(
    request: Request,
    body: SimulationRunRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if body.worker_id is not None and body.worker_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="worker_id must match the authenticated user",
        )

    target_wid = body.worker_id if body.worker_id is not None else current_user.id
    user_row = await db.execute(select(User).where(User.id == target_wid))
    if user_row.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="User not found")

    simulation_id = str(uuid.uuid4())
    asyncio.create_task(_demo_claim_pipeline(request.app, body, simulation_id, target_wid))
    return SimulationStartedResponse(simulation_id=simulation_id)
