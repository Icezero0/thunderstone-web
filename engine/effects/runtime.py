"""Deterministic interpreter for compiled, fully bound card abilities."""

from __future__ import annotations

from copy import deepcopy
from typing import TYPE_CHECKING

from engine.effects.compiler import Ability, EffectsRuleset
from engine.turn.operations import TurnError, number
from engine.effects.combat import matches, stat, combat_values, is_hero
from engine.rules.players import active_players

if TYPE_CHECKING:
    from engine.turn.operations import Transition


MAX_QUERY_RESULTS = 200
MAX_DRAW = 100
MAX_STEPS = 4096


class EffectError(TurnError):
    """An executable ability has no valid resolution in the current state."""


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
            from engine.effects.combat import equipment_pairs
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
                from engine.effects.combat import monster_health
                actual = monster_health(tx, tx.card(instance_id), target_id=instance_id)
            if not {"le": actual <= expected, "lt": actual < expected, "eq": actual == expected,
                    "ge": actual >= expected, "gt": actual > expected}[comparison["op"]]:
                continue
        if "movable" in spec:
            from engine.effects.hall import can_move_monster
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
            from engine.effects.combat import equipment_pairs
            pairs = equipment_pairs(tx.state.get("battle_context") or {})
            equipped = any(instance_id in pair for pair in pairs)
            if equipped != spec["equipped"]:
                continue
        if "equipper_tags_any" in spec:
            from engine.effects.combat import equipment_pairs
            if not any(weapon == instance_id and set(tx.card(hero)["tags"].split("|")).intersection(spec["equipper_tags_any"])
                       for hero, weapon in equipment_pairs(tx.state.get("battle_context") or {})):
                continue
        if "equipper_card_id" in spec:
            from engine.effects.combat import equipment_pairs
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
            from engine.effects.combat import equipment_capacity, equipment_pairs
            if sum(hero == instance_id for hero, _ in equipment_pairs(tx.state["battle_context"])) >= equipment_capacity(tx, instance_id):
                continue
        if spec.get("same_family_as_event"):
            from engine.effects.combat import monster_family
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


def _source_instances(tx: Transition, ability: Ability) -> list[str]:
    from engine.effects.abilities import source_matches
    if ability.source_zone in ("active_hand", "active_control"):
        pool = tx.zone("hand" if ability.source_zone == "active_hand" else "control")
    elif ability.source_zone == "battle_target":
        target = (tx.state.get("battle_context") or {}).get("target_instance_id")
        pool = [target] if target in tx.state["instances"] else []
    elif ability.source_zone == "hall":
        pool = [item for zone, pile in tx.state["zones"].items() if zone.startswith("hall:") for item in pile]
    elif ability.source_zone == "event_source":
        source = tx.state.get("event_context", {}).get("source_instance_id")
        pool = [source] if source in tx.state["instances"] else []
    elif ability.source_zone == "attached":
        pool = list(tx.state.get("attachments", {}))
    else:
        if ability.source_card_id not in tx.state["active_settings"]:
            return []
        pool = tx.state["zones"].get("settings", [])
    return [instance_id for instance_id in pool
            if source_matches(tx, instance_id, ability.source_card_id)]


def available_activations(tx: Transition, ruleset: EffectsRuleset) -> list[dict]:
    if tx.state["chosen_action"] not in ("village", "dungeon"):
        return []
    options = []
    for ability in ruleset.abilities:
        if ability.kind != "activated" or tx.state["chosen_action"] not in ability.actions:
            continue
        from engine.effects.combat import hall_rules
        if hall_rules(tx, "dungeon_deck_lock") and _targets_dungeon_deck(ability.body):
            continue
        for source_id in _source_instances(tx, ability):
            if not all(_condition(tx, condition, {"source": source_id, "_subject": tx.player_id})
                       for condition in ability.conditions):
                continue
            usage_key = f"{source_id}:{ability.id}"
            if (ability.usage == "once_per_turn"
                    and tx.state.get("ability_uses", {}).get(usage_key)
                    == tx.state["turn_number"]):
                continue
            options.append({"ability_id": ability.id,
                            "source_instance_id": source_id})
    return options


def _targets_dungeon_deck(value):
    if isinstance(value, list):
        return any(_targets_dungeon_deck(item) for item in value)
    return isinstance(value, dict) and (
        value.get("op") == "reveal" and value.get("zone") == "dungeon"
        or value.get("destination") in ("dungeon_top", "dungeon_bottom")
        or value.get("op") in ("shuffle_hall_top", "swap_dungeon_top", "shuffle_destroyed_traps")
        or any(_targets_dungeon_deck(item) for item in value.values() if isinstance(item, (dict, list))))


def _bound_target(bindings: dict, target: dict) -> str:
    instance_id = bindings.get(target["var"])
    if not isinstance(instance_id, str):
        raise EffectError(f"unbound card target: {target['var']}")
    return instance_id


def _payable(tx: Transition, cost: dict, bindings: dict) -> bool:
    if cost["op"] == "spend_xp":
        amount = _expr(tx, cost["amount"], bindings)
        return amount >= 0 and tx.state["players"][bindings.get("_subject", tx.player_id)]["xp"] >= amount
    instance_id = _bound_target(bindings, cost["target"])
    location = _location(tx, instance_id)
    subject = bindings.get("_subject", tx.player_id)
    return location in (f"player:{subject}:hand", f"player:{subject}:control") or (
        location is not None and location.startswith(f"player:{subject}:revealed_")
    ) or (
        cost["op"] == "destroy" and location == f"player:{subject}:discard") or (
        cost["op"] == "destroy" and location is not None
        and location.startswith(("village_supply:", "hero_supply:"))
        and tx.state["zones"][location][0] == instance_id)


