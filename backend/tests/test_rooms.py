"""Room API behavior through real migrations, authentication and SQLite transactions."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.app.core.config import get_settings
from backend.app.core.database import get_engine, get_session_factory
from backend.app.core.startup import _upgrade_database
from backend.app.main import create_app
from backend.app.modules.cards.importer import import_catalog
from backend.tests.frontend_assertions import assert_frontend_page


class RoomApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.environment = patch.dict(os.environ, {
            "THUNDERSTONE_DATABASE_URL": f"sqlite+aiosqlite:///{(Path(cls.temp.name) / 'rooms.db').as_posix()}",
            "THUNDERSTONE_JWT_SECRET_KEY": "room-tests-private-key-with-enough-entropy",
        })
        cls.environment.start()
        get_settings.cache_clear()
        get_session_factory.cache_clear()
        get_engine.cache_clear()
        _upgrade_database()

        async def seed():
            async with get_session_factory()() as db:
                await import_catalog(db)
            await get_engine().dispose()
        asyncio.run(seed())
        get_session_factory.cache_clear()
        get_engine.cache_clear()
        cls.context = TestClient(create_app())
        cls.client = cls.context.__enter__()
        cls.sequence = 0

    @classmethod
    def tearDownClass(cls):
        cls.context.__exit__(None, None, None)
        get_session_factory.cache_clear()
        asyncio.run(get_engine().dispose())
        get_engine.cache_clear()
        get_settings.cache_clear()
        cls.environment.stop()
        cls.temp.cleanup()

    def account(self, name="玩家"):
        type(self).sequence += 1
        email = f"player{type(self).sequence}@example.com"
        created = self.client.post("/api/v1/auth/register", json={
            "email": email, "username": name, "password": "secret123",
        })
        self.assertEqual(created.status_code, 201, created.text)
        token = self.client.post("/api/v1/auth/login", json={"email": email, "password": "secret123"}).json()["access_token"]
        return {"id": created.json()["id"], "email": email, "headers": {"Authorization": f"Bearer {token}"}, "token": token}

    def create(self, account, name="测试房间"):
        response = self.client.post("/api/v1/rooms", headers=account["headers"], json={"name": name})
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def get(self, account, room):
        response = self.client.get(f"/api/v1/rooms/{room['id']}", headers=account["headers"])
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def command(self, account, room, action, **kwargs):
        response = self.client.post(f"/api/v1/rooms/{room['id']}/{action}", headers=account["headers"],
                                    json={"expected_version": room["version"], **kwargs})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_player_list_readiness_and_host_transfer(self):
        alice, bob, carol = self.account("Alice"), self.account("Bob"), self.account("Carol")
        room = self.create(alice)
        room = self.command(bob, room, "join")
        self.assertEqual([p["user_id"] for p in room["players"]], [alice["id"], bob["id"]])
        self.assertNotIn("seat", str(room))
        room = self.command(alice, room, "ready", ready=True)
        room = self.command(bob, room, "ready", ready=True)
        self.assertTrue(room["all_ready"])
        room = self.command(carol, room, "join")
        self.assertFalse(any(p["ready"] for p in room["players"]))
        room = self.command(alice, room, "leave")
        self.assertEqual(room["host_user_id"], bob["id"])
        self.assertEqual([p["user_id"] for p in room["players"]], [bob["id"], carol["id"]])
        closed = self.command(bob, room, "close")
        self.assertEqual(closed["status"], "closed")
        self.assertEqual(closed["players"], [])
        for player in (alice, bob, carol):
            self.assertIsNone(self.client.get("/api/v1/rooms/current", headers=player["headers"]).json()["room"])
        self.assertEqual(self.client.get(f"/api/v1/rooms/{room['id']}", headers=bob["headers"]).status_code, 409)

    def test_stale_versions_and_actor_spoofing_leave_state_unchanged(self):
        alice, bob, outsider = self.account(), self.account(), self.account()
        room = self.command(bob, self.create(alice), "join")
        stale = deepcopy(room)
        room = self.command(alice, room, "ready", ready=True)
        failed = self.client.post(f"/api/v1/rooms/{room['id']}/ready", headers=bob["headers"],
                                 json={"expected_version": stale["version"], "ready": True})
        self.assertEqual(failed.status_code, 409)
        self.assertEqual(failed.json()["error"]["code"], "room_version_conflict")
        self.assertEqual(self.get(alice, room), room)
        for account, expected, extra in ((outsider, 403, {}), (bob, 422, {"user_id": alice["id"]})):
            response = self.client.post(f"/api/v1/rooms/{room['id']}/ready", headers=account["headers"],
                json={"expected_version": room["version"], "ready": True, **extra})
            self.assertEqual(response.status_code, expected)
        self.assertEqual(self.get(alice, room), room)

    def test_config_is_validated_host_only_and_invalidates_readiness(self):
        alice, bob = self.account(), self.account()
        room = self.command(bob, self.create(alice), "join")
        room = self.command(alice, room, "ready", ready=True)
        room = self.command(bob, room, "ready", ready=True)
        url = f"/api/v1/rooms/{room['id']}/config"
        config = deepcopy(room["config"])
        config["counts"]["village_groups"] = -1
        invalid = self.client.patch(url, headers=alice["headers"], json={"expected_version": room["version"], "config": config})
        self.assertEqual(invalid.status_code, 422, invalid.text)
        self.assertEqual(invalid.json()["error"]["code"], "invalid_config")
        self.assertEqual(self.get(alice, room), room)
        config["counts"]["village_groups"] = 7
        self.assertEqual(self.client.patch(url, headers=bob["headers"], json={"expected_version": room["version"], "config": config}).status_code, 403)
        saved = self.client.patch(url, headers=alice["headers"], json={"expected_version": room["version"], "config": config})
        self.assertEqual(saved.status_code, 200, saved.text)
        room = saved.json()
        self.assertEqual(room["config_version"], 2)
        self.assertEqual(room["config"], config)
        self.assertFalse(any(p["ready"] for p in room["players"]))
        room = self.command(alice, room, "ready", ready=True)
        same = self.client.patch(url, headers=alice["headers"], json={"expected_version": room["version"], "config": config}).json()
        self.assertEqual(same["config_version"], 2)
        self.assertEqual(same["players"], room["players"])

    def test_membership_uniqueness_idempotent_join_and_last_player_leaving(self):
        alice, bob = self.account(), self.account()
        room = self.create(alice)
        self.assertEqual(self.client.post("/api/v1/rooms", headers=alice["headers"], json={"name": "不可创建"}).status_code, 409)
        room = self.command(alice, room, "ready", ready=True)
        retry = self.client.post(f"/api/v1/rooms/{room['id']}/join", headers=alice["headers"], json={"expected_version": 1})
        self.assertEqual(retry.json(), room)
        other = self.create(bob)
        self.assertEqual(self.client.post(f"/api/v1/rooms/{other['id']}/join", headers=alice["headers"], json={"expected_version": other["version"]}).status_code, 409)
        left = self.command(alice, room, "leave")
        self.assertEqual(left["status"], "closed")
        self.assertEqual(left["players"], [])
        room = self.command(alice, other, "join")
        self.assertEqual(room["player_count"], 2)

    def test_authenticated_public_views_and_web_assets(self):
        self.assertEqual(self.client.get("/api/v1/rooms").status_code, 401)
        self.assertEqual(self.client.post("/api/v1/rooms", json={"name": "x"}).status_code, 401)
        alice, bob = self.account("Alice"), self.account("Bob")
        room = self.create(alice, "  一起玩  ")
        self.assertEqual(room["name"], "一起玩")
        text = self.client.get("/api/v1/rooms", headers=bob["headers"]).text
        self.assertNotIn(alice["email"], text)
        self.assertNotIn("hashed_password", text)
        self.assertEqual(self.get(bob, room)["players"][0]["display_name"], "Alice")
        self.assertEqual(self.client.post("/api/v1/rooms", headers=bob["headers"], json={"name": "   "}).status_code, 422)
        self.assertEqual(self.client.post(f"/api/v1/rooms/{room['id']}/ready", headers=alice["headers"], json={"expected_version": True, "ready": True}).status_code, 422)
        for path in ("/play", "/config"):
            assert_frontend_page(self.client, path)
        self.assertEqual(self.client.get("/assets/../../../cards/cards.csv").status_code, 404)

    def test_concurrent_commands_accept_only_one_expected_version(self):
        alice, bob = self.account(), self.account()
        room = self.command(bob, self.create(alice), "join")

        def ready(account):
            return self.client.post(f"/api/v1/rooms/{room['id']}/ready", headers=account["headers"],
                                    json={"expected_version": room["version"], "ready": True})
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(ready, [alice, bob]))
        self.assertEqual(sorted(r.status_code for r in results), [200, 409], [r.text for r in results])
        current = self.get(alice, room)
        self.assertEqual(current["version"], room["version"] + 1)
        self.assertEqual(sum(p["ready"] for p in current["players"]), 1)

    def test_restart_recovers_room_and_readiness(self):
        alice = self.account("持久化玩家")
        room = self.command(alice, self.create(alice), "ready", ready=True)
        with TestClient(create_app()) as restarted:
            current = restarted.get("/api/v1/rooms/current", headers=alice["headers"])
            self.assertEqual(current.json()["room"], room)

    def test_websocket_invalidates_only_after_commit(self):
        alice, bob = self.account(), self.account()
        with self.client.websocket_connect("/ws") as ws:
            ws.send_json({"type": "auth", "payload": {"token": bob["token"]}})
            self.assertEqual(ws.receive_json()["type"], "ack")
            room = self.create(alice)
            event = ws.receive_json()
            self.assertEqual(event, {"v": 1, "type": "room_changed", "payload": {"room_id": room["id"], "version": room["version"]}})
            self.assertEqual(self.get(bob, room), room)
            room = self.command(bob, room, "join")
            self.assertEqual(ws.receive_json()["payload"]["version"], room["version"])
