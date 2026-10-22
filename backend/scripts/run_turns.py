"""Replay basic turn commands against a setup state without starting a server."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from backend.app.integrations.game_engine.turn import apply_command, legal_commands  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, required=True,
                        help="JSON state or full output from backend/scripts/run_setup.py")
    parser.add_argument("--commands", type=Path, required=True,
                        help="JSON list of commands, each with type and player_id")
    parser.add_argument("--output", type=Path, required=True,
                        help="write resulting state, events and next legal commands")
    args = parser.parse_args()
    loaded = json.loads(args.state.read_text(encoding="utf-8-sig"))
    state = loaded.get("state", loaded)
    commands = json.loads(args.commands.read_text(encoding="utf-8-sig"))
    if not isinstance(commands, list):
        parser.error("--commands must contain a JSON list")
    events = []
    for position, command in enumerate(commands, start=1):
        try:
            result = apply_command(state, command)
        except ValueError as error:
            parser.error(f"command {position}: {error}")
        state = result["state"]
        events.extend(result["events"])
    output = {"state": state, "events": events,
              "legal_commands": legal_commands(state)}
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2),
                           encoding="utf-8")
    print(json.dumps({"game_version": state["game_version"],
                      "turn_number": state["turn_number"],
                      "active_player_id": state["active_player_id"],
                      "subphase": state["subphase"],
                      "event_count": len(events)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
