"""Track authenticated WebSocket connections by user."""

import asyncio
from dataclasses import dataclass
from uuid import uuid4

from fastapi import WebSocket

from backend.app.core.database import get_session_factory
from backend.app.modules.users.repository import UserRepository


@dataclass
class WsConnection:
    connection_id: str
    user_id: int
    websocket: WebSocket
    token_version: int


class RealtimeManager:
    def __init__(self) -> None:
        self.connections: dict[str, WsConnection] = {}
        self.user_connections: dict[int, set[str]] = {}
        self._lock = asyncio.Lock()

    async def register(self, user_id: int, websocket: WebSocket,
                       token_version: int) -> WsConnection:
        connection = WsConnection(uuid4().hex, user_id, websocket, token_version)
        async with self._lock:
            self.connections[connection.connection_id] = connection
            self.user_connections.setdefault(user_id, set()).add(connection.connection_id)
        return connection

    async def disconnect(self, connection_id: str) -> None:
        async with self._lock:
            connection = self.connections.pop(connection_id, None)
            if connection is None:
                return
            ids = self.user_connections.get(connection.user_id)
            if ids is not None:
                ids.discard(connection_id)
                if not ids:
                    self.user_connections.pop(connection.user_id, None)

    async def send_to_user(self, user_id: int, message: dict) -> None:
        for connection_id in list(self.user_connections.get(user_id, set())):
            connection = self.connections.get(connection_id)
            if connection is None:
                continue
            try:
                async with get_session_factory()() as db:
                    user = await UserRepository().get_by_id(db, user_id)
                    if user is None or user.token_version != connection.token_version:
                        await connection.websocket.close(code=1008, reason="Session revoked")
                        await self.disconnect(connection_id)
                        continue
                await connection.websocket.send_json(message)
            except Exception:
                await self.disconnect(connection_id)
