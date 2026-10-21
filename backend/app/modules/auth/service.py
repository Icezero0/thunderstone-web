"""Login and refresh logic adapted from iCinema's auth service."""

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.exceptions import UnauthorizedError
from backend.app.core.security import (create_access_token, create_refresh_token,
                                       decode_token, require_token_version,
                                       verify_password)
from backend.app.modules.users.repository import UserRepository


class AuthService:
    def __init__(self) -> None:
        self.user_repo = UserRepository()

    @staticmethod
    def _tokens(user_id: int, token_version: int) -> dict[str, str]:
        return {
            "access_token": create_access_token(str(user_id), token_version=token_version),
            "refresh_token": create_refresh_token(str(user_id), token_version=token_version),
            "token_type": "bearer",
        }

    async def login(self, db: AsyncSession, *, email: str, password: str) -> dict[str, str]:
        user = await self.user_repo.get_by_email(db, email)
        if user is None or not verify_password(password, user.hashed_password):
            raise UnauthorizedError("Invalid email or password")
        return self._tokens(user.id, user.token_version)

    async def refresh_tokens(self, db: AsyncSession, *, refresh_token: str) -> dict[str, str]:
        try:
            payload = decode_token(refresh_token)
        except Exception as error:
            raise UnauthorizedError("Invalid refresh token") from error
        if payload.get("type") != "refresh":
            raise UnauthorizedError("Invalid token type")
        try:
            user_id = int(payload["sub"])
        except (KeyError, TypeError, ValueError) as error:
            raise UnauthorizedError("Invalid token payload") from error
        user = await self.user_repo.get_by_id(db, user_id)
        if user is None:
            raise UnauthorizedError("User not found")
        require_token_version(payload, user.token_version)
        return self._tokens(user.id, user.token_version)
