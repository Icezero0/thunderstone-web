"""Recompute continuous card contributions from the current battle snapshot."""

from __future__ import annotations

import re


FIELDS = {"attack": "正文_基础攻击", "magic_attack": "正文_基础魔法攻击",
          "light": "wiki_光照", "strength": "wiki_力量", "weight": "wiki_重量",
          "level": "wiki_英雄等级", "gold": "wiki_金币值", "health": "wiki_生命值",
          "cost": "wiki_购买价格", "vp": "wiki_胜利点"}
FIELDS["xp_reward"] = "defeat_xp_reward"
PLAIN = re.compile(r"^(攻击|魔法攻击|光照|光照值) ([+-][0-9]+)。$")
LABELS = {"攻击": "attack", "魔法攻击": "magic_attack", "光照": "light", "光照值": "light"}


def is_hero(card: dict) -> bool:
    """Hero identity is explicit catalog data, including militia/village heroes."""
    return "英雄" in card["tags"].split("|")


def is_monster(card: dict) -> bool:
    """Shared monster identity includes ordinary monsters and guardians."""
    return "怪物" in card["tags"].split("|")


def is_disease(card: dict) -> bool:
    return "疾病" in card["tags"].split("|")


def is_thunderstone(card: dict) -> bool:
    return "雷霆之石" in card["tags"].split("|")


def is_village(card: dict) -> bool:
    return "村庄" in card["tags"].split("|")


def monster_family(card: dict) -> frozenset[str]:
    tags = [tag for tag in card["tags"].split("|") if tag != "怪物"]
    if len(tags) == 2 and tags[0] == "龙" and tags[1] in {"白龙", "绿龙", "蓝龙", "红龙", "黑龙"}:
        return frozenset({"龙", "色彩龙"})
    return frozenset(tags)


def stat(card: dict, key: str) -> int:
    raw = card.get(FIELDS.get(key, key), "")
    try:
        return int(raw)
    except (ValueError, TypeError):
        if key in ("attack", "magic_attack", "light") and raw == "":
            return sum(int(m.group(2)) for line in card["effect_text"].splitlines()
                       if (m := PLAIN.fullmatch(line)) and LABELS[m.group(1)] == key)
        return 0


def matches(card: dict, spec: dict) -> bool:
    tags = set(card["tags"].split("|"))
    for key in ("card_id", "card_type", "subcategory", "name"):
        if key in spec and card[key] != spec[key]:
            return False
    if spec.get("exclude_card_id") == card["card_id"]:
        return False
    if spec.get("exclude_card_type") == card["card_type"]:
        return False
    if "tag" in spec and spec["tag"] not in tags:
        return False
    if "tags_any" in spec and not tags.intersection(spec["tags_any"]):
        return False
    if tags.intersection(spec.get("tags_none", [])):
        return False
    for key, field, comparison in (("gold_min", "gold", "min"),
                                    ("light_min", "light", "min"),
                                    ("level_min", "level", "min"),
                                    ("level_max", "level", "max"),
                                    ("gold_max", "gold", "max"),
                                    ("vp_min", "vp", "min"),
                                    ("vp_max", "vp", "max"),
                                    ("magic_max", "magic_attack", "max"),
                                    ("magic_min", "magic_attack", "min")):
        if key in spec and (stat(card, field) < spec[key] if comparison == "min"
                            else stat(card, field) > spec[key]):
            return False
    if "weight_min" in spec and stat(card, "weight") < spec["weight_min"]:
        return False
    if "weight_max" in spec and stat(card, "weight") > spec["weight_max"]:
        return False
    if "gold_present" in spec and (card.get(FIELDS["gold"], "") != "") != spec["gold_present"]:
        return False
    for key in ("cost", "vp"):
        if key + "_present" in spec and (card.get(FIELDS[key], "") != "") != spec[key + "_present"]:
            return False
    return True


def equipment_pairs(context: dict) -> list[tuple[str, str]]:
    return [(hero, weapon) for hero, weapons in
            context.get("equipped_weapon_by_hero", {}).items()
            for weapon in (weapons if isinstance(weapons, list) else [weapons])]


