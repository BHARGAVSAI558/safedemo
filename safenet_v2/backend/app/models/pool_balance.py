from __future__ import annotations

from sqlalchemy import DateTime, Float, Integer, String
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db.base import Base


class ZonePoolBalance(Base):
    __tablename__ = "zone_pool_balances"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    zone_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    week_start: Mapped[DateTime] = mapped_column(DateTime(timezone=True), index=True, nullable=False)
    pool_balance_start_of_week: Mapped[float] = mapped_column(Float, default=0.0)
    total_payouts_this_week: Mapped[float] = mapped_column(Float, default=0.0)
    utilization_pct: Mapped[float] = mapped_column(Float, default=0.0)
    flagged_reinsurance: Mapped[bool] = mapped_column(default=False)
    risk_note: Mapped[str] = mapped_column(String(256), default="")
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now())

