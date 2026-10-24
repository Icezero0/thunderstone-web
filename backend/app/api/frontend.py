"""Serve the built frontend at stable page URLs."""

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from backend.app.core.paths import PROJECT_ROOT

router = APIRouter()
FRONTEND_DIST = PROJECT_ROOT / "frontend/dist"
PAGE_FILES = {
    "/": "index.html", "/play": "index.html", "/config": "config.html",
    "/effect-lab": "effect-lab.html", "/match": "match.html", "/game-probe": "game-probe.html",
    "/profile": "profile.html",
}


def page_handler(filename: str):
    def page() -> FileResponse:
        path = FRONTEND_DIST / filename
        if not path.is_file():
            raise HTTPException(503, "Frontend is not built; run npm run build at the project root")
        return FileResponse(path, media_type="text/html", headers={"Cache-Control": "no-cache"})
    return page


for route, filename in PAGE_FILES.items():
    router.add_api_route(route, page_handler(filename), methods=["GET"], include_in_schema=False)
