"""Catalog import fidelity, explicit replacement and rollback."""

import asyncio
import csv
import hashlib
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from backend.app.core.config import get_settings
from backend.app.core.database import get_engine, get_session_factory
from backend.app.core.startup import _upgrade_database
from backend.app.modules.cards.importer import import_catalog
from backend.app.modules.cards.models import CardTag
from backend.app.modules.cards.repository import load_catalog_snapshot
from backend.app.integrations.game_engine.catalog.repository import load_catalog
from backend.app.integrations.game_engine.paths import PROJECT_ROOT


def write_revision(root: Path, *, name: str, initial_count: str) -> None:
    path = root / "cards" / "cards.csv"
    with path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        fieldnames = reader.fieldnames
        rows = list(reader)
    rows[0]["name"] = name
    rows[0]["initial_copy_count"] = initial_count
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    index_path = root / "cards" / "setup_catalog.json"
    index = json.loads(index_path.read_text(encoding="utf-8"))
    index["cards_csv_sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
    index_path.write_text(json.dumps(index, ensure_ascii=False), encoding="utf-8")


class CardCatalogSQLiteTests(unittest.TestCase):
    def test_round_trip_idempotence_and_atomic_replace(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "source"
            (root / "cards").mkdir(parents=True)
            shutil.copy2(PROJECT_ROOT / "cards" / "cards.csv", root / "cards" / "cards.csv")
            shutil.copy2(PROJECT_ROOT / "cards" / "setup_catalog.json",
                         root / "cards" / "setup_catalog.json")
            database_path = Path(temp_dir) / "catalog.db"
            with patch.dict(os.environ, {
                "THUNDERSTONE_DATABASE_URL": f"sqlite+aiosqlite:///{database_path.as_posix()}",
            }):
                get_settings.cache_clear()
                get_session_factory.cache_clear()
                get_engine.cache_clear()
                _upgrade_database()

                async def check() -> None:
                    async with get_session_factory()() as db:
                        first = await import_catalog(db, root)
                        self.assertEqual(first["status"], "imported")
                        self.assertEqual(first["cards"], 722)
                        again = await import_catalog(db, root)
                        self.assertEqual(again["status"], "unchanged")
                        self.assertEqual(await load_catalog_snapshot(db), load_catalog(root))
                        hero_tags = set(await db.scalars(select(CardTag.card_id).where(CardTag.tag == "英雄")))
                        expected = {card_id for card_id, card in load_catalog(root).cards.items()
                                    if "英雄" in card["tags"].split("|")}
                        self.assertEqual(hero_tags, expected)
                        monster_tags = set(await db.scalars(select(CardTag.card_id).where(CardTag.tag == "怪物")))
                        expected_monsters = {card_id for card_id, card in load_catalog(root).cards.items()
                                             if "怪物" in card["tags"].split("|")}
                        self.assertEqual(monster_tags, expected_monsters)
                        self.assertTrue({card_id for card_id, card in load_catalog(root).cards.items()
                                         if card["subcategory"] == "守护者"} <= monster_tags)
                        treasure_tags = set(await db.scalars(select(CardTag.card_id).where(CardTag.tag == "宝藏")))
                        self.assertTrue({'TS-0694', 'TS-0695', 'TS-0696'} <= treasure_tags)
                        village_tags = set(await db.scalars(select(CardTag.card_id).where(CardTag.tag == "村庄")))
                        self.assertEqual(village_tags, {card_id for card_id, card in load_catalog(root).cards.items()
                                                       if "村庄" in card["tags"].split("|")})
                        self.assertTrue({'TS-0002', 'TS-0003', 'TS-0004', 'TS-0261'} <= village_tags)
                        self.assertNotIn('TS-0001', village_tags)

                    write_revision(root, name="Revised catalog name", initial_count="6")
                    async with get_session_factory()() as db:
                        with self.assertRaisesRegex(ValueError, "--replace"):
                            await import_catalog(db, root)
                    async with get_session_factory()() as db:
                        self.assertEqual(await load_catalog_snapshot(db), load_catalog(PROJECT_ROOT))
                    async with get_session_factory()() as db:
                        replaced = await import_catalog(db, root, replace=True)
                        self.assertEqual(replaced["status"], "replaced")
                    async with get_session_factory()() as db:
                        self.assertEqual(await load_catalog_snapshot(db), load_catalog(root))

                    write_revision(root, name="Invalid next revision", initial_count="-1")
                    async with get_session_factory()() as db:
                        with self.assertRaises(IntegrityError):
                            await import_catalog(db, root, replace=True)
                    async with get_session_factory()() as db:
                        snapshot = await load_catalog_snapshot(db)
                        self.assertEqual(snapshot.cards["TS-0001"]["name"],
                                         "Revised catalog name")
                try:
                    asyncio.run(check())
                finally:
                    asyncio.run(get_engine().dispose())
                    get_session_factory.cache_clear()
                    get_engine.cache_clear()
                    get_settings.cache_clear()
