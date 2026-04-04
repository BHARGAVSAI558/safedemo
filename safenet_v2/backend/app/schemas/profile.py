import re
from typing import Literal

from pydantic import BaseModel, Field, field_validator


class GigProfileUpsert(BaseModel):
    name: str = Field(..., min_length=2, max_length=100)
    platform: str = Field(..., min_length=1, max_length=32)
    city: str = Field(default="Hyderabad", max_length=100)
    zone_id: str = Field(..., min_length=1, max_length=64)
    avg_daily_income: float = Field(..., gt=0)
    working_hours_preset: str = Field(..., min_length=1, max_length=64)
    coverage_tier: Literal["Basic", "Standard", "Pro"]

    @field_validator("name", "platform", "city", "zone_id", "working_hours_preset")
    @classmethod
    def sanitize(cls, v: str) -> str:
        s = (v or "").strip()
        if re.search(r"<\s*script|<\s*\/", s, flags=re.IGNORECASE):
            raise ValueError("Invalid text value")
        return s
