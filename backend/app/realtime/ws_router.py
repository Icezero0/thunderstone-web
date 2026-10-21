"""Authenticated WebSocket handshake and heartbeat."""

import asyncio

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from backend.app.core.config import get_settings
from backend.app.core.database import get_session_factory
from backend.app.core.exceptions import UnauthorizedError
from backend.app.modules.auth.deps import authenticate_access_token
from backend.app.realtime.manager import RealtimeManager, WsConnection

router = APIRouter()


@router.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    manager: RealtimeManager = ws.app.state.realtime_manager
    connection: WsConnection | None = None
    try:
        try:
            message = await asyncio.wait_for(
                ws.receive_json(), timeout=get_settings().ws_auth_timeout_seconds)
        except asyncio.TimeoutError:
            await ws.close(code=1008, reason="Authentication timeout")
            return
        except ValueError:
            await ws.close(code=1003, reason="Invalid JSON")
            return
        if not isinstance(message, dict) or message.get("type") != "auth":
            await ws.close(code=1008, reason="Authentication required")
            return
        payload = message.get("payload")
        token = payload.get("token") if isinstance(payload, dict) else None
        if not isinstance(token, str):
            await ws.close(code=1008, reason="Invalid token")
            return
        async with get_session_factory()() as db:
            try:
                user = await authenticate_access_token(db, token)
            except UnauthorizedError:
                await ws.close(code=1008, reason="Invalid token")
                return
        connection = await manager.register(user.id, ws, user.token_version)
        await ws.send_json({"v": 1, "type": "ack", "payload": {
            "connection_id": connection.connection_id,
        }})
        while True:
            try:
                message = await ws.receive_json()
            except ValueError:
                await ws.close(code=1003, reason="Invalid JSON")
                return
            async with get_session_factory()() as db:
                try:
                    await authenticate_access_token(db, token)
                except UnauthorizedError:
                    await ws.close(code=1008, reason="Session revoked")
                    return
            if isinstance(message, dict) and message.get("type") == "heartbeat":
                await ws.send_json({"v": 1, "type": "heartbeat", "payload": {"action": "pong"}})
            else:
                await ws.send_json({"v": 1, "type": "error", "payload": {
                    "code": "unsupported_message", "message": "Message type is not supported",
                }})
    except WebSocketDisconnect:
        pass
    finally:
        if connection is not None:
            await manager.disconnect(connection.connection_id)
