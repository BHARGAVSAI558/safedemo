from datetime import datetime
from typing import Any, Dict, List, Optional

import re
from pydantic import BaseModel, Field, field_validator


class GPSPointIn(BaseModel):
    lat: float
    lon: float
    timestamp: datetime
    cell_tower_id: str = ""
    accelerometer_magnitude: float = 1.0

    @field_validator("lat")
    @classmethod
    def validate_lat(cls, v: float) -> float:
        if not (6.5 <= float(v) <= 37.5):
            raise ValueError("Location is outside supported region")
        return float(v)

    @field_validator("lon")
    @classmethod
    def validate_lon(cls, v: float) -> float:
        if not (68.0 <= float(v) <= 97.5):
            raise ValueError("Location is outside supported region")
        return float(v)


class AppActivityEventIn(BaseModel):
    timestamp: datetime
    event_type: str = "heartbeat"

    @field_validator("event_type")
    @classmethod
    def sanitize_event_type(cls, v: str) -> str:
        s = (v or "").strip()
        if re.search(r"<\s*script|<\s*\/", s, flags=re.IGNORECASE):
            raise ValueError("Invalid event_type")
        return s


class SimulationRequest(BaseModel):
    is_active: bool = Field(..., description="Was worker active during disruption?")
    fraud_flag: bool = Field(False, description="Simulate fraud scenario")
    gps_trail: Optional[List[GPSPointIn]] = None
    app_activity: Optional[List[AppActivityEventIn]] = None


class DisruptionData(BaseModel):
    weather: bool
    traffic: bool
    event: bool
    final_disruption: bool


class SimulationResponse(BaseModel):
    id: int
    disruption: DisruptionData
    decision: str
    reason: str
    fraud_score: float
    expected_income: float
    actual_income: float
    loss: float
    payout: float
    weather_data: Optional[Dict[str, Any]]
    created_at: Optional[datetime]

    model_config = {"from_attributes": True}
