from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any, List, Literal, Optional, Sequence, Tuple, Union

from app.db.mongo import save_confidence_document
from app.services.aqi_service import AQIService
from app.services.event_service import EventSignalsService, default_event_signals
from app.services.signal_types import (
    AQISignal,
    ConfidenceResult,
    GovernmentAlertSignal,
    PlatformDemandSignal,
    UnavailableSignal,
    WeatherFetchResult,
    WeatherSignal,
)
from app.services.weather_service import WeatherService
from app.utils.logger import get_logger

log = get_logger(__name__)

W_RAIN = 1.0
W_HEAT = 0.85
W_AQI = 0.75
W_SOCIAL = 1.0
W_PLATFORM = 0.65
SUM_WEIGHTS = W_RAIN + W_HEAT + W_AQI + W_SOCIAL + W_PLATFORM


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _is_red_weather_alert(w: WeatherSignal) -> bool:
    if not w.alert_active:
        return False
    at = (w.alert_type or "").upper()
    return at.startswith("RED") or "RED" in at


def _rain_triggered(w: WeatherFetchResult) -> bool:
    if isinstance(w, UnavailableSignal):
        return False
    r = w.rainfall_mm_hr or 0.0
    if r > 15.0:
        return True
    return _is_red_weather_alert(w)


def _heat_triggered(w: WeatherFetchResult) -> bool:
    if isinstance(w, UnavailableSignal):
        return False
    return (w.temp_c or 0.0) > 42.0


def _aqi_triggered(a: Union[AQISignal, UnavailableSignal]) -> bool:
    if isinstance(a, UnavailableSignal):
        return False
    return float(a.aqi_value) > 300.0


def _social_triggered(g: GovernmentAlertSignal) -> bool:
    if not g.alert_active:
        return False
    t = (g.alert_type or "").lower()
    sev = (g.severity or "").upper()
    return t in ("curfew", "strike", "lockdown") and sev in ("ORANGE", "RED")


def _platform_triggered(p: PlatformDemandSignal) -> bool:
    return p.drop_pct_vs_baseline >= 80.0 and p.sustained_low_hours >= 2.0


def _primary_type(flags: Sequence[Tuple[str, bool]]) -> Optional[str]:
    order = ("rain", "heat", "aqi", "social", "platform")
    for name in order:
        for n, on in flags:
            if n == name and on:
                return name
    return None


class ConfidenceEngine:
    def __init__(
        self,
        *,
        redis: Any = None,
        mongo_db: Any = None,
        weather: Optional[WeatherService] = None,
        aqi: Optional[AQIService] = None,
        events: Optional[EventSignalsService] = None,
    ) -> None:
        self._redis = redis
        self._mongo_db = mongo_db
        self._weather = weather or WeatherService(redis=redis)
        self._aqi = aqi or AQIService(redis=redis)
        self._events = events or default_event_signals()

    async def evaluate(self, zone_id: str, lat: float, lon: float, *, city: str) -> ConfidenceResult:
        w, a, g = await asyncio.gather(
            self._weather.fetch_weather(lat, lon),
            self._aqi.fetch_aqi(city, zone_id),
            self._events.get_government_alert(zone_id),
        )

        other = (
            _rain_triggered(w)
            or _heat_triggered(w)
            or _aqi_triggered(a)
            or _social_triggered(g)
        )
        p = await self._events.get_platform_demand(zone_id, other_triggers_active=other)

        tr_rain = _rain_triggered(w)
        tr_heat = _heat_triggered(w)
        tr_aqi = _aqi_triggered(a)
        tr_social = _social_triggered(g)
        tr_platform = _platform_triggered(p)

        triggered_weights = (
            W_RAIN * float(tr_rain)
            + W_HEAT * float(tr_heat)
            + W_AQI * float(tr_aqi)
            + W_SOCIAL * float(tr_social)
            + W_PLATFORM * float(tr_platform)
        )
        score = triggered_weights / SUM_WEIGHTS

        signals_active: List[str] = []
        if tr_rain:
            signals_active.append("rain")
        if tr_heat:
            signals_active.append("heat")
        if tr_aqi:
            signals_active.append("aqi")
        if tr_social:
            signals_active.append("social")
        if tr_platform:
            signals_active.append("platform")

        unavailable_count = sum(1 for x in (w, a) if isinstance(x, UnavailableSignal))

        if unavailable_count >= 2:
            level: Literal["HIGH", "MIXED", "LOW"] = "MIXED"
            api_degraded = True
        else:
            api_degraded = False
            if score >= 0.6:
                level = "HIGH"
            elif score >= 0.3:
                level = "MIXED"
            else:
                level = "LOW"

        primary = _primary_type(
            (
                ("rain", tr_rain),
                ("heat", tr_heat),
                ("aqi", tr_aqi),
                ("social", tr_social),
                ("platform", tr_platform),
            )
        )

        w_sig = w if isinstance(w, WeatherSignal) else None
        a_sig = a if isinstance(a, AQISignal) else None

        doc = {
            "zone_id": zone_id,
            "score": round(score, 4),
            "level": level,
            "signals_active": signals_active,
            "api_degraded": api_degraded,
            "computed_at": _utcnow(),
            "disruption_type": primary,
            "city": city,
        }

        if self._mongo_db is not None:
            try:
                await save_confidence_document(self._mongo_db, doc)
            except Exception as exc:
                log.warning(
                    "confidence_mongo_write_failed",
                    engine_name="confidence_engine",
                    decision="skip",
                    reason_code="MONGO_ERROR",
                    error=str(exc),
                )

        log.info(
            "confidence_evaluated",
            engine_name="confidence_engine",
            decision=str(level),
            reason_code="CONFIDENCE_OK",
            zone_id=zone_id,
            score=score,
            signals_active=signals_active,
            api_degraded=api_degraded,
        )

        return ConfidenceResult(
            level=level,
            score=round(score, 4),
            signals_active=signals_active,
            api_degraded=api_degraded,
            disruption_type=primary,
            weather=w_sig,
            aqi=a_sig,
        )
