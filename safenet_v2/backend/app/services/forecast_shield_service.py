"""
Forecast Shield: OpenWeather 48h / 3h blocks → app.state.forecast_shields + mobile / payout copy.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from zoneinfo import ZoneInfo

from app.core.config import settings
from app.utils.logger import get_logger

log = get_logger(__name__)

IST = ZoneInfo("Asia/Kolkata")


def _load_zone_coordinates() -> dict[str, dict[str, Any]]:
    base = os.path.dirname(os.path.dirname(__file__))
    path = os.path.join(base, "data", "zone_coordinates.json")
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"Hyderabad": {"zone_id": "hyd_central", "lat": 17.385, "lon": 78.4867}}


def zones_from_coordinates() -> list[tuple[str, str, float, float]]:
    coords = _load_zone_coordinates()
    out: list[tuple[str, str, float, float]] = []
    for city, v in coords.items():
        zid = str(v.get("zone_id", "default"))
        out.append((str(city), zid, float(v.get("lat", 0.0)), float(v.get("lon", 0.0))))
    uniq: dict[str, tuple[str, str, float, float]] = {}
    for city, zid, lat, lon in out:
        if zid not in uniq:
            uniq[zid] = (city, zid, lat, lon)
    return list(uniq.values())


def classify_openweather_item(item: dict[str, Any]) -> str | None:
    rain = item.get("rain") or {}
    r3 = float(rain.get("3h", 0) or 0)
    temp = float((item.get("main") or {}).get("temp", 0) or 0)
    wmain = ""
    for w in item.get("weather") or []:
        wmain = str(w.get("main", ""))
        break
    if r3 > 5:
        return "Heavy Rain"
    if temp > 40:
        return "Extreme Heat"
    if wmain in ("Thunderstorm", "Extreme"):
        return wmain
    return None


def shield_storage_key(zone_id: str, start_ist: datetime) -> str:
    return f"{zone_id}_{start_ist.strftime('%Y%m%d')}_{start_ist.hour:02d}"


def merge_forecast_blocks(
    blocks: list[tuple[datetime, datetime, str, float]],
) -> list[tuple[datetime, datetime, str, float]]:
    if not blocks:
        return []
    blocks = sorted(blocks, key=lambda x: x[0])
    out: list[tuple[datetime, datetime, str, float]] = []
    for st, en, risk, prob in blocks:
        if out and out[-1][2] == risk and st <= out[-1][1] + timedelta(minutes=1):
            prev_st, prev_en, _, prev_prob = out[-1]
            out[-1] = (prev_st, max(prev_en, en), risk, max(prev_prob, prob))
        else:
            out.append((st, en, risk, prob))
    return out


def build_mock_shields() -> dict[str, dict[str, Any]]:
    """When OPENWEATHER_API_KEY is unset: one demo shield for hyd_central, tomorrow 15:00–19:00 IST."""
    issued_at = datetime.now(timezone.utc)
    now_ist = datetime.now(tz=IST)
    day_start = now_ist.replace(hour=0, minute=0, second=0, microsecond=0)
    tomorrow = day_start + timedelta(days=1)
    start_ist = tomorrow.replace(hour=15, minute=0, second=0, microsecond=0)
    end_ist = tomorrow.replace(hour=19, minute=0, second=0, microsecond=0)
    start_utc = start_ist.astimezone(timezone.utc)
    end_utc = end_ist.astimezone(timezone.utc)
    k = shield_storage_key("hyd_central", start_ist)
    return {
        k: {
            "zone_id": "hyd_central",
            "risk_type": "Heavy Rain",
            "start_dt": start_utc.isoformat(),
            "end_dt": end_utc.isoformat(),
            "probability": 0.82,
            "upgrade_tier": "Pro",
            "issued_at": issued_at.isoformat(),
        }
    }


async def fetch_zone_forecast_items(
    client: httpx.AsyncClient,
    lat: float,
    lon: float,
    api_key: str,
    horizon_hours: int = 48,
) -> list[dict[str, Any]] | None:
    """Return forecast list slices for the next ~48h, or None if the OWM call failed (keep prior shields)."""
    url = "https://api.openweathermap.org/data/2.5/forecast"
    params = {"lat": lat, "lon": lon, "appid": api_key, "units": "metric"}
    try:
        r = await client.get(url, params=params)
    except Exception as exc:
        log.warning(
            "forecast_shield_owm_http_error",
            engine_name="forecast_shield_service",
            reason_code="OWM_HTTP",
            error=str(exc),
        )
        return None
    if r.status_code != 200:
        log.warning(
            "forecast_shield_owm_bad_status",
            engine_name="forecast_shield_service",
            reason_code="OWM_STATUS",
            status_code=r.status_code,
        )
        return None
    try:
        data = r.json()
    except Exception:
        return None
    lst = data.get("list") or []
    if not lst:
        return []
    now = datetime.now(timezone.utc)
    cutoff = now + timedelta(hours=horizon_hours)
    out: list[dict[str, Any]] = []
    for item in lst:
        dt_unix = item.get("dt")
        if dt_unix is None:
            continue
        st = datetime.fromtimestamp(int(dt_unix), tz=timezone.utc)
        en_blk = st + timedelta(hours=3)
        if en_blk <= now:
            continue
        if st >= cutoff:
            continue
        out.append(item)
    return out


def items_to_merged_shields(
    zone_id: str,
    items: list[dict[str, Any]],
    issued_at: datetime,
) -> dict[str, dict[str, Any]]:
    blocks: list[tuple[datetime, datetime, str, float]] = []
    for item in items:
        risk = classify_openweather_item(item)
        if not risk:
            continue
        dt_unix = item.get("dt")
        if dt_unix is None:
            continue
        st = datetime.fromtimestamp(int(dt_unix), tz=timezone.utc)
        en = st + timedelta(hours=3)
        blocks.append((st, en, risk, 0.75))

    merged = merge_forecast_blocks(blocks)
    shields: dict[str, dict[str, Any]] = {}
    for st, en, risk, prob in merged:
        st_ist = st.astimezone(IST)
        k = shield_storage_key(zone_id, st_ist)
        shields[k] = {
            "zone_id": zone_id,
            "risk_type": risk,
            "start_dt": st.isoformat(),
            "end_dt": en.isoformat(),
            "probability": prob,
            "upgrade_tier": "Pro",
            "issued_at": issued_at.isoformat(),
        }
    return shields


def _parse_iso_dt(s: Any) -> datetime | None:
    if s is None:
        return None
    try:
        x = str(s).replace("Z", "+00:00")
        d = datetime.fromisoformat(x)
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        return d
    except Exception:
        return None


def payout_message_suffix(
    shields: dict[str, dict[str, Any]] | None,
    zone_id: str | None,
    at: datetime,
) -> str:
    if not shields or not zone_id:
        return ""
    atu = at if at.tzinfo else at.replace(tzinfo=timezone.utc)
    for sh in shields.values():
        if str(sh.get("zone_id")) != str(zone_id):
            continue
        st = _parse_iso_dt(sh.get("start_dt"))
        en = _parse_iso_dt(sh.get("end_dt"))
        if st is None or en is None:
            continue
        if st <= atu < en:
            issued = _parse_iso_dt(sh.get("issued_at")) or st
            hours = max(0.0, (atu - issued).total_seconds() / 3600.0)
            h_int = max(1, int(round(hours)))
            return (
                f" SafeNet predicted this risk {h_int} hours ago "
                "and upgraded your coverage automatically."
            )
    return ""


def active_shields_next_48h(
    shields: dict[str, dict[str, Any]] | None,
    zone_id: str,
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    if not shields:
        return []
    if now is None:
        nowu = datetime.now(timezone.utc)
    elif now.tzinfo is None:
        nowu = now.replace(tzinfo=timezone.utc)
    else:
        nowu = now
    horizon = nowu + timedelta(hours=48)
    rows: list[tuple[datetime, dict[str, Any]]] = []
    for sh in shields.values():
        if str(sh.get("zone_id")) != str(zone_id):
            continue
        st = _parse_iso_dt(sh.get("start_dt"))
        en = _parse_iso_dt(sh.get("end_dt"))
        if st is None or en is None:
            continue
        if en <= nowu or st >= horizon:
            continue
        rows.append((st, dict(sh)))
    rows.sort(key=lambda x: x[0])
    return [r[1] for r in rows]


def _fmt_ist_ampm(dt: datetime) -> str:
    h = dt.hour
    if h == 0:
        return "12 AM"
    if h < 12:
        return f"{h} AM"
    if h == 12:
        return "12 PM"
    return f"{h - 12} PM"


def _day_phrase_ist(st: datetime, now_ist: datetime) -> str:
    if st.date() == now_ist.date():
        return "today"
    if st.date() == (now_ist.date() + timedelta(days=1)):
        return "tomorrow"
    return st.strftime("%a %d %b")


def enrich_shield_for_client(sh: dict[str, Any], now_ist: datetime) -> dict[str, Any]:
    st = _parse_iso_dt(sh.get("start_dt"))
    en = _parse_iso_dt(sh.get("end_dt"))
    if st is None or en is None:
        out = dict(sh)
        out["subtitle"] = ""
        out["coverage_line"] = ""
        return out
    st_i = st.astimezone(IST)
    en_i = en.astimezone(IST)
    risk = str(sh.get("risk_type", "Weather risk"))
    prob = float(sh.get("probability", 0.75) or 0.75)
    pct = int(round(prob * 100))
    day_phr = _day_phrase_ist(st_i, now_ist)
    rs = risk.lower()
    subtitle = (
        f"{rs} predicted {day_phr} {_fmt_ist_ampm(st_i)} – {_fmt_ist_ampm(en_i)} "
        f"({pct}% confidence)"
    )
    hours = max(1, int(round((en - st).total_seconds() / 3600.0)))
    tier = str(sh.get("upgrade_tier", "Pro"))
    coverage_line = f"Coverage auto-upgraded to {tier} · ₹700/day for {hours} hours"
    out = dict(sh)
    out["subtitle"] = subtitle
    out["coverage_line"] = coverage_line
    return out


async def refresh_forecast_shields(app: Any) -> None:
    issued_at = datetime.now(timezone.utc)
    prev = getattr(app.state, "forecast_shields", None) or {}
    if not isinstance(prev, dict):
        prev = {}

    key = (settings.OPENWEATHER_API_KEY or "").strip()
    if not key:
        app.state.forecast_shields = build_mock_shields()
        log.info(
            "forecast_shields_refreshed",
            engine_name="forecast_shield_service",
            mode="mock",
            zones=1,
        )
        return

    zones = zones_from_coordinates()
    combined: dict[str, dict[str, Any]] = {}
    zones_refreshed: set[str] = set()

    timeout = httpx.Timeout(connect=10.0, read=45.0, write=10.0, pool=10.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        for _city, zone_id, lat, lon in zones:
            try:
                items = await fetch_zone_forecast_items(client, lat, lon, key)
                merged_map = items_to_merged_shields(zone_id, items, issued_at)
                combined.update(merged_map)
                zones_refreshed.add(zone_id)
            except Exception as exc:
                log.warning(
                    "forecast_shield_zone_fetch_failed",
                    engine_name="forecast_shield_service",
                    zone_id=zone_id,
                    error=str(exc),
                )

    # Drop only shields for zones we successfully refreshed; keep stale data for failed fetches.
    kept = {k: v for k, v in prev.items() if str(v.get("zone_id", "")) not in zones_refreshed}
    kept.update(combined)
    app.state.forecast_shields = kept
    log.info(
        "forecast_shields_refreshed",
        engine_name="forecast_shield_service",
        mode="openweather",
        zones_refreshed=len(zones_refreshed),
        shield_keys=len(combined),
    )
