"""Match persistence and optimistic updates inside service transactions."""

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.exceptions import AppError, NotFoundError
from backend.app.modules.matches.models import Match, MatchCommand, MatchHistory
from backend.app.modules.rooms.models import Room, RoomPlayer


class MatchRepository:
    async def checkpoint(self, db, match, user_id, label, snapshot):
        db.add(MatchHistory(match_id=match.id, step=match.version, parent_step=match.history_cursor,
            user_id=user_id, label=label, turn_number=(match.state or {}).get("turn_number"), snapshot=snapshot))
        match.history_cursor = match.version
        await db.flush()

    async def history_step(self, db, match_id, step):
        return await db.get(MatchHistory, (match_id, step))

    async def history(self, db, match_id):
        # Never fetch the large private snapshots when rendering the timeline.
        return (await db.execute(select(MatchHistory.step, MatchHistory.parent_step, MatchHistory.user_id,
            MatchHistory.label, MatchHistory.turn_number, MatchHistory.created_at)
            .where(MatchHistory.match_id == match_id).order_by(MatchHistory.step))).mappings().all()

    async def resume_room(self, db, room, match_id):
        changed = await db.execute(update(Room).where(Room.id == room.id, Room.version == room.version,
            Room.status == "waiting", Room.active_match_id.is_(None)).values(status="playing", active_match_id=match_id,
                version=room.version + 1, updated_at=func.now()).execution_options(synchronize_session=False))
        if changed.rowcount != 1:
            raise AppError("房间已开始其他对局，不能恢复旧对局", code="history_room_conflict", status_code=409)
        await db.refresh(room)

    async def get(self, db: AsyncSession, match_id: str) -> Match:
        match = await db.get(Match, match_id)
        if match is None:
            raise NotFoundError("对局不存在")
        return match

    async def current(self, db: AsyncSession, user_id: int) -> Match | None:
        return await db.scalar(select(Match).join(Room, Room.active_match_id == Match.id)
            .join(RoomPlayer, RoomPlayer.room_id == Room.id).where(
                RoomPlayer.user_id == user_id, Room.status == "playing"))

    async def command(self, db: AsyncSession, user_id: int, command_id: str) -> MatchCommand | None:
        return await db.get(MatchCommand, (user_id, command_id))

    async def add(self, db: AsyncSession, match: Match) -> None:
        db.add(match)
        await db.flush()

    async def save_command(self, db: AsyncSession, command: MatchCommand) -> None:
        db.add(command)
        await db.flush()

    async def advance(self, db: AsyncSession, match: Match, expected_version: int,
                      statuses: tuple[str, ...] = ("setup_pending",)) -> None:
        changed = await db.execute(update(Match).where(Match.id == match.id,
            Match.version == expected_version, Match.status.in_(statuses))
            .values(version=expected_version + 1, updated_at=func.now())
            .execution_options(synchronize_session=False))
        if changed.rowcount != 1:
            raise AppError("对局已更新，请刷新后重试", code="match_version_conflict", status_code=409)
        await db.refresh(match)

    async def reopen_room(self, db: AsyncSession, room: Room, match_id: str) -> None:
        changed = await db.execute(update(Room).where(Room.id == room.id,
            Room.version == room.version, Room.status == "playing", Room.active_match_id == match_id)
            .values(status="waiting", active_match_id=None, version=room.version + 1,
                    updated_at=func.now()).execution_options(synchronize_session=False))
        if changed.rowcount != 1:
            raise AppError("房间已更新，请刷新后重试", code="room_version_conflict", status_code=409)
        await db.refresh(room)
