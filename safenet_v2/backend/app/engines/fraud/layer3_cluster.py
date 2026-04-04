from __future__ import annotations

import hashlib
import statistics
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from app.engines.fraud.types import L3Result, RingConfidence
from app.services.realtime_service import publish_fraud_alert
from app.utils.logger import get_logger

log = get_logger(__name__)


class Layer3Cluster:
    def __init__(self, mongo_db: Any = None) -> None:
        self._mongo = mongo_db

    async def _historical_hourly_density(self, zone_id: str, hour: int) -> float:
        if self._mongo is None:
            return 1.0
        try:
            doc = await self._mongo["zone_fraud_density_baseline"].find_one(
                {"zone_id": zone_id, "hour": hour}
            )
            if doc and doc.get("avg_flagged_per_hour"):
                return float(doc["avg_flagged_per_hour"])
        except Exception:
            pass
        return 1.0

    async def _recent_flagged_in_zone(self, zone_id: str, since: datetime) -> List[Dict[str, Any]]:
        if self._mongo is None:
            return []
        try:
            cur = (
                self._mongo["fraud_decisions"]
                .find(
                    {
                        "zone_id": zone_id,
                        "created_at": {"$gte": since},
                        "l2_decision": {"$in": ["FLAG", "BLOCK"]},
                    }
                )
                .sort("created_at", -1)
                .limit(500)
            )
            return await cur.to_list(length=500)
        except Exception:
            return []

    async def run(
        self,
        zone_id: str,
        worker_id: int,
        claim_id: str,
        l2_reason_code: str,
        inactivity_seconds: float,
        confidence_level: Optional[str],
        redis: Any = None,
    ) -> L3Result:
        now = datetime.now(timezone.utc)
        since = now - timedelta(minutes=60)
        flagged = await self._recent_flagged_in_zone(zone_id, since)
        worker_ids = [int(d.get("worker_id", 0)) for d in flagged]
        worker_ids.append(worker_id)
        worker_ids = sorted(set(worker_ids))

        hour = now.hour
        baseline = await self._historical_hourly_density(zone_id, hour)
        count = len(flagged) + 1
        density_spike = baseline > 0 and count > 3.0 * baseline

        sync_spike = False
        window_start = now - timedelta(minutes=3)
        recent_times: List[datetime] = [now]
        for d in flagged:
            ts = d.get("created_at")
            if isinstance(ts, datetime) and ts >= window_start:
                recent_times.append(ts)
        if len(recent_times) >= 5:
            sync_spike = True

        inactivities: List[float] = []
        for d in flagged:
            v = d.get("inactivity_duration_seconds")
            if v is not None:
                inactivities.append(float(v))
        inactivities.append(inactivity_seconds)
        homo_var = statistics.variance(inactivities) if len(inactivities) >= 2 else 9999.0
        codes = [d.get("l2_reason_code") for d in flagged if d.get("l2_reason_code")]
        reasons_match = len(set(codes)) <= 1 if codes else True
        homogeneous = homo_var < 60.0 and reasons_match and len(inactivities) >= 3

        checks: List[str] = []
        if density_spike:
            checks.append("density_spike")
        if sync_spike:
            checks.append("sync_spike")
        if homogeneous:
            checks.append("homogeneous")

        suppress = confidence_level == "HIGH"
        if suppress:
            checks = []
            density_spike = sync_spike = homogeneous = False

        triggered = sum([density_spike, sync_spike, homogeneous])
        ring: RingConfidence = "NONE"
        freeze = False
        if triggered == 3:
            ring = "CONFIRMED"
            freeze = True
        elif triggered == 2:
            ring = "PROBABLE"
            freeze = True
        elif triggered == 1:
            ring = "MONITOR"

        cid = hashlib.sha256(f"{zone_id}:{claim_id}:{now.isoformat()}".encode()).hexdigest()[:16]

        # Publish fraud alerts to real-time consumers when we reach probable/confirmed ring confidence.
        if ring in ("PROBABLE", "CONFIRMED"):
            try:
                await publish_fraud_alert(
                    redis=redis,
                    cluster_id=cid,
                    ring_confidence=ring,
                    worker_ids=worker_ids,
                    zone_id=zone_id,
                )
            except Exception as exc:
                log.warning(
                    "fraud_alert_publish_failed",
                    engine_name="fraud_layer3",
                    reason_code="PUBLISH_ERROR",
                    error=str(exc),
                    zone_id=zone_id,
                    cluster_id=cid,
                )

        log.info(
            "fraud_layer3",
            engine_name="fraud_layer3",
            ring_confidence=ring,
            checks=len(checks),
            zone_id=zone_id,
        )

        return L3Result(
            ring_confidence=ring,
            checks_triggered=checks,
            cluster_id=cid,
            freeze=freeze,
            worker_ids=worker_ids,
            density_spike=density_spike,
            sync_spike=sync_spike,
            homogeneous=homogeneous,
        )
