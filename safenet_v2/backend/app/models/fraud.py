from typing import TYPE_CHECKING

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.sql import func

from app.db.base import Base

if TYPE_CHECKING:
    from app.models.claim import Simulation
    from app.models.worker import User


class FraudSignal(Base):
    __tablename__ = "fraud_signals"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"), index=True, nullable=False)
    simulation_id: Mapped[int] = mapped_column(Integer, ForeignKey("simulations.id"), index=True, nullable=False)
    score: Mapped[float] = mapped_column(Float, nullable=False)
    cluster_id: Mapped[str] = mapped_column(String(128), default="", index=True)
    reason_code: Mapped[str] = mapped_column(String(64), default="ASSESSMENT")
    detail: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    user: Mapped["User"] = relationship("User", back_populates="fraud_signals")
    simulation: Mapped["Simulation"] = relationship("Simulation", back_populates="fraud_signals")
