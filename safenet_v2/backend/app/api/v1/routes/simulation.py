from __future__ import annotations

import asyncio
import json
import traceback
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.routes.workers import get_current_user
from app.db.session import AsyncSessionLocal, get_db
from app.engines.fraud_engine_claims import check_fraud
from app.engines.payout_engine import PayoutEngine
from app.models.claim import DecisionType, Log, Simulation
from app.models.fraud import FraudFlag, FraudSignal
from app.models.payout import PayoutRecord
from app.models.policy import Policy
from app.models.worker import Profile, User
from app.services.forecast_shield_service import payout_message_suffix
from app.services.notification_service import create_notification
from app.services.onboarding_pricing import TIER_MAX_DAILY as ONBOARDING_TIER_MAX_DAILY
from app.engines.trust_payout import payout_delay_seconds, trust_points_from_profile
from app.engines.dual_gate import evaluate_gate2, gate_status_payload
from app.models.zone import Zone
from app.services.realtime_service import publish_claim_update
from app.utils.logger import get_logger

log = get_logger(__name__)

router = APIRouter()

TIER_MAX_DAILY: dict[str, float] = dict(ONBOARDING_TIER_MAX_DAILY)

_SCENARIO_HOURS: dict[str, float] = {
    "HEAVY_RAIN": 5.0,
    "EXTREME_HEAT": 4.0,
    "AQI_SPIKE": 4.0,
    "CURFEW": 6.0,
}

_SCENARIO_SEVERITY: dict[str, float] = {
    "HEAVY_RAIN": 0.85,
    "EXTREME_HEAT": 0.75,
    "AQI_SPIKE": 0.70,
    "CURFEW": 0.90,
}


def _product_to_tier(product_code: str | None) -> str:
    if not product_code:
        return "Standard"
    low = str(product_code).lower()
    if "basic" in low:
        return "Basic"
    if "pro" in low:
        return "Pro"
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


def _sim_gate1_strings(scenario: str) -> tuple[str, str]:
    if scenario == "HEAVY_RAIN":
        return "OpenWeatherMap", "38mm/hr rain"
    if scenario == "EXTREME_HEAT":
        return "OpenWeatherMap", "43°C heat index"
    if scenario == "AQI_SPIKE":
        return "OpenAQ", "AQI 340 hazardous"
    return "Government feed", "Curfew / zone disruption confirmed"


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
    zone_id: str = Field(default="", max_length=128)
    worker_id: int | None = None
    fast_mode: bool = True
    fraud_mode: Literal["NONE", "GPS_SPOOF", "RING_FRAUD_5"] = "NONE"
    worker_count: int = Field(1, ge=1, le=50)


class SimulationStartedResponse(BaseModel):
    simulation_id: str


