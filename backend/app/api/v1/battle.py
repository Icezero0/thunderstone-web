"""Local stateless battle sandbox; future rooms supply stored server state to the adapter."""

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.setup import read_payload
from backend.app.core.database import get_db
from backend.app.integrations.game_engine.battle import battle_preparation, submit_battle_team
from backend.app.integrations.game_engine.shared.client import SharedEngineUnavailable
from backend.app.modules.cards.repository import load_catalog_snapshot

router = APIRouter(prefix="/battle", tags=["Local battle sandbox"])


async def _run(request: Request, db: AsyncSession, *, submit: bool) -> JSONResponse:
    payload = await read_payload(request)
    if isinstance(payload, JSONResponse):
        return payload
    if not isinstance(payload, dict) or not isinstance(payload.get("state"), dict):
        return JSONResponse({"status": "error", "message": "state must be a game state object"}, status_code=422)
    try:
        snapshot = await load_catalog_snapshot(db)
        if submit:
            result = submit_battle_team(payload["state"], payload.get("command"), snapshot=snapshot)
        else:
            result = battle_preparation(payload["state"], payload.get("player_id"), snapshot=snapshot)
        return JSONResponse({"status": "ready", **result})
    except SharedEngineUnavailable as error:
        return JSONResponse({"status": "error", "message": str(error)}, status_code=503)
    except (ValueError, KeyError, TypeError) as error:
        return JSONResponse({"status": "error", "message": str(error)}, status_code=422)


@router.post("/context", summary="Project a local preparation state into visible browser inputs")
async def context(request: Request, db: AsyncSession = Depends(get_db)) -> JSONResponse:
    return await _run(request, db, submit=False)


@router.post("/submit", summary="Execute SubmitBattleTeam against a local sandbox state")
async def submit(request: Request, db: AsyncSession = Depends(get_db)) -> JSONResponse:
    return await _run(request, db, submit=True)
