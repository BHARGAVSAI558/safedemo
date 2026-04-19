"""
DBSCAN-based mass-offline detector for zones with no matching API disruption (zero-day).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import numpy as np
from sklearn.cluster import DBSCAN
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.claim import DisruptionEvent
from app.models.worker import Profile, User
from app.models.zero_day_alert import ZeroDayAlert
from app.models.zone import Zone
from app.services.realtime_service import publish_zero_day_alert


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


async def run_zero_day_detection(db: AsyncSession, *, redis: Any = None) -> list[dict[str, Any]]:
    window_start = _utcnow() - timedelta(minutes=45)

    rows = (
        await db.execute(
            select(User.id, Profile.zone_id, Profile.last_api_call, Profile.last_seen, Profile.last_known_lat, Profile.last_known_lng)
            .join(Profile, Profile.user_id == User.id)
            .where(User.is_active.is_(True), Profile.zone_id.is_not(None))
        )
    ).all()

    zone_groups: dict[str, dict[str, Any]] = {}
    for uid, zid, last_api, last_seen, plat, plng in rows:
        zkey = (zid or "").strip()
        if not zkey:
            continue
        if zkey not in zone_groups:
            zone_groups[zkey] = {"total": 0, "offline": 0, "workers": []}
        zone_groups[zkey]["total"] += 1
        seen = last_api or last_seen
        is_offline = True
        if seen is not None:
            s = seen if seen.tzinfo else seen.replace(tzinfo=timezone.utc)
            is_offline = s < window_start
        if is_offline:
            zone_groups[zkey]["offline"] += 1
        lat = float(plat) if plat is not None else None
        lng = float(plng) if plng is not None else None
        zone_groups[zkey]["workers"].append(
            type("W", (), {"id": uid, "zone_lat": lat, "zone_lng": lng})()
        )

    anomalies: list[dict[str, Any]] = []

    for zone_key, data in zone_groups.items():
        if data["total"] < 3:
            continue
        offline_ratio = data["offline"] / max(data["total"], 1)
        if offline_ratio <= 0.70:
            continue

        zrow = (
            await db.execute(select(Zone).where(func.lower(Zone.city_code) == zone_key.lower()))
        ).scalar_one_or_none()
        zone_norm = str(zrow.city_code) if zrow else zone_key

        recent_disruption = (
            await db.execute(
                select(DisruptionEvent.id)
                .where(
                    func.lower(DisruptionEvent.zone_id) == str(zone_norm).lower(),
                    DisruptionEvent.started_at >= window_start,
                    DisruptionEvent.is_active.is_(True),
                )
                .limit(1)
            )
        ).scalar_one_or_none()

        if recent_disruption is not None:
            continue

        coords_list: list[list[float]] = []
        for w in data["workers"]:
            la = getattr(w, "zone_lat", None) or 0.0
            ln = getattr(w, "zone_lng", None) or 0.0
            if zrow and zrow.lat is not None and zrow.lng is not None and (la == 0 and ln == 0):
                la, ln = float(zrow.lat), float(zrow.lng)
            coords_list.append([float(la), float(ln)])

        coords = np.array(coords_list) if coords_list else np.array([])
        if len(coords) >= 3:
            labels = DBSCAN(eps=0.02, min_samples=2).fit_predict(coords)
            cluster_size = sum(1 for lab in labels if lab >= 0)
            confidence = min(0.95, offline_ratio * (cluster_size / max(data["total"], 1)))
        else:
            confidence = offline_ratio * 0.6

        msg = (
            f"{data['offline']} of {data['total']} workers offline — no API trigger matched "
            f"(zone {zone_norm})"
        )

        recent_dup = (
            await db.execute(
                select(ZeroDayAlert.id)
                .where(
                    ZeroDayAlert.zone_id == zone_norm,
                    ZeroDayAlert.status == "pending",
                    ZeroDayAlert.created_at >= _utcnow() - timedelta(minutes=30),
                )
                .limit(1)
            )
        ).scalar_one_or_none()

        created_new = False
        if recent_dup is None:
            db.add(
                ZeroDayAlert(
                    zone_id=zone_norm,
                    offline_ratio=float(offline_ratio),
                    offline_count=int(data["offline"]),
                    total_count=int(data["total"]),
                    confidence=float(round(confidence, 2)),
                    status="pending",
                    message=msg,
                    payload={
                        "type": "ZERO_DAY_ANOMALY",
                        "action": "HOLD_FOR_ADMIN_REVIEW",
                        "offline_ratio": offline_ratio,
                    },
                )
            )
            await db.flush()
            created_new = True

        if created_new:
            await publish_zero_day_alert(
                redis=redis,
                zone_id=zone_norm,
                confidence=float(confidence),
                offline_ratio=float(offline_ratio),
                offline_count=int(data["offline"]),
                total_count=int(data["total"]),
            )

        anomalies.append(
            {
                "zone_id": zone_norm,
                "offline_ratio": offline_ratio,
                "offline_count": data["offline"],
                "total_count": data["total"],
                "confidence": round(confidence, 2),
                "type": "ZERO_DAY_ANOMALY",
                "action": "HOLD_FOR_ADMIN_REVIEW",
                "description": msg,
            }
        )

    await db.commit()
    return anomalies
