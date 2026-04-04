from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict
import asyncio

import joblib
from sqlalchemy import func, select

from app.db.session import AsyncSessionLocal
from app.models.claim import Simulation
from app.models.worker import Profile, RiskProfile, User
from app.services.zone_resolver import resolve_city_to_zone
from app.utils.logger import get_logger

log = get_logger(__name__)


def _season_from_date(now: datetime) -> int:
    m = int(now.month)
    if m in (12, 1, 2):
        return 0
    if m in (3, 4, 5):
        return 1
    if m in (6, 7, 8, 9):
        return 2
    return 3


def _zone_risk_seeded(zone_id: str) -> float:
    seeded = sum(ord(c) for c in str(zone_id)) % 100
    return max(0.0, min(1.0, seeded / 100.0))


@dataclass(frozen=True)
class PremiumFeatures:
    zone_risk_score: float
    active_hours_per_day: float
    worker_tenure_weeks: int
    season: int
    claim_count_last_30_days: int
    trust_score: float
    historical_disruption_days_per_month: float

    def to_vector(self) -> list[float]:
        return [
            self.zone_risk_score,
            self.active_hours_per_day,
            float(self.worker_tenure_weeks),
            float(self.season),
            float(self.claim_count_last_30_days),
            self.trust_score,
            self.historical_disruption_days_per_month,
        ]

    def as_dict(self) -> Dict[str, float]:
        return {
            "zone_risk_score": self.zone_risk_score,
            "active_hours_per_day": self.active_hours_per_day,
            "worker_tenure_weeks": float(self.worker_tenure_weeks),
            "season": float(self.season),
            "claim_count_last_30_days": float(self.claim_count_last_30_days),
            "trust_score": self.trust_score,
            "historical_disruption_days_per_month": self.historical_disruption_days_per_month,
        }


