"""Temporary ownership and return obligations use original instance identities."""

from tests.migration.reference.python_engine.turn.operations import TurnError


def location(tx, item):
    return next(zone for zone, pile in tx.state["zones"].items() if item in pile)


def borrow(tx, item, *, when, return_destroyed):
    original = tx.state["instances"][item]["owner_player_id"]
    if original not in tx.state["players"] or when not in ("after_battle", "turn_end"):
        raise TurnError("invalid borrowed card")
    tx.state.setdefault("borrowed_cards", {})[item] = {
        "owner_player_id": original, "when": when, "return_destroyed": return_destroyed}
    tx.state["instances"][item]["owner_player_id"] = tx.player_id
    tx.move(item, location(tx, item), f"player:{tx.player_id}:hand")
    tx.event("card_borrowed", instance_id=item, original_owner=original, return_when=when)


def return_borrowed(tx, timing):
    for item, obligation in list(tx.state.get("borrowed_cards", {}).items()):
        if obligation["when"] != timing:
            continue
        del tx.state["borrowed_cards"][item]
        if item not in tx.state["instances"]:
            continue
        zone = location(tx, item)
        if tx.state["instances"][item]["owner_player_id"] is None and not obligation["return_destroyed"]:
            continue
        owner = obligation["owner_player_id"]
        tx.state["instances"][item]["owner_player_id"] = owner
        tx.move(item, zone, f"player:{owner}:discard")
        tx.event("borrowed_card_returned", instance_id=item, player_id=owner)
