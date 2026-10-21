"""Thin HTTP routes for catalog options and game setup preview."""

import json

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from engine.catalog.repository import CatalogSnapshot
from engine.catalog.service import build_panel_catalog
from engine.rules.service import validate_rules_config
from engine.setup import SetupChoiceRequired, SetupError, start_game

from backend.app.core.database import get_db
from backend.app.modules.cards.repository import load_catalog_snapshot

router = APIRouter()


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


async def read_payload(request: Request) -> object | JSONResponse:
    invalid = {"valid": False, "errors": [
        {"path": "$", "message": "请求必须是有效 JSON，且不超过 1 MB"}
    ]}
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 1_000_000:
            return JSONResponse(invalid, status_code=400)
    if not body:
        return JSONResponse(invalid, status_code=400)
    try:
        return json.loads(body)
    except (ValueError, UnicodeDecodeError):
        return JSONResponse(invalid, status_code=400)


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


@router.post("/setup")
async def setup(request: Request, db: AsyncSession = Depends(get_db)) -> JSONResponse:
    payload = await read_payload(request)
    if isinstance(payload, JSONResponse):
        return payload
    status, result = setup_response(payload, snapshot=await load_catalog_snapshot(db))
    return JSONResponse(result, status_code=status)
