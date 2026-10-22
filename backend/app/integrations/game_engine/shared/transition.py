"""Serialize one authoritative command transaction for the shared TS rules package."""

from dataclasses import asdict

from backend.app.integrations.game_engine.catalog.repository import load_catalog
from backend.app.integrations.game_engine.effects.compiler import load_ruleset
from backend.app.integrations.game_engine.shared.client import SharedRuleError, client


def transition_payload(state, *, root, snapshot=None, effects=None):
    catalog = snapshot or load_catalog(root)
    rules = effects or load_ruleset(catalog.cards, root)
    return {
        "state": state,
        "catalog": {"cards": catalog.cards, "setup_index": catalog.setup_index},
        "ruleset": {"version": rules.version,
                    "abilities": [asdict(item) for item in rules.abilities],
                    "mechanics": [asdict(item) for item in rules.mechanics]},
    }


def transition_call(operation, state, *, root, snapshot=None, effects=None, **arguments):
    payload = transition_payload(state, root=root, snapshot=snapshot, effects=effects)
    try:
        return client.call(operation, {**payload, **arguments})
    except SharedRuleError as error:
        from backend.app.integrations.game_engine.turn import TurnError
        raise TurnError(str(error)) from error
