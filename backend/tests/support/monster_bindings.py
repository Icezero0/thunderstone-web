"""Read formal bindings for the completed symbol-review regression.

Keep the exported review fingerprint format, without depending on a retired UI
projection or a natural-language DSL renderer.
"""

import csv
from dataclasses import asdict
import hashlib
import json

from backend.app.core.paths import CARDS_ROOT, PROJECT_ROOT
from backend.app.integrations.game_engine.shared.client import client


def _contracts(name):
    with (CARDS_ROOT / "contracts" / name).open(encoding="utf-8-sig", newline="") as source:
        return {row["ability_id"]: row for row in csv.DictReader(source)}


def _mechanic_scopes(mechanic):
    if mechanic.op in ("response", "hero_aura", "target_bonus"):
        return ["hand_passive"]
    if mechanic.op == "scoring":
        return ["scoring"]
    if mechanic.op == "replace_monster":
        return ["on_enter"]
    if mechanic.op == "economy":
        return {"hall": ["hall"], "hand": ["hand_passive"]}.get(
            mechanic.params.get("scope"), ["hall", "hand_passive"])
    if mechanic.op in ("hall_aura", "dungeon_deck_lock", "hall_movement_lock", "hall_target_restriction", "immovable"):
        return ["hall"]
    return ["battle"]


def monster_bindings(cards, ruleset):
    draft_path = PROJECT_ROOT / "docs/游戏引擎设计参考/thunderstone_card_rules_v0.3.2_engine.json"
    draft = {c["id"]: c for c in json.loads(draft_path.read_text(encoding="utf-8-sig"))["cards"]}
    compiled = {a.id: a for a in ruleset.abilities}
    mechanics = {m.id: m for m in ruleset.mechanics}
    printed, targets = _contracts("printed-contracts.csv"), _contracts("target-contracts.csv")
    system = json.loads((CARDS_ROOT / "contracts/system-contracts.json").read_text(encoding="utf-8"))
    result = {}
    for card_id, card in cards.items():
        if card["slot_kind"] != "front" or card["subcategory"] != "怪物":
            continue
        lines = {a["id"]: a["source_line"] for a in draft.get(card_id, {}).get("abilities", [])}
        for source in (*ruleset.abilities, *ruleset.mechanics):
            if source.source_card_id == card_id:
                lines.setdefault(source.id, getattr(source, "source_line", ""))
        for ability_id, line in lines.items():
            if ability_id in compiled:
                ability = compiled[ability_id]
                binding = asdict(ability)
                if ability.source_zone in ("active_hand", "active_control"):
                    scopes = ["hand_active" if ability.kind == "activated" else "hand_passive"]
                elif ability.source_zone == "event_source":
                    scopes = [{"BREACH": "breach", "HALL_REVEALED": "on_enter", "MONSTER_DEFEATED": "on_defeat"}.get(ability.event, "unknown")]
                else:
                    scopes = [{"battle_target": "battle", "hall": "hall"}.get(ability.source_zone, "unknown")]
            elif ability_id in mechanics:
                binding = asdict(mechanics[ability_id])
                scopes = _mechanic_scopes(mechanics[ability_id])
            elif ability_id in printed:
                row = printed[ability_id]
                binding = {"hook": "printed_hand_baseline", "stat": row["stat"], "line_amount": int(row["amount"]),
                           "runtime_card_total": client.call("card_stat", {"card": card, "key": row["stat"]}), "source_zone": "active_hand"}
                scopes = ["hand_passive"]
            elif ability_id in targets:
                binding = {"hook": "combat_target_text_rule", "rule": targets[ability_id]["rule"], "source_zone": "battle_target"}
                scopes = ["battle"]
            elif ability_id in system:
                binding, scopes = {"hook": system[ability_id]}, ["setup", "hall"]
            else:
                raise AssertionError(f"Reviewed ability has no formal binding: {ability_id}")
            fingerprint = hashlib.sha256(json.dumps({"line": line, "binding": binding, "scopes": scopes},
                                                    ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
            result[ability_id] = {"scope_ids": scopes, "source_line": line, "fingerprint": fingerprint}
    return result
