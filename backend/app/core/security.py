"""Password hashing and versioned JWTs adapted from iCinema."""

import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from jose import jwt
from passlib.context import CryptContext

from backend.app.core.config import get_settings
from backend.app.core.exceptions import UnauthorizedError
from backend.app.core.paths import PROJECT_ROOT

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(password: str, hashed_password: str) -> bool:
    return pwd_context.verify(password, hashed_password)


def _jwt_secret() -> str:
    settings = get_settings()
    if settings.jwt_secret_key:
        return settings.jwt_secret_key
    if settings.app_env != "development":
        raise RuntimeError("THUNDERSTONE_JWT_SECRET_KEY is required outside development")
    path = PROJECT_ROOT / "backend" / "instance" / "jwt_secret"
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("x", encoding="ascii") as handle:
            handle.write(secrets.token_urlsafe(48))
    except FileExistsError:
        pass
    return path.read_text(encoding="ascii").strip()


def create_access_token(subject: str, *, token_version: int = 0) -> str:
    settings = get_settings()
    now = datetime.now(timezone.utc)
    payload: dict[str, Any] = {
        "sub": subject, "type": "access", "iat": now,
        "exp": now + timedelta(minutes=settings.access_token_expire_minutes),
        "ver": token_version,
    }
    return jwt.encode(payload, _jwt_secret(), algorithm=settings.jwt_algorithm)


def create_refresh_token(subject: str, *, token_version: int = 0) -> str:
    settings = get_settings()
    now = datetime.now(timezone.utc)
    payload = {
        "sub": subject, "type": "refresh", "iat": now,
        "exp": now + timedelta(days=settings.refresh_token_expire_days),
        "ver": token_version,
    }
    return jwt.encode(payload, _jwt_secret(), algorithm=settings.jwt_algorithm)


def decode_token(token: str) -> dict[str, Any]:
    settings = get_settings()
    return jwt.decode(token, _jwt_secret(), algorithms=[settings.jwt_algorithm])


def require_token_version(payload: dict[str, Any], current_version: int) -> None:
    version = payload.get("ver", 0)
    if type(version) is not int or version != current_version:
        raise UnauthorizedError("Session has been revoked")
