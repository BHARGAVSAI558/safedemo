from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import List

from app.engines.fraud.helpers import (
    haversine_km,
    speed_kmh,
    synthetic_city_trail,
    variance_latlon,
)
from app.engines.fraud.types import GPSPoint, GPSZone, L1Result
from app.utils.logger import get_logger

log = get_logger(__name__)

ACTIVE_HOURS_LOCAL = range(8, 22)
GAP_MINUTES = 8
STATIC_VARIANCE_THRESHOLD = 1e-9


class Layer1GPS:
    def __init__(self, zone: GPSZone) -> None:
        self._zone = zone

    def _normalize_points(
        self,
        trail: List[GPSPoint],
        city_lat: float,
        city_lon: float,
    ) -> List[GPSPoint]:
        if trail and len(trail) >= 2:
            return sorted(trail, key=lambda p: p.timestamp)
        return synthetic_city_trail(city_lat, city_lon)

    def _tower_mismatch(self, point: GPSPoint) -> bool:
        tid = (point.cell_tower_id or "").strip()
        if not tid:
            return False
        z = self._zone.zone_id
        if z in tid:
            return False
        if tid.startswith("tower_default"):
            return False
        return "zone" in tid and z not in tid

    def run(
        self,
        trail: List[GPSPoint],
        city_avg_lat: float,
        city_avg_lon: float,
        elevated_scrutiny: bool,
    ) -> L1Result:
        pts = self._normalize_points(trail, city_avg_lat, city_avg_lon)
        flags: List[str] = []
        teleport = static = tower_m = gap = fake_m = False

        for i in range(1, len(pts)):
            sp = speed_kmh(pts[i - 1], pts[i])
            if sp > 150.0:
                teleport = True
                flags.append("teleportation")

        now = datetime.now(timezone.utc)
        recent = [p for p in pts if (now - p.timestamp).total_seconds() <= 300]
        if len(recent) >= 2:
            v = variance_latlon(recent)
            if v < STATIC_VARIANCE_THRESHOLD:
                static = True
                flags.append("static_spoof")

        for p in pts[-5:]:
            if self._tower_mismatch(p):
                tower_m = True
                flags.append("cell_tower_mismatch")
                break

        for i in range(1, len(pts)):
            dt_min = (pts[i].timestamp - pts[i - 1].timestamp).total_seconds() / 60.0
            h = pts[i].timestamp.hour
            if h in ACTIVE_HOURS_LOCAL and dt_min > GAP_MINUTES:
                gap = True
                flags.append("trajectory_gap")
                break

        for i in range(1, len(pts)):
            sp = speed_kmh(pts[i - 1], pts[i])
            if sp > 5.0 and pts[i].accelerometer_magnitude < 0.3:
                fake_m = True
                flags.append("fake_movement")
                break

        score = sum([teleport, static, tower_m, gap, fake_m])
        threshold = 1 if elevated_scrutiny else 2
        suspicious = score >= threshold
        integrity: str = "SUSPICIOUS" if suspicious else "CLEAN"

        log.info(
            "fraud_layer1",
            engine_name="fraud_layer1",
            integrity=integrity,
            gps_score=score,
            worker_id=None,
        )

        return L1Result(
            integrity=integrity,  # type: ignore[arg-type]
            flags=flags,
            gps_score=score,
            teleport_flag=teleport,
            static_spoof_flag=static,
            tower_mismatch_flag=tower_m,
            gap_flag=gap,
            fake_movement_flag=fake_m,
        )
