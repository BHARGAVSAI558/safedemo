import asyncio
from collections.abc import AsyncGenerator
from typing import Any

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.core.config import settings
from app.db.base import Base


def _make_engine():
    """SQLite (file) vs PostgreSQL (pooled); mirrors Render `postgres://` DSN handling."""
    database_url = settings.DATABASE_URL
    if database_url.startswith("postgres://"):
        database_url = database_url.replace("postgres://", "postgresql+asyncpg://", 1)

    if database_url.startswith("sqlite"):
        if "+aiosqlite" not in database_url:
            database_url = database_url.replace("sqlite://", "sqlite+aiosqlite://", 1)
        return create_async_engine(
            database_url,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
            echo=False,
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
            await conn.execute(text("ALTER TABLE profiles ADD COLUMN IF NOT EXISTS platform VARCHAR(32)"))
            await conn.execute(text("ALTER TABLE profiles ADD COLUMN IF NOT EXISTS zone_id VARCHAR(64)"))
            await conn.execute(text("ALTER TABLE profiles ADD COLUMN IF NOT EXISTS working_hours_preset VARCHAR(64)"))
            await conn.execute(text("ALTER TABLE profiles ADD COLUMN IF NOT EXISTS coverage_tier VARCHAR(32)"))
            await conn.execute(text("ALTER TABLE profiles ADD COLUMN IF NOT EXISTS risk_score DOUBLE PRECISION"))
            await conn.execute(text("ALTER TABLE profiles ADD COLUMN IF NOT EXISTS weekly_premium DOUBLE PRECISION"))
            await conn.execute(text("ALTER TABLE policies ADD COLUMN IF NOT EXISTS weekly_premium FLOAT DEFAULT 0.0"))
            await conn.execute(text("ALTER TABLE policies ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ"))
            await conn.execute(text("ALTER TABLE policies ADD COLUMN IF NOT EXISTS valid_until TIMESTAMPTZ"))
        else:
            for stmt in (
                "ALTER TABLE profiles ADD COLUMN risk_score FLOAT",
                "ALTER TABLE profiles ADD COLUMN weekly_premium FLOAT",
                "ALTER TABLE policies ADD COLUMN valid_from DATETIME",
                "ALTER TABLE policies ADD COLUMN valid_until DATETIME",
            ):
                try:
                    await conn.execute(text(stmt))
                except Exception:
                    pass


def get_engine() -> Any:
    return engine
