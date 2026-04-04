"""Indian CPCB National Air Quality Index sub-index (PM2.5 / PM10), not US EPA."""

from __future__ import annotations


def _interp(c: float, bp_lo: float, bp_hi: float, i_lo: float, i_hi: float) -> float:
    if c <= bp_lo:
        return i_lo
    if c >= bp_hi:
        return i_hi
    return ((i_hi - i_lo) / (bp_hi - bp_lo)) * (c - bp_lo) + i_lo


def cpcb_sub_index_pm25(c: float) -> float:
    """PM2.5 µg/m³ → sub-index (NAQI)."""
    if c < 0:
        c = 0.0
    if c <= 30:
        return _interp(c, 0, 30, 0, 50)
    if c <= 60:
        return _interp(c, 30, 60, 51, 100)
    if c <= 90:
        return _interp(c, 60, 90, 101, 200)
    if c <= 120:
        return _interp(c, 90, 120, 201, 300)
    if c <= 250:
        return _interp(c, 120, 250, 301, 400)
    return min(500.0, _interp(c, 250, 500, 401, 500))


def cpcb_sub_index_pm10(c: float) -> float:
    """PM10 µg/m³ → sub-index (NAQI)."""
    if c < 0:
        c = 0.0
    if c <= 50:
        return _interp(c, 0, 50, 0, 50)
    if c <= 100:
        return _interp(c, 50, 100, 51, 100)
    if c <= 250:
        return _interp(c, 100, 250, 101, 200)
    if c <= 350:
        return _interp(c, 250, 350, 201, 300)
    if c <= 430:
        return _interp(c, 350, 430, 301, 400)
    return min(500.0, _interp(c, 430, 600, 401, 500))


def combined_aqi(pm25: float | None, pm10: float | None) -> float:
    indices: list[float] = []
    if pm25 is not None:
        indices.append(cpcb_sub_index_pm25(pm25))
    if pm10 is not None:
        indices.append(cpcb_sub_index_pm10(pm10))
    if not indices:
        return 0.0
    return max(indices)


def aqi_category(aqi: float) -> str:
    if aqi <= 50:
        return "Good"
    if aqi <= 100:
        return "Moderate"
    if aqi <= 200:
        return "Poor"
    if aqi <= 300:
        return "Very Poor"
    if aqi <= 400:
        return "Severe"
    return "Hazardous"
