"""Compatibility imports for the original rules configuration API."""

from engine.paths import PROJECT_ROOT as ROOT
from engine.catalog.service import load_panel_catalog
from engine.rules.constants import ENVIRONMENT_SETUP_RULES
from engine.rules.schemas import (DungeonFeatureSelection,
                                               ExtraCardSelection,
                                               ExtraGroupSelection, GroupCounts,
                                               GroupSelection, InstanceMultipliers,
                                               RulesConfig, SetupSelection,
                                               ThunderstoneSelection)
from engine.rules.service import (effective_copy_count,
                                               effective_group_counts,
                                               validate_rules_config)
