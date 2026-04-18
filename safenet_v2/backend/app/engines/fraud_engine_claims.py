"""
Fraud Engine — Claims Pipeline
-------------------------------
Lightweight fraud scoring for the automated claims pipeline.
Complements the existing 4-layer FraudEngine (GPS/behavioral) with
DB-backed signal checks that are fast and explainable.

check_fraud() returns:
  (fraud_score: float, flags: list[tuple[flag_type, flag_detail]])

fraud_score is clamped to [0.0, 1.0].
FraudFlag rows are NOT persisted here — the caller (claims_engine) links
them to the Simulation after flush so simulation_id is always set.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.claim import Simulation
from app.models.policy import Policy
from app.models.worker import Profile
from app.utils.logger import get_logger

log = get_logger(__name__)

# ── Score weights per check ────────────────────────────────────────────────────
_W_REPEATED_CLAIM  = 0.35   # claimed in last 24h
_W_NEW_POLICY      = 0.25   # policy created < 48h ago
_W_ZONE_RATIO      = 0.20   # zone claim density spike
_W_LOW_TRUST       = 0.20   # trust score below threshold

# Zone density: if > this many claims in zone in last hour → spike
_ZONE_CLAIM_SPIKE_THRESHOLD = 8


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _normalise_trust(raw: float) -> float:
    """Stored as 0–1; if somehow > 1 treat as 0–100 scale."""
    return raw / 100.0 if raw > 1.0 else raw


async def check_fraud(
    db: AsyncSession,
    user_id: int,
    zone_id: str,
    policy: Policy,
    profile: Profile,
    disruption_event_id: int = 0,
) -> tuple[float, list[tuple[str, str]]]:
    """
    Runs 4 fraud signal checks and returns (score, flags).

    Checks:
      1. repeated_claim   — worker already claimed in last 24h
      2. new_policy       — policy activated < 48h before disruption
      3. zone_claim_ratio — abnormal claim density in zone (last 1h)
      4. low_trust_score  — trust score below 0.4 (40/100)

    Score = weighted sum of triggered checks, clamped to [0.0, 1.0].
    """
    now = _utcnow()
    flags: list[tuple[str, str]] = []
    score = 0.0

    # ── Check 1: Repeated claim in last 24h ───────────────────────────────────
    window_24h = now - timedelta(hours=24)
    recent_claims = (
        await db.execute(
            select(func.count(Simulation.id)).where(
                Simulation.user_id == user_id,
                Simulation.created_at >= window_24h,
                Simulation.disruption_event_id != disruption_event_id,
            )
        )
    ).scalar_one() or 0

    if recent_claims > 0:
        score += _W_REPEATED_CLAIM
        flags.append((
            "repeated_claim",
            f"Worker submitted {recent_claims} claim(s) in the last 24h",
        ))

    # ── Check 2: New policy (< 48h old) ───────────────────────────────────────
    policy_created = getattr(policy, "created_at", None)
    if policy_created is not None:
        if policy_created.tzinfo is None:
            policy_created = policy_created.replace(tzinfo=timezone.utc)
        policy_age_hours = (now - policy_created).total_seconds() / 3600.0
        if policy_age_hours < 48.0:
            score += _W_NEW_POLICY
            flags.append((
                "timing_anomaly",
                f"Policy activated only {policy_age_hours:.1f}h ago (threshold: 48h)",
            ))

    # ── Check 3: Zone claim density spike (last 1h) ───────────────────────────
    window_1h = now - timedelta(hours=1)
    zone_claims_1h = (
        await db.execute(
            select(func.count(Simulation.id))
            .join(Profile, Profile.user_id == Simulation.user_id)
            .where(
                Profile.zone_id == zone_id,
                Simulation.created_at >= window_1h,
            )
        )
    ).scalar_one() or 0

    if zone_claims_1h >= _ZONE_CLAIM_SPIKE_THRESHOLD:
        score += _W_ZONE_RATIO
        flags.append((
            "ring_detection",
            f"{zone_claims_1h} claims in zone '{zone_id}' in last 1h (threshold: {_ZONE_CLAIM_SPIKE_THRESHOLD})",
        ))

    # ── Check 4: Location mismatch ───────────────────────────────────────────
    profile_zone = (profile.zone_id or "").strip()
    if profile_zone and profile_zone != zone_id:
        score += _W_LOW_TRUST
        flags.append((
            "location_mismatch",
            f"Profile zone '{profile_zone}' does not match disruption zone '{zone_id}'",
        ))

    # ── Check 5: Low trust score ───────────────────────────────────────────────
    trust = _normalise_trust(float(profile.trust_score or 0.5))
    if trust < 0.4:
        score += _W_LOW_TRUST
        flags.append((
            "low_trust_score",
            f"Trust score {trust * 100:.1f}/100 is below threshold (40)",
        ))

    # ── Clamp and log ──────────────────────────────────────────────────────────
    score = round(max(0.0, min(score, 1.0)), 4)

    log.info(
        "fraud_check_scored",
        engine_name="fraud_engine_claims",
        reason_code="FRAUD_SCORED",
        user_id=user_id,
        zone_id=zone_id,
        fraud_score=score,
        flags=[f[0] for f in flags],
    )

    return score, flags
