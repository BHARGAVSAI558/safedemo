# SafeNet Backend API Implementation Plan

## Current Status

### ✅ Already Implemented
- `POST /auth/send-otp` - OTP generation and sending
- `POST /auth/verify-otp` - OTP verification and JWT token creation
- `POST /auth/refresh` - Token refresh
- `POST /auth/admin-login` - Admin authentication
- `GET /zones/{zone_id}/status` - Zone status with weather/AQI
- `GET /zones/{zone_id}/forecast-shield` - Forecast shield data
- `POST /workers/create` - Worker profile creation
- `GET /workers/me` - Get current worker profile
- `PUT /workers/update` - Update worker profile
- `GET /workers/weekly-breakdown` - Weekly payout breakdown
- `GET /workers/earnings-dna` - Earnings DNA heatmap

### ❌ Missing (To Implement)

1. **POST /zones/detect** - GPS-based zone detection
   - Input: lat, lng
   - Output: zone_id, name, city, risk scores
   - Logic: Haversine distance with bounding box optimization

2. **POST /workers** - Worker onboarding (alternative to /create)
   - Input: phone, name, city, platform, avg_daily_income, zone_id
   - Output: worker profile with trust_score=50
   - Logic: Check if exists, create, build EarningsDNA, ensure ZonePool

3. **GET /workers/{id}/dashboard** - Dashboard data
   - Output: profile, policy, zone status, weekly summary, recent claims
   - Aggregates multiple data sources

4. **GET /zones/{zone_id}/disruptions/active** - Active disruptions
   - Output: List of active DisruptionEvents
   - Includes: type, severity, confidence, timestamps

5. **Zone Seeding** - Seed zones on startup
   - Multiple cities: Hyderabad, Mumbai, Bengaluru, Delhi
   - Realistic lat/lng and risk scores
   - Only seed if DB empty

---

## Implementation Details

### 1. GPS Zone Detection (POST /zones/detect)

**Algorithm:**
```
1. Validate lat/lng are within India bounds
2. Filter zones using bounding box (lat ± 1, lng ± 1)
3. Calculate Haversine distance to each zone
4. Return nearest zone with risk data
```

**Response:**
```json
{
  "zone_id": "hyd_central",
  "name": "Hyderabad Central",
  "city": "Hyderabad",
  "lat": 17.385,
  "lng": 78.4867,
  "risk_scores": {
    "flood": 0.65,
    "heat": 0.45,
    "aqi": 0.55
  },
  "zone_risk_multiplier": 1.2,
  "risk_label": "MEDIUM"
}
```

### 2. Worker Onboarding (POST /workers)

**Steps:**
1. Check if worker exists by phone (via User model)
2. Create Profile with onboarding data
3. Build EarningsDNA from avg_daily_income
4. Ensure ZonePool exists for zone
5. Return worker with trust_score=50

**Request:**
```json
{
  "phone": "9876543210",
  "name": "Ravi",
  "city": "Hyderabad",
  "platform": "zomato",
  "avg_daily_income": 800,
  "zone_id": "hyd_central",
  "working_hours_preset": "evening"
}
```

**Response:**
```json
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

### 3. Dashboard (GET /workers/{id}/dashboard)

**Aggregates:**
- Worker profile
- Active policy
- Zone disruption status
- Weekly summary (payouts, claims)
- Recent claims (LIMIT 5)

**Response:**
```json
{
  "profile": { ... },
  "policy": { ... },
  "zone_status": { ... },
  "weekly_summary": {
    "total_protected": 2500,
    "max_coverage": 3500,
    "claims_count": 2
  },
  "recent_claims": [ ... ]
}
```

### 4. Active Disruptions (GET /zones/{zone_id}/disruptions/active)

**Response:**
```json
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

### 5. Zone Seeding

**Cities to seed:**
- Hyderabad (already in zone_coordinates.json)
- Mumbai
- Bengaluru
- Delhi

**Risk scores:**
- flood_risk_score: 0.0-1.0
- heat_risk_score: 0.0-1.0
- aqi_risk_score: 0.0-1.0
- zone_risk_multiplier: 0.8-1.5

---

## Files to Modify

1. **app/api/v1/routes/zones.py**
   - Add `POST /zones/detect` endpoint
   - Add `GET /zones/{zone_id}/disruptions/active` endpoint

2. **app/api/v1/routes/workers.py**
   - Add `POST /workers` endpoint (onboarding)
   - Add `GET /workers/{id}/dashboard` endpoint

3. **app/main.py**
   - Add zone seeding on startup

4. **app/utils/geo_utils.py**
   - Add Haversine distance calculation
   - Add bounding box filtering

---

## Database Considerations

### Zone Model
- Already exists: `app/models/zone.py`
- Fields: city_code, name, city, lat, lng, risk scores, zone_risk_multiplier

### Worker Model
- Already exists: `app/models/worker.py`
- Profile has: zone_id, platform, working_hours_preset, coverage_tier

### EarningsDNA Model
- Already exists: `app/models/worker.py`
- Fields: user_id, day_of_week, hour_of_day, expected_hourly_rate

---

## Error Handling

### GPS Detection
- Invalid lat/lng → 400 Bad Request
- No zones found → 404 Not Found
- GPS outside India → 400 Bad Request

### Worker Onboarding
- Worker already exists → 400 Bad Request
- Invalid phone → 400 Bad Request
- Missing required fields → 422 Unprocessable Entity

### Dashboard
- Worker not found → 404 Not Found
- No policy → Return empty policy object

---

## Performance Considerations

1. **Zone Detection**
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

## Testing Checklist

- [ ] GPS detection with valid coordinates
- [ ] GPS detection with invalid coordinates
- [ ] GPS detection with no zones nearby
- [ ] Worker onboarding with new phone
- [ ] Worker onboarding with existing phone
- [ ] Dashboard with active policy
- [ ] Dashboard with no policy
- [ ] Active disruptions list
- [ ] Zone seeding on startup
- [ ] Zone seeding idempotency

---

## Implementation Order

1. Add Haversine distance utility
2. Implement GPS zone detection
3. Implement worker onboarding
4. Implement dashboard aggregation
5. Implement active disruptions
6. Add zone seeding
7. Test all endpoints

---

## Notes

- No city-specific logic in business layer
- All city info in seed data only
- Support any city via zone_coordinates.json
- Haversine formula for accurate distance
- Bounding box optimization for performance
