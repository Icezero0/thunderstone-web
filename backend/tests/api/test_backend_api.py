"""HTTP integration and reusable backend infrastructure checks."""

import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import text

from backend.app.core.config import Settings, get_settings
from backend.app.core.database import get_engine, get_session_factory
from backend.app.core.startup import _upgrade_database
from backend.app.main import create_app
from backend.app.modules.cards.importer import import_catalog
from backend.app.integrations.game_engine.setup import start_game
from backend.tests.support.frontend import assert_frontend_page


def draft() -> dict:
    return {
        "mode": "classic",
        "counts": {"village_groups": 8, "hero_groups": 4, "monster_groups": 3},
        "selection": {
            "village": {"fixed_randomizer_ids": []},
            "hero": {"fixed_randomizer_ids": []},
            "monster": {"fixed_randomizer_ids": []},
            "dungeon_features": {"mode": "classic_random"},
            "guardian": {"random_count": 0, "fixed_card_ids": []},
            "environment": {"random_count": 0, "fixed_card_ids": []},
            "trap": {"random_count": 0, "fixed_group_ids": []},
            "treasure": {"random_count": 0, "fixed_group_ids": []},
            "thunderstone": {"fixed_card_ids": []},
        },
        "instance_multipliers": {"village": 1, "hero": 1, "monster": 1},
    }


class BackendApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temp = tempfile.TemporaryDirectory()
        db_path = Path(cls.temp.name) / "catalog.db"
        cls.environment = patch.dict(os.environ, {
            "THUNDERSTONE_DATABASE_URL": f"sqlite+aiosqlite:///{db_path.as_posix()}",
        })
        cls.environment.start()
        get_settings.cache_clear()
        get_session_factory.cache_clear()
        get_engine.cache_clear()
        _upgrade_database()

        async def seed() -> None:
            async with get_session_factory()() as db:
                await import_catalog(db)
            await get_engine().dispose()

        asyncio.run(seed())
        get_session_factory.cache_clear()
        get_engine.cache_clear()
        cls.client_context = TestClient(create_app())
        cls.client = cls.client_context.__enter__()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.client_context.__exit__(None, None, None)
        get_session_factory.cache_clear()
        asyncio.run(get_engine().dispose())
        get_engine.cache_clear()
        get_settings.cache_clear()
        cls.environment.stop()
        cls.temp.cleanup()

    def test_versioned_preview_and_legacy_route(self) -> None:
        self.assertEqual(self.client.get("/health").json(), {"status": "ok"})
        options = self.client.get("/api/v1/options")
        self.assertEqual(options.status_code, 200)
        self.assertEqual(options.json(), self.client.get("/api/options").json())
        rules = draft()
        self.assertEqual(self.client.post("/api/v1/validate", json=rules).json(),
                         {"valid": True, "errors": []})
        payload = {"match_id": "api-test", "player_ids": ["alice", "bob"],
                   "rng_seed": "api-test", "config": rules}
        result = self.client.post("/api/v1/setup", json=payload)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()["status"], "ready")
        self.assertEqual(result.json()["state"]["player_order"], ["alice", "bob"])
        self.assertEqual({key: result.json()[key] for key in ("state", "events")},
                         start_game(payload))

    def test_input_errors_and_local_assets(self) -> None:
        self.assertEqual(self.client.post("/api/v1/setup", json={}).status_code, 422)
        self.assertEqual(self.client.post("/api/v1/setup", content=b"not json").status_code, 400)
        self.assertEqual(self.client.post("/api/v1/setup", content=b"x" * 1_000_001).status_code, 400)
        assert_frontend_page(self.client, "/")
        assert_frontend_page(self.client, "/config")
        assert_frontend_page(self.client, "/game-probe")
        self.assertEqual(self.client.get("/cards/TS-0001.png").status_code, 200)
        back = self.client.get("/cards/TS-BACK-001.jpg")
        self.assertEqual(back.status_code, 200)
        self.assertEqual(back.headers["content-type"], "image/jpeg")
        self.assertEqual(self.client.get("/cards/TS-BACK-002.jpg").status_code, 404)
        self.assertEqual(self.client.get("/cards/invalid.png").status_code, 404)

    def test_public_card_details_are_from_sqlite_without_local_maintenance_paths(self) -> None:
        response = self.client.get("/api/v1/cards/TS-0336")
        self.assertEqual(response.status_code, 200)
        card = response.json()
        self.assertEqual(card["name"], "猎法者铁拳")
        self.assertEqual(card["image_url"], "/cards/TS-0336.png")
        self.assertEqual(card["stats"]["力量"], "5")
        self.assertIn("攻击 +2", card["effects"])
        self.assertNotIn("english_image_path", card)
        self.assertNotIn("source_card_id", card)
        self.assertEqual(self.client.get("/api/v1/cards/TS-BACK-001").json()["image_url"],
                         "/cards/TS-BACK-001.jpg")
        self.assertEqual(self.client.get("/api/v1/cards/TS-9999").status_code, 404)


class DatabaseFoundationTests(unittest.TestCase):
    def test_async_session_enables_sqlite_foreign_keys(self) -> None:
        async def check() -> None:
            engine = get_engine()
            async with get_session_factory()() as session:
                self.assertEqual((await session.execute(text("SELECT 1"))).scalar_one(), 1)
                self.assertEqual((await session.execute(text("PRAGMA foreign_keys"))).scalar_one(), 1)
            await engine.dispose()

        with patch("backend.app.core.database.get_settings",
                   return_value=Settings(database_url="sqlite+aiosqlite:///:memory:")):
            get_session_factory.cache_clear()
            get_engine.cache_clear()
            try:
                asyncio.run(check())
            finally:
                get_session_factory.cache_clear()
                get_engine.cache_clear()
