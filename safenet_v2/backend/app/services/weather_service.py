from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from typing import Any, Optional

import httpx

from app.core.config import settings
from app.services.protocols import WeatherServiceProtocol
from app.services.signal_types import UnavailableSignal, WeatherFetchResult, WeatherSignal
from app.utils.logger import get_logger

log = get_logger(__name__)

WEATHER_CACHE_TTL = 600


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _round_coord(x: float) -> float:
    return round(x, 2)


def _cache_key(lat: float, lon: float) -> str:
    return f"weather:{_round_coord(lat)}:{_round_coord(lon)}"


class WeatherService(WeatherServiceProtocol):
    """OpenWeatherMap with Open-Meteo fallback; Redis cache; typed WeatherSignal / UnavailableSignal."""

    def __init__(
        self,
        redis: Any = None,
        *,
        settings_obj: Optional[Any] = None,
        http_client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        self._redis = redis
        self._settings = settings_obj or settings
        self._http = http_client

    def _timeout(self) -> httpx.Timeout:
        return httpx.Timeout(connect=5.0, read=10.0, write=10.0, pool=5.0)

    async def _cache_get(self, key: str) -> tuple[Optional[dict[str, Any]], int]:
        if self._redis is None:
            return None, 0
        try:
            raw = await self._redis.get(key)
            ttl = int(await self._redis.ttl(key))
            if ttl < 0:
                ttl = WEATHER_CACHE_TTL
            if not raw:
                return None, 0
            return json.loads(raw), ttl
        except Exception as exc:
            log.warning(
                "weather_cache_read_failed",
                engine_name="weather_service",
                decision="miss",
                reason_code="REDIS_ERROR",
                error=str(exc),
            )
            return None, 0

    async def _cache_set(self, key: str, payload: dict[str, Any]) -> None:
        if self._redis is None:
            return
        try:
            await self._redis.setex(key, WEATHER_CACHE_TTL, json.dumps(payload, default=str))
        except Exception as exc:
            log.warning(
                "weather_cache_write_failed",
                engine_name="weather_service",
                decision="skip",
                reason_code="REDIS_ERROR",
                error=str(exc),
            )

    def _signal_from_payload(
        self,
        payload: dict[str, Any],
        source: str,
        ttl_remaining: int,
    ) -> WeatherSignal:
        return WeatherSignal(
            rainfall_mm_hr=payload.get("rainfall_mm_hr"),
            temp_c=payload.get("temp_c"),
            alert_active=bool(payload.get("alert_active")),
            alert_type=payload.get("alert_type"),
            wind_speed_m_s=payload.get("wind_speed_m_s"),
            humidity_pct=payload.get("humidity_pct"),
            source=source,
            fetched_at=datetime.fromisoformat(payload["fetched_at"])
            if isinstance(payload.get("fetched_at"), str)
            else _utcnow(),
            ttl_remaining=ttl_remaining,
        )

    async def get_weather(self, lat: float, lon: float) -> WeatherFetchResult:
        """Alias for `fetch_weather` (OpenWeatherMap + Open-Meteo fallback)."""
        return await self.fetch_weather(lat, lon)

    async def fetch_weather(self, lat: float, lon: float) -> WeatherFetchResult:
        key = _cache_key(lat, lon)
        cached, ttl = await self._cache_get(key)
        if cached and cached.get("kind") == "weather":
            return self._signal_from_payload(cached, str(cached.get("source", "cache")), ttl)

        try:
            if self._http is not None:
                return await self._fetch_inner(self._http, lat, lon, key)
            async with httpx.AsyncClient(timeout=self._timeout()) as c:
                return await self._fetch_inner(c, lat, lon, key)
        except Exception as exc:
            log.warning(
                "weather_fetch_failed",
                engine_name="weather_service",
                decision="unavailable",
                reason_code="WEATHER_ERROR",
                error=str(exc),
            )
            return UnavailableSignal(fetched_at=_utcnow())

    async def _fetch_inner(
        self,
        client: httpx.AsyncClient,
        lat: float,
        lon: float,
        cache_key: str,
    ) -> WeatherFetchResult:
        api_key = self._settings.OPENWEATHER_API_KEY
        if not api_key:
            return await self._open_meteo(client, lat, lon, cache_key)

        weather_url = "https://api.openweathermap.org/data/2.5/weather"
        forecast_url = "https://api.openweathermap.org/data/2.5/forecast"
        params = {"lat": lat, "lon": lon, "appid": api_key, "units": "metric"}

        try:
            w_resp, f_resp = await asyncio.gather(
                client.get(weather_url, params=params),
                client.get(forecast_url, params=params),
            )
        except Exception as exc:
            log.warning(
                "openweather_http_error",
                engine_name="weather_service",
                decision="fallback",
                reason_code="HTTP_ERROR",
                error=str(exc),
            )
            return await self._open_meteo(client, lat, lon, cache_key)

        if w_resp.status_code in (429,) or w_resp.status_code >= 500:
            log.info(
                "openweather_rate_or_server_error",
                engine_name="weather_service",
                decision="open_meteo",
                reason_code="OWM_FALLBACK",
                status_weather=w_resp.status_code,
                status_forecast=f_resp.status_code,
            )
            return await self._open_meteo(client, lat, lon, cache_key)

        if w_resp.status_code != 200:
            return await self._open_meteo(client, lat, lon, cache_key)

        try:
            wj = w_resp.json()
            fj = {}
            if f_resp.status_code == 200:
                try:
                    fj = f_resp.json()
                except Exception:
                    fj = {}
        except Exception:
            return await self._open_meteo(client, lat, lon, cache_key)

        rain = wj.get("rain") or {}
        rain_mm_hr: Optional[float] = None
        if "1h" in rain:
            rain_mm_hr = float(rain["1h"])
        elif "3h" in rain:
            rain_mm_hr = float(rain["3h"]) / 3.0

        temp_c = float(wj["main"]["temp"])
        humidity = float(wj["main"].get("humidity", 0))
        wind_speed = float(wj.get("wind", {}).get("speed", 0))

        alert_active = False
        alert_type: Optional[str] = None
        alerts = wj.get("alerts") or fj.get("alerts")
        if isinstance(alerts, list) and alerts:
            alert_active = True
            alert_type = str(alerts[0].get("event") or alerts[0].get("tags") or "ALERT")
            sev = str(alerts[0].get("severity", "")).upper()
            if sev == "RED" or "RED" in alert_type.upper():
                alert_type = "RED:" + alert_type
        else:
            for block in wj.get("weather", []):
                wid = int(block.get("id", 0))
                if wid in (502, 503, 504, 522, 531) or (200 <= wid < 300):
                    alert_active = True
                    alert_type = block.get("main", "severe_weather")
                    break

        payload = {
            "kind": "weather",
            "source": "openweathermap",
            "rainfall_mm_hr": rain_mm_hr,
            "temp_c": temp_c,
            "alert_active": alert_active,
            "alert_type": alert_type,
            "wind_speed_m_s": wind_speed,
            "humidity_pct": humidity,
            "fetched_at": _utcnow().isoformat(),
        }
        await self._cache_set(cache_key, payload)
        return self._signal_from_payload(payload, "openweathermap", WEATHER_CACHE_TTL)

    async def _open_meteo(
        self,
        client: httpx.AsyncClient,
        lat: float,
        lon: float,
        cache_key: str,
    ) -> WeatherFetchResult:
        url = "https://api.open-meteo.com/v1/forecast"
        params = {
            "latitude": lat,
            "longitude": lon,
            "hourly": "precipitation,temperature_2m,relativehumidity_2m,windspeed_10m",
            "current": "precipitation,temperature_2m,relativehumidity_2m,windspeed_10m",
            "timezone": "auto",
        }
        try:
            r = await client.get(url, params=params)
            r.raise_for_status()
            d = r.json()
        except Exception as exc:
            log.warning(
                "open_meteo_failed",
                engine_name="weather_service",
                decision="unavailable",
                reason_code="OPEN_METEO_ERROR",
                error=str(exc),
            )
            return UnavailableSignal(fetched_at=_utcnow())

        cur = d.get("current", {})
        rain_mm_hr = cur.get("precipitation")
        if rain_mm_hr is None and d.get("hourly"):
            pr = d["hourly"].get("precipitation") or []
            rain_mm_hr = float(pr[0]) if pr else 0.0
        else:
            rain_mm_hr = float(rain_mm_hr or 0.0)

        temp_c = float(cur.get("temperature_2m", 0))
        humidity = float(cur.get("relativehumidity_2m", 0))
        wind = float(cur.get("windspeed_10m", 0)) / 3.6

        payload = {
            "kind": "weather",
            "source": "open_meteo",
            "rainfall_mm_hr": rain_mm_hr,
            "temp_c": temp_c,
            "alert_active": rain_mm_hr > 25.0 or temp_c > 43.0,
            "alert_type": "severe_conditions" if (rain_mm_hr > 25.0 or temp_c > 43.0) else None,
            "wind_speed_m_s": wind,
            "humidity_pct": humidity,
            "fetched_at": _utcnow().isoformat(),
        }
        await self._cache_set(cache_key, payload)
        return self._signal_from_payload(payload, "open_meteo", WEATHER_CACHE_TTL)
