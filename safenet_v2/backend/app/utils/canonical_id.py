"""SHA-256 canonical identity from phone (stable across platforms)."""
from __future__ import annotations

import hashlib


def generate_canonical_hash(phone: str) -> str:
    normalized = (phone or "").strip().encode("utf-8")
    return hashlib.sha256(normalized).hexdigest()
