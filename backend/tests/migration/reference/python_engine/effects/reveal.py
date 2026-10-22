"""Finite, deterministic reveal cycles used by Rockslide and Dragon Jaw traps."""

from backend.tests.migration.reference.python_engine.effects.combat import matches
from backend.tests.migration.reference.python_engine.rules.players import active_players


def resolve_reveal_cycle(tx, predicate: dict, goal: int, *, ability_id: str, responses=None) -> None:
    order = active_players(tx.state)
    start = order.index(tx.player_id)
    counterclockwise = [order[(start - offset) % len(order)] for offset in range(len(order))]
    responses = responses or {}
    counterclockwise = [responses.get("redirects", {}).get(player, player) for player in counterclockwise]
    counterclockwise = [player for player in counterclockwise if player not in responses.get("immune", [])]
    destroyed = 0
    revealed_zones = {}
    while destroyed < goal:
        revealed_this_round = 0
        for player in counterclockwise:
            draw = tx.zone("draw", player)
            if not draw:
                discard = tx.zone("discard", player)
                if discard:
                    draw.extend(discard)
                    discard.clear()
                    tx.rng.shuffle(draw)
                    tx.event("player_deck_shuffled", player_id=player, order=list(draw))
            if not draw:
                continue
            instance = draw[0]
            zone = revealed_zones.setdefault(player, f"player:{player}:revealed_cycle_{tx.state['next_event_sequence']}")
            tx.state["zones"].setdefault(zone, [])
            tx.move(instance, f"player:{player}:draw", zone)
            tx.event("cards_revealed", player_id=player, instance_ids=[instance], ability_id=ability_id)
            revealed_this_round += 1
            if matches(tx.card(instance), predicate):
                tx.destroy_card(instance, reason=ability_id)
                destroyed += 1
                if destroyed == goal:
                    break
        if revealed_this_round == 0:
            break
    for player, zone in revealed_zones.items():
        for instance in list(tx.state["zones"][zone]):
            tx.move(instance, zone, f"player:{player}:discard")
        del tx.state["zones"][zone]
    tx.event("trap_reveal_cycle_completed", ability_id=ability_id, destroyed_count=destroyed, goal=goal)
