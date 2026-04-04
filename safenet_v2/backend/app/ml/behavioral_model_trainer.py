from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List

import numpy as np

from app.db.mongo import connect_mongo


def _speed_kmh(p1: Dict[str, Any], p2: Dict[str, Any]) -> float:
    # Lightweight approximation for training baseline only.
    lat1, lon1 = float(p1.get("lat", 0)), float(p1.get("lon", 0))
    lat2, lon2 = float(p2.get("lat", 0)), float(p2.get("lon", 0))
    dt = max(1.0, (datetime.fromisoformat(str(p2["timestamp"])) - datetime.fromisoformat(str(p1["timestamp"]))).total_seconds())
    dist_km = (((lat2 - lat1) ** 2 + (lon2 - lon1) ** 2) ** 0.5) * 111.0
    return float(max(0.0, dist_km / (dt / 3600.0)))


async def train_worker_behavioral_baselines(min_weeks: int = 4) -> int:
    """
    Phase-3 readiness utility:
    Build statistical worker baselines from real telemetry after 4+ weeks.
    Stores baselines in `worker_behavioral_baselines`.
    """
    db = await connect_mongo()
    if db is None:
        return 0

    cutoff = datetime.now(timezone.utc) - timedelta(weeks=min_weeks)
    trails = db["worker_gps_trails"]
    events = db["worker_app_events"]
    out = db["worker_behavioral_baselines"]

    worker_ids = await trails.distinct("worker_id", {"timestamp": {"$gte": cutoff}})
    updated = 0
    for wid in worker_ids:
        points = await trails.find({"worker_id": wid, "timestamp": {"$gte": cutoff}}).sort("timestamp", 1).to_list(length=20000)
        if len(points) < 20:
            continue

        speed_by_hour = defaultdict(list)
        for i in range(1, len(points)):
            p1, p2 = points[i - 1], points[i]
            try:
                h = datetime.fromisoformat(str(p2["timestamp"])).hour
                speed_by_hour[h].append(_speed_kmh(p1, p2))
            except Exception:
                continue

        baseline_speed = {str(h): float(np.median(v)) for h, v in speed_by_hour.items() if v}
        if not baseline_speed:
            continue

        # Approximate deliveries/hour from app logs tagged as delivery events.
        delivery_events = await events.count_documents(
            {"worker_id": wid, "timestamp": {"$gte": cutoff}, "event_type": {"$in": ["delivery_complete", "claim_status_view"]}}
        )
        total_hours = max(1.0, len(points) / 12.0)  # ~5 minute points
        deliveries_per_hour = float(delivery_events) / float(total_hours)

        # Interaction interval baseline
        app_rows = await events.find({"worker_id": wid, "timestamp": {"$gte": cutoff}}).sort("timestamp", 1).to_list(length=15000)
        gaps = []
        for i in range(1, len(app_rows)):
            try:
                t1 = datetime.fromisoformat(str(app_rows[i - 1]["timestamp"]))
                t2 = datetime.fromisoformat(str(app_rows[i]["timestamp"]))
                gaps.append(max(0.0, (t2 - t1).total_seconds() / 60.0))
            except Exception:
                continue
        interaction_interval = float(np.median(gaps)) if gaps else 6.0

        # Zone polygon from GPS cloud bbox
        lats = [float(p.get("lat", 0.0)) for p in points]
        lons = [float(p.get("lon", 0.0)) for p in points]
        min_lat, max_lat = float(np.percentile(lats, 5)), float(np.percentile(lats, 95))
        min_lon, max_lon = float(np.percentile(lons, 5)), float(np.percentile(lons, 95))
        zone_polygon = {
            "type": "Polygon",
            "coordinates": [[[min_lon, min_lat], [max_lon, min_lat], [max_lon, max_lat], [min_lon, max_lat], [min_lon, min_lat]]],
        }

        active_hours = sorted(int(h) for h in baseline_speed.keys())
        start_h = min(active_hours)
        end_h = max(active_hours)

        doc = {
            "worker_id": wid,
            "baseline_speed_kmh": baseline_speed,
            "baseline_deliveries_per_hour": float(deliveries_per_hour),
            "baseline_active_hours_window": [int(start_h), int(end_h)],
            "baseline_app_interaction_interval_minutes": float(interaction_interval),
            "baseline_zone_polygon": zone_polygon,
            "last_updated": datetime.now(timezone.utc),
        }
        await out.update_one({"worker_id": wid}, {"$set": doc}, upsert=True)
        updated += 1
    return updated