def _atom(tx: Transition, node: dict, bindings: dict, ability_id: str) -> None:
    op = node["op"]
    subject = bindings.get("_subject", tx.player_id)
    if node.get("as_owner"):
        subject = tx.state["instances"][_bound_target(bindings, node["target"])]["owner_player_id"]
        bindings = {**bindings, "_subject": subject}
    player = tx.state["players"][subject]
    if op == "draw":
        count = _expr(tx, node["count"], bindings)
        if not 0 <= count <= MAX_DRAW:
            raise EffectError("invalid effect draw count")
        taken = tx.draw(count, player_id=subject)
        tx.event("effect_draw", ability_id=ability_id, player_id=subject,
                 requested=count, instance_ids=taken)
    elif op in ("show", "show_hand"):
        shown = list(tx.zone("hand", subject)) if op == "show_hand" else [_bound_target(bindings, node["target"])]
        if any(item not in tx.zone("hand", subject) for item in shown):
            raise EffectError("shown card is not in the subject's hand")
        tx.event("cards_shown", ability_id=ability_id, player_id=subject, instance_ids=shown)
    elif op in ("destroy", "discard"):
        instance_id = _bound_target(bindings, node["target"])
        if not _payable(tx, node, bindings):
            raise EffectError(f"effect target cannot be {op}ed now")
        location = _location(tx, instance_id)
        card_id = tx.state["instances"][instance_id]["card_id"]
        if op == "destroy":
            destination = tx.destroy_card(instance_id, reason=ability_id)["destination"]
        else:
            destination = f"player:{subject}:discard"
            tx.move(instance_id, location, destination)
        tx.event("effect_card_removed", ability_id=ability_id, op=op,
                 instance_id=instance_id, card_id=card_id,
                 source=location, destination=destination)
    elif op in ("gain_xp", "spend_xp", "lose_xp", "mod_gold", "grant_buy", "mod_attack",
                "mod_magic_attack", "mod_light"):
        amount = _expr(tx, node["amount"], bindings)
        if op == "gain_xp":
            if amount < 0:
                raise EffectError("gain_xp needs nonnegative amount")
            player["xp"] += amount
        elif op == "spend_xp":
            if amount < 0 or player["xp"] < amount:
                raise EffectError("insufficient XP for effect")
            player["xp"] -= amount
        elif op == "lose_xp":
            if amount < 0:
                raise EffectError("lose_xp needs nonnegative amount")
            player["xp"] = max(0, player["xp"] - amount)
        elif op == "mod_gold":
            if tx.state["chosen_action"] != "village":
                raise EffectError("gold modification requires village action")
            tx.player["temporary_gold"] = max(0, tx.player["temporary_gold"] + amount)
        elif op == "grant_buy":
            if (tx.state["chosen_action"] != "village" or amount < 0
                    or tx.player["purchases_remaining"] + amount > 100):
                raise EffectError("invalid additional village purchase")
            tx.player["purchases_remaining"] += amount
        else:
            context = tx.state["battle_context"]
            if tx.state["chosen_action"] != "dungeon" or context is None:
                raise EffectError("battle modifier requires dungeon preparation")
            modifiers = context.setdefault("modifiers", {})
            field = {"mod_attack": "attack", "mod_magic_attack": "magic_attack",
                     "mod_light": "light"}[op]
            modifiers[field] = modifiers.get(field, 0) + amount
            context.setdefault("modifier_sources", []).append({
                "source_instance_id": bindings.get("source"), "field": field, "amount": amount})
        tx.event("effect_resource_changed", ability_id=ability_id, op=op,
                 player_id=subject, amount=amount)
    elif op == "mod_card":
        instance_id = _bound_target(bindings, node["target"])
        if instance_id not in tx.zone("hand") or tx.state["battle_context"] is None:
            raise EffectError("card modifier needs an active hand card in a dungeon action")
        changes = tx.state["battle_context"].setdefault("card_modifiers", {}).setdefault(instance_id, {})
        amount = _expr(tx, node["amount"], bindings)
        field = node["stat"]
        if field == "attack" and amount < 0 and tx.state["subphase"] == "BATTLE_EFFECTS":
            trace = combat_values(tx, tx.state["battle_context"].get("target_rank", 1))
            component = next((row for row in trace["components"] if row["instance_id"] == instance_id), {})
            if component.get("attack", 0) <= 0:
                if component.get("magic_attack", 0) > 0:
                    field = "magic_attack"
                else:
                    amount = 0
        changes[field] = changes.get(field, 0) + amount
        tx.event("effect_card_modified", ability_id=ability_id, instance_id=instance_id,
                 stat=field, amount=amount)
        if node["stat"] == "strength":
            from engine.effects.combat import reconcile_equipment
            reconcile_equipment(tx, during_battle=tx.state["subphase"] == "BATTLE_EFFECTS")
    elif op == "mod_monster_health":
        instance = _bound_target(bindings, node["target"])
        changes = tx.state["battle_context"].setdefault("monster_health_modifiers", {})
        changes[instance] = changes.get(instance, 0) + _expr(tx, node["amount"], bindings)
    elif op in ("collect", "clear_collection"):
        key = f"{bindings.get('_ability_id')}:{bindings.get('source')}:{node['collection']}"
        collections = tx.state.setdefault("effect_collections", {})
        if op == "clear_collection":
            collections[key] = []
        else:
            collections.setdefault(key, []).extend(_query(tx, node["query"], bindings))
    elif op == "add_global_rule":
        rule = {key: node[key] for key in ("kind", "until", "scope", "amount")}
        rule.update(player_id=tx.player_id, source_instance_id=bindings["source"], created_turn=tx.state["turn_number"])
        tx.state["continuous_effects"].append(rule)
        tx.event("continuous_rule_added", rule=rule, ability_id=ability_id)
    elif op == "copy_hero":
        from engine.effects.abilities import copy_hero
        copy_hero(tx, _bound_target(bindings, node["target"]), _bound_target(bindings, node["other"]), preserve_attack=node["preserve_attack"], full_card=node.get("full_card", False))
    elif op == "remove_listener":
        tx.state["registered_triggers"] = [listener for listener in tx.state["registered_triggers"]
            if listener["ability_id"] != ability_id or listener["source_instance_id"] != bindings["source"]]
    elif op == "redistribute_discards":
        remaining = _query(tx, node["query"], bindings)
        tx.rng.shuffle(remaining)
        assignments = []
        for player in active_players(tx.state):
            if player == tx.player_id or not remaining:
                continue
            item = remaining.pop(0)
            tx.state["instances"][item]["owner_player_id"] = player
            tx.move(item, _location(tx, item), f"player:{player}:hand")
            assignments.append({"player_id": player, "instance_id": item})
        tx.event("cards_randomly_distributed", assignments=assignments, ability_id=ability_id)
    elif op == "attach_card":
        from engine.effects.attachments import attach
        attach(tx, _bound_target(bindings, node["target"]), _bound_target(bindings, node["anchor"]), node["kind"], owner=subject)
    elif op == "release_attachment":
        from engine.effects.attachments import release
        release(tx, _bound_target(bindings, node["target"]), recipient=node.get("recipient", "owner"), destroy_anchor=node.get("destroy_anchor", True))
    elif op == "grant_basic_buy":
        tx.player["extra_basic_purchases"] = tx.player.get("extra_basic_purchases", 0) + 1
    elif op == "grant_extra_turn":
        tx.player["extra_turns"] = tx.player.get("extra_turns", 0) + 1
        tx.event("extra_turn_granted", player_id=tx.player_id, ability_id=ability_id)
    elif op == "shuffle_destroyed_traps":
        from engine.effects.hall_actions import shuffle_destroyed_traps
        shuffle_destroyed_traps(tx, bindings)
    elif op == "destroy_matching_supply":
        from engine.effects.inventory import destroy_matching
        count = _expr(tx, node["count"], bindings)
        if not 0 <= count <= 100:
            raise EffectError("invalid matching supply destruction count")
        destroy_matching(tx, _bound_target(bindings, node["target"]), count,
                         family=node.get("family", False), bottom=node.get("from_bottom", False), ability_id=ability_id)
    elif op == "destroy_purchased_supply":
        from engine.effects.inventory import destroy_purchased
        destroy_purchased(tx, ability_id)
    elif op == "destroy_basic_supply":
        if node["card_id"] not in tx.state["supply_rules"]["basic_card_ids"]:
            raise EffectError("not an infinite basic supply")
        count = _expr(tx, node["count"], bindings)
        if not 0 <= count <= 100:
            raise EffectError("invalid basic supply destruction count")
        tx.event("infinite_supply_destruction", card_id=node["card_id"], count=count, ability_id=ability_id)
    elif op == "random_destroy":
        hand = tx.zone("hand", subject)
        if hand:
            victim = hand[tx.rng.randbelow(len(hand))]
            tx.event("cards_shown", player_id=subject, instance_ids=[victim], ability_id=ability_id)
            if not matches(tx.card(victim), node["filter"]):
                tx.destroy_card(victim, reason=ability_id)
    elif op == "convert_card_magic":
        tx.state["battle_context"].setdefault("convert_card_magic", []).append(_bound_target(bindings, node["target"]))
    elif op == "grant_turn_buff":
        from engine.effects.status import grant_turn_buff
        grant_turn_buff(tx, _bound_target(bindings, node["target"]), node["buff"],
                        ability_id=ability_id, source_id=bindings["source"])
    elif op in ("mark_destroy", "exclude_combat"):
        instance_id = _bound_target(bindings, node["target"])
        if instance_id not in tx.state["instances"] or _location(tx, instance_id) != f"player:{subject}:hand":
            raise EffectError("battle effect needs a card in the affected player's hand")
        if op == "mark_destroy":
            key = "pending_after_battle_destruction" if node.get("when", "after_battle") == "after_battle" else "pending_turn_end_destruction"
            tx.state["instances"][instance_id]["flags"][key] = True
        else:
            tx.state["battle_context"].setdefault("excluded_participants", []).append(instance_id)
        tx.event("effect_card_marked", ability_id=ability_id, instance_id=instance_id, mark=op,
                 timing=node.get("when", "after_battle"))
    elif op == "move":
        instance = _bound_target(bindings, node["target"])
        location = _location(tx, instance)
        if location is None:
            raise EffectError("moved card has no location")
        recipient = node.get("recipient", "subject")
        if recipient == "active":
            subject = tx.player_id
        elif recipient == "owner":
            subject = tx.state["instances"][instance]["owner_player_id"]
        elif isinstance(recipient, dict):
            subject = bindings.get(recipient["var"])
        if subject not in tx.state["players"]:
            raise EffectError("invalid card recipient")
        part = "draw" if node["destination"] == "draw_top" else node["destination"]
        destination = f"player:{subject}:{part}"
        tx.state["instances"][instance]["owner_player_id"] = subject
        tx.state["zones"].setdefault(destination, [])
        tx.move(instance, location, destination)
        if node["destination"] == "draw_top":
            pile = tx.state["zones"][destination]
            pile.remove(instance)
            pile.insert(0, instance)
    elif op == "destroy_supply":
        instance = _bound_target(bindings, node["target"])
        zone = _location(tx, instance)
        if zone is None or not zone.startswith(("village_supply:", "hero_supply:")):
            raise EffectError("destroy_supply needs a supply card")
        count = _expr(tx, node["count"], bindings)
        if not 0 <= count <= 10000:
            raise EffectError("invalid supply destruction count")
        pile = tx.state["zones"][zone]
        victims = list(reversed(pile))[:count] if node.get("from_bottom") else list(pile[:count])
        for victim in victims:
            tx.destroy_card(victim, reason=ability_id)
    elif op == "random_discard":
        count = _expr(tx, node["count"], bindings)
        if not 0 <= count <= MAX_DRAW:
            raise EffectError("invalid random discard count")
        for _ in range(min(count, len(tx.zone("hand", subject)))):
            pile = tx.zone("hand", subject)
            instance = pile[tx.rng.randbelow(len(pile))]
            tx.move(instance, f"player:{subject}:hand", f"player:{subject}:discard")
    elif op == "reveal_cycle":
        from engine.effects.reveal import resolve_reveal_cycle
        resolve_reveal_cycle(tx, node["filter"], node["goal"], ability_id=ability_id, responses=bindings.get("_responses"))
    elif op in ("mod_next_hand", "mod_next_gold", "force_dungeon"):
        key = {"mod_next_hand": "next_hand_bonus", "mod_next_gold": "turn_gold_adjustment",
               "force_dungeon": "forced_dungeon"}[op]
        amount = 1 if op == "force_dungeon" else _expr(tx, node["amount"], bindings)
        player[key] = player.get(key, 0) + amount
        tx.event("effect_player_rule_changed", player_id=subject, rule=key, amount=amount, ability_id=ability_id)
    elif op == "set_battle_flag":
        if tx.state["battle_context"] is None:
            raise EffectError("battle flag needs dungeon preparation")
        tx.state["battle_context"][node["flag"]] = node["value"]
    elif op == "set_retreat_position":
        position = _expr(tx, node["amount"], bindings)
        if tx.state["battle_context"] is None or not 1 <= position <= 100:
            raise EffectError("invalid monster retreat position")
        tx.state["battle_context"]["retreat_position"] = position
    elif op == "gain_card":
        card_id = node["card_id"]
        if card_id not in tx.cards:
            raise EffectError(f"unknown gained card: {card_id}")
        destination = f"player:{subject}:{node.get('destination', 'discard')}"
        if card_id in tx.state["supply_rules"]["basic_card_ids"]:
            instance_id = tx.create_owned(card_id, destination, "ability_gain", owner_player_id=subject)
        else:
            supply = next((zone for zone, pile in tx.state["zones"].items()
                           if pile and (zone.startswith("village_supply:")
                                        or zone.startswith("hero_supply:"))
                           and tx.state["instances"][pile[0]]["card_id"] == card_id), None)
            if supply is None:
                raise EffectError(f"no available supply for {card_id}")
            instance_id = tx.state["zones"][supply][0]
            tx.state["instances"][instance_id]["owner_player_id"] = subject
            tx.move(instance_id, supply, destination)
        tx.event("effect_card_gained", ability_id=ability_id,
                 instance_id=instance_id, card_id=card_id,
                 destination=destination)
    else:
        raise EffectError(f"unhandled atom: {op}")


