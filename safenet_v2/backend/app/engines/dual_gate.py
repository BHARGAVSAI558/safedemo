"""
Dual-gate claim validation: Gate 1 external disruption; Gate 2 worker activity in zone.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from app.models.claim import DisruptionEvent
from app.models.worker import Profile
from app.models.zone import Zone
from app.services.signal_types import ConfidenceResult


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return r * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def gate1_from_confidence(conf: ConfidenceResult) -> tuple[bool, str, str]:
    src_parts: list[str] = []
    val_parts: list[str] = []
    w = conf.weather
    if w is not None and hasattr(w, "rainfall_mm_hr"):
        src_parts.append("OpenWeatherMap")
        rv = getattr(w, "rainfall_mm_hr", None) or 0.0
        tv = getattr(w, "temp_c", None)
        if float(rv or 0) > 0:
            val_parts.append(f"{float(rv):.1f}mm/hr rain")
        if tv is not None:
            val_parts.append(f"{float(tv):.1f}°C")
    a = conf.aqi
    if a is not None and hasattr(a, "aqi_value"):
        src_parts.append("OpenAQ")
        val_parts.append(f"AQI {float(getattr(a, 'aqi_value', 0) or 0):.0f}")
    source = " + ".join(src_parts) if src_parts else "multi_signal"
    value = ", ".join(val_parts) if val_parts else (conf.disruption_type or "disruption_confirmed")
    return True, source, value


def gate1_from_disruption_event(ev: DisruptionEvent) -> tuple[bool, str, str]:
    api = (ev.api_source or "disruption_event").strip() or "disruption_event"
    raw = ev.raw_value
    if raw is not None:
        val = f"{float(raw):.2f} (raw)"
    else:
        val = f"{ev.disruption_type} sev={float(ev.severity or 0):.2f}"
    return True, api, val


@dataclass
class Gate2Result:
    passed: bool
    activity_confirmed: bool
    location_confirmed: bool
    volume_drop_confirmed: bool
    signals: dict[str, Any] = field(default_factory=dict)
    failure_reason: str = ""
    human_summary: str = ""


def evaluate_gate2(
    profile: Profile,
    zone: Optional[Zone],
    disruption_started_at: Optional[datetime],
    *,
    pre_window_minutes: int = 45,
) -> Gate2Result:
    ref = _aware(disruption_started_at) or _utcnow()
    window_start = ref - timedelta(minutes=pre_window_minutes)

    last_api = _aware(profile.last_api_call)
    activity_confirmed = bool(last_api and last_api >= window_start)

    location_confirmed = False
    dist_km: Optional[float] = None
    radius = float(zone.zone_radius_km) if zone and zone.zone_radius_km is not None else 15.0
    zlat = float(zone.lat) if zone and zone.lat is not None else None
    zlng = float(zone.lng) if zone and zone.lng is not None else None
    plat = profile.last_known_lat
    plng = profile.last_known_lng
    if zlat is not None and zlng is not None and plat is not None and plng is not None:
        dist_km = haversine_km(float(plat), float(plng), zlat, zlng)
        location_confirmed = dist_km <= radius

    baseline = float(zone.zone_baseline_orders) if zone and zone.zone_baseline_orders is not None else 100.0
    hour_orders = float(zone.orders_last_hour) if zone and zone.orders_last_hour is not None else baseline * 0.85
    volume_drop_confirmed = hour_orders < (baseline * 0.5)

    passed = activity_confirmed or (location_confirmed and volume_drop_confirmed)

    signals: dict[str, Any] = {
        "activity_confirmed": activity_confirmed,
        "location_confirmed": location_confirmed,
        "volume_drop_confirmed": volume_drop_confirmed,
        "window_start_utc": window_start.isoformat(),
        "disruption_ref_utc": ref.isoformat(),
        "last_api_call_utc": last_api.isoformat() if last_api else None,
        "distance_km": round(dist_km, 4) if dist_km is not None else None,
        "zone_radius_km": radius,
        "orders_last_hour": hour_orders,
        "zone_baseline_orders": baseline,
    }

    failure_reason = ""
    if not passed:
        failure_reason = (
            "Disruption confirmed in your zone, but you were not detected as active"
        )

    parts: list[str] = []
    if activity_confirmed and last_api:
        mins = max(0, int((ref - last_api).total_seconds() // 60))
        parts.append(f"App active {mins} min ago")
    if location_confirmed:
        parts.append("GPS in zone")
    if volume_drop_confirmed:
        parts.append("order volume down vs baseline")
    human_summary = " + ".join(parts) if parts else "insufficient activity signals"

    return Gate2Result(
        passed=passed,
        activity_confirmed=activity_confirmed,
        location_confirmed=location_confirmed,
        volume_drop_confirmed=volume_drop_confirmed,
        signals=signals,
        failure_reason=failure_reason,
        human_summary=human_summary,
    )


def gate_status_payload(gate1_passed: bool, gate2_passed: bool, reason: str) -> dict[str, str]:
    return {
        "gate1": "PASSED" if gate1_passed else "FAILED",
        "gate2": "PASSED" if gate2_passed else "FAILED",
        "reason": reason,
    }
