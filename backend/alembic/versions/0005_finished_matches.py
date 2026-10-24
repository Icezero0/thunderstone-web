"""Keep completed matches after releasing their rooms for another game."""

from alembic import op

revision = "0005_finished_matches"
down_revision = "0004_persistent_matches"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("matches") as batch:
        batch.drop_constraint("ck_match_status", type_="check")
        batch.create_check_constraint("ck_match_status", "status IN ('setup_pending', 'active', 'cancelled', 'finished')")


def downgrade() -> None:
    # Preserve historical snapshots/results even when the older API cannot label
    # a finished game separately from a closed one.
    op.execute("UPDATE matches SET status='cancelled' WHERE status='finished'")
    with op.batch_alter_table("matches") as batch:
        batch.drop_constraint("ck_match_status", type_="check")
        batch.create_check_constraint("ck_match_status", "status IN ('setup_pending', 'active', 'cancelled')")
