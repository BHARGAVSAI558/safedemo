from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.routes.admin import get_admin_user
from app.api.v1.routes.workers import get_current_user
from app.db.session import get_db
from app.models.support import SupportQuery
from app.models.worker import User
from app.services.notification_service import create_notification

router = APIRouter()


class SupportQueryBody(BaseModel):
    user_id: str | None = None
    message: str = Field(..., min_length=2, max_length=2000)
    type: str = Field(default="custom")


class SupportReplyBody(BaseModel):
    query_id: int
    admin_reply: str = Field(..., min_length=2, max_length=2000)


def _auto_system_reply(msg: str) -> str:
    t = msg.lower()
    if "payout" in t:
        return "Payout is calculated from disruption verification, fraud checks, and your earning fingerprint for that slot."
    if "claim" in t:
        return "Claims move through verification → fraud check → decision. You can track every step in Claims."
    if "weather" in t or "rain" in t:
        return "Weather alerts are monitored continuously for your zone. If risk is verified, SafeNet evaluates payout eligibility automatically."
    return "Thanks for reaching out. We logged your query and our team can reply here shortly."


def _as_utc_iso(dt: Any) -> str:
    if dt is None:
        return ""
    if getattr(dt, "tzinfo", None) is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    return dt.isoformat().replace("+00:00", "Z")


@router.post("/query")
async def create_support_query(
    body: SupportQueryBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    uid = current_user.id
    if body.user_id is not None and str(body.user_id).strip().isdigit():
        asked = int(str(body.user_id).strip())
        if asked == current_user.id:
            uid = asked
    sys_reply = _auto_system_reply(body.message)
    row = SupportQuery(
        user_id=uid,
        message=body.message.strip(),
        query_type="predefined" if str(body.type).lower() == "predefined" else "custom",
        system_response=sys_reply,
        admin_reply=None,
        status="open",
    )
    db.add(row)
    await db.flush()
    await create_notification(
        db,
        user_id=uid,
        ntype="system",
        title="Support query received",
        message="We got your message. You’ll see an admin reply here when available.",
    )
    await db.commit()
    return {"ok": True, "id": row.id}


@router.get("/history")
async def support_history(
    user_id: str | None = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    uid = current_user.id
    if user_id and str(user_id).strip().isdigit() and int(str(user_id).strip()) == current_user.id:
        uid = int(str(user_id).strip())
    rows = (
        await db.execute(
            select(SupportQuery)
            .where(SupportQuery.user_id == uid)
            .order_by(SupportQuery.created_at.asc(), SupportQuery.id.asc())
        )
    ).scalars().all()
    return [
        {
            "id": r.id,
            "message": r.message,
            "reply": r.system_response,
            "admin_reply": r.admin_reply,
            "status": r.status,
            "created_at": _as_utc_iso(r.created_at),
        }
        for r in rows
    ]


@router.post("/reply")
async def support_reply(
    body: SupportReplyBody,
    _admin: User = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    row = (await db.execute(select(SupportQuery).where(SupportQuery.id == int(body.query_id)))).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Support query not found")
    row.admin_reply = body.admin_reply.strip()
    row.status = "resolved"
    await create_notification(
        db,
        user_id=row.user_id,
        ntype="admin_reply",
        title="Admin replied",
        message=row.admin_reply,
    )
    await db.commit()
    return {"ok": True, "query_id": row.id, "status": row.status, "replied_at": datetime.now(timezone.utc).isoformat()}

