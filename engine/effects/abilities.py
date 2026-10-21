"""Explicit reuse decisions compose compiled abilities onto the existing stack."""

from copy import deepcopy

from engine.turn.operations import TurnError


def source_matches(tx, instance, card_id):
    return (instance in tx.state["instances"] and (tx.card(instance)["card_id"] == card_id
            or card_id in tx.state.get("copied_heroes", {}).get(instance, {}).get("card_ids", [])))


def copy_hero(tx, target, other, *, preserve_attack, full_card=False):
    from engine.effects.combat import is_hero
    if (target == other or target not in tx.zone("hand") or other not in tx.zone("hand")
            or tx.card(target)["card_id"] != "TS-0001" or not is_hero(tx.card(other))):
        raise TurnError("hero copying requires a militia and a different hand hero")
    card_ids = [tx.card(other)["card_id"], *tx.state.get("copied_heroes", {}).get(other, {}).get("card_ids", [])]
    tx.state.setdefault("copied_heroes", {})[target] = {"card_ids": list(dict.fromkeys(card_ids)), "preserve_attack": preserve_attack, "full_card": full_card}
    tx.event("hero_abilities_copied", instance_id=target, template_instance_id=other, preserve_attack=preserve_attack)


def reuse_options(tx, item):
    from engine.effects.runtime import _condition
    if item not in tx.zone("hand") or item not in tx.state.get("used_cards", []):
        return []
    return [ability.id for ability in tx.ruleset.abilities if ability.kind == "activated"
            and ability.source_card_id == tx.card(item)["card_id"] and "dungeon" in ability.actions
            and all(_condition(tx, condition, {"source": item, "_subject": tx.player_id}) for condition in ability.conditions)]


def offer_reuse(tx, item, bindings, stack, ability_id, source_id):
    from engine.effects.choices import pause
    options = reuse_options(tx, item)
    if not options:
        return True
    pause(tx, "effect_reuse", {"op": "reuse_ability", "target": {"var": "reused"}},
          bindings, stack, ability_id, source_id, reused_instance_id=item, options=options)
    return False


def resolve_reuse(tx, selected):
    from engine.effects.choices import continuation
    from engine.effects.runtime import _ability_frames, _run
    choice = tx.state["pending_choice"]
    if choice is None or choice["kind"] != "effect_reuse":
        raise TurnError("no reused ability is pending")
    item = choice["reused_instance_id"]
    if selected not in choice["options"] or selected not in reuse_options(tx, item):
        raise TurnError("reused ability is no longer available")
    stack = continuation(tx, choice)
    ability = tx.ruleset.by_id(selected)
    tx.state["instances"][item]["flags"]["pending_turn_end_destruction"] = True
    tx.state["ability_uses"][f"{item}:{selected}"] = tx.state["turn_number"]
    tx.event("ability_activated", ability_id=selected, source_instance_id=item, player_id=tx.player_id, reused=True)
    stack.extend(_ability_frames(selected, item, ability.body, {"_subject": tx.player_id}))
    tx.state.update(pending_choice=None, resolution_frames=[])
    return _run(tx, choice["ability_id"], choice["source_instance_id"], stack)
