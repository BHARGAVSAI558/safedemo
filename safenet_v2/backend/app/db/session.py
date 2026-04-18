import asyncio
import sqlite3
from pathlib import Path
from collections.abc import AsyncGenerator
from typing import Any

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.core.config import settings
from app.db.base import Base

SQLITE_MEMORY_FALLBACK = False


def _sqlite_database_url_and_connect_args(database_url: str) -> tuple[str, dict[str, Any], dict[str, Any]]:
    global SQLITE_MEMORY_FALLBACK

    if "+aiosqlite" not in database_url:
        database_url = database_url.replace("sqlite://", "sqlite+aiosqlite://", 1)

    connect_args: dict[str, Any] = {"check_same_thread": False}

    raw_target = database_url.replace("sqlite+aiosqlite:///", "", 1)
    if raw_target.startswith("file:"):
        return database_url, {**connect_args, "uri": True}, {}

    probe_dir = Path(raw_target or ".").resolve().parent
    probe_dir.mkdir(parents=True, exist_ok=True)
    probe_path = probe_dir / ".sqlite-write-probe.db"

    try:
        with sqlite3.connect(probe_path) as probe:
            probe.execute("CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY)")
            probe.execute("INSERT INTO probe DEFAULT VALUES")
            probe.commit()
        probe_path.unlink(missing_ok=True)
        return database_url, connect_args, {}
    except Exception:
        SQLITE_MEMORY_FALLBACK = True
        memory_url = "sqlite+aiosqlite:///:memory:"
        return memory_url, connect_args, {"poolclass": StaticPool}


def _make_engine():
    """SQLite (file) vs PostgreSQL (pooled); mirrors Render `postgres://` DSN handling."""
    database_url = settings.DATABASE_URL
    if database_url.startswith("postgres://"):
        database_url = database_url.replace("postgres://", "postgresql+asyncpg://", 1)

    if database_url.startswith("sqlite"):
        database_url, connect_args, engine_kwargs = _sqlite_database_url_and_connect_args(database_url)
        return create_async_engine(
            database_url,
            connect_args=connect_args,
            echo=False,
            **engine_kwargs,
        )

    url = settings.async_database_url
    return create_async_engine(
        url,
        pool_pre_ping=True,
        pool_size=5,
        max_overflow=10,
        echo=bool(settings.DEBUG),
    )


engine = _make_engine()

AsyncSessionLocal = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autocommit=False,
    autoflush=False,
)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    session = AsyncSessionLocal()
    if not settings.is_sqlite:
        try:
            await asyncio.wait_for(session.connection(), timeout=5.0)
        except asyncio.TimeoutError:
            await session.close()
            raise HTTPException(status_code=503, detail="Our system is busy right now. Please try again.")
    try:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
    finally:
        await session.close()


