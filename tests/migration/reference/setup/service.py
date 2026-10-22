"""Validate a frozen request and orchestrate deterministic game setup."""

from __future__ import annotations

from pathlib import Path

from backend.app.integrations.game_engine.paths import PROJECT_ROOT
from backend.app.integrations.game_engine.catalog.repository import CatalogSnapshot, load_catalog
from backend.app.integrations.game_engine.catalog.service import build_panel_catalog
from tests.migration.reference.compiler import load_ruleset
from tests.migration.reference.setup.rules import validate_rules_config
from tests.migration.reference.setup.builder import _Builder
from backend.app.integrations.game_engine.setup.constants import RULESET_VERSION
from backend.app.integrations.game_engine.setup.exceptions import SetupError


def start_game(request: dict, root: Path = PROJECT_ROOT, *,
               snapshot: CatalogSnapshot | None = None) -> dict:
    """Return a full initial state and its private setup event log.

    ``request`` needs match_id, ordered player_ids, rng_seed, and config. A
    two-dungeon setup additionally needs scenario_choices.two_dungeons.
    """
    if not isinstance(request, dict):
        raise SetupError("setup request must be an object")
    match_id = request.get("match_id")
    players = request.get("player_ids")
    if not isinstance(match_id, str) or not match_id.strip():
        raise SetupError("match_id must be a nonempty string")
    if (not isinstance(players, list) or not players
            or any(not isinstance(item, str) or not item.strip() for item in players)
            or len(players) != len(set(players))
            or any(":" in item for item in players)):
        raise SetupError("player_ids must be distinct, nonempty IDs without ':'")
    first = request.get("first_player", {"mode": "random"})
    if (not isinstance(first, dict) or first.get("mode") not in ("random", "fixed")
            or (first.get("mode") == "fixed" and first.get("player_id") not in players)):
        raise SetupError("first_player must be random or a fixed participant")
    if "rng_seed" not in request:
        raise SetupError("rng_seed is required")
    snapshot = snapshot or load_catalog(root)
    cards, index = snapshot.cards, snapshot.setup_index
    panel = build_panel_catalog(cards, index)
    if request.get("catalog_version", panel["catalog_hash"]) != panel["catalog_hash"]:
        raise SetupError("catalog_version does not match the current card catalog")
    if request.get("ruleset_version", RULESET_VERSION) != RULESET_VERSION:
        raise SetupError("unsupported ruleset_version")
    issues = validate_rules_config(request.get("config"), panel)
    if issues:
        raise SetupError("invalid rules configuration", issues)
    result = _Builder(request, cards, index, panel).build()
    result["state"]["effects_version"] = load_ruleset(cards, root).version
    return result
