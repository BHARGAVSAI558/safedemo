import re
from typing import Literal

from pydantic import BaseModel, Field, field_validator


class GigProfileUpsert(BaseModel):
    name: str = Field(..., min_length=2, max_length=100)
    platform: str = Field(..., min_length=1, max_length=32)
    city: str = Field(default="Hyderabad", max_length=100)
    zone_id: str = Field(..., min_length=1, max_length=64)
    location_display: str | None = Field(default=None, max_length=255)
    avg_daily_income: float = Field(..., gt=0)
    working_hours_preset: str = Field(..., min_length=1, max_length=64)
    coverage_tier: Literal["Basic", "Standard", "Pro"]

    @field_validator("name", "platform", "city", "zone_id", "working_hours_preset", "location_display")
    @classmethod
    def sanitize(cls, v: str) -> str:
        s = (v or "").strip()
        if re.search(r"<\s*script|<\s*\/", s, flags=re.IGNORECASE):
            raise ValueError("Invalid text value")
        return s


class GigProfileResponse(BaseModel):
    success: bool
    profile_id: int
    risk_score: float
    weekly_premium: int
    coverage_tier: str
    zone_id: str
    zone_risk_level: str
    max_coverage_per_day: float
    platform: str
    working_hours_preset: str
    name: str
    city: str
    location_display: str | None = None


class ProfileBootstrapResponse(BaseModel):
    """GET /api/v1/profile — default row before onboarding completes."""

    id: int
    phone_number: str
    name: str | None = None
    city: str | None = None
    zone_id: str | None = None
    platform: str | None = None
    location_display: str | None = None
    avg_daily_income: float = 650.0
    trust_score: float = 50.0
    is_profile_complete: bool = False
