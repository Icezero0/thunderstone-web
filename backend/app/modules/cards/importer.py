"""Explicit, atomic CSV and setup-index import into SQLite."""

import csv
import json
from pathlib import Path

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.integrations.game_engine.catalog.repository import CatalogSnapshot, load_catalog

from backend.app.core.paths import PROJECT_ROOT
from backend.app.modules.cards.mapping import (BOOLEAN_FIELDS, CSV_TO_DB,
                                               INTEGER_FIELDS, REQUIRED_FIELDS)
from backend.app.modules.cards.models import CardDefinition, CardTag, CatalogMeta
from backend.app.modules.cards.repository import load_catalog_snapshot


def _read_source(root: Path) -> CatalogSnapshot:
    with (root / "cards" / "cards.csv").open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames != list(CSV_TO_DB):
            raise ValueError("cards.csv columns do not match the SQLite import mapping")
        rows = list(reader)
    snapshot = load_catalog(root)
    if len(rows) != len(snapshot.cards):
        raise ValueError("cards.csv contains duplicate card_id values")
    ids = [row["card_id"] for row in rows]
    orders = [int(row["catalog_order"]) for row in rows]
    if len(ids) != len(set(ids)) or len(orders) != len(set(orders)):
        raise ValueError("cards.csv has duplicate IDs or catalog positions")
    if sorted(orders) != list(range(1, len(rows) + 1)):
        raise ValueError("cards.csv catalog_order must be continuous from 1")
    if not snapshot.setup_index.get("schema_version"):
        raise ValueError("setup_catalog.json has no schema_version")
    return snapshot


def _card_values(row: dict[str, str]) -> dict:
    values = {}
    for csv_name, attribute in CSV_TO_DB.items():
        raw = row[csv_name]
        if csv_name in REQUIRED_FIELDS and raw == "":
            raise ValueError(f"{row['card_id']}: required field {csv_name} is blank")
        if raw == "":
            value = None
        elif csv_name in INTEGER_FIELDS:
            try:
                value = int(raw)
            except ValueError as error:
                raise ValueError(f"{row['card_id']}: {csv_name} is not an integer") from error
        elif csv_name in BOOLEAN_FIELDS:
            if raw not in ("True", "False"):
                raise ValueError(f"{row['card_id']}: {csv_name} is not a boolean")
            value = raw == "True"
        else:
            value = raw
        values[attribute] = value
    return values


async def _check_round_trip(db: AsyncSession, source: CatalogSnapshot) -> None:
    imported = await load_catalog_snapshot(db)
    if imported != source:
        raise ValueError("SQLite catalog differs from the CSV/setup source")
    tags = (await db.scalars(select(CardTag).order_by(CardTag.card_id,
                                                     CardTag.position))).all()
    by_card: dict[str, list[str]] = {}
    for item in tags:
        by_card.setdefault(item.card_id, []).append(item.tag)
    for card_id, row in source.cards.items():
        if "|".join(by_card.get(card_id, [])) != row["tags"]:
            raise ValueError(f"{card_id}: card_tags do not match tags text")


async def import_catalog(db: AsyncSession, root: Path = PROJECT_ROOT, *,
                         replace: bool = False) -> dict:
    """Import a new revision or verify an unchanged one in one transaction."""
    source = _read_source(root)
    catalog_hash = source.setup_index["cards_csv_sha256"]
    async with db.begin():
        current = await db.get(CatalogMeta, 1)
        existing_count = await db.scalar(select(func.count()).select_from(CardDefinition))
        if current is not None and current.cards_csv_sha256 == catalog_hash and not replace:
            await _check_round_trip(db, source)
            return {"status": "unchanged", "cards": len(source.cards),
                    "catalog_hash": catalog_hash}
        if (current is not None or existing_count) and not replace:
            raise ValueError("another catalog revision exists; use --replace to overwrite it")
        was_replaced = current is not None or bool(existing_count)
        if was_replaced:
            await db.execute(delete(CardTag))
            await db.execute(delete(CardDefinition))
            await db.execute(delete(CatalogMeta))
        cards = []
        tags = []
        for row in source.cards.values():
            cards.append(CardDefinition(**_card_values(row)))
            for position, tag in enumerate(row["tags"].split("|") if row["tags"] else []):
                if not tag:
                    raise ValueError(f"{row['card_id']}: empty tag")
                tags.append(CardTag(card_id=row["card_id"], position=position, tag=tag))
        db.add_all(cards)
        await db.flush()
        db.add_all(tags)
        db.add(CatalogMeta(
            id=1, cards_csv_sha256=catalog_hash,
            setup_schema_version=str(source.setup_index["schema_version"]),
            setup_index_json=json.dumps(source.setup_index, ensure_ascii=False,
                                        sort_keys=True, separators=(",", ":")),
            card_count=len(cards),
        ))
        await db.flush()
        await _check_round_trip(db, source)
    return {"status": "replaced" if was_replaced else "imported", "cards": len(source.cards),
            "catalog_hash": catalog_hash}
