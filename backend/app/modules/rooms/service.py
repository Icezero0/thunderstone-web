"""Waiting-room lifecycle; no card rules or game state are stored here."""

import asyncio

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.exceptions import AppError, ConflictError
from backend.app.integrations.game_engine.api import (
    SharedEngineUnavailable, build_panel_catalog, validate_rules_config,
)
from backend.app.modules.cards.repository import load_catalog_snapshot
from backend.app.modules.rooms.models import Room, RoomPlayer
from backend.app.modules.rooms.repository import RoomRepository
from backend.app.modules.rooms.schemas import RoomView


def default_config() -> dict:
    return {
        "mode": "classic", "counts": {"village_groups": 8, "hero_groups": 4, "monster_groups": 3},
        "selection": {
            **{kind: {"fixed_randomizer_ids": []} for kind in ("village", "hero", "monster")},
            "dungeon_features": {"mode": "classic_random"},
            **{kind: {"random_count": 0, "fixed_card_ids": []} for kind in ("guardian", "environment")},
            **{kind: {"random_count": 0, "fixed_group_ids": []} for kind in ("trap", "treasure")},
            "thunderstone": {"fixed_card_ids": []},
        }, "instance_multipliers": {"village": 1, "hero": 1, "monster": 1},
    }


def forbidden(message: str) -> AppError:
    return AppError(message, code="room_forbidden", status_code=403)


class RoomService:
    def __init__(self):
        self.repo = RoomRepository()

    async def current(self, db: AsyncSession, user_id: int) -> RoomView | None:
        player = await self.repo.membership(db, user_id)
        return await self.repo.view(db, await self.repo.get(db, player.room_id)) if player else None

    async def create(self, db: AsyncSession, user_id: int, name: str, *, is_public: bool = True) -> RoomView:
        if await self.repo.membership(db, user_id):
            raise ConflictError("请先离开当前房间")
        try:
            room = Room(name=name, host_user_id=user_id, config=default_config(), is_public=is_public)
            db.add(room)
            await db.flush()
            db.add(RoomPlayer(room_id=room.id, user_id=user_id))
            await db.commit()
        except IntegrityError as error:
            await db.rollback()
            raise ConflictError("你已在另一个房间中") from error
        return await self.repo.view(db, room)

    async def waiting(self, db: AsyncSession, room_id: str) -> Room:
        room = await self.repo.get(db, room_id)
        if room.status == "playing":
            raise AppError("游戏已经开始，房间已锁定，请进入当前对局", code="room_playing", status_code=409)
        if room.status != "waiting":
            raise ConflictError("房间已关闭")
        return room

    async def readable(self, db: AsyncSession, room_id: str, user_id: int) -> Room:
        room = await self.repo.get(db, room_id)
        if room.status == "closed":
            raise ConflictError("房间已关闭")
        if room.status == "playing":
            await self.member(db, room, user_id)
        return room

    async def member(self, db: AsyncSession, room: Room, user_id: int) -> RoomPlayer:
        player = await self.repo.membership(db, user_id)
        if player is None or player.room_id != room.id:
            raise forbidden("你不在这个房间中")
        return player

    async def join(self, db: AsyncSession, room_id: str, user_id: int, version: int) -> RoomView:
        room = await self.waiting(db, room_id)
        player = await self.repo.membership(db, user_id)
        if player:
            if player.room_id == room_id:
                return await self.repo.view(db, room)
            raise ConflictError("请先离开当前房间")
        try:
            await self.repo.bump(db, room, version)
            await self.repo.reset_ready(db, room.id)
            db.add(RoomPlayer(room_id=room.id, user_id=user_id))
            await db.commit()
        except IntegrityError as error:
            await db.rollback()
            raise ConflictError("你已在另一个房间中") from error
        return await self.repo.view(db, room)

    async def ready(self, db: AsyncSession, room_id: str, user_id: int,
                    version: int, ready: bool) -> RoomView:
        room = await self.waiting(db, room_id)
        player = await self.member(db, room, user_id)
        await self.repo.bump(db, room, version)
        player.ready_config_version = room.config_version if ready else None
        await db.commit()
        return await self.repo.view(db, room)

    async def save_config(self, db: AsyncSession, room_id: str, user_id: int,
                          version: int, config: dict) -> RoomView:
        room = await self.waiting(db, room_id)
        if room.host_user_id != user_id:
            raise forbidden("只有房主可以修改配置")
        snapshot = await load_catalog_snapshot(db)
        try:
            errors = await asyncio.to_thread(validate_rules_config, config,
                                             build_panel_catalog(snapshot.cards, snapshot.setup_index))
        except SharedEngineUnavailable as error:
            raise AppError("规则校验暂不可用，请确认引擎已构建", code="engine_unavailable", status_code=503) from error
        if errors:
            raise AppError("规则配置未通过校验", code="invalid_config", status_code=422,
                           details={"errors": errors})
        await self.repo.bump(db, room, version)
        if room.config != config:
            room.config = config
            room.config_version += 1
            await self.repo.reset_ready(db, room.id)
        await db.commit()
        return await self.repo.view(db, room)

    async def leave(self, db: AsyncSession, room_id: str, user_id: int, version: int) -> RoomView:
        room = await self.waiting(db, room_id)
        player = await self.member(db, room, user_id)
        await self.repo.bump(db, room, version)
        await db.delete(player)
        await db.flush()
        remaining = await self.repo.players(db, room.id)
        if not remaining:
            room.status = "closed"
        elif room.host_user_id == user_id:
            room.host_user_id = remaining[0].user_id
        await self.repo.reset_ready(db, room.id)
        await db.commit()
        return await self.repo.view(db, room)

    async def close(self, db: AsyncSession, room_id: str, user_id: int, version: int) -> RoomView:
        room = await self.waiting(db, room_id)
        if room.host_user_id != user_id:
            raise forbidden("只有房主可以关闭房间")
        await self.repo.bump(db, room, version)
        room.status = "closed"
        await self.repo.remove_players(db, room.id)
        await db.commit()
        return await self.repo.view(db, room)
