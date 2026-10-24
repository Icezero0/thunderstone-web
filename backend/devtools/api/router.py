"""Local sandbox routes and their existing URL aliases."""

from fastapi import APIRouter

from backend.app.api.v1.configuration import router as configuration_router
from backend.devtools.api import battle, effects, setup


def create_devtools_router(api_prefix: str) -> APIRouter:
    router = APIRouter()
    router.include_router(setup.router, prefix=api_prefix)
    router.include_router(battle.router, prefix=api_prefix)
    router.include_router(effects.router)
    router.include_router(configuration_router, prefix="/api", include_in_schema=False)
    router.include_router(setup.router, prefix="/api", include_in_schema=False)
    return router
