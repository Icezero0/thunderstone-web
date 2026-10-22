"""Compatibility imports for the original rules configuration API."""

from backend.app.integrations.game_engine.paths import PROJECT_ROOT as ROOT
from backend.app.integrations.game_engine.catalog.service import load_panel_catalog
from backend.app.integrations.game_engine.rules.constants import ENVIRONMENT_SETUP_RULES
from backend.app.integrations.game_engine.rules.schemas import (DungeonFeatureSelection,
                                               ExtraCardSelection,
                                               ExtraGroupSelection, GroupCounts,
                                               GroupSelection, InstanceMultipliers,
                                               RulesConfig, SetupSelection,
                                               ThunderstoneSelection)
from backend.app.integrations.game_engine.rules.service import (effective_copy_count,
                                               effective_group_counts,
                                               validate_rules_config)
