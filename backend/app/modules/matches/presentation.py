"""Incremental disclosure metadata, separate from the rules engine state."""
from copy import deepcopy


def advance(previous, events, state):
    visible = set((previous or {}).get("public_hand", []))
    reveals = deepcopy((previous or {}).get("reveals", {}))
    for event in events:
        kind = event.get("kind")
        if kind in {"cards_shown", "dungeon_hand_revealed"}:
            visible.update(event.get("instance_ids", []))
        elif kind == "card_moved":
            visible.discard(event.get("instance_id"))
        elif kind in {"cards_drawn", "turn_hand_discarded"}:
            visible.difference_update(event.get("instance_ids", []))
        if kind == "cards_revealed" and event.get("zone"):
            reveals[event["zone"]] = deepcopy(event)
    zones = (state or {}).get("zones", {})
    hands = {item for zone, pile in zones.items() if zone.endswith(":hand") for item in pile}
    return {"public_hand": sorted(visible & hands),
            "reveals": {zone: event for zone, event in reveals.items() if zones.get(zone)},
            "recent_reveals": reveals,
            "event_sequence": max((previous or {}).get("event_sequence", 0),
                                  max((e.get("sequence", 0) for e in events), default=0))}
