"""Push token + in-app notification APIs."""

from typing import Optional, Any

from fastapi import APIRouter, Depends, Header, Request
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.routes.workers import get_current_user
from app.core.security import get_user_id_from_token
from app.db.session import get_db
from app.models.notification import Notification
from app.models.worker import User
from app.services.notification_service import create_notification
from app.utils.logger import get_logger

log = get_logger(__name__)
router = APIRouter()


class PushRegisterBody(BaseModel):
    expo_push_token: str = Field(..., min_length=8, max_length=512)


class NotificationCreateBody(BaseModel):
    user_id: str
    type: str = Field(default="system")
    title: str = Field(..., min_length=1, max_length=160)
    message: str = Field(..., min_length=1, max_length=2000)


def _optional_user_id(authorization: Optional[str] = Header(None)) -> Optional[int]:
    if not authorization or not authorization.startswith("Bearer "):
        return None
    token = authorization.split(" ", 1)[1]
    try:
        return int(get_user_id_from_token(token))
    except Exception:
        return None


@router.post("/register")
async def register_expo_push(
    request: Request,
    body: PushRegisterBody,
    authorization: Optional[str] = Header(None),
):
    """
    Acknowledge Expo push token. No auth required; if Bearer JWT is valid, token is keyed in Redis.
    """
    uid = _optional_user_id(authorization)
    tok = body.expo_push_token
    preview = (tok[:24] + "…") if len(tok) > 24 else tok
    log.info(
        "expo_push_registered",
        engine_name="notifications_route",
        worker_id=uid,
        token_preview=preview,
    )
    redis = getattr(request.app.state, "redis", None)
    if redis is not None and uid is not None:
        try:
            await redis.setex(f"expo_push:{uid}", 86400 * 90, tok)
        except Exception as exc:
            log.warning("expo_push_redis_skip", error=str(exc))
    return {"ok": True, "registered": True}


def _as_utc_iso(dt: Any) -> str:
    if dt is None:
        return ""
    if getattr(dt, "tzinfo", None) is None:
        from datetime import timezone
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        from datetime import timezone
        dt = dt.astimezone(timezone.utc)
    return dt.isoformat().replace("+00:00", "Z")


@router.get("")
async def list_notifications(
    user_id: str | None = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    uid = current_user.id
    if user_id and str(user_id).isdigit() and int(str(user_id)) == current_user.id:
        uid = int(str(user_id))
    rows = (
        await db.execute(
            select(Notification)
            .where(Notification.user_id == uid)
            .order_by(Notification.created_at.desc(), Notification.id.desc())
            .limit(200)
        )
    ).scalars().all()
    unread = sum(1 for r in rows if not bool(r.is_read))
    return {
        "unread_count": unread,
        "data": [
            {
                "id": r.id,
                "user_id": r.user_id,
                "type": r.type,
                "title": r.title,
                "message": r.message,
                "is_read": bool(r.is_read),
                "created_at": _as_utc_iso(r.created_at),
            }
            for r in rows
        ],
    }


@router.post("/create")
async def create_notification_route(
    body: NotificationCreateBody,
    _current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not str(body.user_id).isdigit():
        return {"ok": False, "detail": "user_id must be numeric"}
    row = await create_notification(
        db,
        user_id=int(str(body.user_id)),
        ntype=body.type,
        title=body.title,
        message=body.message,
    )
    await db.commit()
    return {"ok": True, "id": row.id}


@router.post("/mark-read/{notification_id}")
async def mark_read(
    notification_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await db.execute(
        update(Notification)
        .where(Notification.id == int(notification_id), Notification.user_id == current_user.id)
        .values(is_read=True)
    )
    await db.commit()
    return {"ok": True}


@router.post("/mark-all-read")
async def mark_all_read(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await db.execute(update(Notification).where(Notification.user_id == current_user.id).values(is_read=True))
    await db.commit()
    return {"ok": True}