def _run(tx: Transition, ability_id: str, source_id: str, stack: list[dict]) -> bool:
    steps = 0
    while stack:
        steps += 1
        tx._effect_steps = getattr(tx, "_effect_steps", 0) + 1
        if steps > MAX_STEPS or tx._effect_steps > MAX_STEPS:
            raise EffectError("effect execution step limit reached")
        frame = stack.pop()
        node, bindings = frame["node"], frame["bindings"]
        ability_id = bindings.get("_ability_id", ability_id)
        source_id = bindings.get("source", source_id)
        op = node["op"]
        from engine.effects.responses import has_global_work
        response_scope = bindings.get("_responses", {})
        subject = bindings.get("_subject", tx.player_id)
        if node.get("as_owner") and isinstance(bindings.get(node["target"]["var"]), str):
            subject = tx.state["instances"][bindings[node["target"]["var"]]]["owner_player_id"]
        if subject in response_scope.get("immune", []) and op not in ("_ability_end", "_discard_reveal") and not has_global_work(node):
            continue
        if op == "_ability_end":
            tx.event("ability_resolved", ability_id=ability_id, source_instance_id=source_id)
        elif op == "_offer_effect":
            from engine.effects.responses import offer_effect
            return offer_effect(tx, node["body"], bindings, stack, ability_id, source_id)
        elif op == "_respond_subject":
            # A player's part is atomic for immunity even when that part
            # contributes cards to a later global comparison (e.g. Hydra).
            if bindings.get("_subject", tx.player_id) in response_scope.get("immune", []):
                continue
            ability = tx.ruleset.by_id(ability_id)
            if (ability.source_zone in ("active_hand", "active_control")
                    and source_id in tx.state["instances"]
                    and tx.state["instances"][source_id]["owner_player_id"] == tx.player_id
                    and bindings.get("_subject", tx.player_id) != tx.player_id):
                from engine.effects.responses import offer_effect
                return offer_effect(tx, node["body"], bindings, stack, ability_id, source_id, subject_window=True)
            stack.append({"node": node["body"], "bindings": bindings})
        elif op == "destroy" and not node.get("_is_cost"):
            from engine.effects.responses import offer_destroy
            if offer_destroy(tx, _bound_target(bindings, node["target"]), ability_id,
                             stack=stack, bindings=bindings, ability_id=ability_id, source_id=source_id):
                return False
            _atom(tx, node, bindings, ability_id)
        elif op == "_discard_reveal":
            zone = node["zone"]
            subject = bindings.get("_subject", tx.player_id)
            remaining = list(tx.state["zones"].get(zone, []))
            destination = node.get("return_to", f"player:{subject}:discard")
            for instance in remaining:
                tx.move(instance, zone, destination)
            if destination.startswith("dungeon:"):
                pile = tx.state["zones"][destination]
                pile[:] = remaining + [item for item in pile if item not in remaining]
            tx.state["zones"].pop(zone, None)
        elif op == "choose_value":
            from engine.effects.choices import value_options, value_bindings, pause
            options = value_options(tx, node, bindings)
            tx.trace_effect(ability_id, source_id, node, bindings, value_options=options)
            if not options:
                tx.event("effect_choice_unavailable", ability_id=ability_id, choice_kind=node["kind"])
                continue
            if len(options) == 1:
                body = {"op": "_respond_subject", "body": node["then"]} if node["kind"] == "player" and node.get("as_subject") else node["then"]
                stack.append({"node": body, "bindings": value_bindings(bindings, node, options[0])})
            else:
                pause(tx, "effect_value", node, bindings, stack, ability_id, source_id, options=options)
                return False
        elif op == "remember":
            tx.trace_effect(ability_id, source_id, node, bindings,
                            candidate_instance_ids=_query(tx, node["query"], bindings))
            stack.append({"node": node["then"], "bindings": {
                **bindings, node["bind"]: _query(tx, node["query"], bindings)}})
        elif op == "reorder":
            from engine.effects.choices import pause, reorder_cards
            candidates = _query(tx, node["query"], bindings)
            tx.trace_effect(ability_id, source_id, node, bindings, candidate_instance_ids=candidates)
            if len(candidates) <= 1:
                reorder_cards(tx, node, bindings, candidates)
            else:
                pause(tx, "effect_reorder", node, bindings, stack, ability_id, source_id,
                      candidate_instance_ids=candidates)
                return False
        elif op == "draw" and "bind" in node:
            subject = bindings.get("_subject", tx.player_id)
            count = _expr(tx, node["count"], bindings)
            if not 0 <= count <= MAX_DRAW:
                raise EffectError("invalid effect draw count")
            taken = tx.draw(count, player_id=subject)
            tx.event("effect_draw", ability_id=ability_id, player_id=subject, requested=count, instance_ids=taken)
            stack.append({"node": node["then"], "bindings": {**bindings, node["bind"]: taken}})
        elif op == "move":
            item = _bound_target(bindings, node["target"])
            old_owner = tx.state["instances"][item]["owner_player_id"]
            _atom(tx, node, bindings, ability_id)
            owner = tx.state["instances"][item]["owner_player_id"]
            if tx.printed_card(item)["card_type"] == "疾病牌" and owner != old_owner:
                from engine.turn.workflow import queue_steps
                queue_steps(tx, [{"op": "resolve_disease_gain", "gain": {
                    "instance_id": item, "player_id": owner, "destination": node["destination"], "used_sources": []}},
                    {"op": "effect_continuation", "ability_id": ability_id, "source_instance_id": source_id, "stack": deepcopy(stack)}], front=True)
                return tx.state["pending_choice"] is None
        elif op == "reuse_ability":
            from engine.effects.abilities import offer_reuse
            if not offer_reuse(tx, _bound_target(bindings, node["target"]), bindings, stack, ability_id, source_id):
                return False
        elif op in ("borrow_card", "equip_from_supply"):
            from engine.effects.borrowing import borrow
            from engine.turn.dungeon import equip_weapon
            from engine.turn.workflow import queue_steps
            item = _bound_target(bindings, node["target"])
            if op == "borrow_card":
                borrow(tx, item, when=node["when"], return_destroyed=node["return_destroyed"])
            else:
                zone = _location(tx, item)
                if zone is None or not zone.startswith("village_supply:") or tx.state["zones"][zone][0] != item:
                    raise EffectError("weapon is not on top of its supply")
                tx.state["instances"][item]["owner_player_id"] = tx.player_id
                tx.move(item, zone, f"player:{tx.player_id}:hand")
                tx.state["instances"][item]["flags"]["pending_after_battle_destruction"] = True
                # Drawing a weapon from the village also counts for Insight Blade.
                from engine.effects.combat import equipment_pairs, hand_rules
                carried = {weapon for _, weapon in equipment_pairs(tx.state["battle_context"])}
                for source, _ in hand_rules(tx, "draw_attack"):
                    if source in carried:
                        counts = tx.state["battle_context"].setdefault("equipment_draw_counts", {})
                        counts[source] = counts.get(source, 0) + 1
                tx.event("effect_draw", ability_id=ability_id, player_id=tx.player_id, requested=1, instance_ids=[item])
            steps = equip_weapon(tx, _bound_target(bindings, node["equipper"]), item, defer_events=True) if "equipper" in node else []
            steps.append({"op": "effect_continuation", "ability_id": ability_id, "source_instance_id": source_id, "stack": deepcopy(stack)})
            queue_steps(tx, steps, front=True)
            return tx.state["pending_choice"] is None
        elif op in ("swap_hall", "exchange_hall", "shuffle_hall_top"):
            from engine.effects.hall_actions import swap_hall, exchange_hall, shuffle_hall_top
            from engine.turn.workflow import queue_steps
            first = _bound_target(bindings, node["target"])
            if op == "shuffle_hall_top":
                steps = shuffle_hall_top(tx, first, node["count"])
            else:
                other = _bound_target(bindings, node["other"])
                steps = (swap_hall if op == "swap_hall" else exchange_hall)(tx, first, other)
            steps.append({"op": "effect_continuation", "ability_id": ability_id, "source_instance_id": source_id, "stack": deepcopy(stack)})
            queue_steps(tx, steps, front=True)
            return tx.state["pending_choice"] is None
        elif op == "relocate_hall":
            from engine.effects.hall import relocate
            from engine.turn.workflow import queue_steps
            steps = relocate(tx, _bound_target(bindings, node["target"]), node["destination"], defeat=node.get("defeat", False))
            steps.append({"op": "effect_continuation", "ability_id": ability_id,
                          "source_instance_id": source_id, "stack": deepcopy(stack)})
            queue_steps(tx, steps, front=True)
            return tx.state["pending_choice"] is None
        elif op == "gain_disease":
            from engine.turn.workflow import queue_steps
            count = _expr(tx, node["count"], bindings)
            if not 0 <= count <= MAX_DRAW:
                raise EffectError("invalid effect disease count")
            tx.trace_effect(ability_id, source_id, node, bindings)
            steps = [{"op": "gain_disease", "player_id": bindings.get("_subject", tx.player_id)} for _ in range(count)]
            steps.append({"op": "effect_continuation", "ability_id": ability_id,
                          "source_instance_id": source_id, "stack": deepcopy(stack)})
            queue_steps(tx, steps, front=True)
            return tx.state["pending_choice"] is None
        elif op == "buy":
            from engine.effects.purchase import offer
            maximum_cost = _expr(tx, node["maximum_cost"], bindings) if "maximum_cost" in node else None
            options = offer(tx, node["filter"], maximum_cost)
            if not options:
                tx.event("effect_purchase_unavailable", ability_id=ability_id)
                continue
            tx.state["pending_choice"] = {
                "kind": "effect_purchase", "player_id": tx.player_id,
                "ability_id": ability_id, "source_instance_id": source_id,
                "options": options, "filter": node["filter"], "destination": node["destination"],
                "payment": node.get("payment", "none"), "maximum_cost": maximum_cost, "bindings": bindings}
            tx.state["resolution_frames"] = [{"ability_id": ability_id, "source_instance_id": source_id,
                                              "stack": deepcopy(stack)}]
            tx.event("effect_purchase_requested", ability_id=ability_id, options=options)
            return False
        elif op == "upgrade":
            from engine.effects.upgrade import offer_upgrade
            tx.trace_effect(ability_id, source_id, node, bindings)
            if not offer_upgrade(tx, node, bindings, stack, ability_id, source_id):
                return False
        elif op == "reveal":
            subject = bindings.get("_subject", tx.player_id)
            is_dungeon = node.get("zone") == "dungeon"
            if is_dungeon:
                from engine.effects.choices import dungeon_zone
                origin = dungeon_zone(tx, bindings)
            else:
                origin = f"player:{subject}:draw"
            count = _expr(tx, node["count"], bindings)
            if not 0 <= count <= 1000:
                raise EffectError("invalid reveal count")
            zone = (f"revealed:{origin.removeprefix('dungeon:')}_{tx.state['next_event_sequence']}" if is_dungeon
                    else f"player:{subject}:revealed_{tx.state['next_event_sequence']}")
            tx.state["zones"][zone] = []
            taken = []
            for _ in range(count):
                draw = tx.state["zones"][origin]
                if not draw and not is_dungeon:
                    discard = tx.zone("discard", subject)
                    draw.extend(discard)
                    discard.clear()
                    tx.rng.shuffle(draw)
                    tx.event("player_deck_shuffled", player_id=subject, order=list(draw))
                if not draw:
                    break
                instance = draw[-1] if node.get("from_bottom") else draw[0]
                tx.move(instance, origin, zone)
                taken.append(instance)
                if "until" in node and matches(tx.card(instance), node["until"]):
                    break
            tx.event("cards_revealed", ability_id=ability_id, player_id=subject, instance_ids=taken)
            close = {"op": "_discard_reveal", "zone": zone}
            if is_dungeon:
                close["return_to"] = origin
            stack.append({"node": close, "bindings": bindings})
            stack.append({"node": node["then"], "bindings": {**bindings, node["bind"]: taken, "_reveal_zone": zone}})
        elif op == "sequence":
            tx.trace_effect(ability_id, source_id, node, bindings,
                            child_count=len(node["children"]))
            stack.extend({"node": child, "bindings": bindings}
                         for child in reversed(node["children"]))
        elif op == "if":
            condition_result = _condition(tx, node["condition"], bindings)
            tx.trace_effect(ability_id, source_id, node, bindings,
                            condition_result=condition_result,
                            branch="then" if condition_result else "else")
            branch = node["then"] if condition_result else node.get("else")
            if branch is not None:
                stack.append({"node": branch, "bindings": bindings})
        elif op in ("select", "for_each"):
            candidates = _query(tx, node["query"], bindings)
            minimum = _expr(tx, node.get("min", 1), bindings)
            maximum = _expr(tx, node.get("max", 1), bindings)
            if op == "select" and not 0 <= minimum <= maximum <= 100:
                raise EffectError("invalid dynamic selection bounds")
            if op == "select":
                feasible = len(candidates)
                for constraint in node.get("constraints", []):
                    matching = sum(matches(tx.card(item), constraint["filter"]) for item in candidates)
                    feasible = min(feasible, len(candidates) - matching + min(matching, constraint["maximum"]))
                maximum = min(maximum, feasible)
                if node.get("allow_shortfall"):
                    minimum = min(minimum, maximum)
                if minimum > maximum:
                    raise EffectError("not enough legal cards to satisfy the selection")
            tx.trace_effect(ability_id, source_id, node, bindings,
                            candidate_instance_ids=list(candidates))
            if op == "for_each":
                stack.extend({"node": node["body"],
                              "bindings": {**bindings, node["bind"]: item}}
                             for item in reversed(candidates))
            elif not candidates and minimum and not node.get("allow_shortfall"):
                raise EffectError("required effect choice has no candidate")
            elif not candidates or maximum == 0:
                stack.append({"node": node["then"], "bindings": {**bindings, node["bind"]: []}})
            elif len(candidates) == 1 and minimum == maximum == 1:
                stack.append({"node": node["then"],
                              "bindings": {**bindings, node["bind"]: candidates[0]}})
            else:
                tx.state["pending_choice"] = {
                    "kind": "effect_select", "player_id": bindings.get("_subject", tx.player_id),
                    "ability_id": ability_id, "source_instance_id": source_id,
                    "candidate_instance_ids": candidates,
                    "query": node["query"], "bind": node["bind"],
                    "then": node["then"], "bindings": bindings,
                    "min_count": min(minimum, len(candidates)) if node.get("allow_shortfall") else minimum,
                    "max_count": min(maximum, len(candidates)),
                    "multiple": maximum > 1 or minimum == 0,
                    "highest_by": node.get("highest_by"), "constraints": node.get("constraints", []),
                }
                tx.state["resolution_frames"] = [{
                    "ability_id": ability_id, "source_instance_id": source_id,
                    "stack": deepcopy(stack)}]
                tx.event("effect_choice_requested", ability_id=ability_id,
                         player_id=bindings.get("_subject", tx.player_id), candidate_instance_ids=candidates)
                return False
        elif op == "for_players":
            players = [player for player in active_players(tx.state)
                       if (node["scope"] == "all" or node["scope"] == "active" and player == tx.player_id
                           or node["scope"] == "others" and player != tx.player_id)]
            redirects = bindings.get("_responses", {}).get("redirects", {})
            stack.extend({"node": {"op": "_respond_subject", "body": node["body"]}, "bindings": {**bindings, "_subject": redirects.get(player, player)}}
                         for player in reversed(players))
        elif op == "let":
            stack.append({"node": node["then"],
                          "bindings": {**bindings, node["bind"]: _expr(tx, node["value"], bindings)}})
        elif op == "cost_gate":
            payable = _payable(tx, node["cost"], bindings)
            tx.trace_effect(ability_id, source_id, node, bindings,
                            payable=payable)
            if not payable:
                raise EffectError("ability cost cannot be paid")
            stack.append({"node": node["then"], "bindings": bindings})
            stack.append({"node": {**node["cost"], "_is_cost": True}, "bindings": bindings})
        elif op == "repeat":
            count = _expr(tx, node["times"], bindings)
            tx.trace_effect(ability_id, source_id, node, bindings, repeat_count=count)
            if not 0 <= count <= node["limit"]:
                raise EffectError("effect repetition exceeds its bound")
            stack.extend({"node": node["body"], "bindings": bindings}
                         for _ in range(count))
        elif op == "listen":
            tx.state["registered_triggers"].append({"event": node["event"], "body": node["body"],
                "conditions": node.get("conditions", []), "once": node.get("once", False),
                "ability_id": ability_id, "source_instance_id": source_id, "bindings": deepcopy(bindings),
                "turn_number": tx.state["turn_number"]})
        elif op == "schedule":
            tx.trace_effect(ability_id, source_id, node, bindings,
                            scheduled_event=node["event"])
            if tx.state["timing_window"] == node["event"]:
                raise EffectError("cannot schedule an effect for the current event")
            tx.state["scheduled_effects"].append({
                "event": node["event"], "turn_number": tx.state["turn_number"] + (
                    1 if node["event"] == "TURN_START" else 0),
                "ability_id": ability_id, "source_instance_id": source_id,
                "player_id": tx.player_id, "body": node["body"],
                "bindings": deepcopy(bindings),
            })
            tx.event("effect_scheduled", ability_id=ability_id,
                     event=node["event"], source_instance_id=source_id)
        else:
            tx.trace_effect(ability_id, source_id, node, bindings)
            _atom(tx, node, bindings, ability_id)
    return True


