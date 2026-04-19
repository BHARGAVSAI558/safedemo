from typing import Optional

from sqlalchemy import DateTime, Float, Integer, String
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db.base import Base


class Zone(Base):
    __tablename__ = "zones"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    city_code: Mapped[str] = mapped_column(String(32), unique=True, index=True, nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    city: Mapped[str] = mapped_column(String(100), default="Hyderabad")
    lat: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    lng: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    flood_risk_score: Mapped[float] = mapped_column(Float, default=0.5)
    heat_risk_score: Mapped[float] = mapped_column(Float, default=0.5)
    aqi_risk_score: Mapped[float] = mapped_column(Float, default=0.5)
    zone_risk_multiplier: Mapped[float] = mapped_column(Float, default=1.0)
    risk_tier: Mapped[str] = mapped_column(String(32), default="medium")
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # Dual-gate / order proxy
    zone_radius_km: Mapped[float] = mapped_column(Float, default=15.0)
    zone_baseline_orders: Mapped[float] = mapped_column(Float, default=100.0)
    orders_last_hour: Mapped[float] = mapped_column(Float, default=85.0)

    # Risk mode engine
    total_registered_workers: Mapped[int] = mapped_column(Integer, default=0)
    current_online_workers: Mapped[int] = mapped_column(Integer, default=0)
    risk_score: Mapped[int] = mapped_column(Integer, default=0)
    risk_mode: Mapped[str] = mapped_column(String(32), default="NORMAL")
    risk_mode_updated_at: Mapped[Optional[DateTime]] = mapped_column(DateTime(timezone=True), nullable=True)
