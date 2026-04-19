import hmac
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.security import create_admin_token, create_access_token, create_refresh_token, verify_token
from app.db.session import get_db
from app.models.claim import Log
from app.models.auth_token import RefreshToken
from app.models.worker import User
from app.schemas.auth import AdminLoginRequest, RefreshRequest, SendOTPRequest, TokenResponse, VerifyOTPRequest
from app.services.otp_service import OTPService
from app.utils.canonical_id import generate_canonical_hash
from app.utils.logger import get_logger
from structlog.contextvars import bind_contextvars

log = get_logger(__name__)
router = APIRouter()


def _const_time_eq(expected: str, provided: str) -> bool:
    e = (expected or "").encode("utf-8")
    p = (provided or "").encode("utf-8")
    if len(e) != len(p):
        return False
    return hmac.compare_digest(e, p)


def get_redis(request: Request):
    return getattr(request.app.state, "redis", None)


@router.post("/send-otp")
async def send_otp(
    request: Request,
    body: SendOTPRequest,
    db: AsyncSession = Depends(get_db),
):
    redis = get_redis(request)
    phone = body.phone_number
    success, message = await OTPService.send(phone, redis, request)

    db.add(
        Log(
            event_type="otp_sent",
            detail=f"phone={phone}",
            ip_address=request.client.host if request.client else None,
        )
    )
    await db.commit()

    log.info(
        "send_otp_complete",
        engine_name="auth_route",
        decision=str(success),
        reason_code="OTP_FLOW",
    )
    return {"success": bool(success)}


@router.post("/admin-login", response_model=TokenResponse)
async def admin_login(
    request: Request,
    body: AdminLoginRequest,
    db: AsyncSession = Depends(get_db),
):
    """Username/password for the web admin only (no OTP). Creates a synthetic admin user row if needed."""
    u = body.username.strip()
    p = (body.password or "").strip()
    if not _const_time_eq(settings.ADMIN_DASHBOARD_USERNAME, u):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid username or password")
    if not _const_time_eq(settings.ADMIN_DASHBOARD_PASSWORD, p):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid username or password")

    phone = (settings.ADMIN_CONSOLE_PHONE or "9000000001").strip()
    result = await db.execute(select(User).where(User.phone == phone))
    user = result.scalar_one_or_none()
    if not user:
        user = User(
            phone=phone,
            is_active=True,
            is_admin=True,
            canonical_hash=generate_canonical_hash(phone),
        )
        db.add(user)
        await db.flush()
        await db.refresh(user)
        log.info(
            "admin_console_user_created",
            engine_name="auth_route",
            worker_id=user.id,
        )
    else:
        if not user.is_admin:
            user.is_admin = True
        if not user.canonical_hash:
            user.canonical_hash = generate_canonical_hash(phone)
        log.info(
            "admin_password_login",
            engine_name="auth_route",
            worker_id=user.id,
        )

    bind_contextvars(worker_id=user.id)
    token_data = {"user_id": user.id, "phone": user.phone}
    access_token = create_admin_token(token_data)
    refresh_token = create_refresh_token(token_data)
    refresh_payload = verify_token(refresh_token, token_type="refresh")
    db.add(
        Log(
            user_id=user.id,
            event_type="admin_login",
            detail="password",
            ip_address=request.client.host if request.client else None,
        )
    )
    db.add(
        RefreshToken(
            user_id=user.id,
            token_jti=str(refresh_payload.get("jti")),
            token_value=refresh_token,
            used=False,
            expires_at=datetime.now(timezone.utc) + timedelta(days=7),
        )
    )
    await db.commit()

    return TokenResponse(
        access_token=access_token,
        refresh_token=refresh_token,
        user_id=user.id,
        is_new_user=False,
    )


@router.post("/verify-otp", response_model=TokenResponse)
async def verify_otp(
    request: Request,
    body: VerifyOTPRequest,
    db: AsyncSession = Depends(get_db),
):
    redis = get_redis(request)
    phone = body.phone_number
    success, message = await OTPService.verify(phone, body.otp, redis, request)

    if not success:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=message)

    result = await db.execute(select(User).where(User.phone == phone))
    user = result.scalar_one_or_none()
    is_new_user = False
    if not user:
        is_new_user = True
        user = User(phone=phone, canonical_hash=generate_canonical_hash(phone))
        db.add(user)
        await db.flush()
        await db.refresh(user)
        log.info(
            "user_created",
            engine_name="auth_route",
            decision="created",
            reason_code="AUTH_NEW_USER",
            worker_id=user.id,
        )
    else:
        if not user.canonical_hash:
            user.canonical_hash = generate_canonical_hash(phone)
        log.info(
            "user_login",
            engine_name="auth_route",
            decision="login",
            reason_code="AUTH_RETURNING",
            worker_id=user.id,
        )

    bind_contextvars(worker_id=user.id)

    db.add(
        Log(
            user_id=user.id,
            event_type="otp_verified",
            detail=f"phone={phone}",
            ip_address=request.client.host if request.client else None,
        )
    )
    await db.commit()

    token_data = {"user_id": user.id, "phone": user.phone}
    if body.admin:
        if not user.is_admin:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
        access_token = create_admin_token(token_data)
    else:
        access_token = create_access_token(token_data)

    refresh_token = create_refresh_token(token_data)
    refresh_payload = verify_token(refresh_token, token_type="refresh")
    db.add(
        RefreshToken(
            user_id=user.id,
            token_jti=str(refresh_payload.get("jti")),
            token_value=refresh_token,
            used=False,
            expires_at=datetime.now(timezone.utc) + timedelta(days=7),
        )
    )
    await db.commit()

    return TokenResponse(
        access_token=access_token,
        refresh_token=refresh_token,
        user_id=user.id,
        is_new_user=is_new_user,
    )


@router.post("/refresh", response_model=TokenResponse)
async def refresh_token(body: RefreshRequest, db: AsyncSession = Depends(get_db)):
    payload = verify_token(body.refresh_token, token_type="refresh")
    jti = str(payload.get("jti") or "")
    token_row = (
        await db.execute(select(RefreshToken).where(RefreshToken.token_jti == jti, RefreshToken.used.is_(False)))
    ).scalar_one_or_none()
    if token_row is None or token_row.token_value != body.refresh_token:
        raise HTTPException(status_code=401, detail="Refresh token is invalid or already used")

    user_id = payload.get("user_id")
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    token_data = {"user_id": user.id, "phone": user.phone}
    if body.admin:
        if not user.is_admin:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
        access_token = create_admin_token(token_data)
    else:
        access_token = create_access_token(token_data)

    token_row.used = True
    new_refresh = create_refresh_token(token_data)
    new_payload = verify_token(new_refresh, token_type="refresh")
    db.add(
        RefreshToken(
            user_id=user.id,
            token_jti=str(new_payload.get("jti")),
            token_value=new_refresh,
            used=False,
            expires_at=datetime.now(timezone.utc) + timedelta(days=7),
        )
    )
    await db.commit()

    return TokenResponse(
        access_token=access_token,
        refresh_token=new_refresh,
        user_id=user.id,
        is_new_user=False,
    )
