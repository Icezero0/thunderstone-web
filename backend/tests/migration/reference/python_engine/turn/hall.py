"""Incremental hall refill, with card events resolved before proceeding."""

from backend.tests.migration.reference.python_engine.rules.hall import hall_capacity
from backend.tests.migration.reference.python_engine.effects.combat import is_thunderstone


def remember_fronts(tx) -> None:
    fronts = tx.state.setdefault("hall_fronts", {})
    for zone, pile in tx.state["zones"].items():
        if zone.startswith("hall:") and not zone.endswith(":rank0"):
            fronts.setdefault(zone, pile[0] if pile else None)


def _event(event, instance_id, hall_zone, **details):
    return {"op": "event", "event": event,
            "context": {"source_instance_id": instance_id, "hall_zone": hall_zone, **details}}


def refill_step(tx, step) -> None:
    from backend.tests.migration.reference.python_engine.turn.workflow import queue_steps
    from backend.tests.migration.reference.python_engine.turn.dungeon import _settle_on_stone

    hall_zone = step["hall_zone"]
    if not step.get("before_refill_done"):
        queue_steps(tx, [{"op": "event", "event": "BEFORE_HALL_REFILL", "context": {
            "hall_zone": hall_zone, "defeated_instance_id": step.get("defeated_instance_id")}},
            {**step, "before_refill_done": True}], front=True)
        return
    hall = tx.state["zones"][hall_zone]
    deck_zone = hall_zone.replace("hall:", "dungeon:")
    deck = tx.state["zones"][deck_zone]
    target_size = hall_capacity((tx.card(item)["card_id"] for item in hall), tx.state["active_settings"])
    # The swamp lets features advance through the hall before revealing them.
    if hall and tx.card(hall[0])["subcategory"] in ("陷阱", "宝藏"):
        instance = hall[0]
        if tx.card(instance)["subcategory"] == "陷阱":
            tx.move(instance, hall_zone, "revealed:" + hall_zone.removeprefix("hall:"))
            tx.event("trap_revealed", instance_id=instance)
            queue_steps(tx, [_event("TRAP_REVEALED", instance, hall_zone, defeated_instance_id=step.get("defeated_instance_id")),
                             {"op": "dispose_revealed", "instance_id": instance}, step], front=True)
        else:
            tx.state["instances"][instance]["owner_player_id"] = tx.player_id
            tx.move(instance, hall_zone, f"player:{tx.player_id}:control")
            tx.event("treasure_claimed", player_id=tx.player_id, instance_id=instance)
            queue_steps(tx, [step], front=True)
        return
    if len(hall) < target_size and deck:
        instance = deck[0]
        from backend.tests.migration.reference.python_engine.rules.reserves import MARKERS, replace_marker
        if tx.card(instance)["card_id"] in MARKERS:
            deck.pop(0)
            replacement = replace_marker(tx.state["zones"], tx.state["instances"], instance, hall_zone)
            tx.event("monster_marker_replaced", marker_instance_id=instance, instance_id=replacement, at_setup=False)
            if replacement is not None:
                deck.insert(0, replacement)
            queue_steps(tx, [step], front=True)
            return
        category = tx.card(instance)["subcategory"]
        if category in ("陷阱", "宝藏") and "TS-0188" not in tx.state["active_settings"]:
            if category == "陷阱":
                tx.move(instance, deck_zone, "revealed:" + hall_zone.removeprefix("hall:"))
                tx.event("trap_revealed", instance_id=instance)
                queue_steps(tx, [_event("TRAP_REVEALED", instance, hall_zone, defeated_instance_id=step.get("defeated_instance_id")),
                                 {"op": "dispose_revealed", "instance_id": instance}, step], front=True)
            else:
                tx.state["instances"][instance]["owner_player_id"] = tx.player_id
                tx.move(instance, deck_zone, f"player:{tx.player_id}:control")
                tx.event("treasure_claimed", player_id=tx.player_id, instance_id=instance)
                queue_steps(tx, [step], front=True)
        else:
            tx.move(instance, deck_zone, hall_zone)
            tx.event("hall_card_entered", hall_zone=hall_zone, instance_id=instance, rank=len(hall))
            queue_steps(tx, [_event("HALL_REVEALED", instance, hall_zone), step], front=True)
        return
    if len(hall) < target_size:
        tx.event("hall_deck_exhausted", hall_zone=hall_zone, missing=target_size - len(hall))
    if not hall:
        tx.state.setdefault("hall_fronts", {})[hall_zone] = None
        return
    instance = hall[0]
    category = tx.card(instance)["subcategory"]
    previous = tx.state.setdefault("hall_fronts", {}).get(hall_zone)
    tx.state["hall_fronts"][hall_zone] = instance
    # Guardians (notably the Heart's guardian + thunderstone identity) keep
    # their own breach lifecycle before generic thunderstone handling.
    if category == "守护者":
        from backend.tests.migration.reference.python_engine.turn.scenarios import HEART_OF_DOOM
        if tx.card(instance)["card_id"] == HEART_OF_DOOM:
            from backend.tests.migration.reference.python_engine.turn.settlement import settle_game
            tx.event("rule_timing", event="BREACH", context={
                "source_instance_id": instance, "hall_zone": hall_zone})
            settle_game(tx, "heart_of_doom_breached", instance_id=instance)
            return
        queue_steps(tx, [_event("BREACH", instance, hall_zone),
                         {"op": "guardian_to_rank0", "instance_id": instance, "hall_zone": hall_zone}, step], front=True)
    elif is_thunderstone(tx.card(instance)):
        if not _settle_on_stone(tx, instance, acquire=step.get("acquire_stone", False)):
            queue_steps(tx, [step], front=True)
    elif instance != previous:
        queue_steps(tx, [_event("BREACH", instance, hall_zone)], front=True)
