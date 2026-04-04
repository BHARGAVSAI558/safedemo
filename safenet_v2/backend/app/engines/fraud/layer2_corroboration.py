from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from app.engines.fraud.helpers import point_in_zone
from app.engines.fraud.types import (
    AppActivityEvent,
    GPSPoint,
    GPSZone,
    L2Decision,
    L2Result,
    SignalStance,
)
from app.utils.logger import get_logger

log = get_logger(__name__)


class Layer2Corroboration:
    def __init__(self, zone: GPSZone) -> None:
        self._zone = zone

    def _s1_gps_disrupted_zone(
        self,
        trail: List[GPSPoint],
        confidence_signals: List[str],
        city_lat: float,
        city_lon: float,
    ) -> SignalStance:
        disrupted = any(s in confidence_signals for s in ("rain", "heat", "aqi", "social", "platform"))
        if not disrupted:
            return "NEUTRAL"
        if not trail:
            lat, lon = city_lat, city_lon
        else:
            lat = sum(p.lat for p in trail) / len(trail)
            lon = sum(p.lon for p in trail) / len(trail)
        if point_in_zone(lat, lon, self._zone):
            return "AGREEING"
        return "DISAGREEING"

    def _s2_external(
        self,
        confidence_signals: List[str],
        weather_signal: Optional[Any],
        aqi_signal: Optional[Any],
    ) -> SignalStance:
        if not any(s in confidence_signals for s in ("rain", "heat", "aqi")):
            return "NEUTRAL"
        if weather_signal is None and aqi_signal is None:
            return "NEUTRAL"
        return "AGREEING"

    def _s3_app_gap(
        self,
        events: List[AppActivityEvent],
    ) -> SignalStance:
        if len(events) < 2:
            return "NEUTRAL"
        ev = sorted(events, key=lambda e: e.timestamp)
        max_gap = max(
            (ev[i].timestamp - ev[i - 1].timestamp).total_seconds() for i in range(1, len(ev))
        )
        if max_gap > 600:
            return "AGREEING"
        return "DISAGREEING"

    def _s4_demand(self, platform_drop_pct: float) -> SignalStance:
        if platform_drop_pct > 70.0:
            return "AGREEING"
        if platform_drop_pct <= 0:
            return "NEUTRAL"
        return "DISAGREEING"

    def run(
        self,
        gps_trail: List[GPSPoint],
        confidence_signals_active: List[str],
        app_activity: List[AppActivityEvent],
        platform_drop_pct: float,
        city_lat: float,
        city_lon: float,
        weather_signal: Optional[Any],
        aqi_signal: Optional[Any],
    ) -> L2Result:
        s1 = self._s1_gps_disrupted_zone(
            gps_trail, confidence_signals_active, city_lat, city_lon
        )
        s2 = self._s2_external(confidence_signals_active, weather_signal, aqi_signal)
        s3 = self._s3_app_gap(app_activity)
        s4 = self._s4_demand(platform_drop_pct)

        signals: Dict[str, SignalStance] = {
            "S1_gps_zone": s1,
            "S2_external": s2,
            "S3_app_activity": s3,
            "S4_zone_demand": s4,
        }

        agreeing = sum(1 for v in signals.values() if v == "AGREEING")
        neutral = sum(1 for v in signals.values() if v == "NEUTRAL")
        effective = 4 - neutral

        minor_anomaly = False
        decision: L2Decision = "BLOCK"
        reason_code = "L2_BLOCK"

        if effective == 0:
            decision = "BLOCK"
            reason_code = "L2_ALL_NEUTRAL"
        elif agreeing == 4:
            decision = "APPROVE"
            reason_code = "L2_4_4"
        elif agreeing == 3:
            decision = "APPROVE"
            reason_code = "L2_3_4"
            minor_anomaly = neutral >= 1
        elif agreeing == 2:
            decision = "FLAG"
            reason_code = "L2_2_4"
        else:
            decision = "BLOCK"
            reason_code = "L2_LOW_AGREE"

        log.info(
            "fraud_layer2",
            engine_name="fraud_layer2",
            decision=decision,
            agreeing=agreeing,
            neutral=neutral,
        )

        return L2Result(
            decision=decision,
            corroboration_score=agreeing,
            signals=signals,
            reason_code=reason_code,
            minor_anomaly=minor_anomaly,
        )
