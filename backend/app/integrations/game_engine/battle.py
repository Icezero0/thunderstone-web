"""Backend entry points for visible battle preparation and authoritative submission."""

from backend.app.core.paths import PROJECT_ROOT
from backend.app.integrations.game_engine.shared.transition import transition_call
from backend.app.integrations.game_engine.turn import TurnError, apply_command


def battle_preparation(state: dict, player_id: str, *, snapshot=None, effects=None) -> dict:
    return transition_call("battle_preparation", state, root=PROJECT_ROOT,
                           snapshot=snapshot, effects=effects, player_id=player_id)


def submit_battle_team(state: dict, command: dict, *, snapshot=None, effects=None) -> dict:
    if not isinstance(command, dict) or command.get("type") != "SubmitBattleTeam":
        raise TurnError("battle submission requires a SubmitBattleTeam command")
    return apply_command(state, command, snapshot=snapshot, effects=effects)
