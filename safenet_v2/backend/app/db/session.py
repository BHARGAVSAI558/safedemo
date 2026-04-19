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
    """SQLite (file) vs PostgreSQL (pooled); DSN comes from env via Settings.async_database_url."""
    url = settings.async_database_url
    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql+asyncpg://", 1)

    if url.startswith("sqlite"):
        sqlite_url, connect_args, engine_kwargs = _sqlite_database_url_and_connect_args(url)
        return create_async_engine(
            sqlite_url,
            connect_args=connect_args,
            echo=False,
            **engine_kwargs,
        )

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
                "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_api_call TIMESTAMPTZ",
                "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ",
                "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_known_lat DOUBLE PRECISION",
                "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_known_lng DOUBLE PRECISION",
                "ALTER TABLE zones ADD COLUMN IF NOT EXISTS zone_radius_km DOUBLE PRECISION DEFAULT 15",
                "ALTER TABLE zones ADD COLUMN IF NOT EXISTS zone_baseline_orders DOUBLE PRECISION DEFAULT 100",
                "ALTER TABLE zones ADD COLUMN IF NOT EXISTS orders_last_hour DOUBLE PRECISION DEFAULT 85",
                "ALTER TABLE zones ADD COLUMN IF NOT EXISTS total_registered_workers INTEGER DEFAULT 0",
                "ALTER TABLE zones ADD COLUMN IF NOT EXISTS current_online_workers INTEGER DEFAULT 0",
                "ALTER TABLE zones ADD COLUMN IF NOT EXISTS risk_score INTEGER DEFAULT 0",
                "ALTER TABLE zones ADD COLUMN IF NOT EXISTS risk_mode VARCHAR(32) DEFAULT 'NORMAL'",
                "ALTER TABLE zones ADD COLUMN IF NOT EXISTS risk_mode_updated_at TIMESTAMPTZ",
                "ALTER TABLE claim_lifecycles ADD COLUMN IF NOT EXISTS gate1_passed BOOLEAN DEFAULT FALSE",
                "ALTER TABLE claim_lifecycles ADD COLUMN IF NOT EXISTS gate1_source VARCHAR(128)",
                "ALTER TABLE claim_lifecycles ADD COLUMN IF NOT EXISTS gate1_value VARCHAR(512)",
                "ALTER TABLE claim_lifecycles ADD COLUMN IF NOT EXISTS gate2_passed BOOLEAN DEFAULT FALSE",
                "ALTER TABLE claim_lifecycles ADD COLUMN IF NOT EXISTS gate2_signals JSONB",
                "ALTER TABLE claim_lifecycles ADD COLUMN IF NOT EXISTS gate2_failure_reason TEXT",
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS canonical_hash VARCHAR(64)",
                "CREATE UNIQUE INDEX IF NOT EXISTS ix_users_canonical_hash ON users (canonical_hash) WHERE canonical_hash IS NOT NULL",
                "ALTER TABLE simulations ADD COLUMN IF NOT EXISTS ai_explanation TEXT",
                "ALTER TABLE simulations ADD COLUMN IF NOT EXISTS dispute_worker_text TEXT",
                "ALTER TABLE simulations ADD COLUMN IF NOT EXISTS dispute_verdict JSONB",
                "ALTER TABLE simulations ADD COLUMN IF NOT EXISTS gate1_passed BOOLEAN DEFAULT TRUE",
                "ALTER TABLE simulations ADD COLUMN IF NOT EXISTS gate1_source VARCHAR(128)",
                "ALTER TABLE simulations ADD COLUMN IF NOT EXISTS gate1_value VARCHAR(512)",
                "ALTER TABLE simulations ADD COLUMN IF NOT EXISTS gate2_passed BOOLEAN DEFAULT TRUE",
                "ALTER TABLE simulations ADD COLUMN IF NOT EXISTS gate2_signals JSONB",
                "ALTER TABLE claim_lifecycles ADD COLUMN IF NOT EXISTS ai_explanation TEXT",
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
                "ALTER TABLE profiles ADD COLUMN last_api_call DATETIME",
                "ALTER TABLE profiles ADD COLUMN last_seen DATETIME",
                "ALTER TABLE profiles ADD COLUMN last_known_lat FLOAT",
                "ALTER TABLE profiles ADD COLUMN last_known_lng FLOAT",
                "ALTER TABLE zones ADD COLUMN zone_radius_km FLOAT DEFAULT 15",
                "ALTER TABLE zones ADD COLUMN zone_baseline_orders FLOAT DEFAULT 100",
                "ALTER TABLE zones ADD COLUMN orders_last_hour FLOAT DEFAULT 85",
                "ALTER TABLE zones ADD COLUMN total_registered_workers INTEGER DEFAULT 0",
                "ALTER TABLE zones ADD COLUMN current_online_workers INTEGER DEFAULT 0",
                "ALTER TABLE zones ADD COLUMN risk_score INTEGER DEFAULT 0",
                "ALTER TABLE zones ADD COLUMN risk_mode VARCHAR(32) DEFAULT 'NORMAL'",
                "ALTER TABLE zones ADD COLUMN risk_mode_updated_at DATETIME",
                "ALTER TABLE claim_lifecycles ADD COLUMN gate1_passed BOOLEAN DEFAULT 0",
                "ALTER TABLE claim_lifecycles ADD COLUMN gate1_source VARCHAR(128)",
                "ALTER TABLE claim_lifecycles ADD COLUMN gate1_value VARCHAR(512)",
                "ALTER TABLE claim_lifecycles ADD COLUMN gate2_passed BOOLEAN DEFAULT 0",
                "ALTER TABLE claim_lifecycles ADD COLUMN gate2_signals TEXT",
                "ALTER TABLE claim_lifecycles ADD COLUMN gate2_failure_reason TEXT",
                "ALTER TABLE users ADD COLUMN canonical_hash VARCHAR(64)",
                "CREATE UNIQUE INDEX IF NOT EXISTS ix_users_canonical_hash ON users (canonical_hash)",
                "ALTER TABLE simulations ADD COLUMN ai_explanation TEXT",
                "ALTER TABLE simulations ADD COLUMN dispute_worker_text TEXT",
                "ALTER TABLE simulations ADD COLUMN dispute_verdict TEXT",
                "ALTER TABLE simulations ADD COLUMN gate1_passed BOOLEAN DEFAULT 1",
                "ALTER TABLE simulations ADD COLUMN gate1_source VARCHAR(128)",
                "ALTER TABLE simulations ADD COLUMN gate1_value VARCHAR(512)",
                "ALTER TABLE simulations ADD COLUMN gate2_passed BOOLEAN DEFAULT 1",
                "ALTER TABLE simulations ADD COLUMN gate2_signals TEXT",
                "ALTER TABLE claim_lifecycles ADD COLUMN ai_explanation TEXT",
            ]
            for stmt in sqlite_stmts:
                try:
                    await conn.execute(text(stmt))
                except Exception:
                    pass

async def _seed_zones() -> None:
    """Delegate to seed_db.reference zone seeding (single source of truth)."""
    from seed_db import seed_zones

    await seed_zones()


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
            from app.utils.canonical_id import generate_canonical_hash

            user = User(
                phone="9000000010",
                is_active=True,
                is_admin=False,
                canonical_hash=generate_canonical_hash("9000000010"),
            )
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
