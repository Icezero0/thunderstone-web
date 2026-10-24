"""Room membership is a player list; it does not represent seats."""

from datetime import datetime
from uuid import uuid4

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Integer, JSON, String, func, true
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.db.base import Base


class Room(Base):
    __tablename__ = "rooms"
    __table_args__ = (
        CheckConstraint("status IN ('waiting', 'playing', 'closed')", name="ck_room_status"),
        CheckConstraint("version > 0 AND config_version > 0", name="ck_room_versions"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: uuid4().hex)
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    is_public: Mapped[bool] = mapped_column(Boolean, default=True, server_default=true(), nullable=False)
    host_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="waiting", nullable=False)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    config_version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    config: Mapped[dict] = mapped_column(JSON, nullable=False)
    active_match_id: Mapped[str | None] = mapped_column(ForeignKey("matches.id", name="fk_room_active_match"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class RoomPlayer(Base):
    __tablename__ = "room_players"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    room_id: Mapped[str] = mapped_column(ForeignKey("rooms.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), unique=True, nullable=False)
    ready_config_version: Mapped[int | None] = mapped_column(Integer)
    joined_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
