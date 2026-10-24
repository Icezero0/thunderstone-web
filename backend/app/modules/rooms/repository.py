"""Room queries and compare-and-swap updates inside the caller's transaction."""

from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.exceptions import AppError, NotFoundError
from backend.app.modules.rooms.models import Room, RoomPlayer
from backend.app.modules.rooms.schemas import PlayerView, RoomSummary, RoomView
from backend.app.modules.users.models import User
from backend.app.modules.users.presentation import avatar_url


def display_name(user_id: int, username: str | None) -> str:
    return username or f"玩家 {user_id}"


class RoomRepository:
    async def get(self, db: AsyncSession, room_id: str) -> Room:
        room = await db.get(Room, room_id)
        if room is None:
            raise NotFoundError("房间不存在")
        return room

    async def membership(self, db: AsyncSession, user_id: int) -> RoomPlayer | None:
        return await db.scalar(select(RoomPlayer).where(RoomPlayer.user_id == user_id))

    async def players(self, db: AsyncSession, room_id: str) -> list[RoomPlayer]:
        return list((await db.scalars(select(RoomPlayer).where(RoomPlayer.room_id == room_id)
                                     .order_by(RoomPlayer.id))).all())

    async def bump(self, db: AsyncSession, room: Room, expected_version: int) -> None:
        changed = await db.execute(update(Room).where(
            Room.id == room.id, Room.version == expected_version, Room.status == "waiting",
        ).values(version=expected_version + 1, updated_at=func.now())
          .execution_options(synchronize_session=False))
        if changed.rowcount != 1:
            await db.rollback()
            raise AppError("房间已更新，请刷新后重试", code="room_version_conflict", status_code=409)
        await db.refresh(room)

    async def reset_ready(self, db: AsyncSession, room_id: str) -> None:
        await db.execute(update(RoomPlayer).where(RoomPlayer.room_id == room_id)
                         .values(ready_config_version=None))

    async def remove_players(self, db: AsyncSession, room_id: str) -> None:
        await db.execute(delete(RoomPlayer).where(RoomPlayer.room_id == room_id))

    async def view(self, db: AsyncSession, room: Room) -> RoomView:
        rows = (await db.execute(select(RoomPlayer, User.username, User.avatar_key)
                                .join(User, User.id == RoomPlayer.user_id)
                                .where(RoomPlayer.room_id == room.id).order_by(RoomPlayer.id))).all()
        players = [PlayerView(user_id=p.user_id, display_name=display_name(p.user_id, name),
                              ready=p.ready_config_version == room.config_version,
                              avatar_url=avatar_url(key)) for p, name, key in rows]
        host_name = next((p.display_name for p in players if p.user_id == room.host_user_id), "")
        return RoomView(id=room.id, name=room.name, is_public=room.is_public, host_user_id=room.host_user_id,
                        host_name=host_name, status=room.status, version=room.version,
                        config_version=room.config_version, player_count=len(players),
                        created_at=room.created_at, players=players, config=room.config,
                        all_ready=bool(players) and all(p.ready for p in players),
                        active_match_id=room.active_match_id)

    async def list_waiting(self, db: AsyncSession) -> list[RoomSummary]:
        rows = (await db.execute(select(Room, User.username, func.count(RoomPlayer.id))
            .join(User, User.id == Room.host_user_id)
            .outerjoin(RoomPlayer, RoomPlayer.room_id == Room.id)
            .where(Room.status == "waiting", Room.is_public.is_(True)).group_by(Room.id, User.username)
            .order_by(Room.created_at.desc(), Room.id).limit(50))).all()
        return [RoomSummary(id=r.id, name=r.name, is_public=r.is_public, host_user_id=r.host_user_id,
                            host_name=display_name(r.host_user_id, name), status=r.status,
                            version=r.version, config_version=r.config_version,
                            player_count=count, created_at=r.created_at) for r, name, count in rows]
