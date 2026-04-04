from __future__ import annotations

from typing import Any, Dict, Optional


class SafeNetBaseException(Exception):
    def __init__(
        self,
        message: str,
        *,
        error_code: str = "SAFENET_ERROR",
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        self.message = message
        self.error_code = error_code
        self.details = details or {}
        super().__init__(message)


class ClaimProcessingException(SafeNetBaseException):
    def __init__(self, claim_id: str, stage: str, reason: str) -> None:
        super().__init__(
            reason,
            error_code="CLAIM_PROCESSING_ERROR",
            details={"claim_id": claim_id, "stage": stage},
        )


class FraudEngineException(SafeNetBaseException):
    def __init__(self, layer: str, worker_id: int, details: Optional[Dict[str, Any]] = None) -> None:
        super().__init__(
            "Fraud checks failed",
            error_code="FRAUD_ENGINE_ERROR",
            details={"layer": layer, "worker_id": worker_id, **(details or {})},
        )


class PayoutFailedException(SafeNetBaseException):
    def __init__(self, claim_id: str, razorpay_error: str, worker_id: int) -> None:
        super().__init__(
            "Payout could not be completed right now",
            error_code="PAYOUT_FAILED",
            details={"claim_id": claim_id, "worker_id": worker_id, "razorpay_error": razorpay_error},
        )


class ExternalAPIException(SafeNetBaseException):
    def __init__(self, service_name: str, status_code: int, url: str) -> None:
        super().__init__(
            f"{service_name} is unavailable",
            error_code="EXTERNAL_API_ERROR",
            details={"service_name": service_name, "status_code": status_code, "url": url},
        )


class InsufficientPoolBalanceException(SafeNetBaseException):
    def __init__(self, zone_id: str, required: float, available: float) -> None:
        super().__init__(
            "Pool balance is not enough",
            error_code="INSUFFICIENT_POOL_BALANCE",
            details={"zone_id": zone_id, "required": required, "available": available},
        )


class DuplicateClaimException(SafeNetBaseException):
    def __init__(self, worker_id: int, event_id: str, existing_claim_id: str) -> None:
        super().__init__(
            "A claim for this event already exists",
            error_code="DUPLICATE_CLAIM",
            details={"worker_id": worker_id, "event_id": event_id, "existing_claim_id": existing_claim_id},
        )
