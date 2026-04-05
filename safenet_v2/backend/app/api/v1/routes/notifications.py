"""Expo push token registration — fast 200 so the app never hangs on a missing route."""

from typing import Optional

from fastapi import APIRouter, Header, Request
from pydantic import BaseModel, Field

from app.core.security import get_user_id_from_token
from app.utils.logger import get_logger

log = get_logger(__name__)
router = APIRouter()


class PushRegisterBody(BaseModel):
    expo_push_token: str = Field(..., min_length=8, max_length=512)


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