def _ability_frames(ability_id: str, source_id: str, body: dict, bindings: dict) -> list[dict]:
    bound = {**bindings, "source": source_id, "_ability_id": ability_id}
    return [{"node": {"op": "_ability_end"}, "bindings": bound},
            {"node": {"op": "_offer_effect", "body": body}, "bindings": bound}]


def activate(tx: Transition, ruleset: EffectsRuleset, ability_id: str,
             source_id: str) -> bool:
    ability = ruleset.by_id(ability_id)
    if (ability is None or ability.kind != "activated"
            or {"ability_id": ability_id, "source_instance_id": source_id}
            not in available_activations(tx, ruleset)):
        raise EffectError("ability is unavailable in this action")
    if ability.usage == "once_per_turn":
        tx.state.setdefault("ability_uses", {})[f"{source_id}:{ability_id}"] = tx.state[
            "turn_number"]
    tx.event("ability_activated", ability_id=ability_id,
             source_instance_id=source_id, player_id=tx.player_id)
    if source_id not in tx.state.setdefault("used_cards", []):
        tx.state["used_cards"].append(source_id)
    if tx.state.get("battle_context") is not None:
        tags = tx.state["battle_context"].setdefault("used_card_tags", [])
        for tag in tx.card(source_id)["tags"].split("|"):
            if tag and tag not in tags:
                tags.append(tag)
    return _run(tx, ability_id, source_id,
                _ability_frames(ability_id, source_id, ability.body, {"_subject": tx.player_id}))