async def init_db() -> None:
    async with engine.begin() as conn:
        try:
            import app.models  # noqa: F401
        except Exception:
            pass
        await conn.run_sync(Base.metadata.create_all)

        if not settings.is_sqlite:
            # PostgreSQL-only: backfill columns added after initial deploy
            pg_stmts = [
                "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS platform VARCHAR(32)",
                "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS zone_id VARCHAR(64)",
                "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS working_hours_preset VARCHAR(64)",
                "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS coverage_tier VARCHAR(32)",
                "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS risk_score DOUBLE PRECISION",
                "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS weekly_premium DOUBLE PRECISION",
                "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS active_hours_per_day DOUBLE PRECISION DEFAULT 8.0",
                "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avg_daily_earnings DOUBLE PRECISION",
                "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS location_display VARCHAR(255)",
                "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS bank_account_number VARCHAR(40)",
                "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS bank_ifsc VARCHAR(20)",
                "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS bank_upi_id VARCHAR(120)",
                "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS bank_account_name VARCHAR(120)",
                "ALTER TABLE policies ADD COLUMN IF NOT EXISTS weekly_premium FLOAT DEFAULT 0.0",
                "ALTER TABLE policies ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ",
                "ALTER TABLE policies ADD COLUMN IF NOT EXISTS valid_until TIMESTAMPTZ",
                "ALTER TABLE policies ADD COLUMN IF NOT EXISTS tier VARCHAR(32) DEFAULT 'basic'",
                "ALTER TABLE policies ADD COLUMN IF NOT EXISTS coverage_cap FLOAT DEFAULT 0.0",
                "ALTER TABLE policies ADD COLUMN IF NOT EXISTS zone_risk_multiplier FLOAT DEFAULT 1.0",
                "ALTER TABLE policies ADD COLUMN IF NOT EXISTS worker_risk_adjustment FLOAT DEFAULT 1.0",
                "ALTER TABLE zones ADD COLUMN IF NOT EXISTS city VARCHAR(100) DEFAULT 'Hyderabad'",
                "ALTER TABLE zones ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION",
                "ALTER TABLE zones ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION",
                "ALTER TABLE zones ADD COLUMN IF NOT EXISTS flood_risk_score FLOAT DEFAULT 0.5",
                "ALTER TABLE zones ADD COLUMN IF NOT EXISTS heat_risk_score FLOAT DEFAULT 0.5",
                "ALTER TABLE zones ADD COLUMN IF NOT EXISTS aqi_risk_score FLOAT DEFAULT 0.5",
                "ALTER TABLE zones ADD COLUMN IF NOT EXISTS zone_risk_multiplier FLOAT DEFAULT 1.0",
                "ALTER TABLE zone_pool_balances ADD COLUMN IF NOT EXISTS total_premiums_collected FLOAT DEFAULT 0.0",
                "ALTER TABLE zone_pool_balances ADD COLUMN IF NOT EXISTS total_payouts_disbursed FLOAT DEFAULT 0.0",
                "ALTER TABLE zone_pool_balances ADD COLUMN IF NOT EXISTS current_balance FLOAT DEFAULT 0.0",
                "ALTER TABLE zone_pool_balances ADD COLUMN IF NOT EXISTS loss_ratio FLOAT DEFAULT 0.0",
                "ALTER TABLE payout_records ADD COLUMN IF NOT EXISTS payment_type VARCHAR(32) DEFAULT 'payout'",
                "ALTER TABLE payout_records ADD COLUMN IF NOT EXISTS razorpay_order_id VARCHAR(128)",
                "ALTER TABLE payout_records ADD COLUMN IF NOT EXISTS razorpay_payment_id VARCHAR(128)",
                "ALTER TABLE support_queries ADD COLUMN IF NOT EXISTS translated_text TEXT DEFAULT ''",
                "ALTER TABLE support_queries ADD COLUMN IF NOT EXISTS priority VARCHAR(16) DEFAULT 'LOW'",
                "ALTER TABLE support_queries ADD COLUMN IF NOT EXISTS category VARCHAR(24) DEFAULT 'other'",
                "ALTER TABLE support_queries ADD COLUMN IF NOT EXISTS score INTEGER DEFAULT 0",
                "ALTER TABLE support_queries ADD COLUMN IF NOT EXISTS reason VARCHAR(255) DEFAULT ''",
                # Performance indexes
                "CREATE INDEX IF NOT EXISTS ix_profiles_zone_id ON profiles (zone_id)",
                "CREATE INDEX IF NOT EXISTS ix_simulations_created_at ON simulations (created_at)",
                "CREATE INDEX IF NOT EXISTS ix_simulations_decision ON simulations (decision)",
                "CREATE INDEX IF NOT EXISTS ix_disruption_events_zone_id ON disruption_events (zone_id)",
                "CREATE INDEX IF NOT EXISTS ix_disruption_events_is_active ON disruption_events (is_active)",
                "CREATE INDEX IF NOT EXISTS ix_payout_records_status ON payout_records (status)",
                "CREATE INDEX IF NOT EXISTS ix_payout_records_created_at ON payout_records (created_at)",
                "CREATE INDEX IF NOT EXISTS ix_support_queries_priority ON support_queries (priority)",
                "CREATE INDEX IF NOT EXISTS ix_support_queries_category ON support_queries (category)",
                "CREATE INDEX IF NOT EXISTS ix_support_queries_score ON support_queries (score)",
                # Payments table (created by SQLAlchemy metadata.create_all, but backfill for existing DBs)
                "CREATE INDEX IF NOT EXISTS ix_payments_user_id ON payments (user_id)",
                "CREATE INDEX IF NOT EXISTS ix_payments_status ON payments (status)",
            ]
            for stmt in pg_stmts:
                await conn.execute(text(stmt))
        else:
            sqlite_stmts = [
                "ALTER TABLE profiles ADD COLUMN risk_score FLOAT",
                "ALTER TABLE profiles ADD COLUMN weekly_premium FLOAT",
                "ALTER TABLE profiles ADD COLUMN active_hours_per_day FLOAT DEFAULT 8.0",
                "ALTER TABLE profiles ADD COLUMN avg_daily_earnings FLOAT",
                "ALTER TABLE profiles ADD COLUMN location_display VARCHAR(255)",
                "ALTER TABLE profiles ADD COLUMN bank_account_number VARCHAR(40)",
                "ALTER TABLE profiles ADD COLUMN bank_ifsc VARCHAR(20)",
                "ALTER TABLE profiles ADD COLUMN bank_upi_id VARCHAR(120)",
                "ALTER TABLE profiles ADD COLUMN bank_account_name VARCHAR(120)",
                "ALTER TABLE policies ADD COLUMN valid_from DATETIME",
                "ALTER TABLE policies ADD COLUMN valid_until DATETIME",
                "ALTER TABLE policies ADD COLUMN tier VARCHAR(32) DEFAULT 'basic'",
                "ALTER TABLE policies ADD COLUMN coverage_cap FLOAT DEFAULT 0.0",
                "ALTER TABLE policies ADD COLUMN zone_risk_multiplier FLOAT DEFAULT 1.0",
                "ALTER TABLE policies ADD COLUMN worker_risk_adjustment FLOAT DEFAULT 1.0",
                "ALTER TABLE zones ADD COLUMN city VARCHAR(100) DEFAULT 'Hyderabad'",
                "ALTER TABLE zones ADD COLUMN lat FLOAT",
                "ALTER TABLE zones ADD COLUMN lng FLOAT",
                "ALTER TABLE zones ADD COLUMN flood_risk_score FLOAT DEFAULT 0.5",
                "ALTER TABLE zones ADD COLUMN heat_risk_score FLOAT DEFAULT 0.5",
                "ALTER TABLE zones ADD COLUMN aqi_risk_score FLOAT DEFAULT 0.5",
                "ALTER TABLE zones ADD COLUMN zone_risk_multiplier FLOAT DEFAULT 1.0",
                "ALTER TABLE zone_pool_balances ADD COLUMN total_premiums_collected FLOAT DEFAULT 0.0",
                "ALTER TABLE zone_pool_balances ADD COLUMN total_payouts_disbursed FLOAT DEFAULT 0.0",
                "ALTER TABLE zone_pool_balances ADD COLUMN current_balance FLOAT DEFAULT 0.0",
                "ALTER TABLE zone_pool_balances ADD COLUMN loss_ratio FLOAT DEFAULT 0.0",
                "ALTER TABLE payout_records ADD COLUMN payment_type VARCHAR(32) DEFAULT 'payout'",
                "ALTER TABLE payout_records ADD COLUMN razorpay_order_id VARCHAR(128)",
                "ALTER TABLE payout_records ADD COLUMN razorpay_payment_id VARCHAR(128)",
                "ALTER TABLE support_queries ADD COLUMN translated_text TEXT DEFAULT ''",
                "ALTER TABLE support_queries ADD COLUMN priority VARCHAR(16) DEFAULT 'LOW'",
                "ALTER TABLE support_queries ADD COLUMN category VARCHAR(24) DEFAULT 'other'",
                "ALTER TABLE support_queries ADD COLUMN score INTEGER DEFAULT 0",
                "ALTER TABLE support_queries ADD COLUMN reason VARCHAR(255) DEFAULT ''",
                "CREATE INDEX IF NOT EXISTS ix_profiles_zone_id ON profiles (zone_id)",
                "CREATE INDEX IF NOT EXISTS ix_simulations_created_at ON simulations (created_at)",
                "CREATE INDEX IF NOT EXISTS ix_simulations_decision ON simulations (decision)",
                "CREATE INDEX IF NOT EXISTS ix_disruption_events_zone_id ON disruption_events (zone_id)",
                "CREATE INDEX IF NOT EXISTS ix_disruption_events_is_active ON disruption_events (is_active)",
                "CREATE INDEX IF NOT EXISTS ix_payout_records_status ON payout_records (status)",
                "CREATE INDEX IF NOT EXISTS ix_payout_records_created_at ON payout_records (created_at)",
                "CREATE INDEX IF NOT EXISTS ix_support_queries_priority ON support_queries (priority)",
                "CREATE INDEX IF NOT EXISTS ix_support_queries_category ON support_queries (category)",
                "CREATE INDEX IF NOT EXISTS ix_support_queries_score ON support_queries (score)",
            ]
            for stmt in sqlite_stmts:
                try:
                    await conn.execute(text(stmt))
                except Exception:
                    pass

    # Seed reference zones (idempotent — skips if already present)
    await _seed_zones()
    await _seed_local_dataset()


