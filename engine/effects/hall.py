"""Hall mutations shared by card actions and rule hooks."""

from engine.turn.operations import TurnError, number


def can_move_monster(tx, instance: str) -> bool:
    from engine.effects.combat import hall_rules
    card_id = tx.card(instance)["card_id"]
    return not (any(rule.op == "immovable" and rule.source_card_id == card_id for rule in tx.ruleset.mechanics)
                or bool(hall_rules(tx, "hall_movement_lock")))


def relocate(tx, instance: str, destination: str, *, defeat: bool = False) -> list[dict]:
    from engine.turn.hall import remember_fronts

    hall = next((zone for zone, pile in tx.state["zones"].items() if zone.startswith("hall:") and instance in pile), None)
    monster = tx.card(instance)["subcategory"] == "怪物"
    stone = tx.card(instance)["subcategory"] == "雷霆之石"
    if hall is None or not (monster or stone and destination == "dungeon_bottom" and not defeat):
        raise TurnError("hall relocation needs a monster in a hall")
    if monster and not defeat and not can_move_monster(tx, instance):
        raise TurnError("this monster cannot leave the hall unless defeated")
    remember_fronts(tx)
    rank = tx.state["zones"][hall].index(instance) + 1
    if rank == 1 and destination != "rank3":
        tx.state["hall_fronts"][hall] = None
    if destination == "dungeon_bottom":
        tx.move(instance, hall, hall.replace("hall:", "dungeon:"))
    elif destination == "discard":
        tx.state["instances"][instance]["owner_player_id"] = tx.player_id
        tx.move(instance, hall, f"player:{tx.player_id}:discard")
    elif destination == "rank3":
        pile = tx.state["zones"][hall]
        pile.remove(instance)
        pile.insert(min(2, len(pile)), instance)
        tx.event("hall_card_repositioned", instance_id=instance, hall_zone=hall, rank=min(3, len(pile)))
    else:
        raise TurnError("unsupported hall relocation")
    tx.event("effect_hall_relocated", instance_id=instance, card_id=tx.card(instance)["card_id"],
             hall_zone=hall, destination=destination, defeat=defeat)
    steps = []
    if defeat:
        tx.state.setdefault("turn_defeated_monsters", []).append(instance)
        xp = number(tx.card(instance), "defeat_xp_reward")
        tx.player["xp"] += xp
        tx.event("monster_defeated", player_id=tx.player_id, target_instance_id=instance, xp_gained=xp, by_effect=True)
        steps.append({"op": "event", "event": "MONSTER_DEFEATED", "context": {
            "source_instance_id": instance, "rank": rank, "hall_zone": hall}})
    steps.append({"op": "refill_hall", "hall_zone": hall, "acquire_stone": defeat and rank == 1,
                  "defeated_instance_id": instance if defeat else None})
    return steps
