"""Load a catalog/effect snapshot and invoke shared TypeScript setup."""
from pathlib import Path
from backend.app.integrations.game_engine.paths import PROJECT_ROOT
from backend.app.integrations.game_engine.catalog.repository import CatalogSnapshot, load_catalog
from backend.app.integrations.game_engine.catalog.service import build_panel_catalog
from backend.app.integrations.game_engine.effects.compiler import load_ruleset
from backend.app.integrations.game_engine.shared.setup import setup_input, setup_call
from backend.app.integrations.game_engine.setup.exceptions import SetupError


def start_game(request: dict, root: Path = PROJECT_ROOT, *, snapshot: CatalogSnapshot | None = None) -> dict:
    """Return the complete initial state/events, or a typed scenario choice."""
    if not isinstance(request, dict):
        raise SetupError("setup request must be an object")
    snapshot = snapshot or load_catalog(root)
    cards, index = snapshot.cards, snapshot.setup_index
    panel = build_panel_catalog(cards, index)
    effects = load_ruleset(cards, root)
    return setup_call("start_game", setup_input(request, cards, index, panel, effects.version))
