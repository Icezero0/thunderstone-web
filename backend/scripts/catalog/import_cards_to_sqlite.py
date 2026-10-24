"""Migrate the published CSV and setup index into the backend SQLite database."""

import argparse
import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from backend.app.core.database import get_session_factory  # noqa: E402
from backend.app.core.startup import _upgrade_database  # noqa: E402
from backend.app.modules.cards.importer import import_catalog  # noqa: E402


async def _run(replace: bool) -> dict:
    async with get_session_factory()() as db:
        return await import_catalog(db, replace=replace)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--replace", action="store_true",
                        help="replace an existing catalog revision atomically")
    args = parser.parse_args()
    try:
        _upgrade_database()
        result = asyncio.run(_run(args.replace))
    except (OSError, ValueError) as error:
        print(f"catalog import failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
