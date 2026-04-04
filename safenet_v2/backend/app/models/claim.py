import enum
from typing import TYPE_CHECKING, List, Optional

from sqlalchemy import Boolean, DateTime, Enum, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.sql import func

from app.db.base import Base

if TYPE_CHECKING:
    from app.models.fraud import FraudSignal
    from app.models.payout import PayoutRecord
    from app.models.worker import User


class DecisionType(str, enum.Enum):
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    FRAUD = "FRAUD"


class Simulation(Base):
    __tablename__ = "simulations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False)
    fraud_flag: Mapped[bool] = mapped_column(Boolean, default=False)
    fraud_score: Mapped[float] = mapped_column(Float, default=0.0)
    weather_disruption: Mapped[bool] = mapped_column(Boolean, default=False)
    traffic_disruption: Mapped[bool] = mapped_column(Boolean, default=False)
    event_disruption: Mapped[bool] = mapped_column(Boolean, default=False)
    final_disruption: Mapped[bool] = mapped_column(Boolean, default=False)
    expected_income: Mapped[float] = mapped_column(Float, nullable=False)
    actual_income: Mapped[float] = mapped_column(Float, nullable=False)
    loss: Mapped[float] = mapped_column(Float, nullable=False)
    payout: Mapped[float] = mapped_column(Float, default=0.0)
    decision: Mapped[DecisionType] = mapped_column(Enum(DecisionType), nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    weather_data: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[DateTime]] = mapped_column(DateTime(timezone=True), server_default=func.now())

    user: Mapped["User"] = relationship("User", back_populates="simulations")
    fraud_signals: Mapped[List["FraudSignal"]] = relationship("FraudSignal", back_populates="simulation")
    payout_records: Mapped[List["PayoutRecord"]] = relationship("PayoutRecord", back_populates="simulation")


class Log(Base):
    __tablename__ = "logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("users.id"), nullable=True)
    event_type: Mapped[str] = mapped_column(String(50), nullable=False)
    detail: Mapped[Optional[str]] = mapped_column(Text)
    ip_address: Mapped[Optional[str]] = mapped_column(String(50))
    created_at: Mapped[Optional[DateTime]] = mapped_column(DateTime(timezone=True), server_default=func.now())

    user: Mapped[Optional["User"]] = relationship("User", back_populates="logs")


class ClaimLifecycle(Base):
    __tablename__ = "claim_lifecycles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    claim_id: Mapped[str] = mapped_column(String(128), unique=True, index=True, nullable=False)
    correlation_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"), index=True, nullable=False)
    zone_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    disruption_type: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    status: Mapped[str] = mapped_column(String(32), index=True, default="INITIATED")
    message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    payout_amount: Mapped[float] = mapped_column(Float, default=0.0)
    error_detail: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[Optional[DateTime]] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[Optional[DateTime]] = mapped_column(DateTime(timezone=True), onupdate=func.now())