async def _seed_zones() -> None:
    """Insert canonical zones across 3 cities if not already present."""
    from sqlalchemy import select
    from app.models.zone import Zone

    ZONES = [
        # Hyderabad
        dict(city_code="HYD_BANJARA_HILLS", name="Banjara Hills", city="Hyderabad", lat=17.4156, lng=78.4347, flood_risk_score=0.55, heat_risk_score=0.58, aqi_risk_score=0.56, risk_tier="medium"),
        dict(city_code="HYD_GACHIBOWLI", name="Gachibowli", city="Hyderabad", lat=17.4401, lng=78.3489, flood_risk_score=0.50, heat_risk_score=0.57, aqi_risk_score=0.52, risk_tier="medium"),
        dict(city_code="HYD_MADHAPUR", name="Madhapur", city="Hyderabad", lat=17.4418, lng=78.3810, flood_risk_score=0.52, heat_risk_score=0.56, aqi_risk_score=0.53, risk_tier="medium"),
        dict(city_code="HYD_KUKATPALLY", name="Kukatpally", city="Hyderabad", lat=17.4849, lng=78.3996, flood_risk_score=0.82, heat_risk_score=0.61, aqi_risk_score=0.66, risk_tier="high"),
        dict(city_code="HYD_LB_NAGAR", name="LB Nagar", city="Hyderabad", lat=17.3439, lng=78.5519, flood_risk_score=0.77, heat_risk_score=0.69, aqi_risk_score=0.72, risk_tier="high"),
        dict(city_code="HYD_SECUNDERABAD", name="Secunderabad", city="Hyderabad", lat=17.4399, lng=78.4983, flood_risk_score=0.58, heat_risk_score=0.55, aqi_risk_score=0.61, risk_tier="medium"),
        dict(city_code="HYD_HITEC_CITY", name="HITEC City", city="Hyderabad", lat=17.4475, lng=78.3762, flood_risk_score=0.44, heat_risk_score=0.53, aqi_risk_score=0.49, risk_tier="low"),
        dict(city_code="HYD_UPPAL", name="Uppal", city="Hyderabad", lat=17.4010, lng=78.5590, flood_risk_score=0.63, heat_risk_score=0.58, aqi_risk_score=0.66, risk_tier="medium"),
        # Vijayawada
        dict(city_code="VJA_CENTRAL", name="Vijayawada Central", city="Vijayawada", lat=16.5062, lng=80.6480, flood_risk_score=0.60, heat_risk_score=0.71, aqi_risk_score=0.47, risk_tier="medium"),
        dict(city_code="VJA_BENZ_CIRCLE", name="Benz Circle", city="Vijayawada", lat=16.5193, lng=80.6305, flood_risk_score=0.57, heat_risk_score=0.69, aqi_risk_score=0.46, risk_tier="medium"),
        dict(city_code="VJA_AUTO_NAGAR", name="Auto Nagar", city="Vijayawada", lat=16.4907, lng=80.6480, flood_risk_score=0.61, heat_risk_score=0.68, aqi_risk_score=0.49, risk_tier="medium"),
        dict(city_code="VJA_KANURU", name="Kanuru", city="Vijayawada", lat=16.5015, lng=80.6780, flood_risk_score=0.55, heat_risk_score=0.67, aqi_risk_score=0.45, risk_tier="medium"),
        # Mumbai
        dict(city_code="MUM_ANDHERI", name="Andheri", city="Mumbai", lat=19.1136, lng=72.8697, flood_risk_score=0.66, heat_risk_score=0.48, aqi_risk_score=0.62, risk_tier="medium"),
        dict(city_code="MUM_DADAR", name="Dadar", city="Mumbai", lat=19.0178, lng=72.8478, flood_risk_score=0.72, heat_risk_score=0.47, aqi_risk_score=0.63, risk_tier="high"),
        dict(city_code="MUM_THANE", name="Thane", city="Mumbai", lat=19.2183, lng=72.9781, flood_risk_score=0.60, heat_risk_score=0.49, aqi_risk_score=0.58, risk_tier="medium"),
        # Delhi
        dict(city_code="DEL_CONN_PLACE", name="Connaught Place", city="Delhi", lat=28.6315, lng=77.2167, flood_risk_score=0.34, heat_risk_score=0.74, aqi_risk_score=0.83, risk_tier="high"),
        dict(city_code="DEL_DWARKA", name="Dwarka", city="Delhi", lat=28.5921, lng=77.0460, flood_risk_score=0.31, heat_risk_score=0.72, aqi_risk_score=0.79, risk_tier="high"),
        # Bengaluru
        dict(city_code="BLR_KORAMANGALA", name="Koramangala", city="Bangalore", lat=12.9352, lng=77.6245, flood_risk_score=0.42, heat_risk_score=0.38, aqi_risk_score=0.52, risk_tier="medium"),
        dict(city_code="BLR_WHITEFIELD", name="Whitefield", city="Bangalore", lat=12.9698, lng=77.7499, flood_risk_score=0.33, heat_risk_score=0.41, aqi_risk_score=0.59, risk_tier="low"),
        dict(city_code="BLR_INDIRANAGAR", name="Indiranagar", city="Bangalore", lat=12.9784, lng=77.6408, flood_risk_score=0.37, heat_risk_score=0.40, aqi_risk_score=0.55, risk_tier="medium"),
        # Chennai
        dict(city_code="CHE_T_NAGAR", name="T Nagar", city="Chennai", lat=13.0418, lng=80.2341, flood_risk_score=0.62, heat_risk_score=0.73, aqi_risk_score=0.54, risk_tier="medium"),
        dict(city_code="CHE_ANNA_NAGAR", name="Anna Nagar", city="Chennai", lat=13.0850, lng=80.2101, flood_risk_score=0.58, heat_risk_score=0.71, aqi_risk_score=0.52, risk_tier="medium"),
    ]

    async with AsyncSessionLocal() as session:
        for z in ZONES:
            existing = (await session.execute(select(Zone).where(Zone.city_code == z["city_code"]))).scalar_one_or_none()
            if existing:
                # Update risk fields in case values changed
                existing.lat = z["lat"]
                existing.lng = z["lng"]
                existing.flood_risk_score = z["flood_risk_score"]
                existing.heat_risk_score = z["heat_risk_score"]
                existing.aqi_risk_score = z["aqi_risk_score"]
                existing.zone_risk_multiplier = round(
                    z["flood_risk_score"] * 0.5 + z["heat_risk_score"] * 0.3 + z["aqi_risk_score"] * 0.2, 4
                )
                existing.risk_tier = z["risk_tier"]
                existing.city = z["city"]
            else:
                multiplier = round(z["flood_risk_score"] * 0.5 + z["heat_risk_score"] * 0.3 + z["aqi_risk_score"] * 0.2, 4)
                session.add(Zone(
                    city_code=z["city_code"],
                    name=z["name"],
                    city=z["city"],
                    lat=z["lat"],
                    lng=z["lng"],
                    flood_risk_score=z["flood_risk_score"],
                    heat_risk_score=z["heat_risk_score"],
                    aqi_risk_score=z["aqi_risk_score"],
                    zone_risk_multiplier=multiplier,
                    risk_tier=z["risk_tier"],
                ))
        await session.commit()


