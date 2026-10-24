"""Bounded JSON parsing shared by HTTP routes."""

import json

from fastapi import Request
from fastapi.responses import JSONResponse


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