def dispatch_event(tx: Transition, ruleset: EffectsRuleset, event: str) -> bool:
    """Resolve triggers, saving an explicit ordering choice when several apply."""
    candidates = []
    for listener in list(tx.state["registered_triggers"]):
        if listener["event"] == event and all(_condition(tx, item, listener["bindings"]) for item in listener["conditions"]):
            candidates.append((listener["ability_id"], listener["source_instance_id"], listener["body"], listener["bindings"]))
            if listener["once"]:
                tx.state["registered_triggers"].remove(listener)
    for ability in ruleset.abilities:
        if ability.kind != "triggered" or ability.event != event:
            continue
        for source_id in _source_instances(tx, ability):
            bindings = {"source": source_id, "_subject": tx.player_id}
            if all(_condition(tx, item, bindings) for item in ability.conditions):
                candidates.append((ability.id, source_id, ability.body, bindings))
    def due(scheduled):
        return (scheduled["event"] == event
                and (scheduled["turn_number"] <= tx.state["turn_number"] if event == "TURN_START"
                     else scheduled["turn_number"] == tx.state["turn_number"])
                and scheduled["player_id"] == tx.player_id)

    for scheduled in tx.state["scheduled_effects"]:
        if due(scheduled):
            candidates.append((scheduled["ability_id"],
                               scheduled["source_instance_id"],
                               scheduled["body"], scheduled["bindings"]))
    if not candidates:
        return True
    tx.state["scheduled_effects"] = [item for item in tx.state["scheduled_effects"] if not due(item)]
    if len(candidates) > 1 and event == "BATTLE_BEFORE_OUTCOME":
        candidates.sort(key=lambda item: (item[0], item[1]))
    if event == "BATTLE_BEFORE_OUTCOME":
        from engine.effects.combat import hall_rules
        extra = sum(rule.params["extra"] for source, rule in hall_rules(tx, "repeat_battle")
                    if any(source in pile for zone, pile in tx.state["zones"].items() if zone.endswith(":rank0")))
        original = list(candidates)
        for _ in range(extra):
            candidates.extend(item for item in original if ruleset.by_id(item[0]).source_zone == "battle_target")
    if len(candidates) > 1 and event == "BATTLE_BEFORE_OUTCOME":
        stack = []
        for ability_id, source_id, body, bindings in reversed(candidates):
            stack.extend(_ability_frames(ability_id, source_id, body,
                                          {"_subject": tx.player_id, **bindings}))
        first_id, first_source, _, _ = candidates[0]
        return _run(tx, first_id, first_source, stack)
    if len(candidates) > 1:
        effects = [{"effect_id": f"{source}:{ability}:{index}", "ability_id": ability,
                    "source_instance_id": source, "body": body,
                    "bindings": {"_subject": tx.player_id, **bindings}}
                   for index, (ability, source, body, bindings) in enumerate(candidates)]
        tx.state["pending_choice"] = {"kind": "effect_order", "player_id": tx.player_id,
                                      "event": event, "effects": effects}
        tx.state["resolution_frames"] = [{"kind": "event_order", "event": event, "stack": []}]
        tx.event("effect_order_requested", event=event, effects=[{
            key: item[key] for key in ("effect_id", "ability_id", "source_instance_id")} for item in effects])
        return False
    ability_id, source_id, body, bindings = candidates[0]
    tx.event("ability_triggered", ability_id=ability_id, source_instance_id=source_id, event=event)
    return _run(tx, ability_id, source_id, _ability_frames(
        ability_id, source_id, body, {"_subject": tx.player_id, **bindings}))


