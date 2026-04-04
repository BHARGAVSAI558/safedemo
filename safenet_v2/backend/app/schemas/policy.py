from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field


class PolicyCreate(BaseModel):
    product_code: str = Field(default="income_shield_basic", max_length=64)


class PolicyActivateRequest(BaseModel):
    tier: Literal["Basic", "Standard", "Pro"]


class PolicyResponse(BaseModel):
    id: int
    user_id: int
    product_code: str
    status: str
    monthly_premium: float
    weekly_premium: float = 0.0
    created_at: datetime | None
    updated_at: datetime | None = None

    model_config = {"from_attributes": True}


class PolicyCurrentResponse(BaseModel):
    status: Literal["active", "inactive", "expiring"]
    tier: Optional[Literal["Basic", "Standard", "Pro"]] = None
    weekly_premium: float = 0.0
    valid_until: Optional[str] = None
    days_remaining: int = 0
    max_coverage_per_day: float = 0.0
    risk_score: float = 0.0
    zone: str = ""
    pool_balance: float = 0.0
    pool_utilization_pct: float = 0.0
    policy_id: Optional[int] = None


class PoolHealthResponse(BaseModel):
    zone_id: str
    zone_label: str = ""
    pool_balance: float = 0.0
    pool_utilization_pct: float = 0.0
