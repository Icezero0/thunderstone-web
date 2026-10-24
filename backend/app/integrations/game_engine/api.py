"""Public Python boundary to the shared TypeScript rules package.

Backend routes and services use these entry points. Domain adapters and worker
serialization stay internal to this package; rules are implemented in engine/.
"""

from backend.app.integrations.game_engine.battle import battle_preparation, submit_battle_team
from backend.app.integrations.game_engine.catalog.repository import CatalogSnapshot, load_catalog
from backend.app.integrations.game_engine.catalog.service import build_panel_catalog, load_panel_catalog
from backend.app.integrations.game_engine.disease import take_disease
from backend.app.integrations.game_engine.effects.compiler import EffectCompileError
from backend.app.integrations.game_engine.rules.schemas import RulesConfig
from backend.app.integrations.game_engine.rules.service import (
    effective_copy_count, effective_group_counts, validate_rules_config,
)
from backend.app.integrations.game_engine.scoring import score_game
from backend.app.integrations.game_engine.revision import rules_revision
from backend.app.integrations.game_engine.options import command_options
from backend.app.integrations.game_engine.setup import SetupChoiceRequired, SetupError, start_game
from backend.app.integrations.game_engine.shared.client import SharedEngineUnavailable
from backend.app.integrations.game_engine.turn import TurnError, apply_command, legal_commands

__all__ = [
    "CatalogSnapshot", "RulesConfig", "SetupChoiceRequired", "SetupError", "EffectCompileError",
    "SharedEngineUnavailable", "TurnError", "apply_command", "battle_preparation",
    "build_panel_catalog", "effective_copy_count", "effective_group_counts",
    "legal_commands", "load_catalog", "load_panel_catalog", "score_game",
    "start_game", "submit_battle_team", "take_disease", "validate_rules_config", "rules_revision", "command_options",
]
