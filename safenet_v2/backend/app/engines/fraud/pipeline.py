from __future__ import annotations

import uuid
from dataclasses import asdict
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from app.db.mongo import save_fraud_decision
from app.engines.fraud.layer1_gps import Layer1GPS
from app.engines.fraud.layer2_corroboration import Layer2Corroboration
from app.engines.fraud.layer3_cluster import Layer3Cluster
from app.engines.fraud.layer4_enrollment import Layer4Enrollment
from app.engines.fraud.types import (
    AppActivityEvent,
    FraudPipelineInput,
    FraudResult,
    GPSPoint,
    GPSZone,
    OverallDecision,
)
from app.utils.logger import get_logger

log = get_logger(__name__)


def _compute_fraud_score(
    l4: Any,
    l1: Any,
    l2: Any,
    l3: Any,
    fraud_flag_sim: bool,
) -> float:
    score = 0.0
    if fraud_flag_sim:
        score += 0.15
    if l4.scrutiny_level == "HIGH":
        score += 0.15
    elif l4.scrutiny_level == "ELEVATED":
        score += 0.08
    if l1.integrity == "SUSPICIOUS":
        score += min(0.35, 0.07 * max(1, l1.gps_score))
    if l2.decision == "BLOCK":
        score += 0.45
    elif l2.decision == "FLAG":
        score += 0.25
    if l3.ring_confidence == "CONFIRMED":
        return 1.0
    if l3.ring_confidence == "PROBABLE":
        score = min(1.0, score + 0.35)
    elif l3.ring_confidence == "MONITOR":
        score = min(1.0, score + 0.08)
    return min(1.0, score)


def _overall_decision(l2: Any, l3: Any, fraud_score: float) -> OverallDecision:
    if l3.ring_confidence == "CONFIRMED":
        return "BLOCKED"
    if l2.decision == "BLOCK":
        return "BLOCKED"
    if l3.ring_confidence == "PROBABLE" or l2.decision == "FLAG":
        return "FLAGGED"
    if fraud_score >= 0.75:
        return "FLAGGED"
    return "CLEAN"


def _reason_codes(l4: Any, l1: Any, l2: Any, l3: Any) -> List[str]:
    codes: List[str] = list(l4.flags)
    codes.extend(l1.flags)
    codes.append(l2.reason_code)
    codes.extend(l3.checks_triggered)
    return [c for c in codes if c]


class MasterFraudPipeline:
    def __init__(self, mongo_db: Any = None, redis: Any = None) -> None:
        self._mongo = mongo_db
        self._redis = redis

    async def execute(self, inp: FraudPipelineInput) -> FraudResult:
        zone = inp.zone_gps
        l4_engine = Layer4Enrollment(self._redis, self._mongo)
        l4 = await l4_engine.run(
            inp.worker_id,
            inp.enrollment_timestamp,
            inp.zone_id,
            inp.first_claim_at,
        )

        l1_engine = Layer1GPS(zone)
        l1 = l1_engine.run(
            inp.gps_trail,
            inp.city_avg_lat,
            inp.city_avg_lon,
            l4.elevated_scrutiny,
        )

        l2_engine = Layer2Corroboration(zone)
        l2 = l2_engine.run(
            inp.gps_trail,
            inp.confidence_signals_active,
            inp.app_activity,
            inp.platform_drop_pct,
            inp.city_avg_lat,
            inp.city_avg_lon,
            inp.weather_signal,
            inp.aqi_signal,
        )

        inactivity_seconds = 3600.0
        if inp.app_activity and len(inp.app_activity) >= 2:
            ev = sorted(inp.app_activity, key=lambda e: e.timestamp)
            inactivity_seconds = max(
                (ev[i].timestamp - ev[i - 1].timestamp).total_seconds()
                for i in range(1, len(ev))
            )

        l3_engine = Layer3Cluster(self._mongo)
        l3 = await l3_engine.run(
            inp.zone_id,
            inp.worker_id,
            inp.claim_id,
            l2.reason_code,
            inactivity_seconds,
            inp.confidence_level,
            redis=self._redis,
        )

        fraud_score = _compute_fraud_score(l4, l1, l2, l3, inp.fraud_flag_sim)
        overall = _overall_decision(l2, l3, fraud_score)
        reasons = _reason_codes(l4, l1, l2, l3)

        layer_results: Dict[str, Any] = {
            "L4": asdict(l4),
            "L1": asdict(l1),
            "L2": asdict(l2),
            "L3": asdict(l3),
        }

        doc = {
            "claim_id": inp.claim_id,
            "worker_id": inp.worker_id,
            "zone_id": inp.zone_id,
            "created_at": datetime.now(timezone.utc),
            "overall_decision": overall,
            "fraud_score": fraud_score,
            "reason_codes": reasons,
            "layer_results": layer_results,
            "l2_decision": l2.decision,
            "l2_reason_code": l2.reason_code,
            "inactivity_duration_seconds": inactivity_seconds,
        }

        if self._mongo is not None:
            try:
                await save_fraud_decision(self._mongo, doc)
            except Exception as exc:
                log.warning("fraud_mongo_save_failed", error=str(exc))

        log.info(
            "fraud_pipeline_complete",
            engine_name="fraud_pipeline",
            overall_decision=overall,
            fraud_score=fraud_score,
            worker_id=inp.worker_id,
        )

        return FraudResult(
            overall_decision=overall,
            layer_results=layer_results,
            fraud_score=fraud_score,
            reason_codes=reasons,
            claim_id=inp.claim_id,
            worker_id=inp.worker_id,
        )


async def run_fraud_pipeline(
    claim_id: str,
    worker_id: int,
    gps_trail: List[GPSPoint],
    app_log: List[AppActivityEvent],
    zone_id: str,
    *,
    enrollment_timestamp: datetime,
    first_claim_at: Optional[datetime],
    fraud_flag_sim: bool,
    confidence_level: Optional[str],
    confidence_signals_active: List[str],
    weather_signal: Any,
    aqi_signal: Any,
    platform_drop_pct: float,
    zone_gps: GPSZone,
    city_avg_lat: float,
    city_avg_lon: float,
    mongo_db: Any,
    redis: Any,
) -> FraudResult:
    inp = FraudPipelineInput(
        claim_id=claim_id,
        worker_id=worker_id,
        zone_id=zone_id,
        enrollment_timestamp=enrollment_timestamp,
        first_claim_at=first_claim_at,
        gps_trail=gps_trail,
        app_activity=app_log,
        fraud_flag_sim=fraud_flag_sim,
        confidence_level=confidence_level,
        confidence_signals_active=confidence_signals_active,
        weather_signal=weather_signal,
        aqi_signal=aqi_signal,
        platform_drop_pct=platform_drop_pct,
        zone_gps=zone_gps,
        city_avg_lat=city_avg_lat,
        city_avg_lon=city_avg_lon,
    )
    pipeline = MasterFraudPipeline(mongo_db, redis)
    return await pipeline.execute(inp)


def new_claim_id() -> str:
    return str(uuid.uuid4())
