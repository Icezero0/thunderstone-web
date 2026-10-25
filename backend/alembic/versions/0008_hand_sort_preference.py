"""Persist the account's automatic hand sorting preference."""

from alembic import op
import sqlalchemy as sa

revision = "0008_hand_sort_preference"
down_revision = "0007_room_visibility"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("auto_sort_hand", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    op.drop_column("users", "auto_sort_hand")
