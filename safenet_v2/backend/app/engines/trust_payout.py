"""Trust score normalization (0–100) and payout delay tiers for worker experience."""
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.models.worker import Profile


def trust_score_points(raw: float | None) -> float:
    if raw is None:
        return 50.0
    r = float(raw)
    if r <= 1.0:
        return max(0.0, min(100.0, r * 100.0))
    return max(0.0, min(100.0, r))


def trust_tier_label(points: float) -> str:
    p = float(points)
    if p >= 91:
        return "Elite"
    if p >= 71:
        return "Trusted"
    if p >= 41:
        return "Reliable"
    return "Emerging"


def payout_delay_seconds(points: float) -> int:
    p = float(points)
    if p > 90:
        return 0
    if p >= 70:
        return 30
    return 120


def trust_points_from_profile(profile: "Profile | None") -> float:
    if profile is None:
        return 50.0
    return trust_score_points(getattr(profile, "trust_score", None))
