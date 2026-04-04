from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Optional, Tuple

import httpx

from app.core.config import settings
from app.services.cpcb_aqi import aqi_category, combined_aqi
from app.services.protocols import AQIServiceProtocol
from app.services.signal_types import AQIFetchResult, AQISignal, UnavailableSignal
from app.utils.logger import get_logger

log = get_logger(__name__)

AQI_CACHE_TTL = 900


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _cache_key(city: str, zone_id: str) -> str:
    return f"aqi:{city.strip().lower()}:{zone_id}"


def _mock_pm(zone_id: str, hour: int) -> Tuple[float, float]:
    import math

    seed = f"{zone_id}:{hour}".encode()
    h = hashlib.sha256(seed).hexdigest()
    v1 = int(h[0:8], 16) / 0xFFFFFFFF
    v2 = int(h[8:16], 16) / 0xFFFFFFFF
    daily = 0.5 + 0.5 * math.sin((hour - 7) / 24.0 * 2 * math.pi)
    pm25 = 20.0 + 80.0 * daily * (0.5 + v1)
    pm10 = 35.0 + 120.0 * daily * (0.5 + v2)
    return round(pm25, 2), round(pm10, 2)


def _walk_extract_pm(obj: Any) -> Tuple[Optional[float], Optional[float]]:
    pm25: Optional[float] = None
    pm10: Optional[float] = None

    def visit(node: Any) -> None:
        nonlocal pm25, pm10
        if isinstance(node, dict):
            p = str(node.get("parameter", "")).lower().replace(".", "")
            v = node.get("value")
            if v is not None and isinstance(v, (int, float)):
                try:
                    fv = float(v)
                except (TypeError, ValueError):
                    fv = None
                if fv is not None:
                    if p in ("pm25", "pm2.5") and pm25 is None:
                        pm25 = fv
                    elif p == "pm10" and pm10 is None:
                        pm10 = fv
            for vv in node.values():
                visit(vv)
        elif isinstance(node, list):
            for x in node:
                visit(x)

    visit(obj)
    return pm25, pm10


class AQIService(AQIServiceProtocol):
    def __init__(
        self,
        redis: Any = None,
        *,
        settings_obj: Optional[Any] = None,
        http_client: Optional[httpx.AsyncClient] = None,
        location_id_resolver: Optional[Any] = None,
    ) -> None:
        self._redis = redis
        self._settings = settings_obj or settings
        self._http = http_client
        self._resolve_location_id = location_id_resolver or self._default_location_id

    def _default_location_id(self, city: str, zone_id: str) -> Optional[int]:
        raw = getattr(self._settings, "OPENAQ_LOCATION_ID", None)
        if raw:
            try:
                return int(str(raw).strip())
            except ValueError:
                pass
        key = f"{zone_id}:{city}".encode()
        digest = hashlib.sha256(key).hexdigest()
        return 100000 + (int(digest[:6], 16) % 900000)

    def _timeout(self) -> httpx.Timeout:
        return httpx.Timeout(connect=5.0, read=10.0, write=10.0, pool=5.0)

    async def _cache_get(self, key: str) -> Tuple[Optional[dict[str, Any]], int]:
        if self._redis is None:
            return None, 0
        try:
            raw = await self._redis.get(key)
            ttl = int(await self._redis.ttl(key))
            if ttl < 0:
                ttl = AQI_CACHE_TTL
            if not raw:
                return None, 0
            return json.loads(raw), ttl
        except Exception as exc:
            log.warning(
                "aqi_cache_read_failed",
                engine_name="aqi_service",
                decision="miss",
                reason_code="REDIS_ERROR",
                error=str(exc),
            )
            return None, 0

    async def _cache_set(self, key: str, payload: dict[str, Any]) -> None:
        if self._redis is None:
            return
        try:
            await self._redis.setex(key, AQI_CACHE_TTL, json.dumps(payload, default=str))
        except Exception as exc:
            log.warning(
                "aqi_cache_write_failed",
                engine_name="aqi_service",
                decision="skip",
                reason_code="REDIS_ERROR",
                error=str(exc),
            )

    async def _openaq_fetch(
        self,
        client: httpx.AsyncClient,
        loc_id: int,
        api_key: str,
    ) -> Tuple[Optional[float], Optional[float]]:
        base = "https://api.openaq.org/v3"
        headers = {"X-API-Key": api_key}
        paths = (
            f"/locations/{loc_id}/measurements",
            f"/locations/{loc_id}/latest",
        )
        for path in paths:
            url = base + path
            try:
                r = await client.get(
                    url,
                    headers=headers,
                    params={"limit": 200},
                )
                if r.status_code != 200:
                    continue
                data = r.json()
                pm25, pm10 = _walk_extract_pm(data)
                if pm25 is not None or pm10 is not None:
                    return pm25, pm10
            except Exception as exc:
                log.info(
                    "openaq_path_failed",
                    engine_name="aqi_service",
                    decision="next",
                    reason_code="OPENAQ_PATH",
                    path=path,
                    error=str(exc),
                )
        return None, None

    async def get_aqi(self, city: str, zone_id: str) -> AQIFetchResult:
        return await self.fetch_aqi(city, zone_id)

    async def fetch_aqi(self, city: str, zone_id: str) -> AQIFetchResult:
        ck = _cache_key(city, zone_id)
        cached, _ttl = await self._cache_get(ck)
        if cached and cached.get("kind") == "aqi":
            return AQISignal(
                aqi_value=float(cached["aqi_value"]),
                category=str(cached["category"]),
                pm25=cached.get("pm25"),
                pm10=cached.get("pm10"),
                source=str(cached["source"]),
                fetched_at=datetime.fromisoformat(cached["fetched_at"])
                if isinstance(cached.get("fetched_at"), str)
                else _utcnow(),
            )

        loc_id = self._resolve_location_id(city, zone_id)
        api_key = self._settings.OPENAQ_API_KEY

        pm25: Optional[float] = None
        pm10: Optional[float] = None
        source = "openaq"

        if api_key and loc_id is not None:
            try:
                if self._http is not None:
                    pm25, pm10 = await self._openaq_fetch(self._http, int(loc_id), api_key)
                else:
                    async with httpx.AsyncClient(timeout=self._timeout()) as c:
                        pm25, pm10 = await self._openaq_fetch(c, int(loc_id), api_key)
            except Exception as exc:
                log.warning(
                    "openaq_client_failed",
                    engine_name="aqi_service",
                    decision="mock",
                    reason_code="OPENAQ_ERROR",
                    error=str(exc),
                )

        if pm25 is None and pm10 is None:
            hour = _utcnow().hour
            pm25, pm10 = _mock_pm(zone_id, hour)
            source = "cpcb_mock"

        aqi_val = combined_aqi(pm25, pm10)
        cat = aqi_category(aqi_val)

        payload = {
            "kind": "aqi",
            "aqi_value": aqi_val,
            "category": cat,
            "pm25": pm25,
            "pm10": pm10,
            "source": source,
            "fetched_at": _utcnow().isoformat(),
        }
        await self._cache_set(ck, payload)

        return AQISignal(
            aqi_value=aqi_val,
            category=cat,
            pm25=pm25,
            pm10=pm10,
            source=source,
            fetched_at=_utcnow(),
        )
