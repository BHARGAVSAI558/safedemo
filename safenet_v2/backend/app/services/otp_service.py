import random
from datetime import datetime, timedelta
from typing import Any, Optional, Tuple

import anyio
from twilio.rest import Client

from app.core.config import settings
from app.utils.logger import get_logger

log = get_logger(__name__)

OTP_EXPIRY_SECONDS = 300
OTP_KEY_PREFIX = "otp:"


def _twilio_configured() -> bool:
    return bool((settings.TWILIO_ACCOUNT_SID or "").strip())


def _sync_twilio_send(phone: str, otp: str) -> None:
    client = Client(settings.TWILIO_ACCOUNT_SID, settings.TWILIO_AUTH_TOKEN)
    client.messages.create(
        body=f"Your SafeNet OTP is: {otp}. Valid for 5 minutes. Do not share.",
        from_=settings.TWILIO_PHONE,
        to=f"+91{phone}",
    )


class OTPService:
    @staticmethod
    def _generate() -> str:
        return str(random.randint(100000, 999999))

    @staticmethod
    def _memory_store(request: Any) -> dict:
        if not hasattr(request.app.state, "otp_store") or request.app.state.otp_store is None:
            request.app.state.otp_store = {}
        return request.app.state.otp_store

    @staticmethod
    async def _store(phone: str, otp: str, redis_client: Any, request: Any) -> None:
        if redis_client is not None:
            await redis_client.setex(f"{OTP_KEY_PREFIX}{phone}", OTP_EXPIRY_SECONDS, otp)
        else:
            store = OTPService._memory_store(request)
            store[phone] = {"otp": otp, "expires_at": datetime.now() + timedelta(seconds=OTP_EXPIRY_SECONDS)}

    @staticmethod
    async def _get(phone: str, redis_client: Any, request: Any) -> Optional[str]:
        if redis_client is not None:
            val = await redis_client.get(f"{OTP_KEY_PREFIX}{phone}")
            return val.decode() if isinstance(val, (bytes, bytearray)) else (val or None)
        store = OTPService._memory_store(request)
        entry = store.get(phone)
        if entry and datetime.now() < entry["expires_at"]:
            return str(entry["otp"])
        return None

    @staticmethod
    async def _delete(phone: str, redis_client: Any, request: Any) -> None:
        if redis_client is not None:
            await redis_client.delete(f"{OTP_KEY_PREFIX}{phone}")
        else:
            OTPService._memory_store(request).pop(phone, None)

    @staticmethod
    async def send(phone: str, redis_client: Any, request: Any) -> Tuple[bool, str, Optional[str]]:
        otp = OTPService._generate()
        await OTPService._store(phone, otp, redis_client, request)

        # Demo / ops visibility (required for demos without SMS)
        log.info(f"OTP for {phone}: {otp}")

        if _twilio_configured():
            try:
                await anyio.to_thread.run_sync(_sync_twilio_send, phone, otp)
                log.info(
                    "otp_sms_sent",
                    engine_name="otp_service",
                    decision="twilio",
                    reason_code="SMS_OK",
                    phone_suffix=phone[-4:],
                )
                return True, "OTP sent via SMS", None
            except Exception as e:
                log.error(
                    "otp_twilio_failed",
                    engine_name="otp_service",
                    decision="error",
                    reason_code="SMS_ERROR",
                    error=str(e),
                )

        log.warning(
            "otp_demo_mode",
            engine_name="otp_service",
            decision="demo",
            reason_code="OTP_DEMO",
            phone_suffix=phone[-4:],
        )
        return True, "OTP generated (demo mode — check server logs)", otp

    @staticmethod
    async def verify(phone: str, otp: str, redis_client: Any, request: Any) -> Tuple[bool, str]:
        # DEMO MODE: accept any valid 6-digit OTP — no friction for judges
        if settings.DEMO_MODE and len(otp) == 6 and otp.isdigit():
            # Still try to clean up a real stored OTP if one exists
            await OTPService._delete(phone, redis_client, request)
            log.info(
                "otp_demo_bypass",
                engine_name="otp_service",
                decision="ok",
                reason_code="OTP_DEMO_BYPASS",
                phone_suffix=phone[-4:],
            )
            return True, "OTP verified successfully"

        stored = await OTPService._get(phone, redis_client, request)
        if not stored:
            return False, "OTP expired or not found. Please request a new one."
        if stored != otp:
            return False, "Invalid OTP. Please try again."
        await OTPService._delete(phone, redis_client, request)
        log.info(
            "otp_verified",
            engine_name="otp_service",
            decision="ok",
            reason_code="OTP_OK",
            phone_suffix=phone[-4:],
        )
        return True, "OTP verified successfully"
