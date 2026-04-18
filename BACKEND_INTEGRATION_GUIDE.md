# SafeNet Backend API Integration Guide

## Overview

This guide explains how to integrate the new APIs into the existing FastAPI backend.

---

## Files to Modify

### 1. app/api/v1/routes/zones.py

**Add imports:**
```python
from pydantic import BaseModel, Field, field_validator
from app.utils.geo_utils import haversine_km
from datetime import timedelta
```

**Add models (after existing imports):**
```python
class GPSDetectRequest(BaseModel):
    lat: float = Field(..., ge=-90, le=90, description="Latitude")
    lng: float = Field(..., ge=-180, le=180, description="Longitude")

    @field_validator("lat")
    @classmethod
    def validate_lat(cls, v: float) -> float:
        if not (6.5 <= v <= 37.5):
            raise ValueError("Latitude must be within India bounds (6.5 to 37.5)")
        return v

    @field_validator("lng")
    @classmethod
    def validate_lng(cls, v: float) -> float:
        if not (68.0 <= v <= 97.5):
            raise ValueError("Longitude must be within India bounds (68.0 to 97.5)")
        return v


class GPSDetectResponse(BaseModel):
    zone_id: str
    name: str
    city: str
    lat: float
    lng: float
    risk_scores: dict[str, float]
    zone_risk_multiplier: float
    risk_label: str
    distance_km: float


class DisruptionEventResponse(BaseModel):
    id: int
    type: str
    severity: float
    confidence: float
    started_at: str
    expected_end_at: str | None
    raw_value: float
    threshold: float


class ActiveDisruptionsResponse(BaseModel):
    zone_id: str
    active_disruptions: list[DisruptionEventResponse]
```

**Add endpoints (after existing endpoints):**
- See BACKEND_GPS_DETECTION.py for `POST /zones/detect`
- See BACKEND_DISRUPTIONS_SEEDING.py for `GET /zones/{zone_id}/disruptions/active`

---

### 2. app/api/v1/routes/workers.py

**Add imports:**
```python
from app.models.zone import Zone
from app.models.pool_balance import PoolBalance
from app.models.worker import EarningsDNA
from sqlalchemy.orm import selectinload
from typing import Any
```

**Add models:**
```python
class WorkerOnboardingRequest(BaseModel):
    """Worker onboarding data from mobile app"""
    phone: str = Field(..., min_length=10, max_length=15)
    name: str = Field(..., min_length=2, max_length=100)
    city: str = Field(default="Hyderabad")
    platform: str = Field(..., description="zomato, swiggy, other")
    avg_daily_income: float = Field(..., gt=0, le=10000)
    zone_id: str = Field(...)
    working_hours_preset: str = Field(default="full_day")
    coverage_tier: str = Field(default="Standard")


class DashboardResponse(BaseModel):
    """Complete dashboard data for worker"""
    profile: WorkerProfileOut
    policy: dict[str, Any] | None
    zone_status: dict[str, Any] | None
    weekly_summary: dict[str, Any]
    recent_claims: list[dict[str, Any]]
```

**Add endpoints (after existing endpoints):**
- See BACKEND_WORKER_ONBOARDING.py for `POST /workers/` (onboarding)
- See BACKEND_WORKER_ONBOARDING.py for `GET /workers/{worker_id}/dashboard`

---

### 3. app/main.py

**Add zone seeding to startup:**

```python
from app.models.zone import Zone
from sqlalchemy import func, select

async def seed_zones(db: AsyncSession):
    """Seed zones on startup if DB is empty."""
    existing = await db.execute(select(func.count(Zone.id)))
    count = existing.scalar_one()
    
    if count > 0:
        return  # Already seeded
    
    zones_data = [
        # Hyderabad zones
        {"city_code": "hyd_central", "name": "Hyderabad Central", "city": "Hyderabad", "lat": 17.385, "lng": 78.4867, "flood": 0.55, "heat": 0.50, "aqi": 0.55, "multiplier": 1.0},
        {"city_code": "kukatpally", "name": "Kukatpally", "city": "Hyderabad", "lat": 17.4945, "lng": 78.3966, "flood": 0.75, "heat": 0.65, "aqi": 0.70, "multiplier": 1.3},
        # ... (see BACKEND_DISRUPTIONS_SEEDING.py for full list)
    ]
    
    for z in zones_data:
        zone = Zone(
            city_code=z["city_code"],
            name=z["name"],
            city=z["city"],
            lat=z["lat"],
            lng=z["lng"],
            flood_risk_score=z["flood"],
            heat_risk_score=z["heat"],
            aqi_risk_score=z["aqi"],
            zone_risk_multiplier=z["multiplier"],
            risk_tier="high" if z["multiplier"] > 1.2 else "low" if z["multiplier"] < 0.95 else "medium",
        )
        db.add(zone)
    
    await db.commit()
    log.info("zones_seeded", engine_name="startup", count=len(zones_data))


# In the lifespan startup event:
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    async with get_db() as db:
        await seed_zones(db)
    
    yield
    
    # Shutdown
    pass
```

---

## API Endpoints Summary

### GPS Zone Detection
```
POST /zones/detect
Content-Type: application/json

{
  "lat": 17.385,
  "lng": 78.4867
}

Response:
{
  "zone_id": "hyd_central",
  "name": "Hyderabad Central",
  "city": "Hyderabad",
  "lat": 17.385,
  "lng": 78.4867,
  "risk_scores": {
    "flood": 0.55,
    "heat": 0.50,
    "aqi": 0.55
  },
  "zone_risk_multiplier": 1.0,
  "risk_label": "MEDIUM",
  "distance_km": 0.0
}
```

