"""Account API integration through SQLite migrations and JWTs."""

import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend.app.core.config import get_settings
from backend.app.core.database import get_engine, get_session_factory
from backend.app.main import create_app


class BackendAuthTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        db_path = Path(self.temp.name) / "auth.db"
        self.environment = patch.dict(os.environ, {
            "THUNDERSTONE_DATABASE_URL": f"sqlite+aiosqlite:///{db_path.as_posix()}",
            "THUNDERSTONE_JWT_SECRET_KEY": "unit-test-secret-with-enough-entropy-for-tests",
        })
        self.environment.start()
        get_settings.cache_clear()
        get_session_factory.cache_clear()
        get_engine.cache_clear()
        self.client_context = TestClient(create_app())
        self.client = self.client_context.__enter__()

    def tearDown(self) -> None:
        self.client_context.__exit__(None, None, None)
        engine = get_engine()
        get_session_factory.cache_clear()
        asyncio.run(engine.dispose())
        get_engine.cache_clear()
        get_settings.cache_clear()
        self.environment.stop()
        self.temp.cleanup()

    def test_register_login_refresh_and_revoke_on_password_change(self) -> None:
        registered = self.client.post("/api/v1/auth/register", json={
            "email": " Alice@Example.com ", "username": "Alice", "password": "secret123",
        })
        self.assertEqual(registered.status_code, 201)
        self.assertEqual(registered.json()["email"], "alice@example.com")
        self.assertNotIn("hashed_password", registered.json())
        self.assertEqual(self.client.post("/api/v1/auth/register", json={
            "email": "alice@example.com", "password": "secret123",
        }).status_code, 409)
        self.assertEqual(self.client.post("/api/v1/auth/login", json={
            "email": "alice@example.com", "password": "wrongpass",
        }).status_code, 401)

        tokens = self.client.post("/api/v1/auth/login", json={
            "email": "alice@example.com", "password": "secret123",
        }).json()
        access = tokens["access_token"]
        refresh = tokens["refresh_token"]
        headers = {"Authorization": f"Bearer {access}"}
        self.assertEqual(self.client.get("/api/v1/users/me", headers=headers).json()["username"],
                         "Alice")
        self.assertEqual(self.client.get("/api/v1/users/me").status_code, 401)
        self.assertEqual(self.client.post("/api/v1/auth/refresh", json={
            "refresh_token": access,
        }).status_code, 401)
        self.assertEqual(self.client.post("/api/v1/auth/refresh", json={
            "refresh_token": refresh,
        }).status_code, 200)

        changed = self.client.patch("/api/v1/users/me", json={
            "password": "changed123", "username": "New Alice",
        }, headers=headers)
        self.assertEqual(changed.status_code, 200)
        self.assertEqual(changed.json()["username"], "New Alice")
        self.assertEqual(self.client.get("/api/v1/users/me", headers=headers).status_code, 401)
        self.assertEqual(self.client.post("/api/v1/auth/refresh", json={
            "refresh_token": refresh,
        }).status_code, 401)
        self.assertEqual(self.client.post("/api/v1/auth/login", json={
            "email": "alice@example.com", "password": "changed123",
        }).status_code, 200)

    def test_websocket_auth_heartbeat_and_revocation(self) -> None:
        self.client.post("/api/v1/auth/register", json={
            "email": "bob@example.com", "password": "secret123",
        })
        access = self.client.post("/api/v1/auth/login", json={
            "email": "bob@example.com", "password": "secret123",
        }).json()["access_token"]
        with self.client.websocket_connect("/ws") as ws:
            ws.send_json({"type": "auth", "payload": {"token": access}})
            self.assertEqual(ws.receive_json()["type"], "ack")
            ws.send_json({"type": "heartbeat"})
            self.assertEqual(ws.receive_json()["payload"]["action"], "pong")
            self.assertEqual(self.client.patch("/api/v1/users/me", json={
                "password": "changed123",
            }, headers={"Authorization": f"Bearer {access}"}).status_code, 200)
            ws.send_json({"type": "heartbeat"})
            with self.assertRaises(WebSocketDisconnect) as closed:
                ws.receive_json()
            self.assertEqual(closed.exception.code, 1008)
        with self.client.websocket_connect("/ws") as ws:
            ws.send_json({"type": "auth", "payload": {"token": "invalid"}})
            with self.assertRaises(WebSocketDisconnect) as closed:
                ws.receive_json()
            self.assertEqual(closed.exception.code, 1008)
