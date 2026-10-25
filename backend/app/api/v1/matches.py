"""Authenticated match projections and explicit participant snapshot downloads."""

import asyncio

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.database import get_db
from backend.app.modules.auth.deps import get_current_user
from backend.app.modules.matches.schemas import MatchCommand, SetupChoiceCommand, StartMatchCommand, RestoreMatchCommand
from backend.app.modules.matches.command_schemas import PlayCommand
from backend.app.modules.matches.service import MatchResult, MatchService
from backend.app.modules.users.models import User

router = APIRouter(tags=["matches"])
service = MatchService()


async def publish(request: Request, result: MatchResult) -> dict:
    if result.changed:
        manager = request.app.state.realtime_manager
        if result.room_version is not None:
            await manager.broadcast({"v": 1, "type": "room_changed", "payload": {
                "room_id": result.view["room_id"], "version": result.room_version} if result.room_is_public else {}})
        message = {"v": 1, "type": "match_changed", "payload": {
            "match_id": result.view["id"], "version": result.view["version"]}}
        await asyncio.gather(*(manager.send_to_user(user_id, message) for user_id in result.participant_ids))
    return result.view


@router.post("/rooms/{room_id}/start")
async def start(room_id: str, payload: StartMatchCommand, request: Request,
                user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    return await publish(request, await service.start(db, room_id, user.id, payload))


@router.get("/matches/current")
async def current(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    return {"match": await service.current(db, user.id)}


@router.get("/matches/{match_id}")
async def match(match_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    return await service.get(db, match_id, user.id)


@router.get("/matches/{match_id}/export")
async def export_match(match_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    data = await service.export(db, match_id, user.id)
    filename = f"thunderstone-match-{data['match']['id']}-v{data['match']['version']}.json"
    return JSONResponse(data, headers={"Cache-Control": "no-store",
        "Content-Disposition": f'attachment; filename="{filename}"'})


@router.post("/matches/{match_id}/setup-choice")
async def setup_choice(match_id: str, payload: SetupChoiceCommand, request: Request,
                       user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    return await publish(request, await service.setup_choice(db, match_id, user.id, payload))


@router.post("/matches/{match_id}/cancel")
async def cancel(match_id: str, payload: MatchCommand, request: Request,
                 user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    return await publish(request, await service.cancel(db, match_id, user.id, payload))


@router.post("/matches/{match_id}/commands")
async def commands(match_id: str, payload: PlayCommand, request: Request,
                   user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    return await publish(request, await service.play(db, match_id, user.id, payload))


@router.post("/matches/{match_id}/history/restore")
async def restore_history(match_id: str, payload: RestoreMatchCommand, request: Request,
                          user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    return await publish(request, await service.restore(db, match_id, user.id, payload))
