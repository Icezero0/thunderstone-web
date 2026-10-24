"""Public card images and the shared browser engine bundle."""

import re

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from backend.app.core.paths import CARDS_ROOT, PROJECT_ROOT

router = APIRouter()


@router.get("/engine/engine.js", include_in_schema=False)
def shared_engine_module() -> FileResponse:
    path = PROJECT_ROOT / "engine/dist/browser/engine.js"
    if not path.is_file():
        raise HTTPException(503, "TypeScript engine is not built; run npm ci then npm run build")
    return FileResponse(path, media_type="text/javascript")


@router.get("/cards/{filename}", include_in_schema=False)
def card_image(filename: str) -> FileResponse:
    if not re.fullmatch(r"(?:TS-\d{4}\.png|TS-BACK-001\.jpg)", filename):
        raise HTTPException(404)
    path = CARDS_ROOT / "assets" / filename
    if not path.is_file():
        raise HTTPException(404)
    return FileResponse(path, media_type="image/jpeg" if filename.endswith(".jpg") else "image/png")
