"""Identify the executable rules before resuming a frozen setup request."""

from pathlib import Path

from backend.app.core.paths import PROJECT_ROOT
from backend.app.integrations.game_engine.catalog.repository import CatalogSnapshot
from backend.app.integrations.game_engine.effects.compiler import load_ruleset
from backend.app.integrations.game_engine.shared.client import client


def rules_revision(snapshot: CatalogSnapshot, root: Path = PROJECT_ROOT) -> dict[str, str]:
    effects = load_ruleset(snapshot.cards, root)
    runtime = client.call("runtime_info", {})
    return {"engine_version": runtime["engine_version"], "effects_version": effects.version}