async def _sim_pipeline(
    app: Any,
    body: SimulationRunRequest,
    run_id: str,
    worker_id: int,
) -> None:
    redis = getattr(app.state, "redis", None)
    step_delay = 0.9 if body.fast_mode else 1.2

    try:
        async with AsyncSessionLocal() as db:
            prof_row = (
                await db.execute(select(Profile).where(Profile.user_id == worker_id))
            ).scalar_one_or_none()

            zone_id = (body.zone_id or "").strip()
            if not zone_id and prof_row and (prof_row.zone_id or "").strip():
                zone_id = prof_row.zone_id.strip()
            if not zone_id:
                zone_id = "hyd_central"
            zone_label = _zone_label(zone_id)

            pol = (
                await db.execute(
                    select(Policy)
                    .where(Policy.user_id == worker_id, Policy.status == "active")
                    .order_by(Policy.id.desc())
                    .limit(1)
                )
            ).scalar_one_or_none()
            tier = _product_to_tier(pol.product_code if pol else None)
            daily_cap = float(TIER_MAX_DAILY.get(tier, 700.0))

            # ── Duplicate guard: same scenario already approved today ──────────
            ist_offset = timezone(timedelta(hours=5, minutes=30))
            now_utc = datetime.now(timezone.utc)
            start_ist = now_utc.astimezone(ist_offset).replace(
                hour=0, minute=0, second=0, microsecond=0
            )
            start_utc = start_ist.astimezone(timezone.utc)

            approved_today = (
                await db.execute(
                    select(Simulation)
                    .where(
                        Simulation.user_id == worker_id,
                        Simulation.decision == DecisionType.APPROVED,
                        Simulation.created_at >= start_utc,
                    )
                    .order_by(Simulation.created_at.desc())
                    .limit(20)
                )
            ).scalars().all()

            approved_scenarios: set[str] = set()
            for s in approved_today:
                try:
                    wd = json.loads(s.weather_data) if isinstance(s.weather_data, str) and s.weather_data else {}
                except Exception:
                    wd = {}
                sc = str((wd or {}).get("scenario") or "").upper().strip()
                if sc:
                    approved_scenarios.add(sc)
            same_disruption_already_paid = body.scenario in approved_scenarios
            already_paid = len(approved_today) > 0

            disruption_start = now_utc
            zone_orm = (
                await db.execute(select(Zone).where(func.lower(Zone.city_code) == zone_id.lower()))
            ).scalar_one_or_none()
            g1_src, g1_val = _sim_gate1_strings(body.scenario)
            if prof_row is not None:
                prof_row.last_api_call = now_utc - timedelta(minutes=23)
                prof_row.last_seen = now_utc
                if zone_orm is not None:
                    if zone_orm.lat is not None:
                        prof_row.last_known_lat = float(zone_orm.lat)
                    if zone_orm.lng is not None:
                        prof_row.last_known_lng = float(zone_orm.lng)
                    zone_orm.orders_last_hour = float(zone_orm.zone_baseline_orders or 100.0) * 0.42
            g2_eval = evaluate_gate2(prof_row, zone_orm, disruption_start) if prof_row is not None else None

            # ── Payout calculation via real engine ────────────────────────────
            disruption_hours = _SCENARIO_HOURS.get(body.scenario, 4.0)
            severity = _SCENARIO_SEVERITY.get(body.scenario, 0.75)

            if prof_row is not None:
                payout_amount, breakdown, _ = await PayoutEngine.compute_db_payout(
                    db=db,
                    user_id=worker_id,
                    profile=prof_row,
                    zone_id=zone_id,
                    disruption_hours=disruption_hours,
                    severity=severity,
                    simulation_id=None,
                    disruption_start=disruption_start,
                    disruption_type=body.scenario,
                    correlation_id=run_id,
                )
            else:
                payout_amount = 0.0
                breakdown = {"final_payout": 0.0, "expected_loss": 0.0}

            expected_loss = float(
                breakdown.get("expected_loss")
                or breakdown.get("raw_payout")
                or breakdown.get("final_payout")
                or 0.0
            )

            # ── Fraud check ───────────────────────────────────────────────────
            fraud_score = 0.0
            fraud_flags: list[tuple[str, str]] = []
            if prof_row is not None and pol is not None:
                fraud_score, fraud_flags = await check_fraud(
                    db=db,
                    user_id=worker_id,
                    zone_id=zone_id,
                    policy=pol,
                    profile=prof_row,
                )

            fraud_flag_sim = body.fraud_mode != "NONE" or fraud_score >= 0.6

            no_active_policy = pol is None
            no_payout = already_paid or fraud_flag_sim or no_active_policy
            if no_payout:
                payout_amount = 0.0
                decision = DecisionType.REJECTED
                if no_active_policy:
                    reason = "Coverage not active. Activate your plan before running disruption payout simulations."
                elif already_paid:
                    if same_disruption_already_paid:
                        reason = f"{body.scenario.replace('_', ' ').title()} already simulated and paid today. Try again tomorrow."
                    elif body.scenario == "AQI_SPIKE":
                        reason = (
                            "AQI is currently in the safer / moderate band — no extra payout on this run. "
                            "Check back when air quality spikes into the hazardous range for your zone."
                        )
                    elif body.scenario == "HEAVY_RAIN":
                        reason = (
                            "Rain intensity is not in the severe band needed for another payout window right now."
                        )
                    elif body.scenario == "EXTREME_HEAT":
                        reason = (
                            "Heat stress is not in the extreme band needed for another payout on this run."
                        )
                    else:
                        reason = "Payout for this scenario was already credited today. Next eligible window starts tomorrow."
                else:
                    reason = f"Claim rejected — fraud score {fraud_score:.2f}"
            else:
                decision = DecisionType.APPROVED
                reason = f"Payout approved — {body.scenario.replace('_', ' ').lower()} disruption ({disruption_hours:.0f}h)"

            temp_c = 33.0
            if body.scenario == "EXTREME_HEAT":
                temp_c = 41.0
            elif body.scenario == "HEAVY_RAIN":
                temp_c = 28.0
            elif body.scenario == "AQI_SPIKE":
                temp_c = 34.0
            wx_label = body.scenario.replace("_", " ").lower()
            weather_display = (
                f"Weather: OpenWeatherMap ({temp_c:.0f}C, {wx_label} confirmed)"
            )
            aqi_display = "AQI: OpenAQ / Open-Meteo (zone corroboration)"
            try:
                from app.services.aqi_service import AQIService
                from app.services.signal_types import AQISignal

                city_nm = (prof_row.city if prof_row else "Hyderabad") or "Hyderabad"
                res = await AQIService(redis=redis).fetch_aqi(city_nm, zone_id)
                if isinstance(res, AQISignal):
                    aqi_display = (
                        f"AQI: OpenAQ / Open-Meteo (AQI {int(round(res.aqi_value))}, {res.category})"
                    )
            except Exception:
                pass

            weather_payload: dict[str, Any] = {
                "scenario": body.scenario,
                "zone_id": zone_id,
                "run_id": run_id,
                "breakdown": breakdown if isinstance(breakdown, dict) else {},
                "weather_display": weather_display,
                "aqi_display": aqi_display,
                "disruption_start": disruption_start.isoformat(),
                "disruption_hours": disruption_hours,
            }

            sim = Simulation(
                user_id=worker_id,
                is_active=False,
                fraud_flag=fraud_flag_sim,
                fraud_score=fraud_score,
                weather_disruption=body.scenario in ("HEAVY_RAIN", "EXTREME_HEAT"),
                traffic_disruption=False,
                event_disruption=body.scenario == "CURFEW",
                final_disruption=not no_payout,
                expected_income=expected_loss,
                actual_income=0.0,
                loss=expected_loss,
                payout=payout_amount,
                decision=decision,
                reason=reason,
                weather_data=json.dumps(weather_payload),
            )
            db.add(sim)
            await db.flush()
            await db.refresh(sim)
            cid = sim.id
            sim.gate1_passed = True
            sim.gate1_source = g1_src
            sim.gate1_value = g1_val
            sim.gate2_passed = bool(g2_eval.passed) if g2_eval is not None else True
            sim.gate2_signals = dict(g2_eval.signals) if g2_eval is not None else None

            # Persist PayoutRecord + pool update now that sim.id is known
            if not no_payout and payout_amount > 0:
                db.add(PayoutRecord(
                    simulation_id=cid,
                    amount=payout_amount,
                    currency="INR",
                    payment_type="payout",
                    status="completed",
                ))
                from app.engines.pool_engine import update_pool_on_payout
                await update_pool_on_payout(db, zone_id, payout_amount)

            # Persist fraud signals
            for flag_type, flag_detail in fraud_flags:
                db.add(FraudFlag(
                    user_id=worker_id,
                    simulation_id=cid,
                    flag_type=flag_type,
                    flag_detail=flag_detail,
                ))
            db.add(FraudSignal(
                user_id=worker_id,
                simulation_id=cid,
                score=fraud_score,
                reason_code="SIM_PIPELINE",
                detail="; ".join(f[0] for f in fraud_flags) or "clean",
            ))
            db.add(Log(
                user_id=worker_id,
                event_type="simulation_run",
                detail=f"decision={decision.value} payout={payout_amount} run={run_id}",
            ))

            if prof_row is not None:
                prof_row.total_claims = int(prof_row.total_claims or 0) + 1
                if not no_payout:
                    prof_row.total_payouts = float(prof_row.total_payouts or 0.0) + payout_amount

            # ── WebSocket progress steps ──────────────────────────────────────
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
                message="Verifying disruption signals...",
                zone_id=zone_id,
                disruption_type=body.scenario,
                correlation_id=run_id,
            )
            await asyncio.sleep(step_delay)

            if g2_eval is not None:
                gs = gate_status_payload(
                    True,
                    bool(g2_eval.passed),
                    f"Gate 1: {g1_val} | Gate 2: {g2_eval.human_summary}",
                )
                gm = [
                    f"Gate 1: Disruption confirmed — {g1_val} ✅",
                    f"Gate 2: Verifying you were working... ✅ {g2_eval.human_summary}",
                ]
                await publish_claim_update(
                    redis=redis,
                    worker_id=worker_id,
                    claim_id=cid,
                    status="GATE_CHECK",
                    message=gm[0],
                    zone_id=zone_id,
                    disruption_type=body.scenario,
                    correlation_id=run_id,
                    gate_status=gs,
                    gate_messages=gm,
                )
                await asyncio.sleep(step_delay * 0.5)
                await publish_claim_update(
                    redis=redis,
                    worker_id=worker_id,
                    claim_id=cid,
                    status="GATE_CHECK",
                    message=gm[1],
                    zone_id=zone_id,
                    disruption_type=body.scenario,
                    correlation_id=run_id,
                    gate_status=gs,
                    gate_messages=gm,
                )
                await asyncio.sleep(step_delay * 0.5)

            await publish_claim_update(
                redis=redis,
                worker_id=worker_id,
                claim_id=cid,
                status="FRAUD_CHECK",
                message="Running safety checks...",
                zone_id=zone_id,
                disruption_type=body.scenario,
                correlation_id=run_id,
                fraud_score=fraud_score,
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

            shields = getattr(app.state, "forecast_shields", None) or {}
            fs_suffix = payout_message_suffix(
                shields if isinstance(shields, dict) else {},
                zone_id,
                now_utc,
            )

            if no_payout:
                final_status = "NO_PAYOUT" if already_paid else ("CLAIM_REJECTED" if fraud_flag_sim else "NO_PAYOUT")
            else:
                final_status = "APPROVED"
            final_message = reason if no_payout else (_approved_message(body.scenario, payout_amount) + fs_suffix)

            if not no_payout:
                await create_notification(
                    db,
                    user_id=worker_id,
                    ntype="payout",
                    title=f"₹{int(round(payout_amount))} credited",
                    message="Disruption verified. Payout added to your wallet.",
                )

            await db.commit()

            try:
                from app.services.claim_ai import persist_ai_explanation_for_simulation_id

                await persist_ai_explanation_for_simulation_id(db, cid)
                await db.commit()
            except Exception:
                await db.rollback()

            try:
                if not no_payout and final_status == "APPROVED":
                    delay = payout_delay_seconds(trust_points_from_profile(prof_row))
                    if delay > 0:
                        await publish_claim_update(
                            redis=redis,
                            worker_id=worker_id,
                            claim_id=cid,
                            status="PROCESSING_PAYOUT",
                            message=f"Payout in {delay} seconds… (trust-based timing)",
                            payout_amount=payout_amount,
                            zone_id=zone_id,
                            disruption_type=body.scenario,
                            fraud_score=fraud_score,
                            correlation_id=run_id,
                            payout_breakdown=breakdown,
                            daily_coverage=daily_cap,
                            payout_countdown_seconds=delay,
                        )
                        await asyncio.sleep(float(delay))
                await publish_claim_update(
                    redis=redis,
                    worker_id=worker_id,
                    claim_id=cid,
                    status=final_status,
                    message=final_message,
                    payout_amount=payout_amount if not no_payout else None,
                    zone_id=zone_id,
                    disruption_type=body.scenario,
                    fraud_score=fraud_score,
                    correlation_id=run_id,
                    payout_breakdown=breakdown,
                    daily_coverage=daily_cap,
                )
            except Exception:
                pass

    except Exception as exc:
        log.error(
            "sim_pipeline_failed",
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
    if (await db.execute(select(User).where(User.id == target_wid))).scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="User not found")

    simulation_id = str(uuid.uuid4())
    asyncio.create_task(_sim_pipeline(request.app, body, simulation_id, target_wid))
    return SimulationStartedResponse(simulation_id=simulation_id)


@router.post("/disruptions/simulate", response_model=SimulationStartedResponse, status_code=202)
async def simulate_disruption_alias(
    request: Request,
    body: SimulationRunRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await run_simulation(request=request, body=body, current_user=current_user, db=db)
