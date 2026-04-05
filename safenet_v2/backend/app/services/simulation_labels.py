"""Shared disruption labels for simulations (history, payouts, weekly breakdown)."""

from __future__ import annotations

import json
from typing import Any, Tuple

SCENARIO_TO_UI = {
    "HEAVY_RAIN": ("Heavy Rain", "rain"),
    "EXTREME_HEAT": ("Extreme Heat", "hot"),
    "AQI_SPIKE": ("AQI Spike", "cloudy"),
    "CURFEW": ("Curfew", "curfew"),
}


def disruption_from_simulation(s: Any) -> tuple[str, str]:
    wd_raw = getattr(s, "weather_data", None)
    if wd_raw:
        try:
            wd = json.loads(wd_raw) if isinstance(wd_raw, str) else wd_raw
            key = str((wd or {}).get("scenario") or (wd or {}).get("disruption_type") or "").upper()
            if key in SCENARIO_TO_UI:
                return SCENARIO_TO_UI[key]
        except (json.JSONDecodeError, TypeError, AttributeError):
            pass
    if getattr(s, "weather_disruption", False):
        return "Heavy Rain", "rain"
    if getattr(s, "event_disruption", False):
        return "Curfew", "cloudy"
    return "Disruption", "cloudy"
