from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any, List, Optional

from app.engines.fraud.types import L4Result, ScrutinyLevel
from app.utils.logger import get_logger

log = get_logger(__name__)


class Layer4Enrollment:
    """Enrollment timing anomaly detection."""

    def __init__(self, redis: Any = None, mongo_db: Any = None) -> None:
        self._redis = redis
        self._mongo = mongo_db

    async def _weather_alert_times(self, zone_id: str) -> List[datetime]:
        """Public weather alert timestamps for zone (Redis or Mongo)."""
        if self._redis is not None:
            try:
                raw = await self._redis.get(f"weather_alerts:{zone_id}")
                if raw:
                    data = json.loads(raw) if isinstance(raw, str) else raw
                    if isinstance(data, list):
                        out: List[datetime] = []
                        for x in data:
                            if isinstance(x, str):
                                out.append(datetime.fromisoformat(x.replace("Z", "+00:00")))
                        return out
            except Exception as exc:
                log.warning("l4_weather_alerts_read_failed", error=str(exc))
        if self._mongo is not None:
            try:
                doc = await self._mongo["zone_weather_alerts"].find_one({"zone_id": zone_id})
                if doc and doc.get("alerts"):
                    return [datetime.fromisoformat(str(t)) for t in doc["alerts"]]
            except Exception:
                pass
        return []

    async def _enrollment_baseline_hour(self, zone_id: str, hour: int) -> float:
        """30-day style baseline enrollments per hour for zone (default 1.0 for first-time zone)."""
        if self._mongo is None:
            return 1.0
        try:
            doc = await self._mongo["zone_enrollment_baselines"].find_one({"zone_id": zone_id, "hour": hour})
            if doc and doc.get("avg_per_hour"):
                return float(doc["avg_per_hour"])
        except Exception:
            pass
        return 1.0

    async def _enrollment_count_4h_before_window(
        self,
        zone_id: str,
        enrollment_ts: datetime,
    ) -> float:
        """Count enrollments in [enrollment-4h, enrollment) from Redis counters."""
        if self._redis is None:
            return 1.0
        total = 0.0
        t = enrollment_ts
        for _ in range(4):
            bucket = t.strftime("%Y%m%d%H")
            try:
                key = f"enroll:{zone_id}:{bucket}"
                v = await self._redis.get(key)
                total += float(v or 0)
            except Exception:
                pass
            t -= timedelta(hours=1)
        return max(total, 0.0)

    async def _alert_active_near(self, zone_id: str, at: datetime) -> bool:
        """Any public weather alert active within 2h of `at`."""
        times = await self._weather_alert_times(zone_id)
        for t in times:
            if abs((at - t).total_seconds()) <= 7200:
                return True
        return False

    async def run(
        self,
        worker_id: int,
        enrollment_timestamp: datetime,
        zone_id: str,
        first_claim_at: Optional[datetime],
    ) -> L4Result:
        enr = enrollment_timestamp
        if enr.tzinfo is None:
            enr = enr.replace(tzinfo=timezone.utc)

        flags: List[str] = []
        suspicious_enrollment = False
        mass_enrollment = False
        fast_claim = False

        alert_times = await self._weather_alert_times(zone_id)
        for t in alert_times:
            if abs((enr - t).total_seconds()) <= 7200:
                suspicious_enrollment = True
                flags.append("enrollment_within_2h_weather_alert")
                break

        hour = enr.hour
        baseline = await self._enrollment_baseline_hour(zone_id, hour)
        window_count = await self._enrollment_count_4h_before_window(zone_id, enr)
        if baseline > 0 and window_count >= 3.0 * baseline:
            mass_enrollment = True
            flags.append("mass_enrollment_spike")

        if first_claim_at is not None:
            fc = first_claim_at
            if fc.tzinfo is None:
                fc = fc.replace(tzinfo=timezone.utc)
            if (fc - enr).total_seconds() <= 48 * 3600:
                if await self._alert_active_near(zone_id, fc):
                    fast_claim = True
                    flags.append("fast_claim_under_alert")

        if suspicious_enrollment:
            flags.append("suspicious_enrollment")

        scrutiny: ScrutinyLevel = "NORMAL"
        if suspicious_enrollment or mass_enrollment or fast_claim:
            scrutiny = "ELEVATED"
        if (suspicious_enrollment and mass_enrollment) or (suspicious_enrollment and fast_claim):
            scrutiny = "HIGH"

        elevated = scrutiny in ("ELEVATED", "HIGH")

        log.info(
            "fraud_layer4",
            engine_name="fraud_layer4",
            scrutiny_level=scrutiny,
            elevated_scrutiny=elevated,
            worker_id=worker_id,
        )

        return L4Result(
            suspicious_enrollment=suspicious_enrollment,
            mass_enrollment=mass_enrollment,
            fast_claim=fast_claim,
            flags=flags,
            scrutiny_level=scrutiny,
            elevated_scrutiny=elevated,
        )
