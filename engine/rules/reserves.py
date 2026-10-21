"""Horde and Swarm markers reference increasing-health off-deck reserves."""


MARKERS = {"TS-0550", "TS-0626"}


def replace_marker(zones, instances, item, destination):
    card_id = instances[item]["card_id"]
    if card_id not in MARKERS:
        return item
    zones.setdefault("monster_markers", []).append(item)
    reserve = zones.get("monster_reserve:" + card_id, [])
    return reserve.pop(0) if reserve else None
