"""Infinite disease supply adapter for the shared TypeScript game engine."""

from backend.app.integrations.game_engine.setup.random import RNG_VERSION, SetupRng
from backend.app.integrations.game_engine.setup.exceptions import SetupError
from backend.app.integrations.game_engine.shared.client import SharedRuleError, client
from backend.app.integrations.game_engine.shared.transition import transition_payload
from backend.app.integrations.game_engine.paths import PROJECT_ROOT


def sample_disease(supply: dict, rng: SetupRng) -> tuple[str, int, int, list[dict]]:
    """Apply the shared infinite-supply weights to one seeded draw."""
    try:
        result = client.call("sample_disease", {"supply": supply,
            "rng": {"algorithm": RNG_VERSION, "seed": rng.seed, "counter": str(rng.counter)}})
    except SharedRuleError as error:
        raise SetupError(str(error)) from error
    rng.counter = int(result["counter"])
    return (result["card_id"], int(result["roll"]), int(result["total_weight"]),
            result["candidates"])


def take_disease(state: dict, player_id: str, *, destination: str = "discard", snapshot=None, effects=None) -> dict:
    """Create and resolve one disease gain without mutating the input state."""
    payload = transition_payload(state, root=PROJECT_ROOT, snapshot=snapshot, effects=effects)
    try:
        return client.call("take_disease", {**payload, "player_id": player_id,
                                            "destination": destination})
    except SharedRuleError as error:
        raise SetupError(str(error)) from error
