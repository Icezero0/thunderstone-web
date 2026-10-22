"""Private server-only input for shared DSL evaluation. Never a player projection."""
from copy import deepcopy
from dataclasses import asdict

from backend.tests.migration.reference.python_engine.shared.projection import BATTLE_FIELDS


def evaluation_input(tx) -> dict:
    state = tx.state
    instances = {key: {"card_id": value["card_id"], "flags": value.get("flags", {})}
                 for key, value in state["instances"].items()}
    card_ids = {value["card_id"] for value in instances.values()} | set(state["active_settings"])
    card_ids.update(card_id for value in state.get("copied_heroes", {}).values()
                    for card_id in value["card_ids"])
    context = state.get("battle_context")
    snapshot = {
        "active_player_id": tx.player_id, "player_order": state["player_order"],
        "players": {key: {field: value[field] for field in ("xp", "temporary_gold", "eliminated") if field in value}
                    for key, value in state["players"].items()},
        "instances": instances, "zones": state["zones"], "active_settings": state["active_settings"],
        "battle_context": {key: value for key, value in context.items() if key in BATTLE_FIELDS} if context is not None else None,
        **{key: state[key] for key in ("copied_heroes", "continuous_effects", "attachments", "chosen_action",
            "used_cards", "event_context", "turn_defeated_monsters", "effect_collections") if key in state},
    }
    mechanics = [asdict(rule) for rule in tx.ruleset.mechanics if rule.source_card_id in card_ids] if tx.ruleset else []
    return deepcopy({"cards": {key: tx.cards[key] for key in sorted(card_ids)},
                     "mechanics": mechanics, "state": snapshot})


def evaluate(tx, operation: str, spec, bindings=None):
    from backend.app.integrations.game_engine.shared.client import client
    return client.call(operation, {"input": evaluation_input(tx), "spec": spec,
                                   "bindings": bindings or {}})
