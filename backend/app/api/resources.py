"""Static assets required by the local setup preview."""

import re

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from backend.app.core.paths import PROJECT_ROOT
from devtools.effect_lab import CASES, card_coverage, run_case
from devtools.monster_audit import monster_audit_data

router = APIRouter()


@router.get("/", include_in_schema=False)
def panel() -> FileResponse:
    return FileResponse(PROJECT_ROOT / "web" / "config_panel.html")


@router.get("/panel.css", include_in_schema=False)
def panel_css() -> FileResponse:
    return FileResponse(PROJECT_ROOT / "web" / "panel.css", media_type="text/css")


@router.get("/panel.js", include_in_schema=False)
def panel_js() -> FileResponse:
    return FileResponse(PROJECT_ROOT / "web" / "panel.js", media_type="text/javascript")


@router.get("/effect-lab", include_in_schema=False)
def effect_lab_page() -> FileResponse:
    return FileResponse(PROJECT_ROOT / "web" / "effect_lab.html")


@router.get("/monster-audit", include_in_schema=False)
def monster_audit_page() -> FileResponse:
    return FileResponse(PROJECT_ROOT / "web" / "monster_audit.html")


@router.get("/monster-audit.css", include_in_schema=False)
def monster_audit_css() -> FileResponse:
    return FileResponse(PROJECT_ROOT / "web" / "monster_audit.css", media_type="text/css")


@router.get("/monster-audit.js", include_in_schema=False)
def monster_audit_js() -> FileResponse:
    return FileResponse(PROJECT_ROOT / "web" / "monster_audit.js", media_type="text/javascript")


@router.get("/monster-audit/data", include_in_schema=False)
def monster_audit_projection() -> dict:
    return monster_audit_data()


@router.get("/effect-lab.css", include_in_schema=False)
def effect_lab_css() -> FileResponse:
    return FileResponse(PROJECT_ROOT / "web" / "effect_lab.css", media_type="text/css")


@router.get("/effect-lab.js", include_in_schema=False)
def effect_lab_js() -> FileResponse:
    return FileResponse(PROJECT_ROOT / "web" / "effect_lab.js", media_type="text/javascript")


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
    path = PROJECT_ROOT / "assets" / "cards" / f"{card_id}.png"
    if not path.is_file():
        raise HTTPException(404)
    return FileResponse(path, media_type="image/png")
