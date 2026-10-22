"""Card images, shared browser engine and read-only development data."""

import re

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from backend.app.core.paths import CARDS_ROOT, PROJECT_ROOT
from backend.devtools.effect_lab import CASES, card_coverage, run_case
from backend.devtools.monster_audit import monster_audit_data

router = APIRouter()


@router.get("/engine/engine.js", include_in_schema=False)
def shared_engine_module() -> FileResponse:
    path = PROJECT_ROOT / "engine/dist/browser/engine.js"
    if not path.is_file():
        raise HTTPException(503, "TypeScript engine is not built; run npm ci then npm run build")
    return FileResponse(path, media_type="text/javascript")


@router.get("/monster-audit/data", include_in_schema=False)
def monster_audit_projection() -> dict:
    return monster_audit_data()


@router.get("/effect-lab/cases", include_in_schema=False)
def effect_lab_cases() -> dict:
    return {"cases": CASES}


@router.get("/effect-lab/coverage", include_in_schema=False)
def effect_lab_coverage() -> dict:
    return card_coverage()


@router.get("/effect-lab/cases/{case_id}/run", include_in_schema=False)
def effect_lab_run(case_id: str, choice_index: int = 0) -> dict:
    if case_id not in {item["id"] for item in CASES}:
        raise HTTPException(404, "unknown effect lab case")
    try:
        return run_case(case_id, choice_index=choice_index)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error


@router.get("/cards/{card_id}.png", include_in_schema=False)
def card_image(card_id: str) -> FileResponse:
    if not re.fullmatch(r"TS-\d{4}", card_id):
        raise HTTPException(404)
    path = CARDS_ROOT / "assets" / f"{card_id}.png"
    if not path.is_file():
        raise HTTPException(404)
    return FileResponse(path, media_type="image/png")
