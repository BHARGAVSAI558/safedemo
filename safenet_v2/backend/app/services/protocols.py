from __future__ import annotations

from typing import Protocol, runtime_checkable

from app.services.signal_types import (
    AQIFetchResult,
    ConfidenceResult,
    GovernmentAlertSignal,
    PlatformDemandSignal,
    WeatherFetchResult,
)


@runtime_checkable
class WeatherServiceProtocol(Protocol):
    async def fetch_weather(self, lat: float, lon: float) -> WeatherFetchResult:
        ...


@runtime_checkable
class AQIServiceProtocol(Protocol):
    async def fetch_aqi(self, city: str, zone_id: str) -> AQIFetchResult:
        ...


@runtime_checkable
class GovernmentAlertsProtocol(Protocol):
    async def get_government_alert(self, zone_id: str) -> GovernmentAlertSignal:
        ...


@runtime_checkable
class PlatformDemandProtocol(Protocol):
    async def get_platform_demand(
        self,
        zone_id: str,
        *,
        other_triggers_active: bool,
    ) -> PlatformDemandSignal:
        ...


@runtime_checkable
class ConfidenceStoreProtocol(Protocol):
    async def save_confidence(self, payload: dict) -> None:
        ...


@runtime_checkable
class ConfidenceEvaluatorProtocol(Protocol):
    async def evaluate(
        self,
        zone_id: str,
        lat: float,
        lon: float,
        *,
        city: str,
    ) -> ConfidenceResult:
        ...