def hand_rules(tx, op: str | None = None):
    if tx.ruleset is None:
        return []
    by_card = {}
    for instance_id in tx.zone("hand"):
        by_card.setdefault(tx.card(instance_id)["card_id"], []).append(instance_id)
        for card_id in tx.state.get("copied_heroes", {}).get(instance_id, {}).get("card_ids", []):
            if instance_id not in by_card.setdefault(card_id, []):
                by_card[card_id].append(instance_id)
    return [(source, rule) for rule in tx.ruleset.mechanics
            if op is None or rule.op == op
            for source in by_card.get(rule.source_card_id, [])]


def equipment_capacity(tx, hero_id: str) -> int:
    from backend.app.integrations.game_engine.shared.client import client
    from backend.tests.migration.reference.python_engine.shared.projection import calculation_input
    return client.call("equipment_capacity", {"input": calculation_input(tx), "hero_id": hero_id})


def hall_rules(tx, op: str | None = None):
    if tx.ruleset is None:
        return []
    result = []
    for zone, pile in tx.state["zones"].items():
        if not zone.startswith("hall:"):
            continue
        for instance_id in pile:
            for rule in tx.ruleset.mechanics:
                if (tx.card(instance_id)["card_id"] == rule.source_card_id
                        and (op is None or rule.op == op)
                        and (not rule.params.get("rank0_only") or zone.endswith(":rank0"))):
                    result.append((instance_id, rule))
    return result


def combat_values(tx, rank: int, target: dict | None = None) -> dict:
    """Use the same TypeScript calculation as the browser build."""
    from backend.app.integrations.game_engine.shared.client import client, SharedRuleError
    from backend.tests.migration.reference.python_engine.shared.projection import calculation_input
    from backend.tests.migration.reference.python_engine.turn.operations import TurnError
    try:
        return client.call("combat_values", {"input": calculation_input(tx, target),
                                             "rank": rank, "target": target})
    except SharedRuleError as error:
        raise TurnError(str(error)) from error


def monster_health(tx, target: dict, *, rank: int = 1,
                   target_id: str | None = None) -> int:
    from backend.app.integrations.game_engine.shared.client import client, SharedRuleError
    from backend.tests.migration.reference.python_engine.shared.projection import calculation_input
    from backend.tests.migration.reference.python_engine.turn.operations import TurnError
    try:
        return client.call("monster_health", {"input": calculation_input(tx, target),
            "rank": rank, "target": target, "target_id": target_id})
    except SharedRuleError as error:
        raise TurnError(str(error)) from error


def reconcile_equipment(tx, *, during_battle: bool = False) -> dict:
    """Drop illegal weapons and retain sticky zero-strength destruction marks."""
    context = tx.state.get("battle_context")
    if context is None:
        return {}
    for _ in range(len(equipment_pairs(context)) + 1):
        trace = combat_values(tx, context.get("target_rank", 1))
        valid = {tuple(pair) for pair in trace["equipped_pairs"]}
        old = equipment_pairs(context)
        dropped = [pair for pair in old if pair not in valid]
        if not dropped:
            break
        mapping = context["equipped_weapon_by_hero"]
        mapping.clear()
        for hero, weapon in old:
            if (hero, weapon) in valid:
                previous = mapping.get(hero)
                mapping[hero] = ([*(previous if isinstance(previous, list) else [previous]), weapon]
                                 if previous else weapon)
        for hero, weapon in dropped:
            tx.event("weapon_dropped", hero_instance_id=hero, weapon_instance_id=weapon,
                     reason="insufficient_strength_or_missing_card")
    if during_battle:
        for hero, strength in trace["hero_strength"].items():
            flags = tx.state["instances"][hero]["flags"]
            if strength == 0 and not flags.get("pending_turn_end_destruction"):
                flags["pending_turn_end_destruction"] = True
                tx.event("hero_zero_strength_marked", instance_id=hero)
    return trace
