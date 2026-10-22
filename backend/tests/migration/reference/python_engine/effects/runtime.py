"""Deterministic interpreter for compiled, fully bound card abilities."""

from __future__ import annotations

from copy import deepcopy
from typing import TYPE_CHECKING

from backend.app.integrations.game_engine.effects.compiler import EffectsRuleset
from backend.tests.migration.reference.python_engine.turn.operations import TurnError, number
from backend.tests.migration.reference.python_engine.effects.combat import matches, stat, combat_values, is_disease
from backend.tests.migration.reference.python_engine.rules.players import active_players

if TYPE_CHECKING:
    from backend.tests.migration.reference.python_engine.turn.operations import Transition


MAX_DRAW = 100
MAX_STEPS = 4096


class EffectError(TurnError):
    """An executable ability has no valid resolution in the current state."""


def _location(tx: Transition, instance_id: str) -> str | None:
    return next((zone for zone, pile in tx.state["zones"].items()
                 if instance_id in pile), None)


def _query(tx: Transition, spec, bindings: dict | None = None) -> list[str]:
    from backend.tests.migration.reference.python_engine.shared.evaluation import evaluate
    from backend.app.integrations.game_engine.shared.client import SharedRuleError
    try:
        return evaluate(tx, "effect_query", spec, bindings)
    except SharedRuleError as error:
        raise EffectError(str(error)) from error


def _expr(tx: Transition, value, bindings: dict | None = None) -> int:
    from backend.tests.migration.reference.python_engine.shared.evaluation import evaluate
    from backend.app.integrations.game_engine.shared.client import SharedRuleError
    try:
        return evaluate(tx, "effect_expression", value, bindings)
    except SharedRuleError as error:
        raise EffectError(str(error)) from error


def _condition(tx: Transition, spec, bindings: dict | None = None) -> bool:
    from backend.tests.migration.reference.python_engine.shared.evaluation import evaluate
    from backend.app.integrations.game_engine.shared.client import SharedRuleError
    try:
        return evaluate(tx, "effect_condition", spec, bindings)
    except SharedRuleError as error:
        raise EffectError(str(error)) from error


def available_activations(tx: Transition, ruleset: EffectsRuleset) -> list[dict]:
    from backend.tests.migration.reference.python_engine.shared.availability import available_activations as shared_available
    from backend.app.integrations.game_engine.shared.client import SharedRuleError

    try:
        return shared_available(tx, ruleset)
    except SharedRuleError as error:
        raise EffectError(str(error)) from error


def _bound_target(bindings: dict, target: dict) -> str:
    instance_id = bindings.get(target["var"])
    if not isinstance(instance_id, str):
        raise EffectError(f"unbound card target: {target['var']}")
    return instance_id


def _cost_result(tx: Transition, cost: dict, bindings: dict) -> dict:
    from backend.tests.migration.reference.python_engine.shared.costs import evaluate_cost
    from backend.app.integrations.game_engine.shared.client import SharedRuleError
    try:
        return evaluate_cost(tx, cost, bindings)
    except SharedRuleError as error:
        raise EffectError(str(error)) from error


def _payable(tx: Transition, cost: dict, bindings: dict) -> bool:
    return _cost_result(tx, cost, bindings)["payable"]


