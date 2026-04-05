from datetime import datetime
from enum import Enum

import re
from typing import Any

from pydantic import BaseModel, Field, field_validator


class OccupationType(str, Enum):
    delivery = "delivery"
    driver = "driver"
    freelancer = "freelancer"
    other = "other"


class RiskProfile(str, Enum):
    low = "low"
    medium = "medium"
    high = "high"


class ProfileCreate(BaseModel):
    name: str = Field(..., min_length=2, max_length=100)
    city: str = Field(default="Hyderabad")
    occupation: OccupationType = OccupationType.delivery
    avg_daily_income: float = Field(default=1000.0, gt=0)
    risk_profile: RiskProfile = RiskProfile.medium

    @field_validator("name", "city")
    @classmethod
    def sanitize_text(cls, v: str) -> str:
        s = (v or "").strip()
        if re.search(r"<\s*script|<\s*\/", s, flags=re.IGNORECASE):
            raise ValueError("Invalid text value")
        return s


class ProfileUpdate(BaseModel):
    name: str | None = None
    city: str | None = None
    occupation: OccupationType | None = None
    avg_daily_income: float | None = None
    risk_profile: RiskProfile | None = None

    @field_validator("name", "city")
    @classmethod
    def sanitize_text_optional(cls, v: str | None) -> str | None:
        if v is None:
            return v
        s = v.strip()
        if re.search(r"<\s*script|<\s*\/", s, flags=re.IGNORECASE):
            raise ValueError("Invalid text value")
        return s


class ProfileResponse(BaseModel):
    id: int
    user_id: int
    name: str
    city: str
    occupation: str
    avg_daily_income: float
    risk_profile: str
    trust_score: float
    total_claims: int
    total_payouts: float
    platform: str | None = None
    zone_id: str | None = None
    working_hours_preset: str | None = None
    coverage_tier: str | None = None
    risk_score: float | None = None
    weekly_premium: float | None = None
    created_at: datetime | None

    model_config = {"from_attributes": True}

    @field_validator("trust_score", mode="before")
    @classmethod
    def trust_score_none(cls, v: Any) -> float:
        return 1.0 if v is None else float(v)

    @field_validator("avg_daily_income", mode="before")
    @classmethod
    def income_none_safe(cls, v: Any) -> float:
        if v is None:
            return 1000.0
        return float(v)

    @field_validator("total_payouts", mode="before")
    @classmethod
    def payouts_none_safe(cls, v: Any) -> float:
        return 0.0 if v is None else float(v)

    @field_validator("total_claims", mode="before")
    @classmethod
    def claims_none_safe(cls, v: Any) -> int:
        return 0 if v is None else int(v)

    @field_validator("risk_score", mode="before")
    @classmethod
    def risk_score_none(cls, v: Any) -> float | None:
        if v is None:
            return None
        return float(v)

    @field_validator("weekly_premium", mode="before")
    @classmethod
    def weekly_premium_profile_none(cls, v: Any) -> float | None:
        if v is None:
            return None
        return float(v)


class PolicyWeekHistoryItem(BaseModel):
    started_at: str | None = None
    plan: str
    status: str
    weekly_premium: float


class WorkerProfileOut(ProfileResponse):
    zone_id: str
    earnings_protected_this_week: float
    max_weekly_coverage: float
    policy_history: list[PolicyWeekHistoryItem] = Field(default_factory=list)
    is_profile_complete: bool = True
    phone_number: str | None = Field(default=None, description="Masked phone for onboarding state")
