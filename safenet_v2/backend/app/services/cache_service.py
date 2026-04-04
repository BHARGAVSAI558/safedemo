from __future__ import annotations

import json
from typing import Any, Optional


async def cache_get_json(redis: Any, key: str) -> Optional[dict]:
    if redis is None:
        return None
    try:
        raw = await redis.get(key)
        if not raw:
            return None
        return json.loads(raw)
    except Exception:
        return None


async def cache_set_json(redis: Any, key: str, value: dict, ttl_seconds: int) -> None:
    if redis is None:
        return
    try:
        await redis.set(key, json.dumps(value, default=str), ex=ttl_seconds)
    except Exception:
        pass


async def cache_invalidate(redis: Any, *keys: str) -> None:
    if redis is None or not keys:
        return
    try:
        await redis.delete(*keys)
    except Exception:
        pass