def _modifier_result(tx: Transition, operation: str, node: dict, bindings: dict) -> dict:
    from backend.tests.migration.reference.python_engine.shared.modifiers import plan_modifier
    from backend.app.integrations.game_engine.shared.client import SharedRuleError
    try:
        return plan_modifier(tx, operation, node, bindings)
    except SharedRuleError as error:
        raise EffectError(str(error)) from error


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
        cost = _cost_result(tx, node, bindings)
        if not cost["payable"]:
            raise EffectError(f"effect target cannot be {op}ed now")
        instance_id = cost["instance_id"]
        location = cost["location"]
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
        from backend.tests.migration.reference.python_engine.shared.turn import apply_resource_effect

        amount = _expr(tx, node["amount"], bindings)
        result = apply_resource_effect({
            "op": op, "amount": amount, "subject_id": subject,
            "active_player_id": tx.player_id, "subject_xp": player["xp"],
            "active_gold": tx.player["temporary_gold"],
            "active_purchases": tx.player["purchases_remaining"],
            "chosen_action": tx.state["chosen_action"],
            "battle_context": tx.state["battle_context"],
            "source_instance_id": bindings.get("source"),
        })
        if "battle_context" in result:
            context = tx.state["battle_context"]
            context.clear()
            context.update(result["battle_context"])
        else:
            tx.state["players"][result["player_id"]][result["field"]] = result["value"]
        tx.event("effect_resource_changed", ability_id=ability_id, op=op,
                 player_id=subject, amount=amount)
    elif op == "mod_card":
        patch = _modifier_result(tx, "plan_card_modifier", node, bindings)
        instance_id, field, amount = patch["instance_id"], patch["field"], patch["amount"]
        tx.state["battle_context"].setdefault("card_modifiers", {}).setdefault(instance_id, {})[field] = patch["value"]
        tx.event("effect_card_modified", ability_id=ability_id, instance_id=instance_id,
                 stat=field, amount=amount)
        if patch["reconcile_equipment"]:
            from backend.tests.migration.reference.python_engine.effects.combat import reconcile_equipment
            reconcile_equipment(tx, during_battle=tx.state["subphase"] == "BATTLE_EFFECTS")
    elif op == "mod_monster_health":
        patch = _modifier_result(tx, "plan_monster_health_modifier", node, bindings)
        instance = patch["instance_id"]
        changes = tx.state["battle_context"].setdefault("monster_health_modifiers", {})
        changes[instance] = patch["value"]
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
        from backend.tests.migration.reference.python_engine.effects.abilities import copy_hero
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
        from backend.tests.migration.reference.python_engine.effects.attachments import attach
        attach(tx, _bound_target(bindings, node["target"]), _bound_target(bindings, node["anchor"]), node["kind"], owner=subject)
    elif op == "release_attachment":
        from backend.tests.migration.reference.python_engine.effects.attachments import release
        release(tx, _bound_target(bindings, node["target"]), recipient=node.get("recipient", "owner"), destroy_anchor=node.get("destroy_anchor", True))
    elif op == "grant_basic_buy":
        tx.player["extra_basic_purchases"] = tx.player.get("extra_basic_purchases", 0) + 1
    elif op == "grant_extra_turn":
        tx.player["extra_turns"] = tx.player.get("extra_turns", 0) + 1
        tx.event("extra_turn_granted", player_id=tx.player_id, ability_id=ability_id)
    elif op == "shuffle_destroyed_traps":
        from backend.tests.migration.reference.python_engine.effects.hall_actions import shuffle_destroyed_traps
        shuffle_destroyed_traps(tx, bindings)
    elif op == "destroy_matching_supply":
        from backend.tests.migration.reference.python_engine.effects.inventory import destroy_matching
        count = _expr(tx, node["count"], bindings)
        if not 0 <= count <= 100:
            raise EffectError("invalid matching supply destruction count")
        destroy_matching(tx, _bound_target(bindings, node["target"]), count,
                         family=node.get("family", False), bottom=node.get("from_bottom", False), ability_id=ability_id)
    elif op == "destroy_purchased_supply":
        from backend.tests.migration.reference.python_engine.effects.inventory import destroy_purchased
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
        from backend.tests.migration.reference.python_engine.effects.status import grant_turn_buff
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
        from backend.tests.migration.reference.python_engine.effects.reveal import resolve_reveal_cycle
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
        from backend.tests.migration.reference.python_engine.effects.responses import has_global_work
        response_scope = bindings.get("_responses", {})
        subject = bindings.get("_subject", tx.player_id)
        if node.get("as_owner") and isinstance(bindings.get(node["target"]["var"]), str):
            subject = tx.state["instances"][bindings[node["target"]["var"]]]["owner_player_id"]
        if subject in response_scope.get("immune", []) and op not in ("_ability_end", "_discard_reveal") and not has_global_work(node):
            continue
        if op == "_ability_end":
            tx.event("ability_resolved", ability_id=ability_id, source_instance_id=source_id)
        elif op == "_offer_effect":
            from backend.tests.migration.reference.python_engine.effects.responses import offer_effect
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
                from backend.tests.migration.reference.python_engine.effects.responses import offer_effect
                return offer_effect(tx, node["body"], bindings, stack, ability_id, source_id, subject_window=True)
            stack.append({"node": node["body"], "bindings": bindings})
        elif op == "destroy" and not node.get("_is_cost"):
            from backend.tests.migration.reference.python_engine.effects.responses import offer_destroy
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
            from backend.tests.migration.reference.python_engine.effects.choices import value_options, value_bindings, pause
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
            from backend.tests.migration.reference.python_engine.effects.choices import pause, reorder_cards
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
            if is_disease(tx.printed_card(item)) and owner != old_owner:
                from backend.tests.migration.reference.python_engine.turn.workflow import queue_steps
                queue_steps(tx, [{"op": "resolve_disease_gain", "gain": {
                    "instance_id": item, "player_id": owner, "destination": node["destination"], "used_sources": []}},
                    {"op": "effect_continuation", "ability_id": ability_id, "source_instance_id": source_id, "stack": deepcopy(stack)}], front=True)
                return tx.state["pending_choice"] is None
        elif op == "reuse_ability":
            from backend.tests.migration.reference.python_engine.effects.abilities import offer_reuse
            if not offer_reuse(tx, _bound_target(bindings, node["target"]), bindings, stack, ability_id, source_id):
                return False
        elif op in ("borrow_card", "equip_from_supply"):
            from backend.tests.migration.reference.python_engine.effects.borrowing import borrow
            from backend.tests.migration.reference.python_engine.turn.dungeon import equip_weapon
            from backend.tests.migration.reference.python_engine.turn.workflow import queue_steps
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
                from backend.tests.migration.reference.python_engine.effects.combat import equipment_pairs, hand_rules
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
            from backend.tests.migration.reference.python_engine.effects.hall_actions import swap_hall, exchange_hall, shuffle_hall_top
            from backend.tests.migration.reference.python_engine.turn.workflow import queue_steps
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
            from backend.tests.migration.reference.python_engine.effects.hall import relocate
            from backend.tests.migration.reference.python_engine.turn.workflow import queue_steps
            steps = relocate(tx, _bound_target(bindings, node["target"]), node["destination"], defeat=node.get("defeat", False))
            steps.append({"op": "effect_continuation", "ability_id": ability_id,
                          "source_instance_id": source_id, "stack": deepcopy(stack)})
            queue_steps(tx, steps, front=True)
            return tx.state["pending_choice"] is None
        elif op == "gain_disease":
            from backend.tests.migration.reference.python_engine.turn.workflow import queue_steps
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
            from backend.tests.migration.reference.python_engine.effects.purchase import offer
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
            from backend.tests.migration.reference.python_engine.effects.upgrade import offer_upgrade
            tx.trace_effect(ability_id, source_id, node, bindings)
            if not offer_upgrade(tx, node, bindings, stack, ability_id, source_id):
                return False
        elif op == "reveal":
            subject = bindings.get("_subject", tx.player_id)
            is_dungeon = node.get("zone") == "dungeon"
            if is_dungeon:
                from backend.tests.migration.reference.python_engine.effects.choices import dungeon_zone
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
    from backend.app.integrations.game_engine.shared.client import SharedRuleError
    from backend.tests.migration.reference.python_engine.shared.events import plan_event_dispatch

    try:
        plan = plan_event_dispatch(tx, ruleset, event)
    except SharedRuleError as error:
        raise EffectError(str(error)) from error
    if plan["mode"] == "none":
        return True
    consumed_listeners = set(plan["consumed_listener_indices"])
    consumed_scheduled = set(plan["consumed_scheduled_indices"])
    tx.state["registered_triggers"] = [item for index, item in enumerate(tx.state["registered_triggers"])
                                        if index not in consumed_listeners]
    tx.state["scheduled_effects"] = [item for index, item in enumerate(tx.state["scheduled_effects"])
                                     if index not in consumed_scheduled]
    candidates = plan["candidates"]
    if plan["mode"] == "battle":
        stack = []
        for item in reversed(candidates):
            stack.extend(_ability_frames(item["ability_id"], item["source_instance_id"], item["body"],
                                          {"_subject": tx.player_id, **item["bindings"]}))
        first = candidates[0]
        return _run(tx, first["ability_id"], first["source_instance_id"], stack)
    if plan["mode"] == "choice":
        effects = [{"effect_id": f"{item['source_instance_id']}:{item['ability_id']}:{index}",
                    **item, "bindings": {"_subject": tx.player_id, **item["bindings"]}}
                   for index, item in enumerate(candidates)]
        tx.state["pending_choice"] = {"kind": "effect_order", "player_id": tx.player_id,
                                      "event": event, "effects": effects}
        tx.state["resolution_frames"] = [{"kind": "event_order", "event": event, "stack": []}]
        tx.event("effect_order_requested", event=event, effects=[{
            key: item[key] for key in ("effect_id", "ability_id", "source_instance_id")} for item in effects])
        return False
    first = candidates[0]
    tx.event("ability_triggered", ability_id=first["ability_id"],
             source_instance_id=first["source_instance_id"], event=event)
    return _run(tx, first["ability_id"], first["source_instance_id"], _ability_frames(
        first["ability_id"], first["source_instance_id"], first["body"],
        {"_subject": tx.player_id, **first["bindings"]}))


