from __future__ import annotations

from sqlalchemy import Float, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class ZoneActuarialSettings(Base):
    """Per pool-zone actuarial load (matches ZonePoolBalance.zone_id strings)."""

    __tablename__ = "zone_actuarial_settings"

    pool_zone_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    actuarial_load_factor: Mapped[float] = mapped_column(Float, default=1.0)
    premium_increases_this_quarter: Mapped[int] = mapped_column(Integer, default=0)
    actuarial_quarter_key: Mapped[str] = mapped_column(String(16), default="")
