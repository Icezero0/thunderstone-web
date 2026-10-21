"""Apply database migrations before serving account requests."""

import asyncio

from alembic import command
from alembic.config import Config

from backend.app.core.config import get_settings
from backend.app.core.paths import PROJECT_ROOT


def _upgrade_database() -> None:
    settings = get_settings()
    if settings.sqlite_path is not None:
        settings.sqlite_path.parent.mkdir(parents=True, exist_ok=True)
    config = Config(str(PROJECT_ROOT / "backend" / "alembic.ini"))
    config.set_main_option("sqlalchemy.url", settings.alembic_database_url)
    command.upgrade(config, "head")


async def initialize_runtime() -> None:
    await asyncio.to_thread(_upgrade_database)
