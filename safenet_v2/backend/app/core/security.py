from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional
from uuid import uuid4

from fastapi import HTTPException, status
from jose import JWTError, jwt
from passlib.context import CryptContext
import redis as redis_sync

from app.core.config import settings

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def _has_pem(value: str) -> bool:
    s = (value or "").strip()
    return "BEGIN" in s and "KEY" in s and "END" in s


def _admin_signing_material() -> tuple[str, str]:
    private_key = (settings.ADMIN_JWT_PRIVATE_KEY or "").strip()
    if settings.ADMIN_JWT_ALGORITHM.upper() == "RS256" and _has_pem(private_key):
        return "RS256", private_key
    return "HS256", settings.admin_jwt_signing_secret


def _admin_verify_material() -> tuple[str, str]:
    public_key = (settings.ADMIN_JWT_PUBLIC_KEY or "").strip()
    if settings.ADMIN_JWT_ALGORITHM.upper() == "RS256" and _has_pem(public_key):
        return "RS256", public_key
    return "HS256", settings.admin_jwt_signing_secret


def _redis_client():
    try:
        return redis_sync.Redis.from_url(settings.REDIS_URL, decode_responses=True, socket_timeout=1)
    except Exception:
        return None


def _store_jti(token_id: str, expires_at: datetime) -> None:
    rc = _redis_client()
    if rc is None:
        return
    ttl = max(1, int((expires_at - datetime.now(timezone.utc)).total_seconds()))
    try:
        rc.setex(f"jwt:jti:{token_id}", ttl, "1")
    except Exception:
        pass


def _is_jti_active(token_id: str) -> bool:
    rc = _redis_client()
    if rc is None:
        return True
    try:
        return rc.get(f"jwt:jti:{token_id}") is not None
    except Exception:
        return True


def create_access_token(data: Dict[str, Any], expires_delta: Optional[timedelta] = None) -> str:
    to_encode = dict(data)
    expire = datetime.now(timezone.utc) + (
        expires_delta or timedelta(hours=settings.ACCESS_TOKEN_EXPIRE_HOURS)
    )
    jti = str(uuid4())
    to_encode.update({"exp": expire, "type": "access", "jti": jti})
    token = jwt.encode(to_encode, settings.JWT_SECRET, algorithm="HS256")
    _store_jti(jti, expire)
    return token


def create_refresh_token(data: Dict[str, Any]) -> str:
    to_encode = dict(data)
    expire = datetime.now(timezone.utc) + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)
    jti = str(uuid4())
    to_encode.update({"exp": expire, "type": "refresh", "jti": jti})
    token = jwt.encode(to_encode, settings.JWT_SECRET, algorithm="HS256")
    _store_jti(jti, expire)
    return token


def create_admin_token(data: Dict[str, Any], expires_delta: Optional[timedelta] = None) -> str:
    to_encode = dict(data)
    expire = datetime.now(timezone.utc) + (
        expires_delta or timedelta(hours=settings.ADMIN_ACCESS_TOKEN_EXPIRE_HOURS)
    )
    jti = str(uuid4())
    to_encode.update({"exp": expire, "type": "admin", "jti": jti})
    alg, key = _admin_signing_material()
    token = jwt.encode(to_encode, key, algorithm=alg)
    _store_jti(jti, expire)
    return token


def verify_token(token: str, token_type: str = "access") -> Dict[str, Any]:
    try:
        payload = jwt.decode(token, settings.JWT_SECRET, algorithms=["HS256"])
        if payload.get("type") != token_type:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token type")
        jti = payload.get("jti")
        if not jti or not _is_jti_active(str(jti)):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token revoked")
        return payload
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")


def verify_admin_token(token: str) -> Dict[str, Any]:
    try:
        alg, key = _admin_verify_material()
        payload = jwt.decode(
            token,
            key,
            algorithms=[alg],
        )
        if payload.get("type") != "admin":
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token type")
        jti = payload.get("jti")
        if not jti or not _is_jti_active(str(jti)):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token revoked")
        return payload
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")


def get_user_id_from_token(token: str) -> int:
    payload = verify_token(token)
    user_id = payload.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token missing user_id")
    return int(user_id)
