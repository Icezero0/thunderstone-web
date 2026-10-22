"""Compatibility entry point for shared setup invariants."""
from backend.app.integrations.game_engine.shared.setup import setup_call


def validate_setup_state(state: dict, cards: dict[str, dict[str, str]]) -> None:
    setup_call("validate_setup_state", {"state": state, "cards": cards})
