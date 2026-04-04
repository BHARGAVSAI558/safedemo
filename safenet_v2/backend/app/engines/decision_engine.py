import json
from dataclasses import asdict
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.engines.behavioral_engine import BehavioralEngine
from app.engines.confidence_engine import ConfidenceEngine
from app.engines.fraud.types import AppActivityEvent, GPSPoint
from app.engines.fraud_engine import FRAUD_THRESHOLD, FraudEngine, build_gps_zone, first_simulation_time
from app.engines.payout_engine import PayoutEngine
from app.engines.premium_engine import PremiumEngine
from app.engines.trust_engine import TrustEngine
from app.models.claim import DecisionType, Log, Simulation
from app.models.fraud import FraudSignal
from app.models.payout import PayoutRecord
from app.models.worker import Profile, User
from app.schemas.claim import DisruptionData, SimulationRequest, SimulationResponse
from app.services.event_service import TrafficService, default_event_signals
from app.services.realtime_service import publish_claim_update
from app.services.zone_resolver import resolve_city_to_zone
from app.utils.logger import get_logger

log = get_logger(__name__)


def _build_weather_payload(conf: Any) -> dict[str, Any]:
    out: dict[str, Any] = {
        "zone_id": None,
        "disruption_type": conf.disruption_type,
        "confidence": {
            "level": conf.level,
            "score": conf.score,
            "signals_active": list(conf.signals_active),
            "api_degraded": conf.api_degraded,
            "disruption_type": conf.disruption_type,
        }
    }
    if conf.weather is not None:
        out["weather"] = asdict(conf.weather)
    if conf.aqi is not None:
        out["aqi"] = asdict(conf.aqi)
    return out


