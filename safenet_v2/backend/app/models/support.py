from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db.base import Base


class SupportQuery(Base):
    __tablename__ = "support_queries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"), index=True, nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    translated_text: Mapped[str] = mapped_column(Text, default="", nullable=False)
    query_type: Mapped[str] = mapped_column(String(24), default="custom", nullable=False)
    priority: Mapped[str] = mapped_column(String(16), default="LOW", index=True, nullable=False)
    category: Mapped[str] = mapped_column(String(24), default="other", index=True, nullable=False)
    score: Mapped[int] = mapped_column(Integer, default=0, index=True, nullable=False)
    reason: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    system_response: Mapped[str] = mapped_column(Text, default="", nullable=False)
    admin_reply: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="open", index=True, nullable=False)
    created_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), onupdate=func.now())

