"""Persistent waiting rooms and their player lists."""

from alembic import op
import sqlalchemy as sa

revision = "0003_waiting_rooms"
down_revision = "0002_card_catalog"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table("rooms",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("name", sa.String(64), nullable=False),
        sa.Column("host_user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("config_version", sa.Integer(), nullable=False),
        sa.Column("config", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("status IN ('waiting', 'closed')", name="ck_room_status"),
        sa.CheckConstraint("version > 0 AND config_version > 0", name="ck_room_versions"))
    op.create_table("room_players",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("room_id", sa.String(32), sa.ForeignKey("rooms.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("ready_config_version", sa.Integer()),
        sa.Column("joined_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("user_id"))
    op.create_index("ix_room_players_room_id", "room_players", ["room_id"])


def downgrade() -> None:
    op.drop_index("ix_room_players_room_id", table_name="room_players")
    op.drop_table("room_players")
    op.drop_table("rooms")
