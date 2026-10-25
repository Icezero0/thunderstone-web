"""Public browser resources with conditional HTTP caching."""

import re
from functools import lru_cache
from hashlib import file_digest
from email.utils import parsedate_to_datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response

from backend.app.core.paths import CARDS_ROOT, PROJECT_ROOT

router = APIRouter()


@lru_cache(maxsize=1024)
def _content_etag(path: Path, size: int, modified_ns: int, changed_ns: int) -> str:
    # Metadata invalidates this small digest cache; the HTTP version is based on
    # bytes so rebuilding/copying an unchanged PDF does not force a redownload.
    with path.open('rb') as source:
        return '"' + file_digest(source, 'sha256').hexdigest() + '"'


def public_file(request: Request, path: Path, media_type: str) -> Response:
    """Keep disk-cache entries reusable without leaving changed files stale."""
    try:
        stat = path.stat()
    except FileNotFoundError:
        raise HTTPException(404)
    response = FileResponse(path, media_type=media_type, stat_result=stat, headers={
        "Cache-Control": "public, no-cache", "X-Content-Type-Options": "nosniff",
        "ETag": _content_etag(path, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns),
    })
    etag = request.headers.get("if-none-match")
    if etag is not None:
        unchanged = any(value.strip().removeprefix("W/") in ("*", response.headers["etag"])
                        for value in etag.split(","))
    else:
        try:
            modified = parsedate_to_datetime(request.headers.get("if-modified-since", ""))
            unchanged = int(stat.st_mtime) <= modified.timestamp()
        except (ValueError, TypeError, OverflowError):
            unchanged = False
    if unchanged:
        return Response(status_code=304, headers={key: response.headers[key] for key in
            ("cache-control", "etag", "last-modified", "x-content-type-options")})
    return response


@router.get("/engine/engine.js", include_in_schema=False)
def shared_engine_module() -> FileResponse:
    path = PROJECT_ROOT / "engine/dist/browser/engine.js"
    if not path.is_file():
        raise HTTPException(503, "TypeScript engine is not built; run npm ci then npm run build")
    return FileResponse(path, media_type="text/javascript")


@router.api_route("/cards/{filename}", methods=["GET", "HEAD"], include_in_schema=False)
def card_image(filename: str, request: Request) -> Response:
    if not re.fullmatch(r"(?:TS-\d{4}\.png|TS-BACK-001\.jpg)", filename):
        raise HTTPException(404)
    path = CARDS_ROOT / "assets" / filename
    if not path.is_file():
        raise HTTPException(404)
    return public_file(request, path, "image/jpeg" if filename.endswith(".jpg") else "image/png")


@router.api_route("/rulebooks/TS4_rules_CN.pdf", methods=["GET", "HEAD"], include_in_schema=False)
def rulebook(request: Request) -> Response:
    return public_file(request, PROJECT_ROOT / "frontend/dist/rulebooks/TS4_rules_CN.pdf", "application/pdf")


@router.get("/asset-cache-sw.js", include_in_schema=False)
def asset_cache_worker(request: Request) -> Response:
    return public_file(request, PROJECT_ROOT / "frontend/dist/asset-cache-sw.js", "text/javascript")


@router.api_route("/favicon.ico", methods=["GET", "HEAD"], include_in_schema=False)
def favicon(request: Request) -> Response:
    return public_file(request, PROJECT_ROOT / "frontend/dist/favicon.ico", "image/x-icon")