def resolve_effect_order(tx: Transition, effect_ids: list[str]) -> bool:
    choice = tx.state["pending_choice"]
    if choice is None or choice.get("kind") != "effect_order":
        raise EffectError("no effect order is pending")
    effects = {item["effect_id"]: item for item in choice["effects"]}
    if (not isinstance(effect_ids, list) or len(effect_ids) != len(effects)
            or any(not isinstance(item, str) for item in effect_ids)
            or set(effect_ids) != set(effects)):
        raise EffectError("effect order must contain every effect once")
    stack = []
    for effect_id in reversed(effect_ids):
        item = effects[effect_id]
        stack.extend(_ability_frames(item["ability_id"], item["source_instance_id"],
                                     item["body"], item["bindings"]))
    tx.state["pending_choice"] = None
    tx.state["resolution_frames"] = []
    tx.event("effect_order_chosen", event=choice["event"], effect_ids=effect_ids)
    first = effects[effect_ids[0]]
    return _run(tx, first["ability_id"], first["source_instance_id"], stack)


def resolve_choice(tx: Transition, selected_id: str | list[str]) -> bool:
    from engine.effects.abilities import source_matches
    choice = tx.state["pending_choice"]
    if choice is None or choice.get("kind") != "effect_select":
        raise EffectError("no effect choice is pending")
    selected = selected_id if isinstance(selected_id, list) else [selected_id]
    if (not choice.get("min_count", 1) <= len(selected) <= choice.get("max_count", 1)
            or any(not isinstance(item, str) for item in selected)
            or len(set(selected)) != len(selected)):
        raise EffectError("chosen cards do not satisfy choice count bounds")
    candidates = _query(tx, choice["query"], choice["bindings"])
    if any(item not in choice["candidate_instance_ids"] or item not in candidates for item in selected):
        raise EffectError("chosen card is no longer a legal candidate")
    for constraint in choice.get("constraints", []):
        if sum(matches(tx.card(item), constraint["filter"]) for item in selected) > constraint["maximum"]:
            raise EffectError("chosen cards violate the selection constraints")
    if choice.get("highest_by") and selected:
        field = choice["highest_by"]
        amounts = {item: stat(tx.card(item), field) for item in candidates}
        if field == "strength" and tx.state.get("battle_context"):
            amounts.update({item: value for item, value in combat_values(tx, 1)["hero_strength"].items() if item in amounts})
        if any(amounts[item] > min(amounts[pick] for pick in selected) for item in candidates if item not in selected):
            raise EffectError("chosen cards must keep the highest values")
    frame = tx.state["resolution_frames"][0]
    if (frame["ability_id"] != choice["ability_id"]
            or frame["source_instance_id"] != choice["source_instance_id"]):
        raise EffectError("effect continuation does not match the choice")
    source_id = choice["source_instance_id"]
    ability = tx.ruleset.by_id(choice["ability_id"])
    if ability is None or not source_matches(tx, source_id, ability.source_card_id):
        raise EffectError("ability continuation has an invalid source")
    stack = deepcopy(frame["stack"])
    stack.append({"node": choice["then"],
                  "bindings": {**choice["bindings"], choice["bind"]:
                               selected if choice.get("multiple") else selected[0]}})
    tx.state["pending_choice"] = None
    tx.state["resolution_frames"] = []
    tx.event("effect_choice_resolved", ability_id=choice["ability_id"],
             player_id=choice["player_id"], selected_instance_id=selected_id)
    return _run(tx, choice["ability_id"], source_id, stack)