class PremiumEngine:
    _model: Any = None
    _loaded: bool = False

    @classmethod
    def _load_model_once(cls) -> Any:
        if cls._loaded:
            return cls._model
        cls._loaded = True
        model_path = Path(__file__).resolve().parents[1] / "ml_models" / "premium_model.pkl"
        try:
            if model_path.exists():
                cls._model = joblib.load(model_path)
                log.info(
                    "premium_model_loaded",
                    engine_name="premium_engine",
                    decision="loaded",
                    reason_code="MODEL_OK",
                    model_path=str(model_path),
                )
            else:
                cls._model = None
                log.warning(
                    "premium_model_missing",
                    engine_name="premium_engine",
                    decision="fallback",
                    reason_code="MODEL_MISSING",
                    model_path=str(model_path),
                )
        except Exception as exc:
            cls._model = None
            log.warning(
                "premium_model_load_failed",
                engine_name="premium_engine",
                decision="fallback",
                reason_code="MODEL_LOAD_FAIL",
                error=str(exc),
            )
        return cls._model

    @staticmethod
    def monthly_premium(profile: Profile) -> tuple[float, str]:
        base = max(50.0, float(profile.avg_daily_income) * 0.02)
        mult = 1.0
        if profile.risk_profile == RiskProfile.high:
            mult = 1.25
        elif profile.risk_profile == RiskProfile.low:
            mult = 0.9
        premium = round(base * mult, 2)
        reason_code = "PREMIUM_FROM_INCOME_RISK"
        return premium, reason_code

    @staticmethod
    async def _feature_vector(
        worker_id: int,
        db: "AsyncSession | None" = None,
        profile: "Profile | None" = None,
        user: "User | None" = None,
    ) -> PremiumFeatures:
        """Build feature vector. Accepts an existing session+ORM objects to avoid
        opening a nested session (which deadlocks when the caller already holds a
        connection from the same pool)."""
        now = datetime.now(timezone.utc)
        month_window = now - timedelta(days=30)

        # Only open a new session when no caller-supplied session is available.
        _own_session = False
        if db is None:
            db = AsyncSessionLocal()
            _own_session = True

        try:
            if user is None:
                user = (await db.execute(select(User).where(User.id == worker_id))).scalar_one_or_none()
            if profile is None:
                profile = (await db.execute(select(Profile).where(Profile.user_id == worker_id))).scalar_one_or_none()
            if user is None or profile is None:
                raise ValueError("Worker or profile missing")

            zone_id, _, _ = resolve_city_to_zone(profile.city)
            zone_risk_score = _zone_risk_seeded(zone_id)
            claim_count = (
                await db.execute(
                    select(func.count(Simulation.id)).where(
                        Simulation.user_id == worker_id,
                        Simulation.created_at >= month_window,
                    )
                )
            ).scalar_one() or 0

            active_hours = max(4.0, min(13.0, 4.0 + float(claim_count) * 0.8))
            created = user.created_at or now
            if created.tzinfo is None:
                created = created.replace(tzinfo=timezone.utc)
            tenure_weeks = int(max(1, min(104, (now - created).days // 7)))

            trust = float(profile.trust_score or 1.0)
            if trust <= 1.0:
                trust *= 100.0
            trust = max(0.0, min(100.0, trust))

            season = _season_from_date(now)
            disruption_days = 6.0 * zone_risk_score + (2.5 if season == 2 else 1.0)

            # Use the already-connected mongo client from app state; never re-ping here.
            from app.db.mongo import get_mongo_client
            from app.core.config import settings as _settings
            mongo_client = get_mongo_client()
            if mongo_client is not None:
                try:
                    _mongo_db = mongo_client[_settings.MONGODB_DB_NAME]
                    high_days = await _mongo_db["confidence_scores"].count_documents(
                        {
                            "zone_id": zone_id,
                            "level": "HIGH",
                            "computed_at": {"$gte": month_window},
                        }
                    )
                    disruption_days = max(disruption_days, float(high_days))
                except Exception:
                    pass
        finally:
            if _own_session:
                await db.close()

        return PremiumFeatures(
            zone_risk_score=float(zone_risk_score),
            active_hours_per_day=float(active_hours),
            worker_tenure_weeks=int(tenure_weeks),
            season=int(season),
            claim_count_last_30_days=int(claim_count),
            trust_score=float(trust),
            historical_disruption_days_per_month=float(max(0.0, disruption_days)),
        )

    @classmethod
    async def calculate(
        cls,
        worker_id: int,
        db: "AsyncSession | None" = None,
        profile: "Profile | None" = None,
        user: "User | None" = None,
    ) -> Dict[str, Any]:
        model = cls._load_model_once()
        features = await cls._feature_vector(worker_id, db=db, profile=profile, user=user)
        fallback_used = False

        premium_raw = 0.0
        if model is not None:
            try:
                loop = asyncio.get_running_loop()
                premium_raw = float(
                    await loop.run_in_executor(None, lambda: model.predict([features.to_vector()])[0])
                )
            except Exception:
                fallback_used = True
        else:
            fallback_used = True

        if fallback_used:
            premium_raw = 35.0 + (features.zone_risk_score * 25.0) + (features.active_hours_per_day / 13.0 * 10.0)

        if premium_raw < 35.0 or premium_raw > 70.0:
            log.warning(
                "premium_clamped",
                engine_name="premium_engine",
                reason_code="PREMIUM_CLAMPED",
                worker_id=worker_id,
                raw_premium=float(premium_raw),
            )
        premium = max(35.0, min(70.0, premium_raw))
        loyalty_discount = bool(features.trust_score >= 70.0)
        if loyalty_discount:
            premium *= 0.95
        weekly_premium = int(max(35, min(70, round(premium))))

        return {
            "weekly_premium": weekly_premium,
            "risk_multiplier": round(1.0 + features.zone_risk_score * 0.25, 3),
            "loyalty_discount_applied": loyalty_discount,
            "features_used": features.as_dict(),
            "fallback_used": fallback_used,
        }
