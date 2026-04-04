"""
Earnings DNA: 7×24 (weekday × hour IST) from APPROVED simulation payouts + synthetic delivery pattern.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Sequence
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")

DAY_NAMES_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
DAY_NAMES_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

# Active window for weekly rollups & mobile heatmap (6 AM – 11 PM IST)
ACTIVE_HOUR_START = 6
ACTIVE_HOUR_END = 23  # inclusive hour index; grid 6..22 = 17 columns


def _synthetic_base_rate_inr_per_hr(h: int) -> float:
    """Template ₹/hr at avg_daily_income=600 before scaling."""
    if h in (0, 1, 2):
        return 5.0
    if 3 <= h <= 5:
        return 0.0
    if 6 <= h <= 8:
        return 45.0
    if 9 <= h <= 11:
        return 55.0
    if 12 <= h <= 13:
        return 78.0
    if 14 <= h <= 16:
        return 42.0
    if 17 <= h <= 18:
        return 55.0
    if 19 <= h <= 21:
        return 92.0
    if h == 22:
        return 55.0
    return 40.0


def synthetic_delivery_pattern_matrix(avg_daily_income: float) -> list[list[float]]:
    """7×24 identical weekday rows; scaled by (avg_daily_income / 600)."""
    scale = max(0.25, float(avg_daily_income or 600.0) / 600.0)
    hourly = [round(_synthetic_base_rate_inr_per_hr(h) * scale, 2) for h in range(24)]
    return [list(hourly) for _ in range(7)]


def _fmt_ampm(h: int) -> str:
    if h == 0:
        return "12A"
    if h < 12:
        return f"{h}A"
    if h == 12:
        return "12P"
    return f"{h - 12}P"


def _fmt_ampm_range(hs: int, he: int) -> str:
    """he exclusive; display e.g. 7–10 PM for 19–22."""
    return f"{_fmt_ampm(hs)}–{_fmt_ampm(he)}"


def _find_best_3h_block(dna: list[list[float]]) -> tuple[int, int, float, float]:
    """Returns (day_index, hour_start, sum_3h, avg_per_hour)."""
    best_sum = -1.0
    best_d, best_hs = 0, 6
    for d in range(7):
        for hs in range(0, 22):
            s = dna[d][hs] + dna[d][hs + 1] + dna[d][hs + 2]
            if s > best_sum:
                best_sum = s
                best_d, best_hs = d, hs
    avg_h = best_sum / 3.0 if best_sum >= 0 else 0.0
    return best_d, best_hs, best_sum, avg_h


def _extend_peak_day_range(dna: list[list[float]], d0: int, hs: int) -> tuple[int, int]:
    """If same 3h block is strong on consecutive weekdays, return day_start, day_end indices."""
    target = sum(dna[d0][hs + i] for i in range(3))
    lo = hi = d0
    for d in range(d0 - 1, -1, -1):
        s = sum(dna[d][hs + i] for i in range(3))
        if s >= target * 0.92:
            lo = d
        else:
            break
    for d in range(d0 + 1, 7):
        s = sum(dna[d][hs + i] for i in range(3))
        if s >= target * 0.92:
            hi = d
        else:
            break
    return lo, hi


def build_worker_earnings_dna(
    approved_simulations_30d: Sequence[Any],
    avg_daily_income: float,
    weekly_payout_sum_this_week: float,
) -> dict[str, Any]:
    """
    - dna[day][hour] = average payout amount for simulations in that slot (₹/hr proxy), else synthetic.
    - weekly_expected = sum of dna over active window (6–22) × 7 days (total expected weekly bucket).
    """
    avg_daily = max(50.0, float(avg_daily_income or 600.0))
    synthetic = synthetic_delivery_pattern_matrix(avg_daily)

    sums = [[0.0 for _ in range(24)] for _ in range(7)]
    counts = [[0 for _ in range(24)] for _ in range(7)]

    for sim in approved_simulations_30d:
        ca = getattr(sim, "created_at", None)
        if ca is None:
            continue
        cau = ca if ca.tzinfo else ca.replace(tzinfo=timezone.utc)
        dt = cau.astimezone(IST)
        d, h = int(dt.weekday()), int(dt.hour)
        payout = float(getattr(sim, "payout", 0.0) or 0.0)
        sums[d][h] += payout
        counts[d][h] += 1

    dna = [[0.0 for _ in range(24)] for _ in range(7)]
    for d in range(7):
        for h in range(24):
            if counts[d][h] > 0:
                dna[d][h] = round(sums[d][h] / counts[d][h], 2)
            else:
                dna[d][h] = synthetic[d][h]

    simulation_count = len(approved_simulations_30d)
    confidence = min(1.0, simulation_count / 14.0) if simulation_count else 0.0
    data_weeks = simulation_count / 14.0

    weekly_expected = round(
        sum(dna[d][h] for d in range(7) for h in range(ACTIVE_HOUR_START, ACTIVE_HOUR_END + 1)),
        2,
    )
    weekly_actual = round(max(0.0, float(weekly_payout_sum_this_week)), 2)

    d0, hs, _sum3, avg_h = _find_best_3h_block(dna)
    lo, hi = _extend_peak_day_range(dna, d0, hs)
    if lo == hi:
        day_part = DAY_NAMES_LONG[d0]
    else:
        day_part = f"{DAY_NAMES_SHORT[lo]}–{DAY_NAMES_SHORT[hi]}"
    peak_label = f"Peak: {day_part} {_fmt_ampm_range(hs, hs + 3)} · avg ₹{round(avg_h, 0)}/hr"

    peak_window = {
        "label": peak_label,
        "day_name": day_part,
        "day_index": d0,
        "hour_start": hs,
        "hour_end": hs + 3,
        "avg_earnings": round(avg_h, 2),
    }

    # Legacy peak_hours for older clients
    peak_hours = {
        "start": peak_window["hour_start"],
        "end": peak_window["hour_end"],
        "avg": peak_window["avg_earnings"],
    }

    return {
        "dna": dna,
        "peak_window": peak_window,
        "peak_hours": peak_hours,
        "confidence": round(confidence, 4),
        "weekly_expected": weekly_expected,
        "weekly_actual": weekly_actual,
        "simulation_count": simulation_count,
        "data_weeks_equivalent": round(data_weeks, 3),
    }


def _is_approved_sim(s: Any) -> bool:
    d = getattr(s, "decision", None)
    if d is None:
        return False
    v = getattr(d, "value", None)
    if v == "APPROVED":
        return True
    return str(d).upper().endswith("APPROVED")


def build_earnings_dna(
    simulations: Sequence[Any],
    avg_daily_income: float,
    city: str,
    weekly_actual_from_sims: float,
) -> dict[str, Any]:
    """Backward-compatible: PayoutEngine / legacy callers; `city` ignored."""
    approved = [s for s in simulations if _is_approved_sim(s)]
    return build_worker_earnings_dna(approved, avg_daily_income, weekly_actual_from_sims)


def admin_aggregate_earnings_analytics(
    simulations: Iterable[Any],
    days: int = 14,
) -> dict[str, Any]:
    """Cross-worker stats + fleet average payout by IST hour (for insurer bar chart)."""
    now = datetime.now(timezone.utc)
    start = now - timedelta(days=max(1, min(60, days)))
    hour_totals: dict[int, list[float]] = {h: [] for h in range(24)}
    exp_vals: list[float] = []
    act_vals: list[float] = []

    for s in simulations:
        ca = getattr(s, "created_at", None)
        if ca is None:
            continue
        cau = ca if ca.tzinfo else ca.replace(tzinfo=timezone.utc)
        if cau < start:
            continue
        if not _is_approved_sim(s):
            continue
        dt = cau.astimezone(IST)
        h = dt.hour
        payout = float(getattr(s, "payout", 0.0) or 0.0)
        hour_totals[h].append(payout)
        exp_vals.append(float(getattr(s, "expected_income", 0.0) or 0.0))
        act_vals.append(float(getattr(s, "actual_income", 0.0) or 0.0))

    peak_list = []
    for h in range(24):
        vals = hour_totals[h]
        avg_h = sum(vals) / len(vals) if vals else 0.0
        peak_list.append({"hour_ist": h, "avg_slot_proxy": round(avg_h, 2), "samples": len(vals)})
    peak_list.sort(key=lambda x: x["avg_slot_proxy"], reverse=True)
    top_peak = peak_list[:5]

    avg_e = sum(exp_vals) / len(exp_vals) if exp_vals else 0.0
    avg_a = sum(act_vals) / len(act_vals) if act_vals else 0.0

    fleet_hourly = []
    for h in range(24):
        vals = hour_totals[h]
        fleet_hourly.append(
            {
                "hour": h,
                "avg_payout": round(sum(vals) / len(vals), 2) if vals else 0.0,
                "samples": len(vals),
            }
        )

    return {
        "window_days": days,
        "simulations_in_window": len(exp_vals),
        "avg_expected": round(avg_e, 2),
        "avg_actual": round(avg_a, 2),
        "peak_hours_ist": top_peak,
        "fleet_hourly_avg_payout": fleet_hourly,
    }
