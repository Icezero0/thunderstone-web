r"""Materialize manually selected exact card lines as reviewed JSON and contracts.

Use: .\.venv\Scripts\python.exe backend\scripts\effects\build_simple_effects.py [--check]
This is an offline review tool. The engine only reads the generated JSON.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CARDS = ROOT / "cards" / "cards.csv"
DRAFT = ROOT / "docs" / "游戏引擎设计参考" / "thunderstone_card_rules_v0.3.2_engine.json"
SIMPLE_JSON = ROOT / "cards" / "effects" / "simple-reviewed.json"
ACTIVATED_CSV = ROOT / "cards" / "contracts" / "activated-contracts.csv"
PRINTED_CSV = ROOT / "cards" / "contracts" / "printed-contracts.csv"
TARGET_CSV = ROOT / "cards" / "contracts" / "target-contracts.csv"
BATTLE_CSV = ROOT / "cards" / "contracts" / "battle-contracts.csv"

# Exact, individually reviewed source lines. Other abilities on these cards
# remain unimplemented until their timing and targets have been bound.
SIMPLE = (
    ("TS-0211-A01", ("village",), "draw", 2),
    ("TS-0222-A01", ("village",), "draw", 1),
    ("TS-0225-A01", ("village", "dungeon"), "draw", 1),
    ("TS-0227-A01", ("village", "dungeon"), "draw", 1),
    ("TS-0373-A03", ("dungeon",), "draw", 1),
    ("TS-0374-A02", ("dungeon",), "draw", 1),
    ("TS-0427-A03", ("village", "dungeon"), "draw", 1),
    ("TS-0429-A02", ("dungeon",), "draw", 1),
    ("TS-0430-A03", ("dungeon",), "draw", 1),
    ("TS-0431-A02", ("dungeon",), "draw", 1),
    ("TS-0433-A02", ("dungeon",), "draw", 1),
    ("TS-0434-A02", ("dungeon",), "draw", 2),
    ("TS-0446-A02", ("dungeon",), "draw", 1),
    ("TS-0492-A03", ("dungeon",), "draw", 1),
    ("TS-0494-A03", ("dungeon",), "draw", 1),
    ("TS-0537-A02", ("dungeon",), "draw", 1),
    ("TS-0708-A02", ("dungeon",), "draw", 2),
    ("TS-0435-A02", ("dungeon",), "gain_xp", 1),
    ("TS-0436-A02", ("dungeon",), "gain_xp", 2),
    ("TS-0527-A04", ("village", "dungeon"), "gain_xp", 1),
    ("TS-0219-A02", ("dungeon",), "mod_attack", 1),
    ("TS-0227-A02", ("dungeon",), "mod_magic_attack", 1),
)

SELF_GOLD = ("TS-0210-A02", "TS-0213-A02", "TS-0215-A02")
EXTRA_BUY = ("TS-0220-A01", "TS-0225-A02", "TS-0215-A01")
DISEASE_DRAW = (
    # ability ID, action scope, usage, wording before draw, draw count
    ("TS-0372-A02", ("dungeon",), "repeatable", "以抽", 1),
    ("TS-0373-A04", ("dungeon",), "repeatable", "抽", 1),
    ("TS-0376-A03", ("dungeon",), "once_per_turn", "抽", 1),
    ("TS-0426-A02", ("village", "dungeon"), "once_per_turn", "抽", 1),
    ("TS-0431-A03", ("village", "dungeon"), "once_per_turn", "以抽", 3),
    ("TS-0432-A02", ("dungeon",), "repeatable", "抽", 1),
    ("TS-0433-A03", ("dungeon",), "repeatable", "抽", 1),
    ("TS-0434-A03", ("dungeon",), "repeatable", "抽", 2),
    ("TS-0524-A03", ("dungeon",), "once_per_turn", "抽取", 1),
)

PLAIN = re.compile(r"^(攻击|魔法攻击|光照|光照值) ([+-][0-9]+)。$")
STAT = {"攻击": "attack", "魔法攻击": "magic_attack", "光照": "light", "光照值": "light"}


def _csv_bytes(rows: list[dict], fields: list[str]) -> bytes:
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=fields, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue().encode("utf-8-sig")


def build_artifacts() -> dict[Path, bytes]:
    with CARDS.open(encoding="utf-8-sig", newline="") as handle:
        cards = {row["card_id"]: row for row in csv.DictReader(handle)}
    draft = json.loads(DRAFT.read_text(encoding="utf-8-sig"))
    abilities = {ability["id"]: ability for card in draft["cards"]
                 for ability in card["abilities"]}
    card_abilities = {card["id"]: card["abilities"] for card in draft["cards"]}
    symbol_reviews = json.loads((ROOT / "cards/reviews/monster-symbols.json").read_text(encoding="utf-8"))["abilities"]

    executable = []
    activation_contracts = []
    def add_reviewed(ability_id: str, actions: tuple[str, ...], op: str,
                     amount: int, line: str, body: dict, *,
                     conditions: list[dict] | None = None,
                     usage: str = "once_per_turn") -> None:
        card_id = ability_id.split("-A", 1)[0]
        if (ability_id not in abilities or abilities[ability_id]["source_line"] != line
                or line not in cards[card_id]["effect_text"].splitlines()):
            raise ValueError(f"reviewed line changed or ability ID is wrong: {ability_id}")
        executable.append({
            "id": ability_id, "source_card_id": card_id, "kind": "activated",
            "actions": list(actions), "source_zone": "active_hand",
            "usage": usage, "conditions": conditions or [], "body": body,
        })
        activation_contracts.append({
            "card_id": card_id, "ability_id": ability_id,
            "actions": "|".join(actions), "usage": usage, "op": op,
            "amount": amount, "source_line": line,
        })

    for ability_id, actions, op, amount in SIMPLE:
        prefix = {("village",): "村庄", ("dungeon",): "地下城",
                  ("village", "dungeon"): "村庄 / 地下城"}[actions]
        clause = {"draw": f"抽 {amount} 张牌。",
                  "gain_xp": f"获得 {amount} 点经验值。",
                  "mod_attack": f"攻击 +{amount}。",
                  "mod_magic_attack": f"魔法攻击 +{amount}。"}[op]
        line = f"{prefix}：{clause}"
        add_reviewed(ability_id, actions, op, amount, line,
                     {"op": op, "count" if op == "draw" else "amount": amount})

    for ability_id in SELF_GOLD:
        add_reviewed(ability_id, ("village",), "destroy_self_gold", 2,
                     "村庄：摧毁此牌，获得 2 金币。", {
                         "op": "cost_gate",
                         "cost": {"op": "destroy", "target": {"var": "source"}},
                         "then": {"op": "mod_gold", "amount": 2},
                     })

    for ability_id in EXTRA_BUY:
        clause = ("本回合你可以额外购买 1 张牌。" if ability_id == "TS-0215-A01"
                  else "你可以额外购买 1 张牌。")
        add_reviewed(ability_id, ("village",), "grant_buy", 1,
                     f"村庄：{clause}", {"op": "grant_buy", "amount": 1})

    disease = {"zone": "active_hand", "tag": "疾病"}
    for ability_id, actions, usage, verb, amount in DISEASE_DRAW:
        prefix = ("重复地下城" if usage == "repeatable" else
                  "村庄 / 地下城" if len(actions) == 2 else "地下城")
        line = f"{prefix}：摧毁 1 张疾病，{verb} {amount} 张牌。"
        add_reviewed(ability_id, actions, "destroy_disease_draw", amount,
                     line, {
                         "op": "select", "query": disease, "bind": "disease",
                         "min": 1, "max": 1,
                         "then": {"op": "cost_gate", "cost": {
                             "op": "destroy", "target": {"var": "disease"}},
                             "then": {"op": "draw", "count": amount}},
                     }, conditions=[{"exists": disease}], usage=usage)

    add_reviewed("TS-0213-A01", ("village",), "destroy_militia_xp", 2,
                 "村庄：摧毁 1 名民兵，获得 2 点经验值。", {
                     "op": "select", "query": {"zone": "active_hand",
                                                 "tag": "民兵"},
                     "bind": "militia", "min": 1, "max": 1,
                     "then": {"op": "cost_gate", "cost": {
                         "op": "destroy", "target": {"var": "militia"}},
                         "then": {"op": "gain_xp", "amount": 2}},
                 }, conditions=[{"exists": {"zone": "active_hand",
                                            "tag": "民兵"}}])

    printed_contracts = []
    target_contracts = []
    for card_id, card in cards.items():
        if card["slot_kind"] != "front":
            continue
        for line in card["effect_text"].splitlines():
            match = PLAIN.fullmatch(line)
            if not match:
                continue
            ids = [item["id"] for item in card_abilities[card_id]
                   if item["source_line"] == line]
            if len(ids) != 1:
                raise ValueError(f"unmatched plain stat line: {card_id}: {line}")
            if "怪物" in card["tags"].split("|"):
                review = symbol_reviews[ids[0]]
                if review["source_line"] != line:
                    raise ValueError(f"monster symbol review needs updating: {ids[0]}")
                if review["symbol"] != "present":
                    continue
            printed_contracts.append({
                "card_id": card_id, "ability_id": ids[0],
                "stat": STAT[match.group(1)], "amount": int(match.group(2)),
                "source_line": line,
            })
    target_lines = {"免疫魔法攻击。": "immune_magic_attack",
                    "只能使用魔法攻击。": "magic_attack_only"}
    battle_line = "战斗：获得 1 张疾病。"
    battle_contracts = []
    for card_id, card in cards.items():
        if "怪物" not in card["tags"].split("|"):
            continue
        for line in card["effect_text"].splitlines():
            if line not in target_lines:
                continue
            ids = [item["id"] for item in card_abilities[card_id]
                   if item["source_line"] == line]
            if len(ids) != 1:
                raise ValueError(f"unmatched target rule: {card_id}: {line}")
            target_contracts.append({
                "card_id": card_id, "ability_id": ids[0],
                "rule": target_lines[line], "source_line": line,
            })
        if battle_line in card["effect_text"].splitlines():
            ids = [item["id"] for item in card_abilities[card_id]
                   if item["source_line"] == battle_line]
            if len(ids) != 1:
                raise ValueError(f"unmatched battle rule: {card_id}: {battle_line}")
            battle_contracts.append({"card_id": card_id,
                                     "ability_id": ids[0],
                                     "source_line": battle_line})
    if len({row["ability_id"] for row in activation_contracts}) != len(activation_contracts):
        raise ValueError("duplicate activated ability ID")

    rules = {"schema_version": "thunderstone.effects/1",
             "source_draft": draft["schema_version"], "abilities": executable}
    return {
        SIMPLE_JSON: (json.dumps(rules, ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
        ACTIVATED_CSV: _csv_bytes(activation_contracts, [
            "card_id", "ability_id", "actions", "usage", "op", "amount",
            "source_line"]),
        PRINTED_CSV: _csv_bytes(printed_contracts, [
            "card_id", "ability_id", "stat", "amount", "source_line"]),
        TARGET_CSV: _csv_bytes(target_contracts, [
            "card_id", "ability_id", "rule", "source_line"]),
        BATTLE_CSV: _csv_bytes(battle_contracts, [
            "card_id", "ability_id", "source_line"]),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true",
                        help="fail if committed artifacts differ from the reviewed input")
    args = parser.parse_args()
    artifacts = build_artifacts()
    for path, content in artifacts.items():
        if args.check:
            if not path.is_file() or path.read_bytes() != content:
                raise ValueError(f"stale effect artifact: {path}")
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        print(f"{path.relative_to(ROOT)}: {len(content)} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
