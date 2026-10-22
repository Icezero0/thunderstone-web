"""Explicit reuse decisions compose compiled abilities onto the existing stack."""

from copy import deepcopy

from backend.tests.migration.reference.python_engine.turn.operations import TurnError


def source_matches(tx, instance, card_id):
    return (instance in tx.state["instances"] and (tx.card(instance)["card_id"] == card_id
            or card_id in tx.state.get("copied_heroes", {}).get(instance, {}).get("card_ids", [])))


def copy_hero(tx, target, other, *, preserve_attack, full_card=False):
    from backend.tests.migration.reference.python_engine.effects.combat import is_hero
    if (target == other or target not in tx.zone("hand") or other not in tx.zone("hand")
            or tx.card(target)["card_id"] != "TS-0001" or not is_hero(tx.card(other))):
        raise TurnError("hero copying requires a militia and a different hand hero")
    card_ids = [tx.card(other)["card_id"], *tx.state.get("copied_heroes", {}).get(other, {}).get("card_ids", [])]
    tx.state.setdefault("copied_heroes", {})[target] = {"card_ids": list(dict.fromkeys(card_ids)), "preserve_attack": preserve_attack, "full_card": full_card}
    tx.event("hero_abilities_copied", instance_id=target, template_instance_id=other, preserve_attack=preserve_attack)


def reuse_options(tx, item):
    from backend.tests.migration.reference.python_engine.shared.availability import reusable_abilities
    from backend.app.integrations.game_engine.shared.client import SharedRuleError
    try:
        return reusable_abilities(tx, item)
    except SharedRuleError as error:
        raise TurnError(str(error)) from error


def offer_reuse(tx, item, bindings, stack, ability_id, source_id):
    from backend.tests.migration.reference.python_engine.effects.choices import pause
    options = reuse_options(tx, item)
    if not options:
        return True
    pause(tx, "effect_reuse", {"op": "reuse_ability", "target": {"var": "reused"}},
          bindings, stack, ability_id, source_id, reused_instance_id=item, options=options)
    return False


def resolve_reuse(tx, selected):
    from backend.tests.migration.reference.python_engine.effects.choices import continuation
    from backend.tests.migration.reference.python_engine.effects.runtime import _ability_frames, _run
    from backend.tests.migration.reference.python_engine.shared.availability import validate_reuse_choice
    from backend.app.integrations.game_engine.shared.client import SharedRuleError
    choice = tx.state["pending_choice"]
    try:
        validate_reuse_choice(tx, selected)
    except SharedRuleError as error:
        raise TurnError(str(error)) from error
    item = choice["reused_instance_id"]
    stack = continuation(tx, choice)
    ability = tx.ruleset.by_id(selected)
    tx.state["instances"][item]["flags"]["pending_turn_end_destruction"] = True
    tx.state["ability_uses"][f"{item}:{selected}"] = tx.state["turn_number"]
    tx.event("ability_activated", ability_id=selected, source_instance_id=item, player_id=tx.player_id, reused=True)
    stack.extend(_ability_frames(selected, item, ability.body, {"_subject": tx.player_id}))
    tx.state.update(pending_choice=None, resolution_frames=[])
    return _run(tx, choice["ability_id"], choice["source_instance_id"], stack)
