"""Shared zone id matching for disruption queries (profile slug vs DB city_code)."""

from __future__ import annotations

import re
from typing import Any, Iterable


def slugify(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", value.strip().lower()).strip("_")


def _aliases_for_zone_row(row: Any) -> set[str]:
    aliases = {
        str(getattr(row, "city_code", "") or "").strip(),
        str(getattr(row, "city_code", "") or "").strip().lower(),
        slugify(str(getattr(row, "city_code", "") or "")),
        slugify(str(getattr(row, "name", "") or "")),
    }
    return {a for a in aliases if a}


def disruption_zone_candidates(zone_id: str, zone_rows: Iterable[Any]) -> set[str]:
    z = str(zone_id or "").strip()
    out = {z}
    normalized = slugify(z)
    for row in zone_rows:
        aliases = _aliases_for_zone_row(row)
        if z in aliases or normalized in aliases:
            out |= aliases
    return out
