import random
from datetime import datetime, timezone
from pathlib import Path
import json
from typing import Any, Dict, Tuple

from app.db.mongo import connect_mongo
from app.models.worker import Profile
from app.utils.logger import get_logger

log = get_logger(__name__)


def _point_in_polygon(lat: float, lon: float, polygon: Dict[str, Any]) -> bool:
    try:
        coords = polygon["coordinates"][0]
    except Exception:
        return True
    x = lon
    y = lat
    inside = False
    j = len(coords) - 1
    for i in range(len(coords)):
        xi, yi = float(coords[i][0]), float(coords[i][1])
        xj, yj = float(coords[j][0]), float(coords[j][1])
        intersect = ((yi > y) != (yj > y)) and (x < ((xj - xi) * (y - yi) / (yj - yi + 1e-9) + xi))
        if intersect:
            inside = not inside
        j = i
    return inside


def _load_city_baseline() -> Dict[str, Any]:
    path = Path(__file__).resolve().parents[1] / "ml" / "city_baselines.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


class BehavioralEngine:
    @staticmethod
    def income_outcome(profile: Profile, is_active: bool, is_disruption: bool) -> Tuple[float, float, float]:
        expected = float(profile.avg_daily_income)

        if is_active:
            pct = random.uniform(0.80, 1.00)
        else:
            if is_disruption:
                pct = random.uniform(0.20, 0.50)
            else:
                pct = random.uniform(0.50, 0.70)

        actual = round(expected * pct, 2)
        loss = round(max(0.0, expected - actual), 2)
        reason_code = "INCOME_SIMULATED"
        log.info(
            "income_simulated",
            engine_name="behavioral_engine",
            decision=f"loss={loss}",
            reason_code=reason_code,
            worker_id=profile.user_id,
            expected_income=expected,
            actual_income=actual,
            loss=loss,
            is_active=is_active,
        )
        return expected, actual, loss

    @staticmethod
    async def compute_deviation(
        worker_id: int,
        current_gps_trail: list[Dict[str, Any]],
        current_app_log: list[Dict[str, Any]],
        *,
        disruption_confirmed: bool = False,
    ) -> Dict[str, Any]:
        db = await connect_mongo()
        baseline = None
        if db is not None:
            baseline = await db["worker_behavioral_baselines"].find_one({"worker_id": worker_id})

        if baseline is None:
            baseline = _load_city_baseline().get("default", {})
            baseline = {
                "baseline_speed_kmh": baseline.get("baseline_speed_kmh_by_hour", {"9": 20.0}),
                "baseline_deliveries_per_hour": baseline.get("baseline_deliveries_per_hour", 2.5),
                "baseline_active_hours_window": baseline.get("baseline_active_hours_window", [8, 21]),
                "baseline_app_interaction_interval_minutes": baseline.get("baseline_app_interaction_interval_minutes", 6.0),
                "baseline_zone_polygon": baseline.get("baseline_zone_polygon"),
            }

        now = datetime.now(timezone.utc)
        hour = now.hour
        speed_baseline = float(baseline.get("baseline_speed_kmh", {}).get(str(hour), 18.0))

        # Approx current speed from last two points.
        current_speed = speed_baseline
        if len(current_gps_trail) >= 2:
            p1 = current_gps_trail[-2]
            p2 = current_gps_trail[-1]
            try:
                t1 = datetime.fromisoformat(str(p1["timestamp"]))
                t2 = datetime.fromisoformat(str(p2["timestamp"]))
                dt_hours = max(1e-6, (t2 - t1).total_seconds() / 3600.0)
                dlat = float(p2.get("lat", 0)) - float(p1.get("lat", 0))
                dlon = float(p2.get("lon", 0)) - float(p1.get("lon", 0))
                dist_km = ((dlat**2 + dlon**2) ** 0.5) * 111.0
                current_speed = max(0.0, dist_km / dt_hours)
            except Exception:
                current_speed = speed_baseline

        speed_deviation = (current_speed - speed_baseline) / max(1e-6, speed_baseline)

        deliveries_baseline = float(baseline.get("baseline_deliveries_per_hour", 2.5))
        current_delivery_rate = float(len(current_app_log)) / 1.0  # assume 1h window
        delivery_rate_deviation = (current_delivery_rate - deliveries_baseline) / max(1e-6, deliveries_baseline)

        # App inactivity
        baseline_interval = float(baseline.get("baseline_app_interaction_interval_minutes", 6.0))
        inactivity_flag = False
        if len(current_app_log) >= 2:
            try:
                last_two = sorted(current_app_log[-2:], key=lambda x: str(x.get("timestamp")))
                t1 = datetime.fromisoformat(str(last_two[0]["timestamp"]))
                t2 = datetime.fromisoformat(str(last_two[1]["timestamp"]))
                inactivity_flag = ((t2 - t1).total_seconds() / 60.0) > (baseline_interval * 1.5)
            except Exception:
                inactivity_flag = False

        zone_exit_flag = False
        if current_gps_trail and baseline.get("baseline_zone_polygon"):
            last = current_gps_trail[-1]
            zone_exit_flag = not _point_in_polygon(
                float(last.get("lat", 0)),
                float(last.get("lon", 0)),
                baseline.get("baseline_zone_polygon"),
            )

        score = 0.0
        if speed_deviation > 0.5:
            score += 25.0
        if delivery_rate_deviation > 0.4:
            score += 25.0
        if inactivity_flag:
            score += 20.0
        if zone_exit_flag:
            score += 10.0
        if disruption_confirmed:
            score *= 1.3
        score = max(0.0, min(100.0, score))

        if score < 30:
            band = "LOW"
        elif score < 55:
            band = "MODERATE"
        elif score < 75:
            band = "HIGH"
        else:
            band = "CRITICAL"

        return {
            "speed_deviation": round(float(speed_deviation), 4),
            "delivery_rate_deviation": round(float(delivery_rate_deviation), 4),
            "inactivity_flag": bool(inactivity_flag),
            "zone_exit_flag": bool(zone_exit_flag),
            "deviation_score": round(float(score), 2),
            "risk_band": band,
            "baseline_used": baseline,
        }
