from pydantic import BaseModel, Field


class PeakHoursOut(BaseModel):
    """Legacy lunch/eve band (kept for backward compatibility)."""

    start: int = Field(..., description="IST hour start (inclusive)")
    end: int = Field(..., description="IST hour end (exclusive)")
    avg: float = Field(..., description="Average ₹/h across that band and weekdays")


class PeakWindowOut(BaseModel):
    """Best sustained 3-hour earnings block (IST)."""

    label: str = Field(..., description="Human-readable, e.g. Peak: Tue–Thu 7–10 PM · avg ₹87/hr")
    day_name: str
    day_index: int = Field(0, ge=0, le=6, description="0=Monday (anchor weekday for the block)")
    hour_start: int = Field(..., ge=0, le=23)
    hour_end: int = Field(..., ge=1, le=24, description="exclusive")
    avg_earnings: float = Field(..., description="Average ₹/hr across the 3-hour window")


class EarningsDnaOut(BaseModel):
    dna: list[list[float]] = Field(..., description="7×24 matrix: average ₹/hr per weekday × hour (IST)")
    peak_window: PeakWindowOut
    peak_hours: PeakHoursOut | None = Field(None, description="Deprecated; use peak_window")
    confidence: float = Field(..., ge=0, le=1)
    weekly_expected: float
    weekly_actual: float
    simulation_count: int = Field(0, description="APPROVED simulations in last 30 days")
    data_weeks_equivalent: float = Field(0, description="simulation_count / 14 for UI copy")
