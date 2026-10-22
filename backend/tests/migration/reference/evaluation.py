"""Frozen pre-migration query/expression/condition reference, tests only."""
from __future__ import annotations
from backend.tests.migration.reference.combat import matches, stat, combat_values, is_hero, hall_rules
from backend.tests.migration.reference.python_engine.effects.runtime import EffectError
MAX_QUERY_RESULTS = 200

def active_players(state):
    return [player for player in state["player_order"] if not state["players"][player].get("eliminated", False)]

def can_move_monster(tx, instance):
    return not (any(rule.op == "immovable" and rule.source_card_id == tx.card(instance)["card_id"]
                    for rule in tx.ruleset.mechanics) or bool(hall_rules(tx, "hall_movement_lock")))

def _location(tx: Transition, instance_id: str) -> str | None:
    return next((zone for zone, pile in tx.state["zones"].items()
                 if instance_id in pile), None)

def _query(tx: Transition, spec: dict, bindings: dict | None = None) -> list[str]:
    bindings = bindings or {}
    zone = spec["zone"]
    subject = bindings.get("_subject", tx.player_id)
    if zone == "active_hand":
        candidates = list(tx.zone("hand"))
    elif zone == "active_hand_or_village_top":
        candidates = list(tx.zone("hand")) + [pile[0] for place, pile in sorted(tx.state["zones"].items())
            if place.startswith("village_supply:") and pile]
    elif zone == "active_control":
        candidates = list(tx.zone("control"))
    elif zone == "subject_control":
        candidates = list(tx.zone("control", subject))
    elif zone in ("other_hand", "other_discard", "other_control"):
        part = zone.removeprefix("other_")
        candidates = [item for player in active_players(tx.state) if player != tx.player_id
                      for item in tx.zone(part, player)]
    elif zone == "event_source":
        source = tx.state.get("event_context", {}).get("source_instance_id")
        candidates = [source] if source in tx.state["instances"] else []
    elif zone == "event_hero":
        hero = tx.state.get("event_context", {}).get("hero_instance_id")
        candidates = [hero] if hero in tx.state["instances"] else []
    elif zone == "defeated_monster":
        source = tx.state.get("event_context", {}).get("defeated_instance_id")
        candidates = [source] if source in tx.state["instances"] else []
    elif zone == "defeated_this_turn":
        candidates = list(tx.state.get("turn_defeated_monsters", []))
    elif zone in ("all_hand", "all_discard"):
        candidates = [item for player in active_players(tx.state) for item in tx.zone(zone.removeprefix("all_"), player)]
    elif zone == "reveal_zone":
        candidates = list(tx.state["zones"].get(bindings.get("_reveal_zone"), []))
    elif zone == "collection":
        candidates = list(tx.state.get("effect_collections", {}).get(
            f"{bindings.get('_ability_id')}:{bindings.get('source')}:{spec['collection']}", []))
    elif zone == "event_supply_top":
        pile = tx.state["zones"].get(tx.state.get("event_context", {}).get("supply_zone"), [])
        candidates = list(pile[:1])
    elif zone in ("subject_hand", "active_discard", "subject_discard"):
        candidates = list(tx.zone("discard" if zone.endswith("discard") else "hand",
                                  tx.player_id if zone == "active_discard" else subject))
    elif zone == "bound":
        value = bindings.get(spec["var"])
        candidates = [value] if isinstance(value, str) else list(value or [])
    elif zone == "hall":
        candidates = [item for place, pile in tx.state["zones"].items()
                      if place.startswith("hall:") for item in pile]
    else:
        candidates = [pile[0] for zone, pile in sorted(tx.state["zones"].items())
                      if zone.startswith("hero_supply:" if spec["zone"] == "hero_supply_top"
                                         else "village_supply:") and pile]
    result = []
    def bound_ids(name):
        value = bindings.get(name, [])
        return [value] if isinstance(value, str) else list(value)
    for instance_id in candidates:
        if instance_id not in tx.state["instances"]:
            continue
        if "exclude_var" in spec and instance_id in bound_ids(spec["exclude_var"]):
            continue
        if "name_in_var" in spec and tx.card(instance_id)["name"] not in {
                tx.card(item)["name"] for item in bound_ids(spec["name_in_var"])
                if item in tx.state["instances"]}:
            continue
        if "same_name_as_var" in spec and tx.card(instance_id)["name"] not in {
                tx.card(item)["name"] for item in bound_ids(spec["same_name_as_var"]) if item in tx.state["instances"]}:
            continue
        if "semantic_type" in spec:
            card = tx.card(instance_id)
            kind = "hero" if is_hero(card) else "monster" if card["subcategory"] == "怪物" else "village" if card["card_type"] in ("基础牌", "村庄牌") else "other"
            if kind != spec["semantic_type"]:
                continue
        if "without_weapon_tag" in spec:
            from backend.tests.migration.reference.combat import equipment_pairs
            if any(hero == instance_id and spec["without_weapon_tag"] in tx.card(weapon)["tags"].split("|")
                   for hero, weapon in equipment_pairs(tx.state.get("battle_context") or {})
                   if weapon in tx.zone("hand")):
                continue
        if "in_hand" in spec and (instance_id in tx.zone("hand", subject)) != spec["in_hand"]:
            continue
        if spec.get("in_selected_dungeon") and _location(tx, instance_id) != bindings.get("_dungeon", "").replace("dungeon:", "hall:"):
            continue
        if "adjacent_to_var" in spec:
            first = bindings.get(spec["adjacent_to_var"])
            place = _location(tx, instance_id)
            if (not place or not place.startswith("hall:") or _location(tx, first) != place
                    or abs(tx.state["zones"][place].index(first) - tx.state["zones"][place].index(instance_id)) != 1):
                continue
        if "compare_stat" in spec:
            comparison = spec["compare_stat"]
            actual, expected = stat(tx.card(instance_id), comparison["field"]), _expr(tx, comparison["value"], bindings)
            if comparison["field"] == "health" and tx.state.get("battle_context"):
                from backend.tests.migration.reference.combat import monster_health
                actual = monster_health(tx, tx.card(instance_id), target_id=instance_id)
            if not {"le": actual <= expected, "lt": actual < expected, "eq": actual == expected,
                    "ge": actual >= expected, "gt": actual > expected}[comparison["op"]]:
                continue
        if "movable" in spec:
            if can_move_monster(tx, instance_id) != spec["movable"]:
                continue
        if spec.get("revealed_only"):
            location = _location(tx, instance_id)
            if location is None or ":revealed_" not in location:
                continue
        if "exclude_pile_var" in spec and _location(tx, instance_id) == _location(tx, bindings.get(spec["exclude_pile_var"])):
            continue
        if "rank" in spec:
            location = _location(tx, instance_id)
            if not location or not location.startswith("hall:"):
                continue
            rank = 0 if location.endswith(":rank0") else tx.state["zones"][location].index(instance_id) + 1
            if rank != spec["rank"]:
                continue
        card = tx.card(instance_id)
        if not matches(card, spec) or spec.get("exclude_source") and instance_id == bindings.get("source"):
            continue
        if "strength_min" in spec or "strength_max" in spec:
            current = (combat_values(tx, 1)["hero_strength"].get(instance_id, stat(card, "strength"))
                       if tx.state.get("battle_context") else stat(card, "strength"))
            if current < spec.get("strength_min", -100) or current > spec.get("strength_max", 100):
                continue
        if spec.get("duplicate_names") and sum(tx.card(item)["name"] == card["name"] for item in candidates) < 2:
            continue
        if spec.get("unmarked") and tx.state["instances"][instance_id]["flags"].get("pending_after_battle_destruction"):
            continue
        if "equipped" in spec:
            from backend.tests.migration.reference.combat import equipment_pairs
            pairs = equipment_pairs(tx.state.get("battle_context") or {})
            equipped = any(instance_id in pair for pair in pairs)
            if equipped != spec["equipped"]:
                continue
        if "equipper_tags_any" in spec:
            from backend.tests.migration.reference.combat import equipment_pairs
            if not any(weapon == instance_id and set(tx.card(hero)["tags"].split("|")).intersection(spec["equipper_tags_any"])
                       for hero, weapon in equipment_pairs(tx.state.get("battle_context") or {})):
                continue
        if "equipper_card_id" in spec:
            from backend.tests.migration.reference.combat import equipment_pairs
            if not any(weapon == instance_id and tx.card(hero)["card_id"] == spec["equipper_card_id"]
                       for hero, weapon in equipment_pairs(tx.state.get("battle_context") or {})):
                continue
        if spec.get("unused") and instance_id in tx.state.get("used_cards", []):
            continue
        if "used" in spec and (instance_id in tx.state.get("used_cards", [])) != spec["used"]:
            continue
        if "in_discard" in spec and bool((_location(tx, instance_id) or "").endswith(":discard")) != spec["in_discard"]:
            continue
        if spec.get("equipment_space"):
            from backend.tests.migration.reference.combat import equipment_capacity, equipment_pairs
            if sum(hero == instance_id for hero, _ in equipment_pairs(tx.state["battle_context"])) >= equipment_capacity(tx, instance_id):
                continue
        if spec.get("same_family_as_event"):
            from backend.tests.migration.reference.combat import monster_family
            event_source = tx.state.get("event_context", {}).get("source_instance_id")
            if event_source not in tx.state["instances"] or monster_family(tx.card(instance_id)) != monster_family(tx.card(event_source)):
                continue
        if "participating" in spec and tx.state.get("battle_context"):
            context = tx.state["battle_context"]
            target_id = context.get("target_instance_id")
            target = tx.card(target_id) if target_id in tx.state["instances"] else None
            included = instance_id not in combat_values(tx, context.get("target_rank", 1), target)["excluded_instance_ids"]
            if included != spec["participating"]:
                continue
        result.append(instance_id)
    if len(result) > MAX_QUERY_RESULTS:
        raise EffectError("effect query has too many candidates")
    field = spec.get("max_by", spec.get("min_by"))
    if field and result:
        key = "cost" if field == "purchase_cost" else field
        values = {item: stat(tx.card(item), key) for item in result}
        if key == "pile_size":
            values = {item: len(tx.state["zones"][_location(tx, item)]) for item in result}
        if key == "strength" and tx.state.get("battle_context"):
            values.update({item: amount for item, amount in combat_values(tx, 1)["hero_strength"].items()
                           if item in values})
        if key == "attack" and tx.state.get("battle_context"):
            trace = combat_values(tx, 1)
            by_instance = {row["instance_id"]: row["attack"] + row["magic_attack"] for row in trace["components"]}
            for item in values:
                values[item] = by_instance.get(item, 0) + sum(by_instance.get(weapon, 0)
                    for hero, weapon in trace["equipped_pairs"] if hero == item)
        extreme = (max if "max_by" in spec else min)(values.values())
        result = [item for item in result if values[item] == extreme]
    return result

