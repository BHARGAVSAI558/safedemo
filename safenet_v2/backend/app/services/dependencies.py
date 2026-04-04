from __future__ import annotations

from typing import Any, Optional

from fastapi import Request

from app.core.config import settings
from app.services.aqi_service import AQIService
from app.services.event_service import EventSignalsService, default_event_signals
from app.services.weather_service import WeatherService


def get_redis_optional(request: Request) -> Any:
    return getattr(request.app.state, "redis", None)


def get_mongo_optional(request: Request) -> Any:
    return getattr(request.app.state, "mongo_db", None)


def make_weather_service(redis: Any = None, http_client: Any = None) -> WeatherService:
    return WeatherService(redis=redis, settings_obj=settings, http_client=http_client)


def make_aqi_service(redis: Any = None, http_client: Any = None) -> AQIService:
    return AQIService(redis=redis, settings_obj=settings, http_client=http_client)


def make_event_signals_service(store: Optional[Any] = None) -> EventSignalsService:
    return EventSignalsService(store) if store is not None else default_event_signals()
