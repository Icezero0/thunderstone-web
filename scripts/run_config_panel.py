r"""Run the Thunderstone API and local setup panel.

Use: .\.venv\Scripts\python.exe scripts\run_config_panel.py
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.app.api.v1.setup import setup_response  # noqa: E402,F401


def main() -> None:
    import uvicorn

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    uvicorn.run("backend.app.main:app", host=args.host, port=args.port)


if __name__ == "__main__":
    main()
