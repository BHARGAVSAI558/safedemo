from __future__ import annotations

import json
import os
from functools import lru_cache
from typing import Any, Tuple


@lru_cache
def _load_zones() -> dict[str, Any]:
    base = os.path.dirname(os.path.dirname(__file__))
    path = os.path.join(base, "data", "zone_coordinates.json")
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def resolve_city_to_zone(city: str) -> Tuple[str, float, float]:
    data = _load_zones()
    key = (city or "").strip()
    entry = data.get(key) or data.get(key.title()) or data.get("Hyderabad")
    if not entry:
        return "default", 17.385, 78.4867
    return (
        str(entry.get("zone_id", "default")),
        float(entry.get("lat", 17.385)),
        float(entry.get("lon", 78.4867)),
    )
