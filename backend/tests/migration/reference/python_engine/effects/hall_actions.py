"""Atomic exchanges preserve hall ranks and resume the shared breach workflow."""

from backend.tests.migration.reference.python_engine.effects.hall import can_move_monster
from backend.tests.migration.reference.python_engine.effects.combat import is_monster
from backend.tests.migration.reference.python_engine.turn.hall import remember_fronts
from backend.tests.migration.reference.python_engine.turn.operations import TurnError


def location(tx, item):
    return next((zone for zone, pile in tx.state["zones"].items() if item in pile), None)


def swap_hall(tx, first, second):
    hall = location(tx, first)
    if (first == second or hall is None or not hall.startswith("hall:") or hall.endswith(":rank0")
            or location(tx, second) != hall or any(not is_monster(tx.card(i))
            or not can_move_monster(tx, i) for i in (first, second))):
        raise TurnError("invalid hall swap")
    pile = tx.state["zones"][hall]
    a, b = pile.index(first), pile.index(second)
    if abs(a - b) != 1:
        raise TurnError("hall swap requires adjacent monsters")
    remember_fronts(tx)
    pile[a], pile[b] = pile[b], pile[a]
    tx.event("hall_cards_swapped", first=first, second=second, hall_zone=hall)
    return [{"op": "refill_hall", "hall_zone": hall}]


def exchange_hall(tx, target, replacement):
    hall, origin = location(tx, target), location(tx, replacement)
    if (hall is None or not hall.startswith("hall:") or hall.endswith(":rank0") or origin is None
            or origin.endswith(":rank0")
            or not is_monster(tx.card(target)) or not is_monster(tx.card(replacement))
            or not can_move_monster(tx, target)
            or (origin.startswith("hall:") and not can_move_monster(tx, replacement))):
        raise TurnError("invalid monster exchange")
    remember_fronts(tx)
    rank = tx.state["zones"][hall].index(target)
    target_owner = tx.state["instances"][replacement]["owner_player_id"]
    tx.state["instances"][replacement]["owner_player_id"] = None
    tx.state["instances"][target]["owner_player_id"] = target_owner
    tx.move(target, hall, origin)
    tx.move(replacement, origin, hall)
    pile = tx.state["zones"][hall]
    pile.remove(replacement)
    pile.insert(rank, replacement)
    tx.event("hall_monster_exchanged", target=target, replacement=replacement, hall_zone=hall, origin=origin)
    return [{"op": "event", "event": "HALL_REVEALED", "context": {"source_instance_id": replacement, "hall_zone": hall}},
            {"op": "refill_hall", "hall_zone": hall}]


def shuffle_hall_top(tx, target, count):
    hall = location(tx, target)
    if (hall is None or not hall.startswith("hall:") or not is_monster(tx.card(target))
            or not can_move_monster(tx, target)):
        raise TurnError("invalid hall shuffle")
    remember_fronts(tx)
    deck = hall.replace("hall:", "dungeon:").removesuffix(":rank0")
    top = list(tx.state["zones"][deck][:count])
    tx.move(target, hall, deck)
    top.append(target)
    for item in top:
        tx.state["zones"][deck].remove(item)
    tx.rng.shuffle(top)
    tx.state["zones"][deck][:0] = top
    tx.event("dungeon_top_shuffled", hall_zone=hall, instance_ids=top)
    return [] if hall.endswith(":rank0") else [{"op": "refill_hall", "hall_zone": hall}]


def shuffle_destroyed_traps(tx, bindings):
    from backend.tests.migration.reference.python_engine.effects.choices import dungeon_zone
    deck = tx.state.get("event_context", {}).get("hall_zone", "").replace("hall:", "dungeon:")
    if deck not in tx.state["zones"]:
        deck = dungeon_zone(tx, bindings)
    top = list(tx.state["zones"][deck][:10])
    for item in list(tx.state["zones"]["destroyed"]):
        if tx.card(item)["subcategory"] == "陷阱":
            tx.move(item, "destroyed", deck)
            top.append(item)
    for item in top:
        tx.state["zones"][deck].remove(item)
    tx.rng.shuffle(top)
    tx.state["zones"][deck][:0] = top
    tx.event("destroyed_traps_shuffled", deck_zone=deck, instance_ids=top)
