"""Infinite disease supply for an already initialized game."""

from __future__ import annotations

from copy import deepcopy

from engine.setup.random import RNG_VERSION, SetupRng
from engine.setup.exceptions import SetupError


def sample_disease(supply: dict, rng: SetupRng) -> tuple[str, int, int, list[dict]]:
    """Apply the shared infinite-supply weights to one seeded draw."""
    weights = supply.get("disease_weights")
    if (not supply.get("disease_infinite") or not isinstance(weights, dict)
            or not weights or set(weights) != set(supply.get("disease_card_ids", []))
            or any(not isinstance(weight, int) or isinstance(weight, bool) or weight < 1
                   for weight in weights.values())):
        raise SetupError("invalid disease supply configuration")
    candidates = sorted(weights.items())
    total_weight = sum(weight for _, weight in candidates)
    roll = rng.randbelow(total_weight)
    remainder = roll
    for card_id, weight in candidates:
        if remainder < weight:
            break
        remainder -= weight
    return card_id, roll, total_weight, [
        {"card_id": item, "weight": weight} for item, weight in candidates]


def take_disease(state: dict, player_id: str, *, destination: str = "discard", snapshot=None, effects=None) -> dict:
    """Sample a disease and return a new state with one owned card instance.

    The catalog's initial copy counts are relative draw weights, not finite stock.
    Replacements use the same workflow as card effects. A pending choice can be
    resumed through apply_command; instance is None if the disease was destroyed.
    """
    if state.get("phase") != "PLAYING":
        raise SetupError("disease can only be taken during play")
    if player_id not in state.get("players", {}):
        raise SetupError(f"unknown disease recipient: {player_id}")
    if state.get("pending_choice") is not None:
        raise SetupError("resolve the pending choice before taking another disease")
    if state["players"][player_id].get("eliminated"):
        raise SetupError("eliminated player cannot receive a disease")
    zone = f"player:{player_id}:{destination}"
    if destination not in ("hand", "discard") or zone not in state["zones"]:
        raise SetupError(f"invalid disease destination: {zone}")

    supply = state["supply_rules"]
    rng_state = state["rng_state"]
    counter = rng_state["counter"]
    if (rng_state.get("algorithm") != RNG_VERSION or not isinstance(counter, int)
            or isinstance(counter, bool) or not 0 <= counter < (1 << 128)):
        raise SetupError("invalid random state for disease draw")
    instance_sequence = state["next_instance_sequence"]
    event_sequence = state["next_event_sequence"]
    version = state["game_version"]
    if any(not isinstance(value, int) or isinstance(value, bool) or value < 1
           for value in (instance_sequence, event_sequence, version)):
        raise SetupError("invalid game sequence for disease draw")
    from engine.catalog.repository import load_catalog
    from engine.effects.compiler import load_ruleset
    from engine.turn.operations import Transition
    from engine.turn.state import validate_turn_state
    snapshot = snapshot or load_catalog()
    effects = effects or load_ruleset(snapshot.cards)
    if state.get("catalog_version") != snapshot.setup_index["cards_csv_sha256"] or state.get("effects_version") != effects.version:
        raise SetupError("disease request uses a different catalog or effect revision")
    validate_turn_state(state, snapshot.cards)
    tx = Transition(state, snapshot.cards, effects)
    instance_id = tx.take_disease(player_id=player_id, destination=destination)
    result = tx.finish()
    validate_turn_state(result["state"], snapshot.cards)
    return {**result, "instance_id": instance_id,
            "instance": deepcopy(result["state"]["instances"].get(instance_id))}