def _expr(tx: Transition, value: int | dict, bindings: dict | None = None) -> int:
    if isinstance(value, int):
        return value
    op, operand = next(iter(value.items()))
    if op == "count":
        return len(_query(tx, operand, bindings))
    if op in ("sum", "maximum"):
        amounts = [stat(tx.card(item), operand["field"]) for item in _query(tx, operand["query"], bindings)]
        return sum(amounts) if op == "sum" else max(amounts, default=0)
    if op == "stat":
        instance = _bound_target(bindings or {}, {"var": operand["var"]})
        if operand["field"] == "strength" and tx.state.get("battle_context"):
            return combat_values(tx, 1)["hero_strength"].get(instance, stat(tx.card(instance), "strength"))
        return stat(tx.card(instance), operand["field"])
    if op == "resource":
        return tx.state["players"][(bindings or {}).get("_subject", tx.player_id)][operand]
    if op == "context":
        return tx.state.get("event_context", {}).get(operand, 0)
    if op == "players":
        return len(active_players(tx.state)) - int(operand == "others")
    if op == "combat":
        if tx.state.get("battle_context") is None:
            raise EffectError("combat value needs a dungeon action")
        return combat_values(tx, tx.state["battle_context"].get("target_rank", 1))[operand]
    if op == "value":
        result = (bindings or {}).get(operand)
        if not isinstance(result, int) or isinstance(result, bool) or not -10000 <= result <= 10000:
            raise EffectError(f"unbound numeric variable: {operand}")
        return result
    left, right = (_expr(tx, item, bindings) for item in operand)
    if op == "div" and right == 0:
        raise EffectError("effect division by zero")
    result = {"add": lambda: left + right, "mul": lambda: left * right,
              "sub": lambda: left - right, "div": lambda: left // right,
              "min": lambda: min(left, right), "max": lambda: max(left, right)}[op]()
    if not -10000 <= result <= 10000:
        raise EffectError("effect expression exceeds numeric bounds")
    return result