class DecisionEngine:
    @staticmethod
    async def run(
        user_id: int,
        request: SimulationRequest,
        db: AsyncSession,
        *,
        redis: Any = None,
        mongo_db: Any = None,
        forecast_shields: dict[str, Any] | None = None,
    ) -> SimulationResponse:
        result = await db.execute(select(Profile).where(Profile.user_id == user_id))
        profile = result.scalar_one_or_none()
        if not profile:
            raise ValueError("User profile not found. Please create a profile first.")

        PremiumEngine.monthly_premium(profile)

        correlation_id = str(uuid4())
        city = profile.city
        zone_id, lat, lon = resolve_city_to_zone(city)
        ce = ConfidenceEngine(redis=redis, mongo_db=mongo_db)
        conf = await ce.evaluate(zone_id, lat, lon, city=city)

        traffic_disruption, traffic_reason, _ = TrafficService.get(city)

        weather_disruption = any(s in conf.signals_active for s in ("rain", "heat"))
        event_disruption = any(s in conf.signals_active for s in ("social", "platform"))
        aqi_disruption = "aqi" in conf.signals_active

        final_disruption = (
            weather_disruption or traffic_disruption or event_disruption or aqi_disruption
        )

        disruption_reasons: list[str] = []
        if weather_disruption:
            disruption_reasons.append(
                "weather:" + ",".join(s for s in conf.signals_active if s in ("rain", "heat"))
            )
        if aqi_disruption:
            disruption_reasons.append("air_quality_hazardous")
        if traffic_disruption:
            disruption_reasons.append(traffic_reason)
        if event_disruption:
            disruption_reasons.append(
                "events:" + ",".join(s for s in conf.signals_active if s in ("social", "platform"))
            )

        user_row = await db.execute(select(User).where(User.id == user_id))
        user = user_row.scalar_one()
        enrollment_ts = user.created_at
        if enrollment_ts is not None and enrollment_ts.tzinfo is None:
            enrollment_ts = enrollment_ts.replace(tzinfo=timezone.utc)

        first_ts = await first_simulation_time(db, user_id)
        first_claim_l4 = datetime.now(timezone.utc) if first_ts is None else first_ts
        if first_claim_l4.tzinfo is None:
            first_claim_l4 = first_claim_l4.replace(tzinfo=timezone.utc)

        other_pre = (
            any(s in conf.signals_active for s in ("rain", "heat"))
            or "aqi" in conf.signals_active
            or any(s in conf.signals_active for s in ("social", "platform"))
        )
        pd = await default_event_signals().get_platform_demand(zone_id, other_triggers_active=other_pre)

        gps_trail: list[GPSPoint] = []
        if request.gps_trail:
            for g in request.gps_trail:
                gps_trail.append(
                    GPSPoint(
                        lat=g.lat,
                        lon=g.lon,
                        timestamp=g.timestamp,
                        cell_tower_id=g.cell_tower_id,
                        accelerometer_magnitude=g.accelerometer_magnitude,
                    )
                )

        app_log: list[AppActivityEvent] = []
        if request.app_activity:
            for a in request.app_activity:
                app_log.append(AppActivityEvent(timestamp=a.timestamp, event_type=a.event_type))

        zg = build_gps_zone(zone_id, lat, lon)

        fr = await FraudEngine.evaluate(
            user_id,
            request.fraud_flag,
            db,
            mongo_db=mongo_db,
            redis=redis,
            zone_id=zone_id,
            enrollment_timestamp=enrollment_ts,
            first_claim_at=first_claim_l4,
            gps_trail=gps_trail,
            app_activity=app_log,
            confidence_level=conf.level,
            confidence_signals_active=list(conf.signals_active),
            weather_signal=conf.weather,
            aqi_signal=conf.aqi,
            platform_drop_pct=pd.drop_pct_vs_baseline,
            zone_gps=zg,
            city_avg_lat=lat,
            city_avg_lon=lon,
        )
        fraud_score = fr.fraud_score
        fraud_reason = "; ".join(fr.reason_codes) if fr.reason_codes else "fraud_pipeline"

        expected, actual, loss = BehavioralEngine.income_outcome(
            profile, request.is_active, final_disruption
        )

        fraud_blocked = fr.overall_decision == "BLOCKED" or fraud_score >= FRAUD_THRESHOLD
        fraud_flagged = fr.overall_decision == "FLAGGED" and not fraud_blocked

        reason_code = "DECISION"
        publish_status = "REJECTED"

        if fraud_blocked:
            decision = DecisionType.FRAUD
            reason = f"Claim rejected — {fraud_reason}"
            payout = 0.0
            publish_status = "CLAIM_REJECTED"
            reason_code = "DECISION_FRAUD"
        elif fraud_flagged:
            decision = DecisionType.REJECTED
            reason = f"Claim flagged for manual review — {fraud_reason}"
            payout = 0.0
            publish_status = "REVALIDATING"
            reason_code = "DECISION_FLAGGED"
        elif not final_disruption:
            decision = DecisionType.REJECTED
            reason = "No disruption detected in your area"
            payout = 0.0
            publish_status = "CLAIM_REJECTED"
            reason_code = "DECISION_NO_DISRUPTION"
        elif request.is_active:
            decision = DecisionType.REJECTED
            reason = f"Worker was active during disruption ({', '.join(disruption_reasons)})"
            payout = 0.0
            publish_status = "CLAIM_REJECTED"
            reason_code = "DECISION_ACTIVE_DURING_DISRUPTION"
        else:
            decision = DecisionType.APPROVED
            reason = f"Payout approved — {', '.join(disruption_reasons)}"
            payout, reason_code = PayoutEngine.compute(loss, profile.trust_score)
            publish_status = "APPROVED"

        log.info(
            "decision_final",
            engine_name="decision_engine",
            decision=decision.value,
            reason_code=reason_code,
            worker_id=user_id,
            payout=payout,
            fraud_score=fraud_score,
        )

        weather_payload = _build_weather_payload(conf)
        weather_payload["zone_id"] = zone_id
        weather_payload["fraud"] = {
            "overall_decision": fr.overall_decision,
            "fraud_score": fr.fraud_score,
            "claim_id": fr.claim_id,
            "layer_results": fr.layer_results,
        }
        sim = Simulation(
            user_id=user_id,
            is_active=request.is_active,
            fraud_flag=request.fraud_flag,
            fraud_score=fraud_score,
            weather_disruption=weather_disruption,
            traffic_disruption=traffic_disruption,
            event_disruption=event_disruption,
            final_disruption=final_disruption,
            expected_income=expected,
            actual_income=actual,
            loss=loss,
            payout=payout,
            decision=decision,
            reason=reason,
            weather_data=json.dumps(weather_payload, default=str),
        )
        db.add(sim)
        await db.flush()
        await db.refresh(sim)

        db.add(
            FraudSignal(
                user_id=user_id,
                simulation_id=sim.id,
                score=fraud_score,
                reason_code="POST_RUN",
                detail=fraud_reason,
            )
        )

        if decision == DecisionType.APPROVED:
            profile.total_claims = int(profile.total_claims) + 1
            profile.total_payouts = float(profile.total_payouts) + payout
            db.add(PayoutRecord(simulation_id=sim.id, amount=payout, currency="INR", status="completed"))

        TrustEngine.penalize_fraud(profile, fraud_score, FRAUD_THRESHOLD)

        db.add(
            Log(
                user_id=user_id,
                event_type="simulation_run",
                detail=f"decision={decision.value} payout={payout}",
            )
        )
        if decision == DecisionType.FRAUD or fraud_blocked:
            db.add(
                Log(
                    user_id=user_id,
                    event_type="fraud_attempt",
                    detail=f"claim_rejected score={fraud_score}",
                )
            )
        await db.commit()

        try:
            await publish_claim_update(
                redis=redis,
                worker_id=user_id,
                claim_id=sim.id,
                status=publish_status,
                message=reason,
                payout_amount=None,
                zone_id=str(weather_payload.get("zone_id", "")) or None,
                disruption_type=str(weather_payload.get("disruption_type", "")) or None,
                confidence_level=str(conf.level),
                fraud_score=float(fraud_score),
                correlation_id=correlation_id,
            )
        except Exception as exc:
            log.warning(
                "claim_update_publish_failed",
                engine_name="decision_engine",
                reason_code="PUBLISH_ERROR",
                error=str(exc),
                worker_id=user_id,
            )

        if decision == DecisionType.APPROVED:
            try:
                await PayoutEngine.publish_payout_after_disbursement(
                    redis=redis,
                    claim_id=sim.id,
                    worker_id=user_id,
                    payout_amount=payout,
                    zone_id=str(weather_payload.get("zone_id", "")) or None,
                    disruption_type=str(weather_payload.get("disruption_type", "")) or None,
                    correlation_id=correlation_id,
                    forecast_shields=forecast_shields,
                )
            except Exception as exc:
                log.warning(
                    "payout_publish_failed",
                    engine_name="decision_engine",
                    reason_code="PUBLISH_ERROR",
                    error=str(exc),
                    worker_id=user_id,
                )

        return SimulationResponse(
            id=sim.id,
            disruption=DisruptionData(
                weather=weather_disruption,
                traffic=traffic_disruption,
                event=event_disruption,
                final_disruption=final_disruption,
            ),
            decision=decision.value,
            reason=reason,
            fraud_score=fraud_score,
            expected_income=expected,
            actual_income=actual,
            loss=loss,
            payout=payout,
            weather_data=weather_payload,
            created_at=sim.created_at,
        )
