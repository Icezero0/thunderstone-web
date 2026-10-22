"""Compare the reference ability draft with the reviewed executable ruleset."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.app.integrations.game_engine.catalog.repository import load_catalog  # noqa: E402
from backend.app.integrations.game_engine.effects.compiler import load_ruleset  # noqa: E402

DRAFT = (ROOT / "docs" / "游戏引擎设计参考"
         / "thunderstone_card_rules_v0.3.2_engine.json")


PRINTED = ROOT / "data" / "effects" / "printed-contracts.csv"
TARGET = ROOT / "data" / "effects" / "target-contracts.csv"
BATTLE = ROOT / "data" / "effects" / "battle-contracts.csv"
SETUP_READY = {"TS-0034-A01", "TS-0035-A01", "TS-0148-A01",
               "TS-0188-A01", "TS-0191-A01", "TS-0192-A01"}
ENV_READY = {"TS-0193-A01", "TS-0194-A01"}
IMPLEMENTED = {"READY", "PRINTED_BASELINE", "TARGET_RULE",
               "BATTLE_RULE", "SETUP_READY", "ENV_RULE", "MECHANIC_READY", "SYSTEM_RULE"}


def _printed_ids() -> set[str]:
    with PRINTED.open(encoding="utf-8-sig", newline="") as handle:
        return {row["ability_id"] for row in csv.DictReader(handle)}


def build_rows() -> tuple[list[dict[str, str]], dict[str, int]]:
    draft = json.loads(DRAFT.read_text(encoding="utf-8-sig"))
    catalog = load_catalog().cards
    ruleset = load_ruleset(catalog)
    ready = {item.id for item in ruleset.abilities}
    mechanics = {item.id for item in ruleset.mechanics}
    system = json.loads((ROOT / "data/effects/system-contracts.json").read_text(encoding="utf-8"))
    printed = _printed_ids()
    with TARGET.open(encoding="utf-8-sig", newline="") as handle:
        target = {row["ability_id"] for row in csv.DictReader(handle)}
    with BATTLE.open(encoding="utf-8-sig", newline="") as handle:
        battle = {row["ability_id"] for row in csv.DictReader(handle)}
    rows = []
    for card in draft["cards"]:
        for ability in card["abilities"]:
            if catalog[card["id"]]["slot_kind"] != "front":
                status = "RULE_REFERENCE"
            elif ability["id"] in ready:
                status = "READY"
            elif ability["id"] in mechanics:
                status = "MECHANIC_READY"
            elif ability["id"] in printed:
                status = "PRINTED_BASELINE"
            elif ability["id"] in target:
                status = "TARGET_RULE"
            elif ability["id"] in battle:
                status = "BATTLE_RULE"
            elif ability["id"] in SETUP_READY:
                status = "SETUP_READY"
            elif ability["id"] in ENV_READY:
                status = "ENV_RULE"
            elif ability["id"] in system:
                status = "SYSTEM_RULE"
            elif not ability["is_executable_as_card_ability"]:
                status = "RULE_REFERENCE"
            elif "通用原子模板" in ability["dsl_readiness"]:
                status = "DRAFT_TEMPLATE"
            else:
                status = "DRAFT_CARD_SPECIFIC"
            rows.append({
                "ability_id": ability["id"], "card_id": card["id"],
                "status": status,
                "trigger": ability["trigger"]["event"],
                "effect_atoms": "|".join(ability["effect_atom_ids"]),
                "flow_nodes": "|".join(ability["flow_nodes"]),
                "binding_note": "" if status in IMPLEMENTED else ability["dsl_readiness"],
            })
    found = {row["ability_id"] for row in rows}
    if (len(found) != len(rows)
            or not (ready | mechanics | printed | target | battle | SETUP_READY | ENV_READY | set(system))
            <= found):
        raise ValueError("draft has duplicate abilities or a reviewed ability is absent")
    return rows, dict(sorted(Counter(row["status"] for row in rows).items()))


def build_card_rows(ability_rows: list[dict[str, str]]) -> tuple[list[dict[str, str]], dict[str, int]]:
    cards = load_catalog().cards
    by_card: dict[str, list[dict[str, str]]] = {}
    for row in ability_rows:
        by_card.setdefault(row["card_id"], []).append(row)
    rows = []
    for card_id, card in sorted(cards.items()):
        if card["slot_kind"] != "front" or not card["effect_text"].strip():
            continue
        abilities = by_card.get(card_id, [])
        if not abilities:
            raise ValueError(f"effect card absent from the draft: {card_id}")
        covered = [item for item in abilities if item["status"] in IMPLEMENTED]
        status = ("COMPLETE" if len(covered) == len(abilities)
                  else "PARTIAL" if covered else "PENDING")
        rows.append({
            "card_id": card_id, "name": card["name"],
            "card_type": card["card_type"], "ability_count": str(len(abilities)),
            "covered_count": str(len(covered)), "status": status,
            "covered_ability_ids": "|".join(item["ability_id"] for item in covered),
            "pending_ability_ids": "|".join(item["ability_id"] for item in abilities
                                            if item["status"] not in IMPLEMENTED),
        })
    return rows, dict(sorted(Counter(row["status"] for row in rows).items()))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path,
                        help="optionally write one review-status row per ability as CSV")
    parser.add_argument("--card-output", type=Path,
                        help="optionally write one completeness row per effect card")
    parser.add_argument("--require-complete", action="store_true",
                        help="fail while any effect card has pending abilities")
    args = parser.parse_args()
    rows, counts = build_rows()
    card_rows, card_counts = build_card_rows(rows)
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
            writer.writeheader()
            writer.writerows(rows)
    if args.card_output is not None:
        args.card_output.parent.mkdir(parents=True, exist_ok=True)
        with args.card_output.open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=list(card_rows[0]))
            writer.writeheader()
            writer.writerows(card_rows)
    print(json.dumps({"draft_abilities": len(rows), "statuses": counts,
                      "effect_cards": len(card_rows), "card_statuses": card_counts},
                     ensure_ascii=False, indent=2))
    if args.require_complete and any(row["status"] != "COMPLETE"
                                     for row in card_rows):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
