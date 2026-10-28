"""Read-only turn options and card-text labels from the shared rules package."""

from pathlib import Path
import re

from backend.app.core.paths import PROJECT_ROOT
from backend.app.integrations.game_engine.effects.compiler import load_ruleset
from backend.app.integrations.game_engine.shared.transition import transition_call


def command_options(state: dict, player_id: str, *, snapshot, root: Path = PROJECT_ROOT, prediction=False) -> dict:
    rules = load_ruleset(snapshot.cards, root)
    labels = []
    for ability in rules.abilities:
        lines = snapshot.cards[ability.source_card_id].get("effect_text", "").splitlines()
        match = re.search(r"-A(\d+)$", ability.id)
        index = int(match.group(1)) - 1 if match else -1
        labels.append({"id": ability.id, "source_card_id": ability.source_card_id,
                       "source_line": lines[index] if 0 <= index < len(lines) else ""})
    labels.extend({"id": m.id, "source_card_id": m.source_card_id, "source_line": m.source_line}
                  for m in rules.mechanics)
    options = transition_call("turn_options", state, root=root, snapshot=snapshot, effects=rules, player_id=player_id, prediction=prediction)
    return {**options, "abilities": labels}
