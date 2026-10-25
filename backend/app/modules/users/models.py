"""Persistent user account, derived from iCinema's user model."""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String, func, false
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.db.base import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    username: Mapped[str | None] = mapped_column(String(64), nullable=True)
    avatar_key: Mapped[str | None] = mapped_column(String(128), nullable=True)
    auto_sort_hand: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false(), nullable=False)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    token_version: Mapped[int] = mapped_column(Integer, default=0, server_default="0", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    @property
    def avatar_url(self) -> str | None:
        from backend.app.modules.users.presentation import avatar_url
        return avatar_url(self.avatar_key)
