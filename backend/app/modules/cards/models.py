"""SQLite card definitions and their imported catalog revision."""

from datetime import datetime

from sqlalchemy import (Boolean, CheckConstraint, DateTime, ForeignKey, Index,
                        Integer, String, Text, func)
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.db.base import Base


class CardDefinition(Base):
    __tablename__ = "card_definitions"
    __table_args__ = (
        CheckConstraint("slot_kind IN ('front', 'reference', 'back')", name="ck_card_slot_kind"),
        CheckConstraint("initial_copy_count IS NULL OR initial_copy_count > 0",
                        name="ck_card_initial_copy_count"),
        Index("ix_cards_type_subcategory", "card_type", "subcategory"),
    )

    card_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    source_card_id: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    catalog_order: Mapped[int] = mapped_column(Integer, unique=True, nullable=False)
    slot_kind: Mapped[str] = mapped_column(String(16), nullable=False)
    tts_card_id: Mapped[int | None] = mapped_column(Integer)
    tts_copy_count: Mapped[int] = mapped_column(Integer, nullable=False)
    initial_copy_count: Mapped[int | None] = mapped_column(Integer)
    deck_id: Mapped[str] = mapped_column(String(8), nullable=False)
    source_row: Mapped[int] = mapped_column(Integer, nullable=False)
    source_column: Mapped[int] = mapped_column(Integer, nullable=False)
    card_type: Mapped[str | None] = mapped_column(String(32))
    subcategory: Mapped[str | None] = mapped_column(String(64))
    hero_series_status: Mapped[str | None] = mapped_column(String(32))
    hero_series_size: Mapped[int | None] = mapped_column(Integer)
    name: Mapped[str | None] = mapped_column(Text)
    waist_text: Mapped[str | None] = mapped_column(Text)
    tags_text: Mapped[str | None] = mapped_column(Text)
    effect_text: Mapped[str | None] = mapped_column(Text)
    other_text: Mapped[str | None] = mapped_column(Text)
    review_status: Mapped[str] = mapped_column(String(32), nullable=False)
    review_reasons: Mapped[str | None] = mapped_column(Text)
    legacy_edited: Mapped[bool] = mapped_column(Boolean, nullable=False)
    image_path: Mapped[str] = mapped_column(Text, nullable=False)
    english_image_path: Mapped[str] = mapped_column(Text, nullable=False)
    clean_image_path: Mapped[str] = mapped_column(Text, nullable=False)
    english_name: Mapped[str | None] = mapped_column(Text)
    wiki_expansion: Mapped[str | None] = mapped_column(Text)
    purchase_cost: Mapped[int | None] = mapped_column(Integer)
    gold_value: Mapped[int | None] = mapped_column(Integer)
    light_value: Mapped[int | None] = mapped_column(Integer)
    weight_value: Mapped[int | None] = mapped_column(Integer)
    hero_level: Mapped[int | None] = mapped_column(Integer)
    strength_value: Mapped[int | None] = mapped_column(Integer)
    health_value: Mapped[int | None] = mapped_column(Integer)
    printed_xp: Mapped[int | None] = mapped_column(Integer)
    victory_points: Mapped[int | None] = mapped_column(Integer)
    base_attack: Mapped[int | None] = mapped_column(Integer)
    base_magic_attack: Mapped[int | None] = mapped_column(Integer)
    printed_symbols: Mapped[str | None] = mapped_column(Text)
    wiki_match_status: Mapped[str] = mapped_column(Text, nullable=False)
    wiki_data_note: Mapped[str | None] = mapped_column(Text)
    wiki_source_url: Mapped[str | None] = mapped_column(Text)
    upgrade_xp_cost: Mapped[int | None] = mapped_column(Integer)
    defeat_xp_reward: Mapped[int | None] = mapped_column(Integer)
    wiki_review_status: Mapped[str] = mapped_column(String(32), nullable=False)
    wiki_review_note: Mapped[str | None] = mapped_column(Text)
    review_note: Mapped[str | None] = mapped_column(Text)


class CardTag(Base):
    __tablename__ = "card_tags"
    __table_args__ = (Index("ix_card_tags_tag_card", "tag", "card_id"),)

    card_id: Mapped[str] = mapped_column(
        ForeignKey("card_definitions.card_id", ondelete="CASCADE"), primary_key=True)
    position: Mapped[int] = mapped_column(Integer, primary_key=True)
    tag: Mapped[str] = mapped_column(Text, nullable=False)


class CatalogMeta(Base):
    __tablename__ = "catalog_meta"
    __table_args__ = (CheckConstraint("id = 1", name="ck_catalog_meta_singleton"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    cards_csv_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    setup_schema_version: Mapped[str] = mapped_column(String(64), nullable=False)
    setup_index_json: Mapped[str] = mapped_column(Text, nullable=False)
    card_count: Mapped[int] = mapped_column(Integer, nullable=False)
    imported_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),
                                                   server_default=func.now(), nullable=False)
