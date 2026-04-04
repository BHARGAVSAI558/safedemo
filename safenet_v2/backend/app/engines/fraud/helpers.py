from __future__ import annotations

import math
import random
from datetime import datetime, timedelta, timezone
from typing import List, Tuple

from app.engines.fraud.types import GPSPoint, GPSZone

EARTH_R_KM = 6371.0


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    rlat1, rlon1 = math.radians(lat1), math.radians(lon1)
    rlat2, rlon2 = math.radians(lat2), math.radians(lon2)
    dlat = rlat2 - rlat1
    dlon = rlon2 - rlon1
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlon / 2) ** 2
    c = 2 * math.asin(min(1.0, math.sqrt(a)))
    return EARTH_R_KM * c


def point_in_zone(lat: float, lon: float, zone: GPSZone) -> bool:
    return haversine_km(lat, lon, zone.center_lat, zone.center_lon) <= zone.radius_km


def speed_kmh(p1: GPSPoint, p2: GPSPoint) -> float:
    dt = p2.timestamp - p1.timestamp
    secs = max(abs(dt.total_seconds()), 1e-3)
    dist = haversine_km(p1.lat, p1.lon, p2.lat, p2.lon)
    return (dist / secs) * 3600.0


def variance_latlon(points: List[GPSPoint]) -> float:
    if len(points) < 2:
        return 1.0
    ml = sum(p.lat for p in points) / len(points)
    mo = sum(p.lon for p in points) / len(points)
    vl = sum((p.lat - ml) ** 2 for p in points) / len(points)
    vo = sum((p.lon - mo) ** 2 for p in points) / len(points)
    return vl + vo


def synthetic_city_trail(center_lat: float, center_lon: float, n: int = 5) -> List[GPSPoint]:
    now = datetime.now(timezone.utc)
    out: List[GPSPoint] = []
    rnd = random.Random(42)
    for i in range(n):
        out.append(
            GPSPoint(
                lat=center_lat + rnd.uniform(-0.002, 0.002),
                lon=center_lon + rnd.uniform(-0.002, 0.002),
                timestamp=now - timedelta(minutes=n - i),
                cell_tower_id="tower_default",
                accelerometer_magnitude=0.5 + rnd.random() * 0.5,
            )
        )
    return out
