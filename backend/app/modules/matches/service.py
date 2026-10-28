"""Authoritative match transactions, frozen rules and per-user command receipts."""

import asyncio
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import secrets
from uuid import uuid4

from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.exceptions import AppError
from backend.app.integrations.game_engine.api import (
    CatalogSnapshot, EffectCompileError, SetupChoiceRequired, SetupError, SharedEngineUnavailable,
    TurnError, apply_command, command_options, rules_revision, start_game,
)
from backend.app.modules.cards.repository import load_catalog_snapshot
from backend.app.modules.matches.models import Match, MatchCommand as SavedCommand
from backend.app.modules.matches.projection import build_match_view
from backend.app.modules.matches.repository import MatchRepository
from backend.app.modules.matches.schemas import MatchCommand, SetupChoiceCommand, StartMatchCommand, ViewCursor
from backend.app.modules.matches.command_schemas import PlayCommand
from backend.app.modules.matches import history, presentation
from backend.app.modules.rooms.service import RoomService
from backend.app.modules.users.repository import UserRepository


@dataclass(frozen=True)
class MatchResult:
    view: dict
    changed: bool = False
    participant_ids: tuple[int, ...] = ()
    room_version: int | None = None
    room_is_public: bool = True


def forbidden(message="只有房主可以执行此操作"):
    return AppError(message, code="match_forbidden", status_code=403)


