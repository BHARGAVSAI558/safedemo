# Add these imports to workers.py
from app.models.zone import Zone
from app.models.pool_balance import PoolBalance
from app.services.earnings_dna_service import build_worker_earnings_dna
from sqlalchemy.orm import selectinload

# Add these models to workers.py schemas or use existing ProfileCreate

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


# Add these endpoints to workers.py router

@router.post("/", response_model=ProfileResponse, status_code=201)
async def onboard_worker(
    request: Request,
    body: WorkerOnboardingRequest,
    db: AsyncSession = Depends(get_db),
):
    """
    Worker onboarding endpoint.
    
    Steps:
    1. Check if worker already exists by phone
    2. Create User if new
    3. Create Profile with onboarding data
    4. Build EarningsDNA from avg_daily_income
    5. Ensure ZonePool exists
    6. Return worker with trust_score=50
    """
    phone = body.phone.strip()
    
    # Step 1: Check if worker exists
    existing_user = (
        await db.execute(select(User).where(User.phone == phone))
    ).scalar_one_or_none()
    
    if existing_user:
        existing_profile = (
            await db.execute(select(Profile).where(Profile.user_id == existing_user.id))
        ).scalar_one_or_none()
        if existing_profile:
            raise HTTPException(
                status_code=400,
                detail="Worker already exists. Use PUT /workers/update to modify."
            )
    
    # Step 2: Create User if new
    if not existing_user:
        user = User(phone=phone, is_active=True)
        db.add(user)
        await db.flush()
        await db.refresh(user)
        user_id = user.id
    else:
        user_id = existing_user.id
    
    # Step 3: Create Profile
    profile = Profile(
        user_id=user_id,
        name=body.name.strip(),
        city=body.city.strip(),
        platform=body.platform.lower(),
        zone_id=body.zone_id,
        working_hours_preset=body.working_hours_preset,
        coverage_tier=body.coverage_tier,
        avg_daily_income=float(body.avg_daily_income),
        trust_score=50.0,  # Initial trust score
        occupation=OrmOccupation.delivery,
        risk_profile=OrmRisk.medium,
    )
    db.add(profile)
    await db.flush()
    await db.refresh(profile)
    
    # Step 4: Build EarningsDNA from avg_daily_income
    # Create 7x24 matrix with hourly rates based on avg_daily_income
    hourly_rate = float(body.avg_daily_income) / 8.0  # Assume 8 working hours
    
    for day_of_week in range(7):
        for hour_of_day in range(24):
            # Vary by hour: peak hours (6-10 PM) get 1.5x, off-peak get 0.5x
            if 18 <= hour_of_day <= 22:  # 6 PM - 10 PM
                rate = hourly_rate * 1.5
            elif 6 <= hour_of_day <= 12:  # 6 AM - 12 PM
                rate = hourly_rate * 0.8
            else:
                rate = hourly_rate * 0.5
            
            dna = EarningsDNA(
                user_id=user_id,
                day_of_week=day_of_week,
                hour_of_day=hour_of_day,
                expected_hourly_rate=rate,
            )
            db.add(dna)
    
    # Step 5: Ensure ZonePool exists
    zone_pool = (
        await db.execute(select(PoolBalance).where(PoolBalance.zone_id == body.zone_id))
    ).scalar_one_or_none()
    
    if not zone_pool:
        zone_pool = PoolBalance(
            zone_id=body.zone_id,
            total_balance=0.0,
            available_balance=0.0,
            reserved_balance=0.0,
        )
        db.add(zone_pool)
    
    await db.commit()
    await db.refresh(profile)
    
    log.info(
        "worker_onboarded",
        engine_name="workers_route",
        decision="onboarded",
        reason_code="ONBOARDING_OK",
        worker_id=user_id,
        zone_id=body.zone_id,
    )
    
    return _profile_response_from_orm(profile)


@router.get("/{worker_id}/dashboard", response_model=DashboardResponse)
async def get_dashboard(
    worker_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Get complete dashboard data for worker.
    
    Aggregates:
    - Worker profile
    - Active policy
    - Zone disruption status
    - Weekly summary
    - Recent claims (LIMIT 5)
    """
    if worker_id != current_user.id:
        raise HTTPException(
            status_code=403,
            detail="Cannot access other worker's dashboard"
        )
    
    # Get profile
    profile_result = await db.execute(
        select(Profile).where(Profile.user_id == worker_id)
    )
    profile = profile_result.scalar_one_or_none()
    
    if not profile:
        profile_out = await _default_worker_profile_out(current_user, db)
    else:
        profile_out = await _worker_profile_payload(profile, current_user, db)
    
    # Get active policy
    policy_result = await db.execute(
        select(Policy)
        .where(Policy.user_id == worker_id, Policy.status == "active")
        .order_by(Policy.id.desc())
        .limit(1)
    )
    policy_row = policy_result.scalar_one_or_none()
    
    policy_data = None
    if policy_row:
        policy_data = {
            "id": policy_row.id,
            "tier": _product_plan_label(getattr(policy_row, "product_code", "")),
            "status": policy_row.status,
            "weekly_premium": float(getattr(policy_row, "weekly_premium", 0)),
            "max_coverage_per_day": float(getattr(policy_row, "max_coverage_per_day", 500)),
            "valid_until": policy_row.valid_until.isoformat() if getattr(policy_row, "valid_until", None) else None,
        }
    
    # Get zone status (from cache or compute)
    zone_status_data = None
    if profile and profile.zone_id:
        # In production, call zone_status endpoint or fetch from cache
        zone_status_data = {
            "zone_id": profile.zone_id,
            "safe_level": "SAFE",
            "disruption_active": False,
        }
    
    # Get weekly summary
    start, end = _week_bounds_utc()
    weekly_sum = (
        await db.execute(
            select(func.coalesce(func.sum(Simulation.payout), 0.0)).where(
                Simulation.user_id == worker_id,
                or_(Simulation.decision == DecisionType.APPROVED, Simulation.payout > 0),
                Simulation.created_at >= start,
                Simulation.created_at < end,
            )
        )
    ).scalar_one()
    
    claims_count = (
        await db.execute(
            select(func.count(Simulation.id)).where(
                Simulation.user_id == worker_id,
                Simulation.created_at >= start,
                Simulation.created_at < end,
            )
        )
    ).scalar_one()
    
    weekly_summary = {
        "total_protected": round(float(weekly_sum or 0), 2),
        "max_coverage": profile_out.max_weekly_coverage if profile_out else 2450.0,
        "claims_count": int(claims_count or 0),
    }
    
    # Get recent claims (LIMIT 5)
    recent_claims_result = await db.execute(
        select(Simulation)
        .where(Simulation.user_id == worker_id)
        .order_by(Simulation.created_at.desc())
        .limit(5)
    )
    recent_claims_rows = recent_claims_result.scalars().all()
    
    recent_claims = []
    for sim in recent_claims_rows:
        label, icon = disruption_from_simulation(sim)
        recent_claims.append({
            "id": sim.id,
            "disruption_type": label,
            "status": str(getattr(sim, "decision", "PENDING")),
            "payout": float(getattr(sim, "payout", 0)),
            "created_at": sim.created_at.isoformat() if sim.created_at else None,
        })
    
    return DashboardResponse(
        profile=profile_out,
        policy=policy_data,
        zone_status=zone_status_data,
        weekly_summary=weekly_summary,
        recent_claims=recent_claims,
    )
