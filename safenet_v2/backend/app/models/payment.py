"""
Payment Model
-------------
Tracks both premium collection and payout disbursement.
Separate from PayoutRecord (which is claim-specific).
"""
from typing import Optional

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db.base import Base


class Payment(Base):
    """
    Universal payment record for both premium collection and payout disbursement.
    Tracks full Razorpay lifecycle with idempotency guards.
    """
    __tablename__ = "payments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"), index=True, nullable=False)
    policy_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("policies.id"), nullable=True)
    simulation_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("simulations.id"), nullable=True)
    
    payment_type: Mapped[str] = mapped_column(String(32), index=True, nullable=False)  # premium_collection / payout
    amount: Mapped[float] = mapped_column(Float, nullable=False)
    currency: Mapped[str] = mapped_column(String(8), default="INR")
    
    # Razorpay fields
    razorpay_order_id: Mapped[Optional[str]] = mapped_column(String(128), unique=True, index=True, nullable=True)
    razorpay_payment_id: Mapped[Optional[str]] = mapped_column(String(128), index=True, nullable=True)
    razorpay_signature: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    
    # Payment state machine
    status: Mapped[str] = mapped_column(String(32), index=True, default="pending")  # pending / processing / success / failed
    
    # Audit trail
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[Optional[DateTime]] = mapped_column(DateTime(timezone=True), onupdate=func.now())