def resolve_purchase(tx: Transition, card_id: str | None) -> bool:
    from engine.effects.abilities import source_matches
    from engine.effects.purchase import buy
    from engine.turn.workflow import queue_steps

    choice = tx.state["pending_choice"]
    if choice is None or choice.get("kind") != "effect_purchase":
        raise EffectError("no effect purchase is pending")
    if card_id is not None and (not isinstance(card_id, str) or not any(row["card_id"] == card_id for row in choice["options"])):
        raise EffectError("invalid effect purchase card")
    frame = tx.state["resolution_frames"][0]
    source = choice["source_instance_id"]
    ability = tx.ruleset.by_id(choice["ability_id"])
    if ability is None or not source_matches(tx, source, ability.source_card_id):
        raise EffectError("invalid effect purchase continuation")
    steps = []
    if card_id is not None:
        if choice["payment"] != "none":
            op = "discard" if choice["payment"] == "discard_source" else "destroy"
            if not _payable(tx, {"op": op, "target": {"var": "source"}}, choice["bindings"]):
                raise EffectError("effect purchase payment is unavailable")
        # Price is evaluated before discarding the source: its printed gold is
        # part of the revealed allowance used to make this purchase.
        steps = buy(tx, card_id, choice["filter"], choice["destination"], ability_id=choice["ability_id"], maximum_cost=choice.get("maximum_cost"))
        if choice["payment"] != "none":
            _atom(tx, {"op": op, "target": {"var": "source"}}, choice["bindings"], choice["ability_id"])
    tx.state["pending_choice"] = None
    tx.state["resolution_frames"] = []
    steps.append({"op": "effect_continuation", "ability_id": choice["ability_id"],
                  "source_instance_id": source, "stack": deepcopy(frame["stack"])})
    queue_steps(tx, steps, front=True)
    return tx.state["pending_choice"] is None
