from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, List, Literal, Optional, Union


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


@dataclass(frozen=True)
class UnavailableSignal:
    source: Literal["UNAVAILABLE"] = "UNAVAILABLE"
    value: None = None
    confidence: float = 0.0
    fetched_at: datetime = field(default_factory=_utcnow)


@dataclass(frozen=True)
class WeatherSignal:
    rainfall_mm_hr: Optional[float]
    temp_c: Optional[float]
    alert_active: bool
    alert_type: Optional[str]
    wind_speed_m_s: Optional[float]
    humidity_pct: Optional[float]
    source: str
    fetched_at: datetime
    ttl_remaining: int


WeatherFetchResult = Union[WeatherSignal, UnavailableSignal]


@dataclass(frozen=True)
class AQISignal:
    aqi_value: float
    category: str
    pm25: Optional[float]
    pm10: Optional[float]
    source: str
    fetched_at: datetime


AQIFetchResult = Union[AQISignal, UnavailableSignal]


@dataclass(frozen=True)
class GovernmentAlertSignal:
    alert_active: bool
    severity: Optional[Literal["GREEN", "YELLOW", "ORANGE", "RED"]]
    alert_type: Optional[str]
    description: str
    source: str
    fetched_at: datetime


@dataclass(frozen=True)
class PlatformDemandSignal:
    order_rate_index: float
    drop_pct_vs_baseline: float
    sustained_low_hours: float
    source: str
    fetched_at: datetime


@dataclass(frozen=True)
class ConfidenceResult:
    level: Literal["HIGH", "MIXED", "LOW"]
    score: float
    signals_active: List[str]
    api_degraded: bool
    disruption_type: Optional[str]
    weather: Optional[WeatherSignal] = None
    aqi: Optional[AQISignal] = None


@dataclass(frozen=True)
class ConfidenceMongoPayload:
    zone_id: str
    score: float
    level: str
    signals_active: List[str]
    api_degraded: bool
    computed_at: datetime
    extra: dict[str, Any] = field(default_factory=dict)
