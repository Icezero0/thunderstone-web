"""Launch the backend from any working directory with the project virtualenv."""

from __future__ import annotations

import argparse
from importlib.util import find_spec
from pathlib import Path
import shutil
import sys

BACKEND_ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = BACKEND_ROOT.parent
sys.path.insert(0, str(PROJECT_ROOT))


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--reload", action=argparse.BooleanOptionalAction, default=True)
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    if shutil.which("node") is None:
        parser.error("Node.js 22.12+ is required for the shared engine")
    if not (PROJECT_ROOT / "engine/dist/index.js").is_file():
        parser.error("Shared engine is not built. Run npm ci and npm run build:engine at the project root")
    if not any(find_spec(name) for name in ("websockets", "wsproto")):
        parser.error("WebSocket support is missing. Install backend/requirements.txt into the project .venv")
    import uvicorn

    options = {"host": args.host, "port": args.port, "reload": args.reload,
               "app_dir": str(PROJECT_ROOT)}
    if args.reload:
        options["reload_dirs"] = [str(BACKEND_ROOT / "app"), str(BACKEND_ROOT / "devtools")]
    uvicorn.run("backend.app.main:app", **options)


if __name__ == "__main__":
    main()
