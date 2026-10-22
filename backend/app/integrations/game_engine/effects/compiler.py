"""File loading and Python compatibility types for the shared TypeScript compiler."""
from __future__ import annotations
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from backend.app.integrations.game_engine.paths import PROJECT_ROOT
from backend.app.integrations.game_engine.effects.mechanics import Mechanic
from backend.app.integrations.game_engine.shared.client import client, SharedRuleError


SCHEMA_VERSION = "thunderstone.effects/1"


class EffectCompileError(ValueError):
    """A reviewed definition failed shared DSL validation."""


@dataclass(frozen=True)
class Ability:
    id: str
    source_card_id: str
    kind: str
    source_zone: str
    usage: str
    actions: tuple[str, ...]
    event: str | None
    conditions: tuple[dict, ...]
    body: dict


@dataclass(frozen=True)
class EffectsRuleset:
    schema_version: str
    version: str
    abilities: tuple[Ability, ...]
    mechanics: tuple[Mechanic, ...] = ()

    def by_id(self, ability_id: str) -> Ability | None:
        return next((item for item in self.abilities if item.id == ability_id), None)


def compile_ruleset(data: object, cards: dict[str, dict[str, str]]) -> EffectsRuleset:
    try:
        compiled = client.call("compile_ruleset", {"source": data, "cards": cards})
    except SharedRuleError as error:
        raise EffectCompileError(str(error)) from error
    abilities = tuple(Ability(item["id"], item["source_card_id"], item["kind"],
                              item["source_zone"], item["usage"], tuple(item["actions"]),
                              item["event"], tuple(item["conditions"]), item["body"])
                      for item in compiled["abilities"])
    mechanics = tuple(Mechanic(**item) for item in compiled["mechanics"])
    canonical = json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return EffectsRuleset(compiled["schema_version"], hashlib.sha256(canonical).hexdigest(), abilities, mechanics)


def load_ruleset(cards: dict[str, dict[str, str]], root: Path = PROJECT_ROOT) -> EffectsRuleset:
    directory = root / "data" / "effects"
    source = json.loads((directory / "classic-v1.json").read_text(encoding="utf-8"))
    simple = json.loads((directory / "simple-reviewed.json").read_text(encoding="utf-8"))
    if simple.get("schema_version") != source.get("schema_version"):
        raise EffectCompileError("reviewed effect files use different schemas")
    source["abilities"].extend(simple["abilities"])
    for filename in ("action-reviewed.json", "battle-reviewed.json", "event-reviewed.json"):
        action_path = directory / filename
        if action_path.is_file():
            actions = json.loads(action_path.read_text(encoding="utf-8"))
            if actions.get("schema_version") != SCHEMA_VERSION:
                raise EffectCompileError(f"{filename} uses a different schema")
            source["abilities"].extend(actions["abilities"])
    mechanics_path = directory / "mechanics.json"
    if mechanics_path.is_file():
        source["mechanics"] = json.loads(mechanics_path.read_text(encoding="utf-8"))
    return compile_ruleset(source, cards)
