"""Effect-driven upgrades reuse the village's level, cost and supply rules."""

from tests.migration.reference.python_engine.effects.choices import continuation, pause
from tests.migration.reference.python_engine.turn.operations import TurnError


def offer_upgrade(tx, node, bindings, stack, ability_id, source_id):
    from tests.migration.reference.python_engine.turn.village import upgrade_options
    options = upgrade_options(tx)
    if not options:
        tx.event("effect_upgrade_unavailable", ability_id=ability_id)
        return True
    pause(tx, "effect_upgrade", node, bindings, stack, ability_id, source_id, options=options)
    return False


def resolve_upgrade(tx, source_id, target_card_id):
    from tests.migration.reference.python_engine.effects.runtime import _atom, _payable
    from tests.migration.reference.python_engine.turn.village import perform_hero_upgrade, upgrade_options
    from tests.migration.reference.python_engine.turn.workflow import queue_steps
    choice = tx.state["pending_choice"]
    if choice is None or choice["kind"] != "effect_upgrade":
        raise TurnError("no effect upgrade is pending")
    stack = continuation(tx, choice)
    steps = []
    if source_id is not None or target_card_id is not None:
        if not any(option["source_instance_id"] == source_id and option["target_card_id"] == target_card_id
                   for option in choice["options"] if option in upgrade_options(tx)):
            raise TurnError("invalid effect hero upgrade")
        payment = choice["node"].get("payment", "none")
        if payment != "none":
            if not _payable(tx, {"op": "discard", "target": {"var": "source"}}, choice["bindings"]):
                raise TurnError("effect upgrade payment is unavailable")
            if source_id == choice["source_instance_id"]:
                raise TurnError("upgrade source cannot also pay the treasure cost")
        steps = perform_hero_upgrade(tx, source_id, target_card_id, destination=choice["node"]["destination"])
        if payment != "none":
            _atom(tx, {"op": "discard", "target": {"var": "source"}}, choice["bindings"], choice["ability_id"])
    tx.state.update(pending_choice=None, resolution_frames=[])
    steps.append({"op": "effect_continuation", "ability_id": choice["ability_id"],
                  "source_instance_id": choice["source_instance_id"], "stack": stack})
    queue_steps(tx, steps, front=True)
    return tx.state["pending_choice"] is None