async def _seed_local_dataset() -> None:
    import json
    from datetime import datetime, timedelta, timezone

    from sqlalchemy import select

    from app.models.claim import ClaimLifecycle, DecisionType, DisruptionEvent, Simulation
    from app.models.payment import Payment
    from app.models.policy import Policy
    from app.models.pool_balance import ZonePoolBalance
    from app.models.worker import OccupationType, Profile, RiskProfile, User

    async with AsyncSessionLocal() as session:
        has_user = (await session.execute(select(User.id).limit(1))).scalar_one_or_none() is not None
        has_sim = (await session.execute(select(Simulation.id).limit(1))).scalar_one_or_none() is not None
        has_payment = (await session.execute(select(Payment.id).limit(1))).scalar_one_or_none() is not None
        if has_user and has_sim and has_payment:
            return

        now = datetime.now(timezone.utc)
        user = (await session.execute(select(User).where(User.phone == "9000000010"))).scalar_one_or_none()
        if user is None:
            user = User(phone="9000000010", is_active=True, is_admin=False)
            session.add(user)
            await session.flush()

        profile = (await session.execute(select(Profile).where(Profile.user_id == user.id))).scalar_one_or_none()
        if profile is None:
            profile = Profile(
                user_id=user.id,
                name="Local Worker",
                city="Hyderabad",
                occupation=OccupationType.delivery,
                avg_daily_income=900.0,
                risk_profile=RiskProfile.medium,
                trust_score=0.82,
                total_claims=1,
                total_payouts=420.0,
                platform="zomato",
                zone_id="hyd_central",
                working_hours_preset="full_day",
                coverage_tier="Standard",
                risk_score=64.0,
                weekly_premium=49.0,
                avg_daily_earnings=900.0,
            )
            session.add(profile)

        policy = (
            await session.execute(
                select(Policy).where(Policy.user_id == user.id, Policy.status == "active").order_by(Policy.id.desc()).limit(1)
            )
        ).scalar_one_or_none()
        if policy is None:
            policy = Policy(
                user_id=user.id,
                product_code="income_shield_standard",
                tier="Standard",
                status="active",
                monthly_premium=212.17,
                weekly_premium=49.0,
                coverage_cap=3500.0,
                zone_risk_multiplier=1.08,
                worker_risk_adjustment=0.92,
                valid_from=now - timedelta(days=2),
                valid_until=now + timedelta(days=5),
                updated_at=now,
            )
            session.add(policy)
            await session.flush()

        event = (
            await session.execute(
                select(DisruptionEvent)
                .where(DisruptionEvent.zone_id == "hyd_central", DisruptionEvent.is_active.is_(True))
                .order_by(DisruptionEvent.id.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        if event is None:
            event = DisruptionEvent(
                zone_id="hyd_central",
                disruption_type="HEAVY_RAIN",
                severity=0.82,
                confidence="HIGH",
                api_source="local_seed",
                raw_value=22.4,
                threshold_value=12.0,
                started_at=now - timedelta(hours=3),
                is_active=True,
            )
            session.add(event)
            await session.flush()

        simulation = (
            await session.execute(select(Simulation).where(Simulation.user_id == user.id).order_by(Simulation.id.desc()).limit(1))
        ).scalar_one_or_none()
        if simulation is None:
            simulation = Simulation(
                user_id=user.id,
                disruption_event_id=event.id,
                is_active=True,
                fraud_flag=False,
                fraud_score=0.08,
                weather_disruption=True,
                traffic_disruption=False,
                event_disruption=False,
                final_disruption=True,
                expected_income=900.0,
                actual_income=420.0,
                loss=480.0,
                payout=420.0,
                decision=DecisionType.APPROVED,
                reason="Heavy rain disruption verified. Payout credited to worker wallet.",
                weather_data=json.dumps({"zone_id": "hyd_central", "disruption_type": "HEAVY_RAIN", "source": "local_seed"}),
                created_at=now - timedelta(hours=2),
            )
            session.add(simulation)
            await session.flush()

        lifecycle = (
            await session.execute(select(ClaimLifecycle).where(ClaimLifecycle.user_id == user.id).order_by(ClaimLifecycle.id.desc()).limit(1))
        ).scalar_one_or_none()
        if lifecycle is None:
            session.add(
                ClaimLifecycle(
                    claim_id=f"seed:{user.id}:{simulation.id}",
                    correlation_id=f"seed-{user.id}-{simulation.id}",
                    user_id=user.id,
                    zone_id="hyd_central",
                    disruption_type="HEAVY_RAIN",
                    status="PAYOUT_CREDITED",
                    message="Heavy rain verified. Payout credited.",
                    payout_amount=420.0,
                    created_at=now - timedelta(hours=2),
                )
            )

        payment = (
            await session.execute(
                select(Payment)
                .where(Payment.user_id == user.id, Payment.simulation_id == simulation.id)
                .order_by(Payment.id.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        if payment is None:
            session.add(
                Payment(
                    user_id=user.id,
                    policy_id=policy.id,
                    simulation_id=simulation.id,
                    payment_type="payout",
                    amount=420.0,
                    currency="INR",
                    razorpay_order_id="order_local_seed",
                    razorpay_payment_id="pay_local_seed",
                    status="success",
                    notes="local bootstrap payout",
                )
            )

        pool = (
            await session.execute(
                select(ZonePoolBalance).where(ZonePoolBalance.zone_id == "hyd_central").order_by(ZonePoolBalance.id.desc()).limit(1)
            )
        ).scalar_one_or_none()
        if pool is None:
            session.add(
                ZonePoolBalance(
                    zone_id="hyd_central",
                    week_start=now - timedelta(days=now.weekday()),
                    pool_balance_start_of_week=125000.0,
                    total_premiums_collected=125000.0,
                    total_payouts_this_week=420.0,
                    total_payouts_disbursed=420.0,
                    current_balance=124580.0,
                    utilization_pct=0.34,
                    loss_ratio=0.0034,
                    flagged_reinsurance=False,
                    risk_note="local bootstrap pool",
                )
            )

        await session.commit()


def get_engine() -> Any:
    return engine


def sqlite_uses_memory_fallback() -> bool:
    return SQLITE_MEMORY_FALLBACK
