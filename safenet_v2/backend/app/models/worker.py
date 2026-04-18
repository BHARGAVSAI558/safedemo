import enum
from typing import TYPE_CHECKING, List, Optional

from sqlalchemy import Boolean, DateTime, Enum, Float, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.sql import func

from app.db.base import Base

if TYPE_CHECKING:
    from app.models.claim import Log, Simulation
    from app.models.fraud import FraudFlag, FraudSignal
    from app.models.policy import Policy


class OccupationType(str, enum.Enum):
    delivery = "delivery"
    driver = "driver"
    freelancer = "freelancer"
    other = "other"


class RiskProfile(str, enum.Enum):
    low = "low"
    medium = "medium"
    high = "high"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    phone: Mapped[str] = mapped_column(String(15), unique=True, nullable=False, index=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[Optional[DateTime]] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[Optional[DateTime]] = mapped_column(DateTime(timezone=True), onupdate=func.now())

    profile: Mapped[Optional["Profile"]] = relationship("Profile", back_populates="user", uselist=False)
    simulations: Mapped[List["Simulation"]] = relationship("Simulation", back_populates="user")
    logs: Mapped[List["Log"]] = relationship("Log", back_populates="user")
    policies: Mapped[List["Policy"]] = relationship("Policy", back_populates="user")
    fraud_signals: Mapped[List["FraudSignal"]] = relationship("FraudSignal", back_populates="user")


class Profile(Base):
    __tablename__ = "profiles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    city: Mapped[str] = mapped_column(String(100), default="Hyderabad")
    occupation: Mapped[OccupationType] = mapped_column(Enum(OccupationType), default=OccupationType.delivery)
    avg_daily_income: Mapped[float] = mapped_column(Float, default=1000.0)
    risk_profile: Mapped[RiskProfile] = mapped_column(Enum(RiskProfile), default=RiskProfile.medium)
    trust_score: Mapped[float] = mapped_column(Float, default=0.0)
    total_claims: Mapped[int] = mapped_column(Integer, default=0)
    total_payouts: Mapped[float] = mapped_column(Float, default=0.0)
    platform: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    zone_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    location_display: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    working_hours_preset: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    coverage_tier: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    risk_score: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    weekly_premium: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    active_hours_per_day: Mapped[float] = mapped_column(Float, default=8.0)
    avg_daily_earnings: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    bank_account_number: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    bank_ifsc: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    bank_upi_id: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    bank_account_name: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    created_at: Mapped[Optional[DateTime]] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[Optional[DateTime]] = mapped_column(DateTime(timezone=True), onupdate=func.now())

    user: Mapped["User"] = relationship("User", back_populates="profile")


class EarningsDNA(Base):
    """7×24 hourly earning fingerprint per worker."""
    __tablename__ = "earnings_dna"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"), index=True, nullable=False)
    day_of_week: Mapped[int] = mapped_column(Integer, nullable=False)   # 0=Monday … 6=Sunday
    hour_of_day: Mapped[int] = mapped_column(Integer, nullable=False)   # 0–23
    expected_hourly_rate: Mapped[float] = mapped_column(Float, default=0.0)  # INR/hr for this slot
    updated_at: Mapped[Optional[DateTime]] = mapped_column(DateTime(timezone=True), onupdate=func.now())
