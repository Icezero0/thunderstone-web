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

    async def history_parent(self, db, match_id, step):
        return await db.scalar(select(MatchHistory.parent_step).where(MatchHistory.match_id == match_id, MatchHistory.step == step))

    async def history(self, db, match_id, after=0):
        # Never fetch the large private snapshots when rendering the timeline.
        return (await db.execute(select(MatchHistory.step, MatchHistory.parent_step, MatchHistory.user_id,
            MatchHistory.label, MatchHistory.turn_number, MatchHistory.created_at)
            .where(MatchHistory.match_id == match_id, MatchHistory.step > after).order_by(MatchHistory.step))).mappings().all()

    async def event_batches(self, db, match, after=0, reveal_context=None):
        """Read only event JSON on the selected branch, never historical game snapshots."""
        if reveal_context is not None:
            reveal_context.update((match.presentation or {}).get("recent_reveals", {}))
        if match.presentation is None or not match.history_cursor:
            return [e for e in match.events if e.get("sequence", 0) > after]
        if after >= match.presentation.get("event_sequence", 0):
            return []
        if match.events and after >= match.events[0].get("sequence", 0) - 1:
            return [e for e in match.events if e.get("sequence", 0) > after]
        chain = select(MatchHistory.step, MatchHistory.parent_step).where(
            MatchHistory.match_id == match.id, MatchHistory.step == match.history_cursor).cte(recursive=True)
        chain = chain.union_all(select(MatchHistory.step, MatchHistory.parent_step).join(
            chain, MatchHistory.step == chain.c.parent_step).where(MatchHistory.match_id == match.id,
                func.coalesce(MatchHistory.snapshot["presentation"]["event_sequence"].as_integer(), after + 1) > after))
        rows = (await db.execute(select(MatchHistory.step,
            MatchHistory.snapshot["events"], MatchHistory.snapshot["presentation"])
            .join(chain, MatchHistory.step == chain.c.step).where(MatchHistory.match_id == match.id)
            .order_by(MatchHistory.step.desc()))).all()
        batches = []
        for _, events, presentation in rows:
            if reveal_context is not None:
                for zone, event in (presentation or {}).get("recent_reveals", {}).items():
                    reveal_context.setdefault(zone, event)
            batch = [e for e in (events or []) if e.get("sequence", 0) > after]
            if batch:
                batches.append(batch)
            if presentation is None or presentation.get("event_sequence", 0) <= after or batch and batch[0].get("sequence", 0) <= after + 1:
                break
        return [event for batch in reversed(batches) for event in batch]

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
