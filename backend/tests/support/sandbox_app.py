"""Mount retired sandbox transports only in isolated, in-process test apps."""

from backend.app.main import create_app
from backend.app.core.config import get_settings
from backend.devtools.api.router import create_devtools_router


def create_sandbox_app():
    app = create_app()
    app.include_router(create_devtools_router(get_settings().api_v1_prefix))
    return app
