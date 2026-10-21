"""Authenticated user dependency for HTTP and future room routes."""

from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.database import get_db
from backend.app.core.exceptions import UnauthorizedError
from backend.app.core.security import decode_token, require_token_version
from backend.app.modules.users.models import User
from backend.app.modules.users.repository import UserRepository

bearer_scheme = HTTPBearer(auto_error=False)


async def authenticate_access_token(db: AsyncSession, token: str) -> User:
    try:
        payload = decode_token(token)
    except Exception as error:
        raise UnauthorizedError("Invalid token") from error
    if payload.get("type") != "access":
        raise UnauthorizedError("Invalid token type")
    try:
        user_id = int(payload["sub"])
    except (KeyError, TypeError, ValueError) as error:
        raise UnauthorizedError("Invalid token payload") from error
    user = await UserRepository().get_by_id(db, user_id)
    if user is None:
        raise UnauthorizedError("User not found")
    require_token_version(payload, user.token_version)
    return user


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: AsyncSession = Depends(get_db),
) -> User:
    if credentials is None:
        raise UnauthorizedError("Missing authorization token")
    return await authenticate_access_token(db, credentials.credentials)
