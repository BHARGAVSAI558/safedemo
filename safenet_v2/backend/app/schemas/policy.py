from datetime import datetime
from typing import Any, Dict, Literal, Optional

from pydantic import BaseModel, Field


class PolicyCreate(BaseModel):
    product_code: str = Field(default="income_shield_basic", max_length=64)


class PolicyActivateRequest(BaseModel):
    tier: Literal["Basic", "Standard", "Pro"]
    zone_id: Optional[str] = Field(default=None, max_length=64)


class PolicyResponse(BaseModel):
    id: int
    user_id: int
    product_code: str
    status: str
    monthly_premium: float
    weekly_premium: float = 0.0
    created_at: datetime | None
    updated_at: datetime | None = None
    valid_from: datetime | None = None
    valid_until: datetime | None = None

    model_config = {"from_attributes": True}


class PolicyActivatedFullResponse(BaseModel):
    """Returned after POST /policies/activate — full context for the mobile success screen."""

    id: int
    user_id: int
    product_code: str
    status: str
    tier: Literal["Basic", "Standard", "Pro"]
    monthly_premium: float
    weekly_premium: float
    valid_from: str
    valid_until: str
    max_coverage_per_day: float
    risk_score: float
    zone_id: str
    zone_label: str
    zone_risk_level: str
    city: str
    name: str
    trust_level: str = "Newcomer"
    premium_breakdown: Optional[Dict[str, Any]] = None


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
    message: Optional[str] = None
    premium_breakdown: Optional[Dict[str, Any]] = None


class PoolHealthResponse(BaseModel):
    zone_id: str
    zone_label: str = ""
    pool_balance: float = 0.0
    pool_utilization_pct: float = 0.0
    loss_ratio: float = 0.0
    total_premiums_collected: float = 0.0
    total_payouts_disbursed: float = 0.0
