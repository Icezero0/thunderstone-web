"""Network and account application; game rules execute in packages/engine."""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.app.api.v1.setup import router as setup_router
from backend.app.api.v1.battle import router as battle_router
from backend.app.api.resources import router as resources_router
from backend.app.api.v1.auth import router as auth_router
from backend.app.api.v1.users import router as users_router
from backend.app.core.config import get_settings
from backend.app.core.exceptions import register_exception_handlers
from backend.app.core.startup import initialize_runtime
from backend.app.realtime.manager import RealtimeManager
from backend.app.realtime.ws_router import router as ws_router


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await initialize_runtime()
    try:
        yield
    finally:
        from backend.app.integrations.game_engine.shared.client import client
        client.close()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title=settings.app_name, debug=settings.debug, lifespan=lifespan)
    app.state.realtime_manager = RealtimeManager()
    if settings.cors_origins:
        app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins,
                           allow_methods=["*"], allow_headers=["*"])
    app.include_router(setup_router, prefix=settings.api_v1_prefix)
    app.include_router(battle_router, prefix=settings.api_v1_prefix)
    app.include_router(auth_router, prefix=settings.api_v1_prefix)
    app.include_router(users_router, prefix=settings.api_v1_prefix)
    app.include_router(setup_router, prefix="/api", include_in_schema=False)
    app.include_router(resources_router)
    app.include_router(ws_router)
    register_exception_handlers(app)

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
