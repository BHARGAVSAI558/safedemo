from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

ScrutinyLevel = Literal["NORMAL", "ELEVATED", "HIGH"]
IntegrityLevel = Literal["CLEAN", "SUSPICIOUS"]
L2Decision = Literal["APPROVE", "FLAG", "BLOCK"]
RingConfidence = Literal["NONE", "MONITOR", "PROBABLE", "CONFIRMED"]
OverallDecision = Literal["CLEAN", "FLAGGED", "BLOCKED"]
SignalStance = Literal["AGREEING", "DISAGREEING", "NEUTRAL"]


@dataclass
class GPSPoint:
    lat: float
    lon: float
    timestamp: datetime
    cell_tower_id: str = ""
    accelerometer_magnitude: float = 1.0


@dataclass
class AppActivityEvent:
    timestamp: datetime
    event_type: str = "heartbeat"


@dataclass
class GPSZone:
    zone_id: str
    center_lat: float
    center_lon: float
    radius_km: float = 25.0


@dataclass
class L4Result:
    suspicious_enrollment: bool
    mass_enrollment: bool
    fast_claim: bool
    flags: List[str]
    scrutiny_level: ScrutinyLevel
    elevated_scrutiny: bool


@dataclass
class L1Result:
    integrity: IntegrityLevel
    flags: List[str]
    gps_score: int
    teleport_flag: bool
    static_spoof_flag: bool
    tower_mismatch_flag: bool
    gap_flag: bool
    fake_movement_flag: bool


@dataclass
class L2Result:
    decision: L2Decision
    corroboration_score: int
    signals: Dict[str, SignalStance]
    reason_code: str
    minor_anomaly: bool


@dataclass
class L3Result:
    ring_confidence: RingConfidence
    checks_triggered: List[str]
    cluster_id: str
    freeze: bool
    worker_ids: List[int]
    density_spike: bool
    sync_spike: bool
    homogeneous: bool


@dataclass
class FraudResult:
    overall_decision: OverallDecision
    layer_results: Dict[str, Any]
    fraud_score: float
    reason_codes: List[str]
    claim_id: str
    worker_id: int


@dataclass
class FraudPipelineInput:
    claim_id: str
    worker_id: int
    zone_id: str
    enrollment_timestamp: datetime
    first_claim_at: Optional[datetime]
    gps_trail: List[GPSPoint]
    app_activity: List[AppActivityEvent]
    fraud_flag_sim: bool
    confidence_level: Optional[str]
    confidence_signals_active: List[str]
    weather_signal: Optional[Any]
    aqi_signal: Optional[Any]
    platform_drop_pct: float
    zone_gps: GPSZone
    city_avg_lat: float
    city_avg_lon: float
