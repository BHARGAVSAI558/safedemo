from __future__ import annotations

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db.base import Base


class WeeklySummary(Base):
    __tablename__ = "weekly_summaries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"), index=True, nullable=False)
    week_start: Mapped[DateTime] = mapped_column(DateTime(timezone=True), index=True, nullable=False)
    hours_protected: Mapped[float] = mapped_column(Float, default=0.0)
    disruptions_in_zone: Mapped[int] = mapped_column(Integer, default=0)
    payout_inr: Mapped[float] = mapped_column(Float, default=0.0)
    premium_peace_inr: Mapped[float] = mapped_column(Float, default=0.0)
    zone_risk_next_week: Mapped[str] = mapped_column(String(16), default="MEDIUM")
    trust_delta_points: Mapped[int] = mapped_column(Integer, default=0)
    title: Mapped[str] = mapped_column(String(160), default="Your SafeNet Week in Review")
    body: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now())
