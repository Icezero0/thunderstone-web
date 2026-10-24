"""Persist frozen setup requests, authoritative matches and command receipts."""

from alembic import op
import sqlalchemy as sa

revision = "0004_persistent_matches"
down_revision = "0003_waiting_rooms"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table("matches",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("room_id", sa.String(32), sa.ForeignKey("rooms.id"), nullable=False),
        sa.Column("host_user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("frozen_players", sa.JSON(), nullable=False),
        sa.Column("setup_request", sa.JSON(), nullable=False),
        sa.Column("setup_choice", sa.JSON(), nullable=True),
        sa.Column("state", sa.JSON(), nullable=True),
        sa.Column("events", sa.JSON(), nullable=False),
        sa.Column("catalog_snapshot", sa.JSON(), nullable=False),
        sa.Column("engine_version", sa.String(64), nullable=False),
        sa.Column("effects_version", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("status IN ('setup_pending', 'active', 'cancelled')", name="ck_match_status"),
        sa.CheckConstraint("version > 0", name="ck_match_version"))
    op.create_index("ix_matches_room_id", "matches", ["room_id"])
    op.create_table("match_commands",
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), primary_key=True),
        sa.Column("command_id", sa.String(128), primary_key=True),
        sa.Column("operation", sa.String(16), nullable=False),
        sa.Column("resource_id", sa.String(32), nullable=False),
        sa.Column("payload_hash", sa.String(64), nullable=False),
        sa.Column("match_id", sa.String(32), sa.ForeignKey("matches.id"), nullable=False),
        sa.Column("response_view", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False))
    op.create_index("ix_match_commands_match_id", "match_commands", ["match_id"])
    with op.batch_alter_table("rooms") as batch:
        batch.drop_constraint("ck_room_status", type_="check")
        batch.create_check_constraint("ck_room_status", "status IN ('waiting', 'playing', 'closed')")
        batch.add_column(sa.Column("active_match_id", sa.String(32), nullable=True))
        batch.create_foreign_key("fk_room_active_match", "matches", ["active_match_id"], ["id"])


def downgrade() -> None:
    # A downgrade preserves waiting-room memberships and removes only matches.
    op.execute("UPDATE rooms SET status='waiting', active_match_id=NULL WHERE status='playing'")
    with op.batch_alter_table("rooms") as batch:
        batch.drop_constraint("fk_room_active_match", type_="foreignkey")
        batch.drop_column("active_match_id")
        batch.drop_constraint("ck_room_status", type_="check")
        batch.create_check_constraint("ck_room_status", "status IN ('waiting', 'closed')")
    op.drop_index("ix_match_commands_match_id", table_name="match_commands")
    op.drop_table("match_commands")
    op.drop_index("ix_matches_room_id", table_name="matches")
    op.drop_table("matches")
