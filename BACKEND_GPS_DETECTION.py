# Add these imports to zones.py
from pydantic import BaseModel, Field, field_validator
from app.utils.geo_utils import haversine_km

# Add these models to zones.py
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


# Add this endpoint to zones.py router
@router.post("/detect", response_model=GPSDetectResponse)
async def detect_zone_from_gps(body: GPSDetectRequest):
    """
    Detect nearest zone from GPS coordinates using Haversine distance.
    
    Algorithm:
    1. Filter zones using bounding box (lat ± 1, lng ± 1)
    2. Calculate Haversine distance to each zone
    3. Return nearest zone with risk data
    """
    lat, lng = body.lat, body.lng
    
    # Bounding box filter: ± 1 degree
    bbox_lat_min = lat - 1.0
    bbox_lat_max = lat + 1.0
    bbox_lng_min = lng - 1.0
    bbox_lng_max = lng + 1.0
    
    # Filter zones in bounding box
    candidates = []
    for zone_id, zone_data in ZONE_COORDS.items():
        z_lat = float(zone_data.get("lat", 0))
        z_lng = float(zone_data.get("lon", 0))
        
        if bbox_lat_min <= z_lat <= bbox_lat_max and bbox_lng_min <= z_lng <= bbox_lng_max:
            distance = haversine_km(lat, lng, z_lat, z_lng)
            candidates.append((zone_id, zone_data, distance))
    
    if not candidates:
        raise HTTPException(
            status_code=404,
            detail="No zones found near your location. Please select manually."
        )
    
    # Sort by distance and get nearest
    candidates.sort(key=lambda x: x[2])
    nearest_zone_id, nearest_zone_data, distance_km = candidates[0]
    
    # Map risk scores based on zone_id patterns
    def get_risk_label(zone_id: str) -> str:
        z = str(zone_id).lower()
        if any(x in z for x in ["kukatpally", "lb_nagar", "old_city"]):
            return "HIGH"
        if any(x in z for x in ["hitec", "jubilee", "banjara"]):
            return "LOW"
        return "MEDIUM"
    
    def get_risk_multiplier(zone_id: str) -> float:
        label = get_risk_label(zone_id)
        if label == "HIGH":
            return 1.3
        if label == "LOW":
            return 0.9
        return 1.0
    
    risk_label = get_risk_label(nearest_zone_id)
    multiplier = get_risk_multiplier(nearest_zone_id)
    
    # Risk scores (0.0-1.0)
    if risk_label == "HIGH":
        risk_scores = {"flood": 0.75, "heat": 0.65, "aqi": 0.70}
    elif risk_label == "LOW":
        risk_scores = {"flood": 0.35, "heat": 0.40, "aqi": 0.45}
    else:
        risk_scores = {"flood": 0.55, "heat": 0.50, "aqi": 0.55}
    
    return GPSDetectResponse(
        zone_id=nearest_zone_id,
        name=str(nearest_zone_data.get("zone_name", nearest_zone_id)),
        city=str(nearest_zone_data.get("city", "Hyderabad")),
        lat=float(nearest_zone_data.get("lat", lat)),
        lng=float(nearest_zone_data.get("lon", lng)),
        risk_scores=risk_scores,
        zone_risk_multiplier=multiplier,
        risk_label=risk_label,
        distance_km=round(distance_km, 2)
    )