### Worker Onboarding
```
POST /workers/
Content-Type: application/json
Authorization: Bearer <token>

{
  "phone": "9876543210",
  "name": "Ravi",
  "city": "Hyderabad",
  "platform": "zomato",
  "avg_daily_income": 800,
  "zone_id": "hyd_central",
  "working_hours_preset": "evening",
  "coverage_tier": "Standard"
}

Response:
{
  "id": 1,
  "user_id": 1,
  "name": "Ravi",
  "city": "Hyderabad",
  "platform": "zomato",
  "zone_id": "hyd_central",
  "trust_score": 50,
  "total_claims": 0,
  "total_payouts": 0
}
```

### Dashboard
```
GET /workers/{worker_id}/dashboard
Authorization: Bearer <token>

Response:
{
  "profile": { ... },
  "policy": {
    "id": 1,
    "tier": "Standard",
    "status": "active",
    "weekly_premium": 49,
    "max_coverage_per_day": 500,
    "valid_until": "2024-01-22T00:00:00Z"
  },
  "zone_status": {
    "zone_id": "hyd_central",
    "safe_level": "SAFE",
    "disruption_active": false
  },
  "weekly_summary": {
    "total_protected": 2500,
    "max_coverage": 3500,
    "claims_count": 2
  },
  "recent_claims": [
    {
      "id": 1,
      "disruption_type": "Heavy Rain",
      "status": "APPROVED",
      "payout": 500,
      "created_at": "2024-01-15T14:30:00Z"
    }
  ]
}
```

### Active Disruptions
```
GET /zones/{zone_id}/disruptions/active
Authorization: Bearer <token>

Response:
{
  "zone_id": "hyd_central",
  "active_disruptions": [
    {
      "id": 1,
      "type": "HEAVY_RAIN",
      "severity": 0.8,
      "confidence": 0.92,
      "started_at": "2024-01-15T14:30:00Z",
      "expected_end_at": "2024-01-15T18:00:00Z",
      "raw_value": 25.5,
      "threshold": 15.0
    }
  ]
}
```

---

## Database Models

### Zone Model (Already exists)
```python
class Zone(Base):
    __tablename__ = "zones"
    
    id: Mapped[int]
    city_code: Mapped[str]  # unique
    name: Mapped[str]
    city: Mapped[str]
    lat: Mapped[Optional[float]]
    lng: Mapped[Optional[float]]
    flood_risk_score: Mapped[float]
    heat_risk_score: Mapped[float]
    aqi_risk_score: Mapped[float]
    zone_risk_multiplier: Mapped[float]
    risk_tier: Mapped[str]  # low, medium, high
    created_at: Mapped[DateTime]
```

### EarningsDNA Model (Already exists)
```python
class EarningsDNA(Base):
    __tablename__ = "earnings_dna"
    
    id: Mapped[int]
    user_id: Mapped[int]  # FK to User
    day_of_week: Mapped[int]  # 0-6 (Mon-Sun)
    hour_of_day: Mapped[int]  # 0-23
    expected_hourly_rate: Mapped[float]  # INR/hr
    updated_at: Mapped[Optional[DateTime]]
```

---

## Testing

### Test GPS Detection
```bash
curl -X POST http://localhost:8000/api/v1/zones/detect \
  -H "Content-Type: application/json" \
  -d '{"lat": 17.385, "lng": 78.4867}'
```

### Test Worker Onboarding
```bash
curl -X POST http://localhost:8000/api/v1/workers/ \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "phone": "9876543210",
    "name": "Ravi",
    "city": "Hyderabad",
    "platform": "zomato",
    "avg_daily_income": 800,
    "zone_id": "hyd_central",
    "working_hours_preset": "evening",
    "coverage_tier": "Standard"
  }'
```

### Test Dashboard
```bash
curl -X GET http://localhost:8000/api/v1/workers/1/dashboard \
  -H "Authorization: Bearer <token>"
```

### Test Active Disruptions
```bash
curl -X GET http://localhost:8000/api/v1/zones/hyd_central/disruptions/active \
  -H "Authorization: Bearer <token>"
```

---

## Performance Considerations

1. **GPS Detection**
   - Bounding box filter first (O(n))
   - Then Haversine distance (O(n))
   - Cache zone coordinates in memory

2. **Dashboard**
   - Cache zone status (120s TTL)
   - Batch queries for claims/payouts
   - Limit recent claims to 5

3. **Disruptions**
   - Cache active disruptions (60s TTL)
   - Filter by zone_id
   - Order by severity DESC

---

## Error Handling

### GPS Detection
- 400: Invalid lat/lng or outside India bounds
- 404: No zones found near location

### Worker Onboarding
- 400: Worker already exists
- 422: Missing required fields

### Dashboard
- 403: Cannot access other worker's dashboard
- 404: Worker not found

### Active Disruptions
- 404: Unknown zone_id

---

## Implementation Checklist

- [ ] Add imports to zones.py
- [ ] Add GPS detection models to zones.py
- [ ] Add GPS detection endpoint to zones.py
- [ ] Add disruption models to zones.py
- [ ] Add active disruptions endpoint to zones.py
- [ ] Add imports to workers.py
- [ ] Add onboarding models to workers.py
- [ ] Add onboarding endpoint to workers.py
- [ ] Add dashboard endpoint to workers.py
- [ ] Add zone seeding to main.py
- [ ] Test all endpoints
- [ ] Verify database migrations
- [ ] Check error handling
- [ ] Performance test with load

---

## Notes

- All endpoints require authentication (Bearer token)
- GPS detection is public (no auth required)
- Zone seeding is idempotent (only runs if DB empty)
- All timestamps are in UTC
- Risk scores are 0.0-1.0
- Distance is in kilometers
- Haversine formula for accurate distance calculation
- Bounding box optimization for performance
