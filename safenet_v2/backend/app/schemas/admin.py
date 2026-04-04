from datetime import datetime
from typing import Optional

from pydantic import BaseModel

from app.schemas.worker import ProfileResponse


class UserAdminResponse(BaseModel):
    id: int
    phone: str
    is_active: bool
    is_admin: bool
    created_at: Optional[datetime]
    profile: Optional[ProfileResponse] = None

    model_config = {"from_attributes": True}


class AnalyticsResponse(BaseModel):
    total_users: int
    total_simulations: int
    total_payouts: float
    fraud_cases: int
    approved_cases: int
    rejected_cases: int
    disruption_rate: float


class ZoneAlertItem(BaseModel):
    type: str
    severity: str = "YELLOW"
    description: str = ""


class ZoneAlertsInjectBody(BaseModel):
    alerts: list[ZoneAlertItem]
    replace: bool = True
