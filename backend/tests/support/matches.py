"""A migrated temporary database and real authenticated match API clients."""

import asyncio
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import tempfile
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient

from backend.app.core.config import get_settings
from backend.app.core.database import get_engine, get_session_factory
from backend.app.core.startup import _upgrade_database
from backend.app.main import create_app
from backend.app.modules.cards.importer import import_catalog


class MatchApiFixture:
    def __enter__(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp.name) / "matches.db"
        self.environment = patch.dict(os.environ, {
            "THUNDERSTONE_DATABASE_URL": f"sqlite+aiosqlite:///{self.db_path.as_posix()}",
            "THUNDERSTONE_JWT_SECRET_KEY": "match-tests-private-key-with-enough-entropy",
            "THUNDERSTONE_AVATAR_DIR": str(Path(self.temp.name) / "avatars"),
        })
        self.environment.start()
        get_settings.cache_clear(); get_session_factory.cache_clear(); get_engine.cache_clear()
        _upgrade_database()

        async def seed():
            async with get_session_factory()() as db:
                await import_catalog(db)
            await get_engine().dispose()
        asyncio.run(seed())
        get_session_factory.cache_clear(); get_engine.cache_clear()
        self.context = TestClient(create_app())
        self.client = self.context.__enter__()
        self.sequence = 0
        return self

    def __exit__(self, *args):
        self.context.__exit__(*args)
        get_session_factory.cache_clear()
        asyncio.run(get_engine().dispose())
        get_engine.cache_clear(); get_settings.cache_clear()
        self.environment.stop()
        self.temp.cleanup()

    @staticmethod
    def successful(response, code=200):
        assert response.status_code == code, response.text
        return response.json()

    def account(self, name="玩家"):
        self.sequence += 1
        email = f"match-player{self.sequence}@example.com"
        account = self.successful(self.client.post("/api/v1/auth/register", json={
            "email": email, "username": name, "password": "secret123"}), 201)
        token = self.successful(self.client.post("/api/v1/auth/login", json={
            "email": email, "password": "secret123"}))["access_token"]
        return {"id": account["id"], "email": email, "token": token,
                "headers": {"Authorization": f"Bearer {token}"}}

    def create(self, account, name="测试房间", **options):
        return self.successful(self.client.post("/api/v1/rooms", headers=account["headers"], json={"name": name, **options}), 201)

    def command(self, account, room, action, **kwargs):
        return self.successful(self.client.post(f"/api/v1/rooms/{room['id']}/{action}",
            headers=account["headers"], json={"expected_version": room["version"], **kwargs}))

    def save_config(self, account, room, config):
        return self.successful(self.client.patch(f"/api/v1/rooms/{room['id']}/config",
            headers=account["headers"], json={"expected_version": room["version"], "config": config}))

    def ready_all(self, room, *accounts):
        for account in accounts:
            room = self.command(account, room, "ready", ready=True)
        return room

    def start(self, account, room, command_id=None, first_player=None):
        payload = {"expected_version": room["version"], "command_id": command_id or uuid4().hex}
        if first_player is not None:
            payload["first_player"] = first_player
        return self.client.post(f"/api/v1/rooms/{room['id']}/start", headers=account["headers"], json=payload)

    def play(self, account, match, command, command_id=None, expected_version=None):
        return self.client.post(f"/api/v1/matches/{match['id']}/commands", headers=account["headers"], json={
            "expected_version": match["version"] if expected_version is None else expected_version,
            "command_id": command_id or uuid4().hex, "command": command})

    def stored_match(self, match_id):
        with closing(sqlite3.connect(self.db_path)) as db:
            db.row_factory = sqlite3.Row
            row = dict(db.execute("SELECT * FROM matches WHERE id=?", (match_id,)).fetchone())
        for key in ("frozen_players", "setup_request", "setup_choice", "state", "events", "catalog_snapshot"):
            row[key] = json.loads(row[key]) if row[key] is not None else None
        # Most integration assertions inspect the logical selected-branch log,
        # not its compact on-disk batches. Preserve the raw batch for storage tests.
        row["event_batch"] = row["events"]
        if row.get("presentation") and json.loads(row["presentation"]) is not None and row.get("history_cursor"):
            batches, step = [], row["history_cursor"]
            with closing(sqlite3.connect(self.db_path)) as db:
                while step:
                    saved = db.execute("SELECT parent_step, snapshot FROM match_history WHERE match_id=? AND step=?", (match_id, step)).fetchone()
                    if not saved:
                        break
                    snapshot = json.loads(saved[1]); batches.append(snapshot["events"])
                    if snapshot.get("presentation") is None:
                        break
                    step = saved[0]
            row["events"] = [event for batch in reversed(batches) for event in batch]
        return row