def resolve_effect_order(tx: Transition, effect_ids: list[str]) -> bool:
    from backend.app.integrations.game_engine.shared.client import client, SharedRuleError

    choice = tx.state["pending_choice"]
    try:
        ordered = client.call("resolve_event_order", {"choice": choice, "effect_ids": effect_ids})
    except SharedRuleError as error:
        raise EffectError(str(error)) from error
    stack = []
    for item in reversed(ordered):
        stack.extend(_ability_frames(item["ability_id"], item["source_instance_id"],
                                     item["body"], item["bindings"]))
    tx.state["pending_choice"] = None
    tx.state["resolution_frames"] = []
    tx.event("effect_order_chosen", event=choice["event"], effect_ids=effect_ids)
    first = ordered[0]
    return _run(tx, first["ability_id"], first["source_instance_id"], stack)


def resolve_choice(tx: Transition, selected_id: str | list[str]) -> bool:
    from backend.tests.migration.reference.python_engine.shared.choices import validate_effect_selection
    from backend.app.integrations.game_engine.shared.client import SharedRuleError
    choice = tx.state["pending_choice"]
    try:
        selected = validate_effect_selection(tx, selected_id)
    except SharedRuleError as error:
        raise EffectError(str(error)) from error
    frame = tx.state["resolution_frames"][0]
    source_id = choice["source_instance_id"]
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
    from backend.tests.migration.reference.python_engine.shared.choices import validate_effect_purchase
    from backend.app.integrations.game_engine.shared.client import SharedRuleError
    from backend.tests.migration.reference.python_engine.effects.purchase import buy
    from backend.tests.migration.reference.python_engine.turn.workflow import queue_steps

    choice = tx.state["pending_choice"]
    try:
        payment = validate_effect_purchase(tx, card_id)["payment_op"]
    except SharedRuleError as error:
        raise EffectError(str(error)) from error
    frame = tx.state["resolution_frames"][0]
    source = choice["source_instance_id"]
    steps = []
    if card_id is not None:
        # Price is evaluated before discarding the source: its printed gold is
        # part of the revealed allowance used to make this purchase.
        steps = buy(tx, card_id, choice["filter"], choice["destination"], ability_id=choice["ability_id"], maximum_cost=choice.get("maximum_cost"))
        if payment is not None:
            _atom(tx, {"op": payment, "target": {"var": "source"}}, choice["bindings"], choice["ability_id"])
    tx.state["pending_choice"] = None
    tx.state["resolution_frames"] = []
    steps.append({"op": "effect_continuation", "ability_id": choice["ability_id"],
                  "source_instance_id": source, "stack": deepcopy(frame["stack"])})
    queue_steps(tx, steps, front=True)
    return tx.state["pending_choice"] is None
