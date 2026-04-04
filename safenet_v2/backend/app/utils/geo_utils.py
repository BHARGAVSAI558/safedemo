from math import asin, cos, radians, sin, sqrt
from typing import Tuple


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)
    a = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2
    c = 2 * asin(sqrt(a))
    return r * c


def bbox_contains(
    point: Tuple[float, float],
    south_west: Tuple[float, float],
    north_east: Tuple[float, float],
) -> bool:
    lat, lon = point
    sw_lat, sw_lon = south_west
    ne_lat, ne_lon = north_east
    return sw_lat <= lat <= ne_lat and sw_lon <= lon <= ne_lon
