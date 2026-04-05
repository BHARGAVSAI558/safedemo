"""Shared onboarding premium + risk score (must match SafeNetFresh ProfileSetupScreen)."""

from __future__ import annotations

from typing import Literal

from app.models.worker import RiskProfile as OrmRisk

ZoneLevel = Literal["high", "medium", "low"]

ZONE_TO_RISK: dict[str, OrmRisk] = {
    "kukatpally": OrmRisk.high,
    "hitec_city": OrmRisk.low,
    "madhapur": OrmRisk.medium,
    "jubilee_hills": OrmRisk.low,
    "banjara_hills": OrmRisk.medium,
    "begumpet": OrmRisk.medium,
    "miyapur": OrmRisk.medium,
    "kondapur": OrmRisk.medium,
    "uppal": OrmRisk.medium,
    "old_city": OrmRisk.high,
    "secunderabad": OrmRisk.medium,
    "gachibowli": OrmRisk.medium,
    "lb_nagar": OrmRisk.high,
    "ameerpet": OrmRisk.medium,
    "other": OrmRisk.medium,
}

ZONE_BASE_SCORE: dict[str, float] = {
    "kukatpally": 81.0,
    "hitec_city": 58.0,
    "madhapur": 65.0,
    "jubilee_hills": 55.0,
    "banjara_hills": 63.0,
    "begumpet": 68.0,
    "miyapur": 70.0,
    "kondapur": 67.0,
    "uppal": 73.0,
    "old_city": 76.0,
    "secunderabad": 69.0,
    "gachibowli": 66.0,
    "lb_nagar": 78.0,
    "ameerpet": 71.0,
    "other": 72.0,
}

HOURS_RISK_DELTA: dict[str, float] = {
    "morning": -3.0,
    "afternoon": -1.0,
    "evening": 2.0,
    "full_day": 5.0,
    "flexible": 0.0,
}

PLATFORM_RISK_DELTA: dict[str, float] = {
    "zomato": 1.0,
    "swiggy": 1.0,
    "both": 3.0,
    "other": 0.0,
}

ZONE_RISK_LABEL: dict[str, str] = {
    "kukatpally": "High Risk",
    "hitec_city": "Low Risk",
    "madhapur": "Medium Risk",
    "jubilee_hills": "Low Risk",
    "banjara_hills": "Medium Risk",
    "begumpet": "Medium Risk",
    "miyapur": "Medium Risk",
    "kondapur": "Medium Risk",
    "uppal": "Medium Risk",
    "old_city": "High Risk",
    "secunderabad": "Medium Risk",
    "gachibowli": "Medium Risk",
    "lb_nagar": "High Risk",
    "ameerpet": "Medium Risk",
    "other": "Medium Risk",
}

ZONE_LABEL: dict[str, str] = {
    "kukatpally": "Kukatpally",
    "hitec_city": "HITEC City",
    "madhapur": "Madhapur",
    "jubilee_hills": "Jubilee Hills",
    "banjara_hills": "Banjara Hills",
    "begumpet": "Begumpet",
    "miyapur": "Miyapur",
    "kondapur": "Kondapur",
    "uppal": "Uppal",
    "old_city": "Old City",
    "secunderabad": "Secunderabad",
    "gachibowli": "Gachibowli",
    "lb_nagar": "LB Nagar",
    "ameerpet": "Ameerpet",
    "other": "Other",
}

# Premium: base × zone_mult × hours_mult × tier_mult (aligned with mobile)
BASE_PREMIUM_WEEKLY = 42.0

ZONE_PREMIUM_MULT: dict[ZoneLevel, float] = {
    "high": 1.3,
    "medium": 1.0,
    "low": 0.8,
}

HOURS_PREMIUM_MULT: dict[str, float] = {
    "morning": 0.8,
    "afternoon": 0.9,
    "evening": 0.8,
    "full_day": 1.2,
    "flexible": 1.0,
}

TIER_PREMIUM_MULT: dict[str, float] = {
    "Basic": 0.92,
    "Standard": 1.0,
    "Pro": 1.12,
}

TIER_MAX_DAILY: dict[str, float] = {
    "Basic": 350.0,
    "Standard": 500.0,
    "Pro": 700.0,
}

TIER_TO_PRODUCT: dict[str, str] = {
    "Basic": "income_shield_basic",
    "Standard": "income_shield_standard",
    "Pro": "income_shield_pro",
}


def normalize_zone(zone_id: str) -> str:
    z = (zone_id or "").strip().lower().replace(" ", "_")
    return "hitec_city" if z in ("hitec_city", "hitec") else z


def zone_risk_level(zone_key: str) -> ZoneLevel:
    r = ZONE_TO_RISK.get(zone_key, OrmRisk.medium)
    if r == OrmRisk.high:
        return "high"
    if r == OrmRisk.low:
        return "low"
    return "medium"


def compute_risk_score(zone_key: str, hours: str, platform: str) -> float:
    base = ZONE_BASE_SCORE.get(zone_key, 72.0)
    delta = HOURS_RISK_DELTA.get(hours, 0.0) + PLATFORM_RISK_DELTA.get(platform.lower(), 0.0)
    return round(max(0.0, min(100.0, base + delta)), 1)


def compute_weekly_premium_pre_tier(zone_key: str, hours: str) -> int:
    zl = zone_risk_level(zone_key)
    zm = ZONE_PREMIUM_MULT[zl]
    hm = HOURS_PREMIUM_MULT.get(hours, 1.0)
    raw = BASE_PREMIUM_WEEKLY * zm * hm
    return int(max(25, min(100, round(raw))))


def compute_weekly_premium(zone_key: str, hours: str, tier: str) -> int:
    zl = zone_risk_level(zone_key)
    zm = ZONE_PREMIUM_MULT[zl]
    hm = HOURS_PREMIUM_MULT.get(hours, 1.0)
    tm = TIER_PREMIUM_MULT.get(tier, 1.0)
    raw = BASE_PREMIUM_WEEKLY * zm * hm * tm
    return int(max(28, min(120, round(raw))))


def recommended_tier_for_zone(zone_key: str) -> str:
    zl = zone_risk_level(zone_key)
    if zl == "high":
        return "Pro"
    if zl == "low":
        return "Basic"
    return "Standard"
