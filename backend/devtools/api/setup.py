"""Local setup preview; returns a complete private sandbox state."""

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.payloads import read_payload
from backend.app.core.database import get_db
from backend.app.integrations.game_engine.api import CatalogSnapshot, SetupChoiceRequired, SetupError, start_game
from backend.app.modules.cards.repository import load_catalog_snapshot

router = APIRouter(tags=["Local setup sandbox"])


def setup_response(payload: object, *,
                   snapshot: CatalogSnapshot | None = None) -> tuple[int, dict]:
    """Return the setup result, a scenario choice, or a validation error."""
    try:
        result = start_game(payload, snapshot=snapshot)
    except SetupChoiceRequired as error:
        return 200, {"status": "choice_required", "choice": error.choice}
    except SetupError as error:
        return 422, {"status": "error", "message": str(error), "issues": error.issues}
    return 200, {"status": "ready", **result}


@router.post("/setup")
async def setup(request: Request, db: AsyncSession = Depends(get_db)) -> JSONResponse:
    payload = await read_payload(request)
    if isinstance(payload, JSONResponse):
        return payload
    status, result = setup_response(payload, snapshot=await load_catalog_snapshot(db))
    return JSONResponse(result, status_code=status)
