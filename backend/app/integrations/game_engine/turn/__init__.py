"""Pure command-based turn transitions."""

class TurnError(ValueError):
    """A game command cannot be applied to the supplied state."""


def apply_command(*args, **kwargs):
    from backend.app.integrations.game_engine.turn.service import apply_command as implement
    return implement(*args, **kwargs)


def legal_commands(*args, **kwargs):
    from backend.app.integrations.game_engine.turn.service import legal_commands as implement
    return implement(*args, **kwargs)

__all__ = ["TurnError", "apply_command", "legal_commands"]
