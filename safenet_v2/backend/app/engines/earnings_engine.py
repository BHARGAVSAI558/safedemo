"""
Earnings DNA Engine
-------------------
Provides per-worker expected hourly earnings from the EarningsDNA table,
with a deterministic fallback when no DB row exists.
"""
from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.worker import EarningsDNA, Profile
from app.utils.logger import get_logger

if TYPE_CHECKING:
    pass

log = get_logger(__name__)

# ── Time-of-day multipliers ────────────────────────────────────────────────────
# Keyed by hour (0–23).  Values represent fraction of base hourly rate.
_HOUR_MULT: dict[int, float] = {
    0: 0.25, 1: 0.20, 2: 0.20, 3: 0.20, 4: 0.20, 5: 0.25,   # deep night / pre-dawn
    6: 0.70, 7: 0.85, 8: 0.90,                                 # morning ramp
    9: 0.95, 10: 1.00, 11: 1.05,                               # mid-morning
    12: 1.30, 13: 1.40,                                         # lunch peak
    14: 1.00, 15: 0.90, 16: 0.85,                              # afternoon lull
    17: 1.00, 18: 1.10,                                         # evening ramp
    19: 1.40, 20: 1.50, 21: 1.45,                              # dinner peak
    22: 1.10, 23: 0.60,                                         # late night
}

# Weekend uplift (Saturday=5, Sunday=6)
_WEEKEND_MULT: dict[int, float] = {5: 1.2, 6: 1.3}


def _time_multiplier(day_of_week: int, hour_of_day: int) -> float:
    base = _HOUR_MULT.get(hour_of_day, 1.0)
    weekend = _WEEKEND_MULT.get(day_of_week, 1.0)
    return base * weekend


async def get_expected_hourly_rate(
    db: AsyncSession,
    user_id: int,
    at_datetime: datetime,
) -> float:
    """
    Returns expected INR/hour for this worker at the given datetime.

    Priority:
      1. EarningsDNA row for (user_id, day_of_week, hour_of_day)
      2. Fallback: profile.avg_daily_earnings / max(active_hours_per_day, 1)
         scaled by the time-of-day multiplier for the slot
    """
    wd = int(at_datetime.weekday())   # 0=Monday
    hr = int(at_datetime.hour)

    dna_row = (
        await db.execute(
            select(EarningsDNA).where(
                EarningsDNA.user_id == user_id,
                EarningsDNA.day_of_week == wd,
                EarningsDNA.hour_of_day == hr,
            )
        )
    ).scalar_one_or_none()

    if dna_row is not None and float(dna_row.expected_hourly_rate) > 0:
        return float(dna_row.expected_hourly_rate)

    # Fallback — derive from profile
    profile = (
        await db.execute(select(Profile).where(Profile.user_id == user_id))
    ).scalar_one_or_none()

    if profile is None:
        log.warning(
            "earnings_dna_fallback_no_profile",
            engine_name="earnings_engine",
            reason_code="NO_PROFILE",
            user_id=user_id,
        )
        return 50.0  # absolute floor

    avg_daily = max(50.0, float(profile.avg_daily_earnings or profile.avg_daily_income or 600.0))
    active_hours = max(1.0, float(profile.active_hours_per_day or 8.0))
    base_hourly = avg_daily / active_hours
    rate = round(base_hourly * _time_multiplier(wd, hr), 2)

    log.info(
        "earnings_dna_fallback_used",
        engine_name="earnings_engine",
        reason_code="DNA_FALLBACK",
        user_id=user_id,
        base_hourly=base_hourly,
        rate=rate,
    )
    return max(1.0, rate)


async def build_earnings_dna_from_onboarding(
    db: AsyncSession,
    user_id: int,
    avg_daily: float,
    active_hours: float,
) -> None:
    """
    Create (or replace) the full 7×24 EarningsDNA matrix for a worker.

    Formula per slot:
        base_hourly = avg_daily / max(active_hours, 1)
        rate[day][hour] = base_hourly × hour_mult × weekend_mult

    Existing rows are deleted and re-inserted so onboarding updates are
    always reflected cleanly.
    """
    from sqlalchemy import delete

    avg_daily = max(50.0, float(avg_daily))
    active_hours = max(1.0, float(active_hours))
    base_hourly = avg_daily / active_hours

    # Remove stale rows for this worker
    await db.execute(delete(EarningsDNA).where(EarningsDNA.user_id == user_id))

    rows: list[EarningsDNA] = []
    for day in range(7):
        for hour in range(24):
            mult = _time_multiplier(day, hour)
            rate = round(max(1.0, base_hourly * mult), 2)
            rows.append(
                EarningsDNA(
                    user_id=user_id,
                    day_of_week=day,
                    hour_of_day=hour,
                    expected_hourly_rate=rate,
                )
            )

    db.add_all(rows)
    await db.flush()

    log.info(
        "earnings_dna_built",
        engine_name="earnings_engine",
        decision="ok",
        reason_code="DNA_BUILT",
        user_id=user_id,
        base_hourly=round(base_hourly, 2),
        rows=len(rows),
    )
