"""Python transition adapter for shared turn-bound hero buffs."""

from tests.migration.reference.python_engine.shared.turn import turn_atom


def validate_turn_buffs(state, instance, card) -> None:
    if "turn_buffs" not in instance["flags"]:
        return
    turn_atom("validate_turn_buffs", {"turn_number": state["turn_number"],
        "instance": instance, "card": card})


def grant_turn_buff(tx, instance_id: str, buff: str, *, ability_id: str,
                    source_id: str) -> None:
    instance = tx.state["instances"].get(instance_id)
    result = turn_atom("grant_turn_buff", {
        "instance": instance,
        "card": tx.card(instance_id) if instance is not None else None,
        "in_active_hand": instance_id in tx.zone("hand"),
        "turn_number": tx.state["turn_number"], "buff": buff,
        "ability_id": ability_id, "source_instance_id": source_id})
    if result["granted"] is None:
        return
    instance["flags"]["turn_buffs"] = result["turn_buffs"]
    tx.event("hero_turn_buff_granted", instance_id=instance_id, **result["granted"])


def destruction_replacement(tx, instance_id: str) -> dict | None:
    instance = tx.state["instances"][instance_id]
    if not instance["flags"].get("turn_buffs"):
        return None
    return turn_atom("destruction_replacement", {"instance": instance,
        "card": tx.card(instance_id), "turn_number": tx.state["turn_number"]})


def expire_turn_buffs(tx) -> None:
    """Run after end-of-turn effects and hand refill, just before passing play."""
    candidates = [{"instance_id": instance_id,
                   "turn_buffs": instance["flags"]["turn_buffs"]}
                  for instance_id, instance in tx.state["instances"].items()
                  if instance["flags"].get("turn_buffs")]
    if not candidates:
        return
    changes = turn_atom("expire_turn_buffs", {"turn_number": tx.state["turn_number"],
        "instances": candidates})
    for change in changes:
        flags = tx.state["instances"][change["instance_id"]]["flags"]
        if change["remaining"]:
            flags["turn_buffs"] = change["remaining"]
        else:
            flags.pop("turn_buffs", None)
        tx.event("hero_turn_buffs_expired", instance_id=change["instance_id"],
                 buffs=change["expired"])
