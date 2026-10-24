"""Public catalog options and rule configuration validation."""

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.payloads import read_payload
from backend.app.core.database import get_db
from backend.app.integrations.game_engine.api import build_panel_catalog, validate_rules_config
from backend.app.modules.cards.repository import load_catalog_snapshot

router = APIRouter(tags=["Configuration"])


@router.get("/options")
async def options(db: AsyncSession = Depends(get_db)) -> dict:
    snapshot = await load_catalog_snapshot(db)
    return build_panel_catalog(snapshot.cards, snapshot.setup_index)


@router.post("/validate")
async def validate(request: Request, db: AsyncSession = Depends(get_db)) -> JSONResponse:
    payload = await read_payload(request)
    if isinstance(payload, JSONResponse):
        return payload
    snapshot = await load_catalog_snapshot(db)
    errors = validate_rules_config(payload,
                                   build_panel_catalog(snapshot.cards, snapshot.setup_index))
    return JSONResponse({"valid": not errors, "errors": errors})


