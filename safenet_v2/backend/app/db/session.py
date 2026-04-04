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
    url = settings.async_database_url
    if settings.is_sqlite:
        # SQLite: single shared connection, no pool sizing
        return create_async_engine(
            url,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
            echo=False,
        )
    # PostgreSQL
    return create_async_engine(
        url,
        pool_pre_ping=True,
        pool_size=10,
        max_overflow=20,
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
            await conn.execute(text("ALTER TABLE policies ADD COLUMN IF NOT EXISTS weekly_premium FLOAT DEFAULT 0.0"))


def get_engine() -> Any:
    return engine
