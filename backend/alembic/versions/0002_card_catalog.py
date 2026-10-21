"""Create the runtime card catalog.

Revision ID: 0002_card_catalog
Revises: 0001_users
"""

from alembic import op
import sqlalchemy as sa

revision = "0002_card_catalog"
down_revision = "0001_users"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "card_definitions",
        sa.Column("card_id", sa.String(32), primary_key=True),
        sa.Column("source_card_id", sa.String(128), nullable=False),
        sa.Column("catalog_order", sa.Integer(), nullable=False),
        sa.Column("slot_kind", sa.String(16), nullable=False),
        sa.Column("tts_card_id", sa.Integer()),
        sa.Column("tts_copy_count", sa.Integer(), nullable=False),
        sa.Column("initial_copy_count", sa.Integer()),
        sa.Column("deck_id", sa.String(8), nullable=False),
        sa.Column("source_row", sa.Integer(), nullable=False),
        sa.Column("source_column", sa.Integer(), nullable=False),
        sa.Column("card_type", sa.String(32)),
        sa.Column("subcategory", sa.String(64)),
        sa.Column("hero_series_status", sa.String(32)),
        sa.Column("hero_series_size", sa.Integer()),
        sa.Column("name", sa.Text()),
        sa.Column("waist_text", sa.Text()),
        sa.Column("tags_text", sa.Text()),
        sa.Column("effect_text", sa.Text()),
        sa.Column("other_text", sa.Text()),
        sa.Column("review_status", sa.String(32), nullable=False),
        sa.Column("review_reasons", sa.Text()),
        sa.Column("legacy_edited", sa.Boolean(), nullable=False),
        sa.Column("image_path", sa.Text(), nullable=False),
        sa.Column("english_image_path", sa.Text(), nullable=False),
        sa.Column("clean_image_path", sa.Text(), nullable=False),
        sa.Column("english_name", sa.Text()),
        sa.Column("wiki_expansion", sa.Text()),
        sa.Column("purchase_cost", sa.Integer()),
        sa.Column("gold_value", sa.Integer()),
        sa.Column("light_value", sa.Integer()),
        sa.Column("weight_value", sa.Integer()),
        sa.Column("hero_level", sa.Integer()),
        sa.Column("strength_value", sa.Integer()),
        sa.Column("health_value", sa.Integer()),
        sa.Column("printed_xp", sa.Integer()),
        sa.Column("victory_points", sa.Integer()),
        sa.Column("base_attack", sa.Integer()),
        sa.Column("base_magic_attack", sa.Integer()),
        sa.Column("printed_symbols", sa.Text()),
        sa.Column("wiki_match_status", sa.Text(), nullable=False),
        sa.Column("wiki_data_note", sa.Text()),
        sa.Column("wiki_source_url", sa.Text()),
        sa.Column("upgrade_xp_cost", sa.Integer()),
        sa.Column("defeat_xp_reward", sa.Integer()),
        sa.Column("wiki_review_status", sa.String(32), nullable=False),
        sa.Column("wiki_review_note", sa.Text()),
        sa.Column("review_note", sa.Text()),
        sa.CheckConstraint("slot_kind IN ('front', 'reference', 'back')",
                           name="ck_card_slot_kind"),
        sa.CheckConstraint("initial_copy_count IS NULL OR initial_copy_count > 0",
                           name="ck_card_initial_copy_count"),
        sa.UniqueConstraint("source_card_id"),
        sa.UniqueConstraint("catalog_order"),
    )
    op.create_index("ix_cards_type_subcategory", "card_definitions",
                    ["card_type", "subcategory"])
    op.create_table(
        "card_tags",
        sa.Column("card_id", sa.String(32),
                  sa.ForeignKey("card_definitions.card_id", ondelete="CASCADE"),
                  primary_key=True),
        sa.Column("position", sa.Integer(), primary_key=True),
        sa.Column("tag", sa.Text(), nullable=False),
    )
    op.create_index("ix_card_tags_tag_card", "card_tags", ["tag", "card_id"])
    op.create_table(
        "catalog_meta",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("cards_csv_sha256", sa.String(64), nullable=False),
        sa.Column("setup_schema_version", sa.String(64), nullable=False),
        sa.Column("setup_index_json", sa.Text(), nullable=False),
        sa.Column("card_count", sa.Integer(), nullable=False),
        sa.Column("imported_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("id = 1", name="ck_catalog_meta_singleton"),
    )


def downgrade() -> None:
    op.drop_table("catalog_meta")
    op.drop_index("ix_card_tags_tag_card", table_name="card_tags")
    op.drop_table("card_tags")
    op.drop_index("ix_cards_type_subcategory", table_name="card_definitions")
    op.drop_table("card_definitions")
