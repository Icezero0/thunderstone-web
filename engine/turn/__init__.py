"""Pure command-based turn transitions."""

from engine.turn.operations import TurnError


def apply_command(*args, **kwargs):
    from engine.turn.service import apply_command as implement
    return implement(*args, **kwargs)


def legal_commands(*args, **kwargs):
    from engine.turn.service import legal_commands as implement
    return implement(*args, **kwargs)

__all__ = ["TurnError", "apply_command", "legal_commands"]
