"""Local effect traces and per-card coverage reports."""

from fastapi import APIRouter, HTTPException

from backend.devtools.effect_lab.service import CASES, card_coverage, run_case

router = APIRouter(prefix="/effect-lab", include_in_schema=False)


@router.get("/cases")
def cases() -> dict:
    return {"cases": CASES}


@router.get("/coverage")
def coverage() -> dict:
    return card_coverage()


@router.get("/cases/{case_id}/run")
def run(case_id: str, choice_index: int = 0) -> dict:
    if case_id not in {item["id"] for item in CASES}:
        raise HTTPException(404, "unknown effect lab case")
    try:
        return run_case(case_id, choice_index=choice_index)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
