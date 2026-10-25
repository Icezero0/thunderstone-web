"""Persist match checkpoints and a monotonic presentation reset epoch."""
from alembic import op
import sqlalchemy as sa

revision = "0009_match_history"
down_revision = "0008_hand_sort_preference"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("matches", sa.Column("history_cursor", sa.Integer(), nullable=True))
    op.add_column("matches", sa.Column("history_epoch", sa.Integer(), nullable=False, server_default="0"))
    op.create_table("match_history",
        sa.Column("match_id", sa.String(32), sa.ForeignKey("matches.id"), primary_key=True),
        sa.Column("step", sa.Integer(), primary_key=True),
        sa.Column("parent_step", sa.Integer(), nullable=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("label", sa.String(160), nullable=False),
        sa.Column("turn_number", sa.Integer(), nullable=True),
        sa.Column("snapshot", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()))


def downgrade():
    op.drop_table("match_history")
    op.drop_column("matches", "history_epoch")
    op.drop_column("matches", "history_cursor")
