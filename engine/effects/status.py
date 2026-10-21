"""Instance-bound buffs that remain valid through the current turn's cleanup."""

from __future__ import annotations

from engine.effects.combat import is_hero
from engine.turn.operations import TurnError


TURN_BUFFS = {"discard_instead_of_destroy"}


def validate_turn_buffs(state, instance, card) -> None:
    buffs = instance["flags"].get("turn_buffs", [])
    if not isinstance(buffs, list) or (buffs and not is_hero(card)):
        raise TurnError("invalid hero turn buffs")
    for value in buffs:
        if (not isinstance(value, dict) or set(value) != {
                "buff", "expires_after_turn", "ability_id", "source_instance_id"}
                or not isinstance(value["buff"], str) or value["buff"] not in TURN_BUFFS
                or type(value["expires_after_turn"]) is not int
                or value["expires_after_turn"] != state["turn_number"]
                or any(not isinstance(value[key], str) or not value[key]
                       for key in ("ability_id", "source_instance_id"))):
            raise TurnError("invalid hero turn buff")


def grant_turn_buff(tx, instance_id: str, buff: str, *, ability_id: str,
                    source_id: str) -> None:
    instance = tx.state["instances"].get(instance_id)
    if (buff not in TURN_BUFFS or instance is None
            or not is_hero(tx.card(instance_id))
            or instance_id not in tx.zone("hand")):
        raise TurnError("turn buff needs a hero in the active player's hand")
    value = {"buff": buff, "expires_after_turn": tx.state["turn_number"],
             "ability_id": ability_id, "source_instance_id": source_id}
    buffs = instance["flags"].setdefault("turn_buffs", [])
    if value not in buffs:
        buffs.append(value)
        tx.event("hero_turn_buff_granted", instance_id=instance_id, **value)


def destruction_replacement(tx, instance_id: str) -> dict | None:
    instance = tx.state["instances"][instance_id]
    if instance["owner_player_id"] is None or not is_hero(tx.card(instance_id)):
        return None
    return next((buff for buff in instance["flags"].get("turn_buffs", [])
                 if buff["buff"] == "discard_instead_of_destroy"
                 and buff["expires_after_turn"] == tx.state["turn_number"]), None)


def expire_turn_buffs(tx) -> None:
    """Run after end-of-turn effects and hand refill, just before passing play."""
    for instance_id, instance in tx.state["instances"].items():
        buffs = instance["flags"].get("turn_buffs", [])
        expired = [buff for buff in buffs if buff["expires_after_turn"] <= tx.state["turn_number"]]
        if not expired:
            continue
        remaining = [buff for buff in buffs if buff not in expired]
        if remaining:
            instance["flags"]["turn_buffs"] = remaining
        else:
            instance["flags"].pop("turn_buffs", None)
        tx.event("hero_turn_buffs_expired", instance_id=instance_id, buffs=expired)
