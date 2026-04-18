from app.models.worker import Profile
from app.utils.logger import get_logger

log = get_logger(__name__)


class TrustEngine:
    @staticmethod
    def penalize_fraud(profile: Profile, fraud_score: float, threshold: float) -> None:
        if fraud_score >= threshold:
            before = profile.trust_score
            profile.trust_score = max(0.1, float(profile.trust_score) - 0.1)
            log.info(
                "trust_penalized",
                engine_name="trust_engine",
                decision=f"{before}->{profile.trust_score}",
                reason_code="TRUST_FRAUD_PENALTY",
                worker_id=profile.user_id,
            )

    @staticmethod
    def reward_clean_claim(profile: Profile, fraud_score: float) -> None:
        """
        Reward an approved claim with low fraud score.
        +0.06 for very clean (fraud_score < 0.1), +0.03 for medium-clean (< 0.3).
        Capped at 1.0.
        """
        if fraud_score < 0.1:
            delta = 0.06
        elif fraud_score < 0.3:
            delta = 0.03
        else:
            return
        before = float(profile.trust_score or 0.5)
        profile.trust_score = round(min(1.0, before + delta), 4)
        log.info(
            "trust_rewarded",
            engine_name="trust_engine",
            decision=f"{before}->{profile.trust_score}",
            reason_code="TRUST_CLEAN_CLAIM",
            worker_id=profile.user_id,
            fraud_score=fraud_score,
        )

    @staticmethod
    def penalize_review(profile: Profile) -> None:
        """
        Small penalty for claims held for manual review (+0.02 trust, not a penalty).
        Reflects that the worker is still operating but under scrutiny.
        """
        before = float(profile.trust_score or 0.5)
        profile.trust_score = round(min(1.0, before + 0.02), 4)
        log.info(
            "trust_review_nudge",
            engine_name="trust_engine",
            decision=f"{before}->{profile.trust_score}",
            reason_code="TRUST_REVIEW_NUDGE",
            worker_id=profile.user_id,
        )

    @staticmethod
    def penalize_rejected(profile: Profile) -> None:
        """
        Significant penalty for a rejected (fraud-flagged) claim.
        -0.18 trust, floored at 0.0.
        """
        before = float(profile.trust_score or 0.5)
        profile.trust_score = round(max(0.0, before - 0.18), 4)
        log.info(
            "trust_rejected",
            engine_name="trust_engine",
            decision=f"{before}->{profile.trust_score}",
            reason_code="TRUST_REJECTED_CLAIM",
            worker_id=profile.user_id,
        )
