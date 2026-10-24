"""Environment-backed application settings, adapted from iCinema."""

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from backend.app.core.paths import DATA_ROOT, PROJECT_ROOT


class Settings(BaseSettings):
    app_name: str = "Thunderstone Backend"
    app_env: str = "development"
    debug: bool = False
    api_v1_prefix: str = "/api/v1"
    log_sql: bool = False
    database_url: str = Field(default_factory=lambda: (
        f"sqlite+aiosqlite:///{(DATA_ROOT / 'thunderstone.db').as_posix()}"
    ))
    jwt_secret_key: str | None = None
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = Field(default=60, ge=1)
    refresh_token_expire_days: int = Field(default=7, ge=1)
    ws_auth_timeout_seconds: int = Field(default=10, ge=1)
    cors_origins: list[str] = Field(default_factory=list)
    avatar_dir: Path = Field(default_factory=lambda: DATA_ROOT / "avatars")

    model_config = SettingsConfigDict(
        env_file=PROJECT_ROOT / ".env",
        env_file_encoding="utf-8",
        env_prefix="THUNDERSTONE_",
        extra="ignore",
    )

    @property
    def sqlite_path(self) -> Path | None:
        prefix = "sqlite+aiosqlite:///"
        return Path(self.database_url.removeprefix(prefix)) if self.database_url.startswith(prefix) else None

    @property
    def alembic_database_url(self) -> str:
        return self.database_url.replace("+aiosqlite", "")


@lru_cache
def get_settings() -> Settings:
    return Settings()
