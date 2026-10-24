"""Keep private rooms out of the public recruitment list."""

from alembic import op
import sqlalchemy as sa

revision = "0007_room_visibility"
down_revision = "0006_user_avatars"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("rooms", sa.Column("is_public", sa.Boolean(), nullable=False, server_default=sa.true()))


def downgrade() -> None:
    op.drop_column("rooms", "is_public")
