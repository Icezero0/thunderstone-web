"""Track disclosure state; new checkpoints store event batches, legacy rows remain readable."""
from alembic import op
import sqlalchemy as sa

revision = "0010_match_event_batches"
down_revision = "0009_match_history"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("matches", sa.Column("presentation", sa.JSON(), nullable=True))


def downgrade():
    op.drop_column("matches", "presentation")
