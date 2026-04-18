# Add to zones.py

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


@router.get("/{zone_id}/disruptions/active", response_model=ActiveDisruptionsResponse)
async def get_active_disruptions(
    zone_id: str,
    request: Request,
    current_user: User = Depends(get_current_user),
):
    """
    Get active disruptions for a zone.
    
    Returns:
    - type: HEAVY_RAIN, EXTREME_HEAT, AQI_SPIKE, CURFEW, etc.
    - severity: 0.0-1.0
    - confidence: 0.0-1.0
    - timestamps: started_at, expected_end_at
    - raw_value: actual measurement
    - threshold: trigger threshold
    """
    redis = getattr(request.app.state, "redis", None)
    
    # Check cache first
    cache_key = f"disruptions:{zone_id}"
    cached = await cache_get_json(redis, cache_key)
    if cached is not None:
        return cached
    
    # Get zone coordinates
    z = ZONE_COORDS.get(zone_id)
    if z is None:
        raise HTTPException(status_code=404, detail="Unknown zone_id")
    
    lat = float(z["lat"])
    lon = float(z["lon"])
    
    # Fetch weather and AQI
    weather_service = WeatherService(redis=redis)
    aqi_service = AQIService(redis=redis)
    
    try:
        weather_sig, aqi_sig = await asyncio.wait_for(
            asyncio.gather(
                weather_service.get_weather(lat, lon),
                aqi_service.get_aqi("Hyderabad", zone_id),
            ),
            timeout=5.0,
        )
    except (asyncio.TimeoutError, Exception):
        weather_sig = UnavailableSignal()
        aqi_sig = UnavailableSignal()
    
    disruptions: list[DisruptionEventResponse] = []
    now = datetime.now(timezone.utc)
    
    # Check weather disruptions
    if not isinstance(weather_sig, UnavailableSignal):
        rainfall = float(getattr(weather_sig, "rainfall_mm_hr", 0) or 0)
        temp_c = float(getattr(weather_sig, "temp_c", 28) or 28)
        
        # Heavy rain
        if rainfall > 15.0:
            disruptions.append(
                DisruptionEventResponse(
                    id=1,
                    type="HEAVY_RAIN",
                    severity=min(1.0, rainfall / 50.0),
                    confidence=0.92,
                    started_at=now.isoformat(),
                    expected_end_at=(now + timedelta(hours=4)).isoformat(),
                    raw_value=rainfall,
                    threshold=15.0,
                )
            )
        
        # Extreme heat
        if temp_c >= 42.0:
            disruptions.append(
                DisruptionEventResponse(
                    id=2,
                    type="EXTREME_HEAT",
                    severity=min(1.0, (temp_c - 35.0) / 10.0),
                    confidence=0.95,
                    started_at=now.isoformat(),
                    expected_end_at=(now + timedelta(hours=8)).isoformat(),
                    raw_value=temp_c,
                    threshold=42.0,
                )
            )
    
    # Check AQI disruptions
    if not isinstance(aqi_sig, UnavailableSignal):
        aqi_value = float(getattr(aqi_sig, "aqi_value", 100) or 100)
        
        if aqi_value > 300:
            disruptions.append(
                DisruptionEventResponse(
                    id=3,
                    type="AQI_SPIKE",
                    severity=min(1.0, aqi_value / 500.0),
                    confidence=0.88,
                    started_at=now.isoformat(),
                    expected_end_at=(now + timedelta(hours=6)).isoformat(),
                    raw_value=aqi_value,
                    threshold=300.0,
                )
            )
    
    # Check government alerts
    gov_rows = government_alert_store.get_raw(zone_id)
    for i, alert in enumerate(gov_rows[:3]):  # Limit to 3 alerts
        disruptions.append(
            DisruptionEventResponse(
                id=100 + i,
                type=str(getattr(alert, "alert_type", "SOCIAL_ALERT")),
                severity=0.8,
                confidence=0.90,
                started_at=now.isoformat(),
                expected_end_at=(now + timedelta(hours=12)).isoformat(),
                raw_value=1.0,
                threshold=0.5,
            )
        )
    
    response = ActiveDisruptionsResponse(
        zone_id=zone_id,
        active_disruptions=disruptions,
    )
    
    # Cache for 60 seconds
    await cache_set_json(redis, cache_key, response.model_dump(), ttl_seconds=60)
    
    return response


# Add to main.py startup

