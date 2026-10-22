"""Setup state invariants."""

from backend.app.integrations.game_engine.setup.exceptions import SetupError
from tests.migration.reference.setup.hall import base_hall_capacity, hall_capacity


def validate_setup_state(state: dict, cards: dict[str, dict[str, str]]) -> None:
    """Check zone uniqueness, ownership, and the initial hand/hall contract."""
    seen: set[str] = set()
    for zone, pile in state["zones"].items():
        for instance_id in pile:
            if instance_id in seen or instance_id not in state["instances"]:
                raise SetupError(f"duplicate or unknown instance in {zone}: {instance_id}")
            seen.add(instance_id)
            instance = state["instances"][instance_id]
            if instance["card_id"] not in cards:
                raise SetupError(f"unknown card: {instance['card_id']}")
            if zone.startswith("player:") and instance["owner_player_id"] != zone.split(":")[1]:
                raise SetupError(f"wrong owner in {zone}: {instance_id}")
            if not zone.startswith("player:") and instance["owner_player_id"] is not None:
                raise SetupError(f"unexpected owner in {zone}: {instance_id}")
    if seen != set(state["instances"]):
        raise SetupError("some instances have no zone")
    for player_id in state["player_order"]:
        total = sum(len(state["zones"][f"player:{player_id}:{part}"])
                    for part in ("draw", "hand", "discard", "control"))
        if total != 12 or len(state["zones"][f"player:{player_id}:hand"]) != 6:
            raise SetupError(f"{player_id}: invalid starter deck")
    for zone, pile in state["zones"].items():
        if not zone.startswith("hall:"):
            continue
        hall_size = hall_capacity((state["instances"][item]["card_id"] for item in pile), state["active_settings"])
        remaining = state["zones"].get(zone.replace("hall:", "dungeon:"), [])
        shortfall = (base_hall_capacity(state["active_settings"]) <= len(pile) < hall_size and not any(
            cards[state["instances"][item]["card_id"]]["subcategory"] == "怪物" for item in remaining))
        if (len(pile) != hall_size and not shortfall or any(
                cards[state["instances"][item]["card_id"]]["subcategory"] != "怪物"
                for item in pile)):
            raise SetupError(f"{zone}: invalid initial hall")


