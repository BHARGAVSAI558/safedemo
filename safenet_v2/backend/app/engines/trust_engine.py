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
