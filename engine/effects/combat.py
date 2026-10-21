"""Recompute continuous card contributions from the current battle snapshot."""

from __future__ import annotations

import re


FIELDS = {"attack": "正文_基础攻击", "magic_attack": "正文_基础魔法攻击",
          "light": "wiki_光照", "strength": "wiki_力量", "weight": "wiki_重量",
          "level": "wiki_英雄等级", "gold": "wiki_金币值", "health": "wiki_生命值",
          "cost": "wiki_购买价格", "vp": "wiki_胜利点"}
FIELDS["xp_reward"] = "defeat_xp_reward"
STATS = ("attack", "magic_attack", "light", "strength")
PLAIN = re.compile(r"^(攻击|魔法攻击|光照|光照值) ([+-][0-9]+)。$")
LABELS = {"攻击": "attack", "魔法攻击": "magic_attack", "光照": "light", "光照值": "light"}


def is_hero(card: dict) -> bool:
    """Hero identity is explicit catalog data, including militia/village heroes."""
    return "英雄" in card["tags"].split("|")


def monster_family(card: dict) -> frozenset[str]:
    tags = card["tags"].split("|")
    if len(tags) == 2 and tags[0] == "龙" and tags[1] in {"白龙", "绿龙", "蓝龙", "红龙", "黑龙"}:
        return frozenset({"龙", "色彩龙"})
    return frozenset(tags)


def light_requirement(tx, rank, target_rules, hall) -> int:
    if rank == 0:
        return 0
    result = max(0, rank)
    if any(rule.op == "hall_aura" and rule.params.get("double_darkness") for _, rule in hall):
        result *= 2
    for rule in target_rules:
        if rule.op == "light_requirement":
            result = rule.params.get("ranks", {}).get(str(rank), result)
    if "TS-0193" in tx.state["active_settings"]:
        result = 1
    elif "TS-0194" in tx.state["active_settings"]:
        result = 0
    return result


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
    carried = {weapon for owner, weapon in equipment_pairs(tx.state["battle_context"])
               if owner == hero_id}
    return max([1] + [rule.params["capacity"] for source, rule in hand_rules(tx, "extra_equipment")
                      if source == hero_id or source in carried])


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


def _metric(tx, params: dict, source: str | None = None) -> int:
    selected = [item for item in tx.zone("hand")
                if matches(tx.card(item), params.get("filter", {}))
                and (not params.get("exclude_source") or item != source)]
    metric = params.get("metric", "count")
    if metric == "gold":
        from engine.effects.economy import printed_gold
        value = sum(printed_gold(tx, tx.card(item)) for item in selected)
    elif metric == "level_sum":
        value = sum(stat(tx.card(item), "level") for item in selected)
    elif metric == "level_max":
        value = max((stat(tx.card(item), "level") for item in selected), default=0)
    elif metric == "xp":
        value = tx.player["xp"]
    else:
        value = len(selected)
    if params.get("absent"):
        return int(value == 0)
    if value < params.get("minimum", 0):
        return 0
    return 1 if params.get("flat") else value // max(1, params.get("divisor", 1))


def _add(values: dict, params: dict, multiplier: int = 1) -> None:
    for field in STATS:
        values[field] += params.get(field, 0) * multiplier