def _condition(tx: Transition, spec: dict, bindings: dict | None = None) -> bool:
    op, value = next(iter(spec.items()))
    if op == "all":
        return all(_condition(tx, item, bindings) for item in value)
    if op == "any":
        return any(_condition(tx, item, bindings) for item in value)
    if op == "not":
        return not _condition(tx, value, bindings)
    if op == "exists":
        return bool(_query(tx, value, bindings))
    if op == "action_in":
        return tx.state["chosen_action"] in value
    if op == "setting_active":
        return value in tx.state["active_settings"]
    if op == "choice_is":
        return (bindings or {}).get(value["var"]) == value["option"]
    if op == "subject_is_active":
        return ((bindings or {}).get("_subject", tx.player_id) == tx.player_id) == value
    left, right = _expr(tx, value["left"], bindings), _expr(tx, value["right"], bindings)
    return {"eq": lambda: left == right, "ne": lambda: left != right,
            "lt": lambda: left < right, "le": lambda: left <= right,
            "gt": lambda: left > right, "ge": lambda: left >= right}[value["op"]]()

def _bound_target(bindings: dict, target: dict) -> str:
    instance_id = bindings.get(target["var"])
    if not isinstance(instance_id, str):
        raise EffectError(f"unbound card target: {target['var']}")
    return instance_id
