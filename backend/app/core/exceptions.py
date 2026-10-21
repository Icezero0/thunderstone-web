"""Transport-level errors for the account and future room APIs."""

from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse


class AppError(Exception):
    def __init__(self, message: str, *, code: str, status_code: int,
                 details: dict[str, Any] | None = None):
        super().__init__(message)
        self.message = message
        self.code = code
        self.status_code = status_code
        self.details = details


class ConflictError(AppError):
    def __init__(self, message: str = "Conflict"):
        super().__init__(message, code="conflict", status_code=409)


class UnauthorizedError(AppError):
    def __init__(self, message: str = "Unauthorized"):
        super().__init__(message, code="unauthorized", status_code=401)


class NotFoundError(AppError):
    def __init__(self, message: str = "Not found"):
        super().__init__(message, code="not_found", status_code=404)


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def handle_app_error(_request: Request, error: AppError) -> JSONResponse:
        return JSONResponse(status_code=error.status_code, content={"error": {
            "code": error.code, "message": error.message, "details": error.details,
        }})