def combat_values(tx, rank: int, target: dict | None = None) -> dict:
    context = tx.state["battle_context"] or {}
    hand = list(tx.zone("hand"))
    heroes = [item for item in hand if is_hero(tx.card(item))]
    values = {item: {key: stat(tx.card(item), key) for key in STATS} for item in hand}
    for item, copy in tx.state.get("copied_heroes", {}).items():
        if item not in values or copy.get("full_card"):
            continue
        if not copy["preserve_attack"]:
            for key in ("attack", "magic_attack"):
                values[item][key] = 0
        for card_id in copy["card_ids"]:
            for line in tx.cards[card_id]["effect_text"].splitlines():
                match = PLAIN.fullmatch(line)
                if match:
                    values[item][LABELS[match.group(1)]] += int(match.group(2))
    reasons = {item: [] for item in hand}
    pairs = [(hero, weapon) for hero, weapon in equipment_pairs(context)
             if hero in hand and weapon in hand]
    equipper = {weapon: hero for hero, weapon in pairs}
    rules = hand_rules(tx)
    hall = hall_rules(tx)
    strength_penalties = []
    for item, changes in context.get("card_modifiers", {}).items():
        if item in values:
            _add(values[item], changes)
    for source, rule in rules:
        p = rule.params
        if rule.op == "disease_strength":
            chosen = context.get("strength_penalty_assignments", {}).get(source)
            targets = ([chosen if chosen in heroes else heroes[0]] if heroes else []) if p.get("single") else heroes
            if p.get("single"):
                strength_penalties.append({"instance_id": source, "hero_instance_id": targets[0] if targets else None,
                                           "amount": p["amount"]})
            for hero in targets:
                values[hero]["strength"] += p["amount"]
        elif rule.op == "response":
            values[source]["attack"] += p.get("attack", 0)
        elif rule.op == "hero_aura":
            for hero in heroes:
                if (matches(tx.card(hero), p.get("filter", {}))
                        and (not p.get("exclude_source") or hero != source)
                        and (not p.get("equipped") or any(h == hero for h, _ in pairs))):
                    _add(values[hero], p)
        elif rule.op == "card_aura":
            for item in hand:
                if any(matches(tx.card(item), predicate) for predicate in p["filters_any"]):
                    _add(values[item], p)
        elif rule.op == "hand_bonus":
            _add(values[source], p, _metric(tx, p, source))
        elif rule.op == "draw_attack":
            if source in equipper:
                values[source]["attack"] += p["amount"] * context.get("equipment_draw_counts", {}).get(source, 0)
        elif rule.op == "rank_bonus" and p.get("minimum", 0) <= rank <= p.get("maximum", 100):
            _add(values[source], p, rank if p.get("scale") else 1)
        elif rule.op == "target_bonus" and target is not None:
            if (rank >= p.get("minimum_rank", 0)
                    and (not p.get("tag") or p["tag"] in target["tags"].split("|"))
                    and (not p.get("same_family") or any(tx.card(item)["subcategory"] == "怪物" and monster_family(tx.card(item)) == monster_family(target) for item in hand))
                    and (not p.get("gives_disease") or re.search(r"获得\s*[0-9一两]?\s*张疾病", target["effect_text"]))):
                _add(values[source], p)
        elif rule.op == "equipment_bonus":
            relevant = ([(equipper[source], source)] if source in equipper else
                        [(hero, weapon) for hero, weapon in pairs if hero == source])
            for hero, weapon in relevant:
                if (p.get("hero_tag") and not set(p["hero_tag"].split("|")).intersection(tx.card(hero)["tags"].split("|"))
                        or p.get("hero_card_id") and tx.card(hero)["card_id"] != p["hero_card_id"]
                        or p.get("weapon_tag") and p["weapon_tag"] not in tx.card(weapon)["tags"].split("|")
                        or stat(tx.card(weapon), "weight") > p.get("weight_max", 100)
                        or values[hero]["strength"] < p.get("strength_min", -100)
                        or rank < p.get("minimum_rank", 0)):
                    continue
                if p.get("target_tags_any") and (target is None or not set(target["tags"].split("|")).intersection(p["target_tags_any"])):
                    continue
                _add(values[source], p, stat(tx.card(hero), "level") if p.get("level_scale") else 1)
                if source in equipper and p.get("strength"):
                    values[hero]["strength"] += p["strength"]
                    values[source]["strength"] -= p["strength"]
                break
    for _, rule in hall:
        if rule.op == "hall_aura":
            penalty = rule.params.get("strength", 0)
            if rule.params.get("strength_per_spell"):
                penalty -= sum("法术" in tx.card(item)["tags"].split("|") for item in hand)
            for hero in heroes:
                values[hero]["strength"] += penalty
            if rule.params.get("disease_attack"):
                for item in hand:
                    if tx.card(item)["card_type"] == "疾病牌":
                        values[item]["attack"] += rule.params["disease_attack"]
    # Target battle modifiers are snapshots, recorded before outcome evaluation.
    for hero in heroes:
        _add(values[hero], context.get("hero_battle_modifiers", {}))
    valid_pairs = [(hero, weapon) for hero, weapon in pairs
                   if stat(tx.card(weapon), "weight") <= max(0, values[hero]["strength"]) + sum(
                       rule.params["amount"] for source, rule in rules
                       if source == weapon and rule.op == "equipment_discount"
                       and rule.params["hero_tag"] in tx.card(hero)["tags"].split("|"))
                   or context.get("zero_weapon_weight")]
    equipped = {weapon for _, weapon in valid_pairs}
    for source, rule in rules:
        if rule.op == "weapon_aura":
            for weapon in equipped:
                _add(values[weapon], rule.params)
    forbidden = set(context.get("excluded_participants", []))
    for source, rule in rules:
        if rule.op == "rank_restriction":
            p = rule.params
            if rank in p.get("forbidden", []) or ("allowed" in p and rank not in p["allowed"]):
                forbidden.add(source)
    restrictions = []
    zero_attack = set()
    target_rules = [rule for rule in (tx.ruleset.mechanics if tx.ruleset else ())
                    if target is not None and rule.source_card_id == target["card_id"]]
    for rule in target_rules:
        if rule.op != "target_restriction":
            continue
        p = rule.params
        for hero in heroes:
            if (set(tx.card(hero)["tags"].split("|")).intersection(p.get("exclude_tags", []))
                    or max(0, values[hero]["strength"]) < p.get("strength_min", -100)
                    or p.get("equipped_only") and not any(h == hero for h, _ in valid_pairs)):
                forbidden.add(hero)
        if p.get("immune_spells"):
            zero_attack.update(item for item in hand if "法术" in tx.card(item)["tags"].split("|"))
        if p.get("immune_unarmed"):
            zero_attack.update(hero for hero in heroes if not any(h == hero for h, _ in valid_pairs))
        if p.get("immune_weapon_tag"):
            zero_attack.update(item for item in equipped
                               if p["immune_weapon_tag"] in tx.card(item)["tags"].split("|"))
    forbidden.update(weapon for hero, weapon in valid_pairs if hero in forbidden)
    for item in hand:
        if "武器" in tx.card(item)["tags"].split("|") and item not in equipped:
            forbidden.add(item)
    if context.get("convert_all_magic"):
        for item, entry in values.items():
            if tx.card(item)["card_type"] == "疾病牌":
                continue
            entry["magic_attack"] += entry["attack"]
            entry["attack"] = 0
    elif context.get("convert_equipped_magic"):
        for item in {part for pair in valid_pairs for part in pair}:
            values[item]["magic_attack"] += values[item]["attack"]
            values[item]["attack"] = 0
    for item in context.get("convert_card_magic", []):
        if item in values:
            values[item]["magic_attack"] += values[item]["attack"]
            values[item]["attack"] = 0
    for item in zero_attack:
        values[item]["attack"] = values[item]["magic_attack"] = 0
    components = []
    for item in hand:
        if item in forbidden:
            reasons[item].append("not_participating")
            continue
        if any(values[item][key] for key in ("attack", "magic_attack", "light")):
            components.append({"instance_id": item, "card_id": tx.card(item)["card_id"],
                               **{key: values[item][key] for key in ("attack", "magic_attack", "light")}})
    modifiers = dict(context.get("modifiers", {}))
    for modifier in context.get("modifier_sources", []):
        if (modifier["source_instance_id"] in forbidden or modifier["source_instance_id"] in zero_attack
                and modifier["field"] in ("attack", "magic_attack")):
            field = modifier["field"]
            modifiers[field] = modifiers.get(field, 0) - modifier["amount"]
    if context.get("convert_all_magic"):
        modifiers["magic_attack"] = modifiers.get("magic_attack", 0) + modifiers.get("attack", 0)
        modifiers["attack"] = 0
    attack = sum(item["attack"] for item in components) + modifiers.get("attack", 0)
    magic = sum(item["magic_attack"] for item in components) + modifiers.get("magic_attack", 0)
    light = sum(item["light"] for item in components) + modifiers.get("light", 0)
    from engine.effects.durations import applicable_rules
    light += sum(rule["amount"] for rule in applicable_rules(tx, "light"))
    for _, rule in hall:
        if rule.op == "hall_aura":
            light += rule.params.get("light", 0)
    requirement = light_requirement(tx, rank, target_rules, hall)
    for source, rule in rules:
        if rule.op == "excess_light_magic" and source not in forbidden and source not in zero_attack:
            bonus = rule.params["amount"] * max(0, light - requirement)
            magic += bonus
            component = next((row for row in components if row["instance_id"] == source), None)
            if component is not None:
                component["magic_attack"] += bonus
    target_lines = target["effect_text"].splitlines() if target else []
    if "免疫魔法攻击。" in target_lines:
        magic = 0
        restrictions.append("immune_magic_attack")
    if "只能使用魔法攻击。" in target_lines:
        attack = 0
        restrictions.append("magic_attack_only")
    diseases = [item for item in hand if tx.card(item)["card_type"] == "疾病牌"
                and values[item]["attack"] < 0]
    disease_order = context.get("disease_order", diseases)
    diseases = [item for item in disease_order if item in diseases] + [item for item in diseases if item not in disease_order]
    penalties = []
    attack -= sum(values[item]["attack"] for item in diseases) if "只能使用魔法攻击。" not in target_lines else 0
    for item in diseases:
        chosen = context.get("disease_penalty_assignments", {}).get(item)
        if chosen is None:
            chosen = "attack" if attack > 0 else "magic_attack" if magic > 0 else None
        if chosen == "attack" and attack > 0:
            attack += values[item]["attack"]
        elif chosen == "magic_attack" and magic > 0:
            magic += values[item]["attack"]
        elif attack > 0 or magic > 0:
            from engine.turn.operations import TurnError
            raise TurnError("disease penalty must target a positive attack type")
        else:
            chosen = None
        penalties.append({"instance_id": item, "attack_type": chosen,
                          "amount": values[item]["attack"] if chosen else 0})
    for source, rule in rules:
        if source not in forbidden and rule.op == "double_magic":
            magic *= 2
    can_defeat, can_attack = not context.get("cannot_defeat", False), True
    for source, rule in hall:
        if (rule.op == "hall_target_restriction" and target is not None
                and target["card_id"] != tx.card(source)["card_id"]
                and rule.params["protected_tag"] in target["tags"].split("|")):
            can_attack = False
    for rule in target_rules:
        if rule.op != "target_restriction":
            continue
        p = rule.params
        if p.get("half_magic"):
            magic //= 2
        if p.get("half_attack_no_magic") and magic <= 0:
            attack //= 2
        if p.get("half_attack_no_weapon") and not equipped:
            combined = (attack + magic) // 2
            magic //= 2
            attack = combined - magic
        if p.get("magic_required") and magic <= 0:
            can_defeat = False
        if len(heroes) < p.get("min_heroes", 0):
            can_defeat = False
        used = set(context.get("used_card_tags", []))
        if p.get("forbid_used_spell") and "法术" in used or p.get("forbid_equipment") and equipped:
            can_attack = False
        if p.get("requires_used_spell_or_item") and not used.intersection({"法术", "物品"}):
            can_defeat = False
        if p.get("half_no_element") and not any("元素" in tx.card(item)["tags"].split("|") for item in hand):
            combined = (attack + magic) // 2
            magic //= 2
            attack = combined - magic
    darkness = max(0, requirement - light) if rank else 0
    irreducible = any(rule.op == "light_requirement" and rule.params.get("irreducible") for rule in target_rules)
    if irreducible:
        darkness = requirement if rank else 0
    ignore = False
    for source, rule in rules:
        if source in forbidden:
            continue
        p = rule.params
        if (rule.op == "ignore_darkness" or rule.op == "target_bonus" and p.get("ignore_darkness")):
            if (rank >= p.get("minimum_rank", 0)
                    and (not p.get("tag") or target and p["tag"] in target["tags"].split("|"))):
                ignore = True
    if ignore and not irreducible:
        darkness = 0
    for rule in target_rules:
        if rule.op == "target_restriction" and rule.params.get("no_darkness") and darkness:
            can_attack = False
    return {"components": components, "modifiers": modifiers,
            "attack": attack, "magic_attack": magic, "light": light,
            "light_requirement": requirement, "darkness": darkness,
            "darkness_penalty": 2 * darkness,
            "effective_attack": max(0, attack + magic - 2 * darkness),
            "restrictions": restrictions, "can_defeat": can_defeat,
            "can_attack": can_attack, "hero_strength": {
                hero: max(0, values[hero]["strength"]) for hero in heroes},
            "equipped_pairs": [list(pair) for pair in valid_pairs],
            "excluded_instance_ids": sorted(forbidden), "disease_penalties": penalties,
            "strength_penalties": strength_penalties}


