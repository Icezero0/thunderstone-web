"""Private authoritative snapshots; API responses use explicit projections."""

from datetime import datetime
from uuid import uuid4

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, JSON, String, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.db.base import Base


class Match(Base):
    __tablename__ = "matches"
    __table_args__ = (
        CheckConstraint("status IN ('setup_pending', 'active', 'cancelled', 'finished')", name="ck_match_status"),
        CheckConstraint("version > 0", name="ck_match_version"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: uuid4().hex)
    room_id: Mapped[str] = mapped_column(ForeignKey("rooms.id"), index=True)
    host_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    history_cursor: Mapped[int | None] = mapped_column(Integer, nullable=True)
    history_epoch: Mapped[int] = mapped_column(Integer, default=0, server_default="0", nullable=False)
    frozen_players: Mapped[list] = mapped_column(JSON, nullable=False)
    setup_request: Mapped[dict] = mapped_column(JSON, nullable=False)
    setup_choice: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    state: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    events: Mapped[list] = mapped_column(JSON, nullable=False)
    presentation: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    catalog_snapshot: Mapped[dict] = mapped_column(JSON, nullable=False)
    engine_version: Mapped[str] = mapped_column(String(64), nullable=False)
    effects_version: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class MatchHistory(Base):
    """Complete state checkpoints plus per-step events; parents retain alternate branches."""

    __tablename__ = "match_history"
    match_id: Mapped[str] = mapped_column(ForeignKey("matches.id"), primary_key=True)
    step: Mapped[int] = mapped_column(Integer, primary_key=True)
    parent_step: Mapped[int | None] = mapped_column(Integer, nullable=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    label: Mapped[str] = mapped_column(String(160), nullable=False)
    turn_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    snapshot: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class MatchCommand(Base):
    """Retries return the same user's accepted response without repeating setup."""

    __tablename__ = "match_commands"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), primary_key=True)
    command_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    operation: Mapped[str] = mapped_column(String(16), nullable=False)
    resource_id: Mapped[str] = mapped_column(String(32), nullable=False)
    payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    match_id: Mapped[str] = mapped_column(ForeignKey("matches.id"), index=True)
    response_view: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
