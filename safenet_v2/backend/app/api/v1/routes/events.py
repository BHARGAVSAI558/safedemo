"""
Admin Events API
----------------
Manages social disruption events (curfew, strike, zone_closure).
Admin creates events → immediately triggers disruption check for that zone.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.routes.admin import get_admin_user
from app.db.session import get_db
from app.engines.disruption_engine import check_disruptions_for_zone
from app.engines.claims_engine import initiate_claims_for_disruption
from app.models.claim import DisruptionEvent
from app.models.worker import User
from app.models.zone import Zone
from app.utils.logger import get_logger

log = get_logger(__name__)
router = APIRouter()


class EventCreateRequest(BaseModel):
    zone_id: str
    event_type: Literal["curfew", "strike", "zone_closure"]
    description: str
    duration_hours: float = 4.0


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


@router.post("")
async def create_social_event(
    body: EventCreateRequest,
    admin: User = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Admin creates a social disruption event (curfew/strike).
    Immediately triggers disruption check for that zone.
    """
    zone_id = body.zone_id.strip()
    if not zone_id:
        raise HTTPException(status_code=400, detail="zone_id required")

    # Verify zone exists
    zone_row = (
        await db.execute(select(Zone).where(Zone.city_code == zone_id))
    ).scalar_one_or_none()

    if zone_row is None:
        raise HTTPException(status_code=404, detail=f"Zone '{zone_id}' not found")

    now = _utcnow()
    ended_at = now + timedelta(hours=max(0.5, min(24.0, body.duration_hours)))

    event = DisruptionEvent(
        zone_id=zone_id,
        disruption_type=body.event_type,
        severity=1.0,  # social events are always max severity
        confidence="HIGH",
        api_source="admin",
        raw_value=1.0,
        threshold_value=0.0,
        started_at=now,
        ended_at=ended_at,
        is_active=True,
    )
    db.add(event)
    await db.commit()
    await db.refresh(event)

    log.info(
        "social_event_created",
        engine_name="events_route",
        reason_code="EVENT_CREATED",
        zone_id=zone_id,
        event_type=body.event_type,
        event_id=event.id,
        admin_id=admin.id,
    )

    # Immediately trigger disruption check + claims pipeline
    try:
        redis = None  # events route doesn't have app.state access; pass None
        events = await check_disruptions_for_zone(db, zone_row)
        if events:
            await initiate_claims_for_disruption(db, event, redis=redis)
    except Exception as exc:
        log.warning(
            "social_event_trigger_failed",
            engine_name="events_route",
            reason_code="TRIGGER_FAIL",
            zone_id=zone_id,
            error=str(exc),
        )

    return {
        "ok": True,
        "event_id": event.id,
        "zone_id": zone_id,
        "event_type": body.event_type,
        "started_at": event.started_at.isoformat(),
        "ended_at": event.ended_at.isoformat() if event.ended_at else None,
    }


@router.get("")
async def list_social_events(
    admin: User = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
    active_only: bool = False,
):
    """
    Returns all social events (curfew/strike/zone_closure).
    Optionally filtered to active only.
    """
    stmt = (
        select(DisruptionEvent)
        .where(DisruptionEvent.disruption_type.in_(["curfew", "strike", "zone_closure"]))
        .order_by(DisruptionEvent.started_at.desc())
        .limit(100)
    )
    if active_only:
        stmt = stmt.where(DisruptionEvent.is_active.is_(True))

    rows = (await db.execute(stmt)).scalars().all()

    def _iso(dt: Optional[datetime]) -> Optional[str]:
        if dt is None:
            return None
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.isoformat().replace("+00:00", "Z")

    return [
        {
            "id": r.id,
            "zone_id": r.zone_id,
            "event_type": r.disruption_type,
            "severity": round(float(r.severity or 0.0), 3),
            "confidence": r.confidence,
            "is_active": r.is_active,
            "started_at": _iso(r.started_at),
            "ended_at": _iso(r.ended_at),
        }
        for r in rows
    ]


@router.patch("/{event_id}/deactivate")
async def deactivate_social_event(
    event_id: int,
    admin: User = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Manually deactivate a social event.
    Sets is_active=False and ended_at=now.
    """
    row = (
        await db.execute(select(DisruptionEvent).where(DisruptionEvent.id == event_id))
    ).scalar_one_or_none()

    if row is None:
        raise HTTPException(status_code=404, detail="Event not found")

    if not row.is_active:
        return {"ok": True, "already_inactive": True, "event_id": event_id}

    row.is_active = False
    row.ended_at = _utcnow()
    await db.commit()

    log.info(
        "social_event_deactivated",
        engine_name="events_route",
        reason_code="EVENT_DEACTIVATED",
        event_id=event_id,
        admin_id=admin.id,
    )

    return {
        "ok": True,
        "event_id": event_id,
        "ended_at": row.ended_at.isoformat(),
    }
