"""Async database session lifecycle for future persistent domain modules."""

from collections.abc import AsyncGenerator
from functools import lru_cache

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from backend.app.core.config import get_settings


@lru_cache
def get_engine() -> AsyncEngine:
    settings = get_settings()
    if settings.sqlite_path is not None:
        settings.sqlite_path.parent.mkdir(parents=True, exist_ok=True)
    engine = create_async_engine(settings.database_url, echo=settings.log_sql)
    if settings.database_url.startswith("sqlite+"):
        @event.listens_for(engine.sync_engine, "connect")
        def enable_foreign_keys(connection, _record) -> None:
            cursor = connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()
    return engine


@lru_cache
def get_session_factory() -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(get_engine(), expire_on_commit=False, autoflush=False)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with get_session_factory()() as session:
        yield session
