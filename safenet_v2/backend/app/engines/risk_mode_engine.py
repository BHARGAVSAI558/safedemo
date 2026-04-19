"""
Dynamic risk mode per zone — composite score 0–100 and operational mode (NORMAL → CRITICAL).
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from app.models.zone import Zone


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def compute_zone_risk_score(
    zone: Zone,
    weather_data: Optional[dict[str, Any]],
    aqi_data: Optional[dict[str, Any]],
    traffic_data: Optional[dict[str, Any]],
) -> int:
    """Composite risk score 0–100 from four dimensions (25 pts each)."""
    # Dimension 1: Weather (0–25)
    weather_score = 0
    if weather_data:
        rain_mm = float(weather_data.get("rain_1h") or weather_data.get("rainfall_mm_hr") or 0)
        temp_c = float(weather_data.get("temp") or weather_data.get("temp_c") or 30)
        if rain_mm > 35:
            weather_score = 25
        elif rain_mm > 15:
            weather_score = 18
        elif rain_mm > 5:
            weather_score = 10
        if temp_c > 42:
            weather_score = max(weather_score, 20)
        elif temp_c > 38:
            weather_score = max(weather_score, 12)

    # Dimension 2: AQI / PM2.5 (0–25)
    aqi_score = 0
    if aqi_data:
        pm25 = float(aqi_data.get("pm25") or aqi_data.get("pm2_5") or 0)
        if pm25 > 300:
            aqi_score = 25
        elif pm25 > 200:
            aqi_score = 18
        elif pm25 > 150:
            aqi_score = 10

    # Dimension 3: Historical zone risk (0–25) — map from Zone flood/heat/aqi scores
    hf = float(zone.flood_risk_score or 0.5)
    hh = float(zone.heat_risk_score or 0.5)
    ha = float(zone.aqi_risk_score or 0.5)
    hist_score = int((hf * 0.4 + hh * 0.3 + ha * 0.3) * 25)

    # Dimension 4: Active worker density (0–25)
    hour = _utcnow().hour
    is_peak = hour in (12, 13, 19, 20, 21)
    total = max(int(zone.total_registered_workers or 0), 1)
    online = int(zone.current_online_workers or 0)
    online_ratio = online / total
    density_score = 0
    if is_peak and online_ratio < 0.4:
        density_score = 25
    elif is_peak and online_ratio < 0.6:
        density_score = 15
    # Optional traffic overlay (small nudge)
    if traffic_data and float(traffic_data.get("congestion_index") or 0) > 0.85:
        density_score = min(25, density_score + 3)

    total_score = weather_score + aqi_score + hist_score + density_score
    return min(int(total_score), 100)


def get_risk_mode(risk_score: int) -> dict[str, Any]:
    """Operational mode from composite score."""
    if risk_score <= 30:
        return {
            "mode": "NORMAL",
            "label": "Normal Operations",
            "color": "green",
            "action": "standard_coverage",
            "description": "No elevated risk. Standard parametric triggers active.",
        }
    if risk_score <= 60:
        return {
            "mode": "ELEVATED",
            "label": "Elevated Risk",
            "color": "yellow",
            "action": "enhanced_monitoring",
            "description": "Risk detected. Scheduler polling every 15 min instead of 30.",
        }
    if risk_score <= 80:
        return {
            "mode": "PROTECTION",
            "label": "Protection Mode",
            "color": "orange",
            "action": "proactive_coverage",
            "description": "High risk. Forecast Shield auto-activating. Coverage upgraded for active workers.",
        }
    return {
        "mode": "CRITICAL",
        "label": "Critical Mode",
        "color": "red",
        "action": "mass_payout_ready",
        "description": "Crisis level. Claim pipeline pre-authorized. Payouts will fire on Gate 1 confirmation alone.",
    }