def monster_health(tx, target: dict, *, rank: int = 1,
                   target_id: str | None = None) -> int:
    target_id = target_id or (tx.state.get("battle_context") or {}).get("target_instance_id")
    if target_id is None:
        target_id = next((item for zone, pile in tx.state["zones"].items()
                          if zone.startswith("hall:") for item in pile
                          if tx.card(item)["card_id"] == target["card_id"]), None)
    result = stat(target, "health")
    result += sum(record["kind"] == "disease_after" for record in tx.state.get("attachments", {}).get(target_id, []))
    for rule in tx.ruleset.mechanics if tx.ruleset else ():
        if rule.source_card_id != target["card_id"] or rule.op != "target_health":
            continue
        p = rule.params
        if "gold_below_double" in p:
            if _metric(tx, {"metric": "gold"}) < p["gold_below_double"]:
                result *= 2
        else:
            value = (sum(item != target_id and matches(tx.card(item), p["hall_filter"])
                         for zone, pile in tx.state["zones"].items() if zone.startswith("hall:")
                         for item in pile) if "hall_filter" in p else _metric(tx, p))
            if p.get("other_tag"):
                value = int(any(p["other_tag"] in tx.card(item)["tags"].split("|") for item in tx.zone("hand"))
                            or any(p["other_tag"] in tx.card(item)["tags"].split("|") and item != target_id
                                   for zone, pile in tx.state["zones"].items()
                                   if zone.startswith("hall:") for item in pile))
            result += value * p.get("multiplier", 1) + p.get("amount", 0)
    for source, rule in hall_rules(tx, "hall_aura"):
        if tx.card(source)["card_id"] != target["card_id"]:
            result += rule.params.get("health", 0)
    context = tx.state["battle_context"] or {}
    return max(0, result + context.get("health_modifier", 0)
               + context.get("monster_health_modifiers", {}).get(target_id, 0))


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
