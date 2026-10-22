"""Adapter for TypeScript turn atoms while Python owns the command transaction."""

from backend.app.integrations.game_engine.shared.client import SharedRuleError, client


def draw_cards(*, draw, discard, hand, count, rng):
    from backend.tests.migration.reference.python_engine.turn.operations import TurnError

    try:
        return client.call("draw_cards", {"draw": draw, "discard": discard,
            "hand": hand, "count": count,
            "rng": {**rng, "counter": str(rng["counter"])}})
    except SharedRuleError as error:
        raise TurnError(str(error)) from error


def apply_resource_effect(payload):
    from backend.tests.migration.reference.python_engine.effects.runtime import EffectError

    try:
        return client.call("apply_resource_effect", payload)
    except SharedRuleError as error:
        raise EffectError(str(error)) from error


def advance_turn(payload):
    from backend.tests.migration.reference.python_engine.turn.operations import TurnError

    try:
        return client.call("advance_turn", payload)
    except SharedRuleError as error:
        raise TurnError(str(error)) from error


def turn_atom(operation, payload):
    from backend.tests.migration.reference.python_engine.turn.operations import TurnError

    try:
        return client.call(operation, payload)
    except SharedRuleError as error:
        raise TurnError(str(error)) from error
