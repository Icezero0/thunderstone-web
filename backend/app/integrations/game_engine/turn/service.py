"""Public, stateless adapter to the TypeScript turn rules.

The server owns and persists the returned state; the worker keeps no match state.
"""

from pathlib import Path

from backend.app.integrations.game_engine.paths import PROJECT_ROOT
from backend.app.integrations.game_engine.shared.transition import transition_call


def legal_commands(state: dict, root: Path = PROJECT_ROOT, *, snapshot=None, effects=None) -> list[dict]:
    return transition_call("legal_commands", state, root=root, snapshot=snapshot, effects=effects)


def apply_command(state: dict, command: dict, root: Path = PROJECT_ROOT, *,
                  snapshot=None, effects=None, trace_effects: bool = False) -> dict:
    return transition_call("apply_command", state, root=root, snapshot=snapshot,
                           effects=effects, command=command, trace_effects=trace_effects)
