"""Store the current avatar key independently from game state."""

from alembic import op
import sqlalchemy as sa

revision = "0006_user_avatars"
down_revision = "0005_finished_matches"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("avatar_key", sa.String(128), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "avatar_key")