def payload_hash(payload: MatchCommand) -> str:
    values = payload.model_dump()
    if values.get("sync") is None:
        values.pop("sync", None)  # Preserve pre-cursor command receipts during upgrades.
    return hashlib.sha256(json.dumps(values, sort_keys=True,
        separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()


def calculate_setup(request: dict, snapshot: CatalogSnapshot, expected_revision: dict | None = None) -> dict:
    """Resume compatible frozen setup inputs, guarding against a mid-call update."""
    try:
        revision = check_revision(snapshot, expected_revision) if expected_revision is not None else rules_revision(snapshot)
        try:
            result = start_game(request, snapshot=snapshot)
            outcome = {"status": "active", "state": result["state"],
                       "events": result["events"], "setup_choice": None}
        except SetupChoiceRequired as choice:
            outcome = {"status": "setup_pending", "state": None,
                       "events": [], "setup_choice": choice.choice}
        if rules_revision(snapshot) != revision:
            raise AppError("组局期间规则版本发生变化，请重试", code="match_rules_changed", status_code=409)
        return {**outcome, **revision}
    except SharedEngineUnavailable as error:
        raise AppError("规则引擎暂不可用，请确认引擎已构建", code="engine_unavailable", status_code=503) from error
    except SetupError as error:
        raise AppError("组局参数无法执行，请检查设置或分配选择", code="invalid_setup", status_code=422,
                       details={"issues": error.issues}) from error
    except EffectCompileError as error:
        if expected_revision is not None:
            raise AppError("当前规则无法读取本局目录快照；本局已保留，需迁移规则数据后继续",
                           code="match_rules_changed", status_code=409) from error
        raise AppError("规则定义暂不可用，请检查目录与效果版本", code="engine_unavailable", status_code=503) from error


def check_revision(snapshot: CatalogSnapshot, expected: dict) -> dict:
    # The build fingerprint is for browser/server agreement and in-flight races,
    # not save compatibility. The engine validates the persisted state contract.
    current = rules_revision(snapshot)
    if current["effects_version"] != expected["effects_version"]:
        raise AppError("本局卡牌效果版本与当前版本不同；本局已保留，需迁移规则数据后继续",
                       code="match_rules_changed", status_code=409)
    return current


def check_runtime_unchanged(snapshot: CatalogSnapshot, revision: dict) -> None:
    if rules_revision(snapshot) != revision:
        raise AppError("操作期间规则引擎发生更新，请刷新后重试", code="match_rules_changed", status_code=409)


def calculate_command(state: dict, command: dict, snapshot: CatalogSnapshot, expected: dict) -> dict:
    """An engine transition is atomic: a rejected command never persists state."""
    try:
        revision = check_revision(snapshot, expected)
        if command.get("type") == "SubmitBattleTeam":
            # The HTTP API supplies choices only; bind its draft to this runtime,
            # never to the build that originally created the match.
            command = deepcopy(command)
            command["draft"]["engine_version"] = revision["engine_version"]
        result = apply_command(state, command, snapshot=snapshot)
        check_runtime_unchanged(snapshot, revision)
        return result
    except EffectCompileError as error:
        raise AppError("当前规则无法读取本局快照；本局已保留，需迁移规则数据后继续",
                       code="match_rules_changed", status_code=409) from error
    except SharedEngineUnavailable as error:
        raise AppError("规则引擎暂不可用，请稍后重试", code="engine_unavailable", status_code=503) from error
    except TurnError as error:
        # Raw interpreter diagnostics can contain hidden card or continuation
        # details. A public error identifies rejection without exposing them.
        raise AppError("当前局面不允许此操作，请刷新后按可用选项重新选择",
                       code="invalid_game_command", status_code=422) from error


def calculate_options(state: dict, player_id: str, snapshot: CatalogSnapshot, expected: dict, prediction=False) -> dict:
    try:
        revision = check_revision(snapshot, expected)
        result = command_options(state, player_id, snapshot=snapshot, prediction=prediction)
        check_runtime_unchanged(snapshot, revision)
        return result
    except AppError as error:
        return {"unavailable_reason": str(error)}
    except SharedEngineUnavailable:
        return {"unavailable_reason": "规则引擎暂不可用；本局已保留，请稍后刷新重试"}
    except (EffectCompileError, TurnError):
        return {"unavailable_reason": "当前引擎无法读取本局规则或存档格式；本局已保留，可下载对局文件排查并迁移"}


class MatchService:
    def __init__(self):
        self.repo = MatchRepository()
        self.rooms = RoomService()

    async def get(self, db: AsyncSession, match_id: str, user_id: int, sync: ViewCursor | None = None) -> dict:
        return await self.view(db, await self.repo.get(db, match_id), user_id, sync)

    async def export(self, db: AsyncSession, match_id: str, user_id: int) -> dict:
        """Explicit participant download, independent of engine availability/projection.

        All mutable values come from one persisted Match row, so a concurrent
        command cannot mix two revisions inside the exported checkpoint.
        """
        match = await self.repo.get(db, match_id)
        self.member(match, user_id)
        snapshot = history.snapshot(match)
        snapshot["events"] = await self.repo.event_batches(db, match)
        snapshot["presentation"] = None  # Portable exports carry the complete selected branch.
        return {
            "format": "thunderstone-match", "format_version": 1,
            "exported_at": datetime.now(timezone.utc).isoformat(),
            "match": {
                "id": match.id, "room_id": match.room_id, "host_user_id": match.host_user_id,
                "version": match.version, "history_cursor": match.history_cursor,
                "history_epoch": match.history_epoch or 0,
                "created_at": match.created_at.replace(tzinfo=timezone.utc).isoformat(),
                "updated_at": match.updated_at.replace(tzinfo=timezone.utc).isoformat(),
            },
            "players": deepcopy(match.frozen_players),
            "rules": self.revision(match),
            "catalog_snapshot": deepcopy(match.catalog_snapshot),
            "snapshot": snapshot,
        }

    async def current(self, db: AsyncSession, user_id: int) -> dict | None:
        match = await self.repo.current(db, user_id)
        return await self.view(db, match, user_id) if match else None

    @staticmethod
    def member(match: Match, user_id: int) -> dict:
        member = next((p for p in match.frozen_players if p["user_id"] == user_id), None)
        if member is None:
            raise forbidden("你不在这场对局中")
        return member

    @staticmethod
    def revision(match: Match) -> dict:
        return {"engine_version": match.engine_version, "effects_version": match.effects_version}

    async def view(self, db: AsyncSession, match: Match, user_id: int, sync: ViewCursor | None = None) -> dict:
        member = self.member(match, user_id)
        options = {}
        state = match.state or {}
        # Observers also need engine-calculated public hall capacities. The
        # projection still restricts commands and preparation to their actor.
        if match.status == "active":
            options = await asyncio.to_thread(calculate_options, state, member["player_id"],
                CatalogSnapshot(**match.catalog_snapshot), self.revision(match), sync is not None)
        profiles = await UserRepository().profiles(db, [p["user_id"] for p in match.frozen_players])
        last_event = (match.presentation or {}).get("event_sequence", max((e.get("sequence", 0) for e in match.events), default=0))
        reset = sync is not None and (sync.after_event is None or sync.epoch != (match.history_epoch or 0) or sync.after_event > last_event)
        reveal_context = {}
        events = [] if reset else await self.repo.event_batches(db, match, sync.after_event if sync else 0, reveal_context)
        view = build_match_view(match, user_id, profiles=profiles, presentation_events=events, reveal_events=list(reveal_context.values()), **options)
        rows = await self.repo.history(db, match.id, (sync.history_after if sync else 0) or 0) if sync is None or sync.history_after is not None else []
        parent = await self.repo.history_parent(db, match.id, match.history_cursor) if match.history_cursor else None
        view["history"] = {"cursor": match.history_cursor, "epoch": match.history_epoch or 0,
            "can_undo": match.status in ("active", "setup_pending", "finished") and bool(parent),
            "can_jump": match.host_user_id == user_id and match.status != "cancelled",
            "entries": [{**dict(row), "created_at": row["created_at"].replace(tzinfo=timezone.utc).isoformat()} for row in rows]}
        if sync is not None:
            view["sync"] = {"reset": reset, "event_sequence": (match.presentation or {}).get("event_sequence",
                max((e.get("sequence", 0) for e in match.events), default=0)),
                "history_loaded": sync.history_after is not None,
                "history_after": max([sync.history_after or 0, *[row["step"] for row in rows]])}
        return view

    async def history_entries(self, db, match_id, user_id):
        match = await self.repo.get(db, match_id)
        self.member(match, user_id)
        rows = await self.repo.history(db, match_id)
        return {"entries": [{**dict(row), "created_at": row["created_at"].replace(tzinfo=timezone.utc).isoformat()} for row in rows]}

    async def replay(self, db, user_id, operation, resource_id, payload) -> MatchResult | None:
        previous = await self.repo.command(db, user_id, payload.command_id)
        if previous is None:
            return None
        if previous.operation != operation or previous.resource_id != resource_id or previous.payload_hash != payload_hash(payload):
            raise AppError("该命令编号已用于不同请求，请使用新的 command_id", code="command_reused", status_code=409)
        return MatchResult(deepcopy(previous.response_view))

    async def accepted(self, db, match, user_id, operation, resource_id, payload, room_version=None):
        if operation in ("start", "setup_choice", "command"):
            if match.presentation is None or operation in ("start", "setup_choice"):
                match.presentation = presentation.advance(None, match.events, match.state)
            await self.repo.checkpoint(db, match, user_id, history.label(operation, payload), history.snapshot(match))
        await db.flush()
        view = await self.view(db, match, user_id, payload.sync)
        await self.repo.save_command(db, SavedCommand(user_id=user_id, command_id=payload.command_id,
            operation=operation, resource_id=resource_id, payload_hash=payload_hash(payload),
            match_id=match.id, response_view=deepcopy(view)))
        room_is_public = (await self.rooms.repo.get(db, match.room_id)).is_public if room_version is not None else True
        await db.commit()
        return MatchResult(view, True, tuple(p["user_id"] for p in match.frozen_players), room_version, room_is_public)

    async def recover(self, db, error, user_id, operation, resource_id, payload):
        await db.rollback()
        retry = await self.replay(db, user_id, operation, resource_id, payload)
        if retry is not None:
            return retry
        if isinstance(error, IntegrityError) or isinstance(error, OperationalError) and "locked" in str(error).lower():
            raise AppError("对局或房间已更新，请刷新后重试", code="match_version_conflict", status_code=409) from error
        raise error

    async def start(self, db: AsyncSession, room_id: str, user_id: int, payload: StartMatchCommand) -> MatchResult:
        try:
            retry = await self.replay(db, user_id, "start", room_id, payload)
            if retry is not None:
                return retry
            room = await self.rooms.waiting(db, room_id)
            if room.host_user_id != user_id:
                raise forbidden()
            room_view = await self.rooms.repo.view(db, room)
            if not room_view.all_ready:
                raise AppError("需要所有玩家对当前配置准备就绪后才能开始", code="players_not_ready", status_code=409)
            players = [{"user_id": p.user_id, "player_id": f"u-{p.user_id}", "display_name": p.display_name}
                       for p in room_view.players]
            first = {"mode": payload.first_player.mode}
            if first["mode"] == "fixed":
                chosen = next((p for p in players if p["user_id"] == payload.first_player.user_id), None)
                if chosen is None:
                    raise AppError("先手玩家必须属于当前房间", code="invalid_first_player", status_code=422)
                first["player_id"] = chosen["player_id"]
            snapshot = await load_catalog_snapshot(db)
            await self.rooms.repo.bump(db, room, payload.expected_version)
            match_id = uuid4().hex
            request = {"match_id": match_id, "config": deepcopy(room.config),
                "player_ids": [p["player_id"] for p in players], "first_player": first,
                "catalog_version": snapshot.setup_index["cards_csv_sha256"], "rng_seed": secrets.token_hex(32)}
            outcome = await asyncio.to_thread(calculate_setup, request, snapshot)
            match = Match(id=match_id, room_id=room.id, host_user_id=user_id, version=1,
                frozen_players=players, setup_request=request,
                catalog_snapshot={"cards": snapshot.cards, "setup_index": snapshot.setup_index}, **outcome)
            await self.repo.add(db, match)
            room.status = "playing"
            room.active_match_id = match.id
            return await self.accepted(db, match, user_id, "start", room_id, payload, room.version)
        except Exception as error:
            return await self.recover(db, error, user_id, "start", room_id, payload)

    async def setup_choice(self, db: AsyncSession, match_id: str, user_id: int,
                           payload: SetupChoiceCommand) -> MatchResult:
        try:
            retry = await self.replay(db, user_id, "setup_choice", match_id, payload)
            if retry is not None:
                return retry
            match = await self.repo.get(db, match_id)
            if match.host_user_id != user_id:
                raise forbidden()
            await self.ensure_history(db, match)
            await self.repo.advance(db, match, payload.expected_version)
            snapshot = CatalogSnapshot(**deepcopy(match.catalog_snapshot))
            request = deepcopy(match.setup_request)
            request["scenario_choices"] = {"two_dungeons": {
                "group_a_ids": list(payload.group_a_ids), "group_a_feature_ids": list(payload.group_a_feature_ids)}}
            expected = {"engine_version": match.engine_version, "effects_version": match.effects_version}
            outcome = await asyncio.to_thread(calculate_setup, request, snapshot, expected)
            if outcome["status"] != "active":
                raise AppError("分配选择未完成", code="invalid_setup_choice", status_code=422)
            match.setup_request = request
            for key, value in outcome.items():
                setattr(match, key, value)
            return await self.accepted(db, match, user_id, "setup_choice", match_id, payload)
        except Exception as error:
            return await self.recover(db, error, user_id, "setup_choice", match_id, payload)

    async def cancel(self, db: AsyncSession, match_id: str, user_id: int, payload: MatchCommand) -> MatchResult:
        try:
            retry = await self.replay(db, user_id, "cancel", match_id, payload)
            if retry is not None:
                return retry
            match = await self.repo.get(db, match_id)
            if match.host_user_id != user_id:
                raise forbidden()
            await self.repo.advance(db, match, payload.expected_version, ("setup_pending", "active"))
            room = await self.rooms.repo.get(db, match.room_id)
            await self.repo.reopen_room(db, room, match.id)
            await self.rooms.repo.reset_ready(db, room.id)
            match.status = "cancelled"
            return await self.accepted(db, match, user_id, "cancel", match_id, payload, room.version)
        except Exception as error:
            return await self.recover(db, error, user_id, "cancel", match_id, payload)

    async def play(self, db: AsyncSession, match_id: str, user_id: int, payload: PlayCommand) -> MatchResult:
        try:
            retry = await self.replay(db, user_id, "command", match_id, payload)
            if retry is not None:
                return retry
            match = await self.repo.get(db, match_id)
            member = self.member(match, user_id)
            if match.status != "active":
                raise AppError("对局尚未开始或已经结束，无法提交回合操作",
                               code="match_not_active", status_code=409)
            await self.ensure_history(db, match)
            await self.repo.advance(db, match, payload.expected_version, ("active",))
            state = match.state
            actor = (state.get("pending_choice") or {}).get("player_id", state["active_player_id"])
            if member["player_id"] != actor:
                raise forbidden("当前正在等待另一位玩家操作")
            # Client intent has no authority fields. The HTTP version guards the
            # entire match; the independent engine receives its own state version.
            command = payload.command.model_dump(exclude_none=True)
            command.update(player_id=member["player_id"], expected_version=state["game_version"])
            if command["type"] == "SubmitBattleTeam":
                command["draft"]["target_instance_id"] = None
                command["draft"].update(schema_version="thunderstone.battle-draft/1",
                    engine_version=match.engine_version, game_version=state["game_version"],
                    catalog_version=state["catalog_version"], effects_version=match.effects_version,
                    player_id=member["player_id"])
            result = await asyncio.to_thread(calculate_command, state, command,
                CatalogSnapshot(**match.catalog_snapshot), self.revision(match))
            previous_presentation = match.presentation or presentation.advance(None, match.events, match.state)
            match.state = result["state"]
            match.events = result["events"]
            match.presentation = presentation.advance(previous_presentation, match.events, match.state)
            room_version = None
            if match.state["phase"] == "SETTLING":
                if not isinstance(match.state.get("result"), dict):
                    raise RuntimeError("Settled match has no score result")
                match.status = "finished"
                room = await self.rooms.repo.get(db, match.room_id)
                await self.repo.reopen_room(db, room, match.id)
                await self.rooms.repo.reset_ready(db, room.id)
                room_version = room.version
            return await self.accepted(db, match, user_id, "command", match_id, payload, room_version)
        except Exception as error:
            return await self.recover(db, error, user_id, "command", match_id, payload)

    async def ensure_history(self, db, match):
        if match.history_cursor is None:
            await self.repo.checkpoint(db, match, None, "现有对局起点", history.snapshot(match))

    async def restore(self, db, match_id, user_id, payload):
        try:
            retry = await self.replay(db, user_id, "restore", match_id, payload)
            if retry is not None:
                return retry
            match = await self.repo.get(db, match_id)
            self.member(match, user_id)
            if payload.target_step is not None and match.host_user_id != user_id:
                raise forbidden("只有房主可以跳转操作历史")
            current = await self.repo.history_step(db, match.id, match.history_cursor) if match.history_cursor else None
            target = payload.target_step if payload.target_step is not None else current.parent_step if current else None
            checkpoint = await self.repo.history_step(db, match.id, target) if target else None
            if checkpoint is None or target == match.history_cursor:
                raise AppError("没有可恢复的操作节点", code="invalid_history_step", status_code=409)
            await self.repo.advance(db, match, payload.expected_version, ("active", "setup_pending", "finished"))
            room = await self.rooms.repo.get(db, match.room_id)
            members = await self.rooms.repo.players(db, room.id)
            if room.status == "closed" or room.active_match_id not in (None, match.id) or \
                    {p.user_id for p in members} != {p["user_id"] for p in match.frozen_players}:
                raise AppError("房间参与者或对局已改变，不能恢复旧对局", code="history_room_conflict", status_code=409)
            state = deepcopy(checkpoint.snapshot)
            room_version = None
            if state["status"] == "finished" and room.status == "playing":
                await self.repo.reopen_room(db, room, match.id)
                await self.rooms.repo.reset_ready(db, room.id)
                room_version = room.version
            elif state["status"] in ("active", "setup_pending") and room.status == "waiting":
                await self.repo.resume_room(db, room, match.id)
                await self.rooms.repo.reset_ready(db, room.id)
                room_version = room.version
            for key in history.SNAPSHOT_FIELDS:
                setattr(match, key, state.get(key))
            match.history_cursor = target
            match.history_epoch = (match.history_epoch or 0) + 1
            return await self.accepted(db, match, user_id, "restore", match_id, payload, room_version)
        except Exception as error:
            return await self.recover(db, error, user_id, "restore", match_id, payload)