async def seed_zones(db: AsyncSession):
    """Seed zones on startup if DB is empty."""
    existing = await db.execute(select(func.count(Zone.id)))
    count = existing.scalar_one()
    
    if count > 0:
        return  # Already seeded
    
    zones_data = [
        # Hyderabad
        {"city_code": "hyd_central", "name": "Hyderabad Central", "city": "Hyderabad", "lat": 17.385, "lng": 78.4867, "flood": 0.55, "heat": 0.50, "aqi": 0.55, "multiplier": 1.0},
        {"city_code": "kukatpally", "name": "Kukatpally", "city": "Hyderabad", "lat": 17.4945, "lng": 78.3966, "flood": 0.75, "heat": 0.65, "aqi": 0.70, "multiplier": 1.3},
        {"city_code": "hitec_city", "name": "HITEC City", "city": "Hyderabad", "lat": 17.4435, "lng": 78.3772, "flood": 0.35, "heat": 0.40, "aqi": 0.45, "multiplier": 0.9},
        {"city_code": "madhapur", "name": "Madhapur", "city": "Hyderabad", "lat": 17.4483, "lng": 78.3915, "flood": 0.50, "heat": 0.48, "aqi": 0.52, "multiplier": 1.0},
        {"city_code": "jubilee_hills", "name": "Jubilee Hills", "city": "Hyderabad", "lat": 17.4319, "lng": 78.4075, "flood": 0.40, "heat": 0.42, "aqi": 0.48, "multiplier": 0.9},
        {"city_code": "banjara_hills", "name": "Banjara Hills", "city": "Hyderabad", "lat": 17.4264, "lng": 78.4351, "flood": 0.45, "heat": 0.45, "aqi": 0.50, "multiplier": 0.95},
        {"city_code": "begumpet", "name": "Begumpet", "city": "Hyderabad", "lat": 17.4375, "lng": 78.4728, "flood": 0.55, "heat": 0.50, "aqi": 0.55, "multiplier": 1.0},
        {"city_code": "ameerpet", "name": "Ameerpet", "city": "Hyderabad", "lat": 17.4375, "lng": 78.4482, "flood": 0.52, "heat": 0.50, "aqi": 0.54, "multiplier": 1.0},
        {"city_code": "miyapur", "name": "Miyapur", "city": "Hyderabad", "lat": 17.6756, "lng": 78.3429, "flood": 0.60, "heat": 0.55, "aqi": 0.60, "multiplier": 1.1},
        {"city_code": "kondapur", "name": "Kondapur", "city": "Hyderabad", "lat": 17.4699, "lng": 78.3578, "flood": 0.50, "heat": 0.48, "aqi": 0.52, "multiplier": 1.0},
        {"city_code": "uppal", "name": "Uppal", "city": "Hyderabad", "lat": 17.4018, "lng": 78.5604, "flood": 0.65, "heat": 0.60, "aqi": 0.65, "multiplier": 1.2},
        {"city_code": "old_city", "name": "Old City", "city": "Hyderabad", "lat": 17.3616, "lng": 78.4747, "flood": 0.70, "heat": 0.62, "aqi": 0.68, "multiplier": 1.25},
        {"city_code": "secunderabad", "name": "Secunderabad", "city": "Hyderabad", "lat": 17.4399, "lng": 78.4983, "flood": 0.55, "heat": 0.50, "aqi": 0.55, "multiplier": 1.0},
        {"city_code": "gachibowli", "name": "Gachibowli", "city": "Hyderabad", "lat": 17.4401, "lng": 78.3489, "flood": 0.48, "heat": 0.46, "aqi": 0.50, "multiplier": 0.95},
        {"city_code": "lb_nagar", "name": "LB Nagar", "city": "Hyderabad", "lat": 17.3481, "lng": 78.545, "flood": 0.72, "heat": 0.63, "aqi": 0.70, "multiplier": 1.3},
        
        # Bengaluru
        {"city_code": "blr_central", "name": "Bengaluru Central", "city": "Bengaluru", "lat": 12.9716, "lng": 77.5946, "flood": 0.50, "heat": 0.45, "aqi": 0.55, "multiplier": 1.0},
        
        # Mumbai
        {"city_code": "bom_central", "name": "Mumbai Central", "city": "Mumbai", "lat": 19.076, "lng": 72.8777, "flood": 0.80, "heat": 0.55, "aqi": 0.65, "multiplier": 1.4},
        
        # Delhi
        {"city_code": "del_central", "name": "Delhi Central", "city": "Delhi", "lat": 28.6139, "lng": 77.209, "flood": 0.45, "heat": 0.70, "aqi": 0.75, "multiplier": 1.2},
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


# In main.py, add to lifespan startup:
# await seed_zones(db)
