"""Persist Gemini AI explanations onto Simulation rows."""
from __future__ import annotations

import json
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.claim import ClaimLifecycle, Simulation
from app.models.worker import Profile, User
from app.models.zone import Zone
from app.services.gemini_dispute import explain_claim_decision
from app.utils.logger import get_logger

log = get_logger(__name__)


def _status_from_sim(sim: Simulation) -> str:
    from app.models.claim import DecisionType

    if sim.decision == DecisionType.APPROVED and float(sim.payout or 0) > 0:
        return "approved"
    if sim.decision == DecisionType.REJECTED:
        return "rejected"
    if sim.decision == DecisionType.REVIEW:
        return "review"
    if sim.decision == DecisionType.FRAUD:
        return "rejected"
    return "unknown"


async def persist_ai_explanation_for_simulation_id(db: AsyncSession, simulation_id: int) -> None:
    sim = (await db.execute(select(Simulation).where(Simulation.id == int(simulation_id)))).scalar_one_or_none()
    if sim is None:
        return
    profile = (await db.execute(select(Profile).where(Profile.user_id == sim.user_id))).scalar_one_or_none()
    user = (await db.execute(select(User).where(User.id == sim.user_id))).scalar_one_or_none()
    z: Optional[Zone] = None
    if profile and profile.zone_id:
        z = (
            await db.execute(
                select(Zone).where(Zone.city_code == profile.zone_id)  # noqa: SIM114
            )
        ).scalar_one_or_none()
        if z is None:
            from sqlalchemy import func

            z = (
                await db.execute(select(Zone).where(func.lower(Zone.city_code) == str(profile.zone_id).lower()))
            ).scalar_one_or_none()
    zone_name = z.name if z else (profile.zone_id if profile else "your zone")
    wd: dict[str, Any] = {}
    if sim.weather_data:
        try:
            wd = json.loads(sim.weather_data) if isinstance(sim.weather_data, str) else {}
        except Exception:
            wd = {}
    breakdown = wd.get("breakdown") or {}
    dna_rate = float(breakdown.get("hourly_rate") or sim.expected_income or 58.0)
    hours = float(breakdown.get("disruption_hours") or 2.5)
    tier_mult = float(breakdown.get("coverage_multiplier") or 0.8)

    gate_results = {
        "gate1_source": getattr(sim, "gate1_source", None) or "APIs",
        "gate1_value": getattr(sim, "gate1_value", None) or wd.get("weather_display") or "disruption data",
        "gate2_passed": bool(getattr(sim, "gate2_passed", True)),
    }

    lc = (
        await db.execute(
            select(ClaimLifecycle)
            .where(
                ClaimLifecycle.user_id == sim.user_id,
                ClaimLifecycle.disruption_type.is_not(None),
            )
            .order_by(ClaimLifecycle.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if lc and (lc.gate1_source or lc.gate1_value):
        gate_results["gate1_source"] = lc.gate1_source or gate_results["gate1_source"]
        gate_results["gate1_value"] = lc.gate1_value or gate_results["gate1_value"]
        gate_results["gate2_passed"] = bool(lc.gate2_passed)

    claim_dict = {
        "disruption_type": wd.get("scenario") or "disruption",
        "created_at": str(sim.created_at or ""),
        "status": _status_from_sim(sim),
        "dna_rate": dna_rate,
        "duration_hours": hours,
        "tier_multiplier": tier_mult,
    }
    worker_dict = {
        "name": profile.name if profile else (user.phone if user else "Worker"),
        "platform": profile.platform if profile else "—",
    }
    zone_dict = {"name": zone_name}
    fraud_result = {"fraud_score": float(sim.fraud_score or 0.0)}
    payout = float(sim.payout or 0.0)

    text = await explain_claim_decision(
        claim_dict,
        worker_dict,
        zone_dict,
        fraud_result,
        gate_results,
        payout,
    )
    sim.ai_explanation = text[:8000] if text else None

    if sim.disruption_event_id:
        lc = (
            await db.execute(
                select(ClaimLifecycle).where(
                    ClaimLifecycle.user_id == sim.user_id,
                    ClaimLifecycle.claim_id == f"auto:{sim.user_id}:{sim.disruption_event_id}",
                )
            )
        ).scalar_one_or_none()
        if lc is not None:
            lc.ai_explanation = sim.ai_explanation

    await db.flush()
