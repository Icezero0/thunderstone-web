"""Run one deterministic setup from a panel-exported rules configuration."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from backend.app.integrations.game_engine.setup import SetupChoiceRequired, SetupError, start_game  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True, help="面板导出的规则配置 JSON")
    parser.add_argument("--players", nargs="+", required=True, help="按玩家列表顺序列出玩家 ID")
    parser.add_argument("--seed", required=True, help="可复现的随机种子")
    parser.add_argument("--match-id", required=True)
    parser.add_argument("--first-player", help="指定先手玩家 ID；省略则随机")
    parser.add_argument("--choices", type=Path, help="特殊场景选择 JSON")
    parser.add_argument("--output", type=Path, required=True, help="写入完整初始状态与私有设置事件")
    args = parser.parse_args()
    try:
        request = {
            "match_id": args.match_id, "player_ids": args.players, "rng_seed": args.seed,
            "config": json.loads(args.config.read_text(encoding="utf-8-sig")),
            "first_player": ({"mode": "fixed", "player_id": args.first_player}
                             if args.first_player else {"mode": "random"}),
        }
        if args.choices:
            request["scenario_choices"] = json.loads(args.choices.read_text(encoding="utf-8-sig"))
        result = start_game(request)
    except SetupChoiceRequired as error:
        print(json.dumps({"required_choice": error.choice}, ensure_ascii=False, indent=2))
        return 2
    except (SetupError, OSError, json.JSONDecodeError) as error:
        print(json.dumps({"error": str(error), "issues": getattr(error, "issues", [])},
                         ensure_ascii=False, indent=2), file=sys.stderr)
        return 1
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
