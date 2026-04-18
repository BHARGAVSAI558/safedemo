from __future__ import annotations

from sqlalchemy import DateTime, Float, Integer
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db.base import Base


class PoolHealthWeeklySnapshot(Base):
    """Persisted pool health metrics for the ISO week (IST-aligned week_start stored in UTC)."""

    __tablename__ = "pool_health_weekly_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    week_start: Mapped[DateTime] = mapped_column(DateTime(timezone=True), unique=True, index=True, nullable=False)
    total_weekly_premiums_booked: Mapped[float] = mapped_column(Float, default=0.0)
    total_payouts_week: Mapped[float] = mapped_column(Float, default=0.0)
    loss_ratio: Mapped[float] = mapped_column(Float, default=0.0)
    reserve_pool_total: Mapped[float] = mapped_column(Float, default=0.0)
    estimated_next_week_payout: Mapped[float] = mapped_column(Float, default=0.0)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now())
