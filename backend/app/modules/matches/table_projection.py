"""Viewer-safe inventories and presentation metadata for the graphical table."""


def public_hand_instances(events: list[dict]) -> set[str]:
    """A reveal lasts only for the current stay in hand, never through a hidden draw."""
    visible: set[str] = set()
    for event in events:
        kind = event.get("kind")
        if kind in {"cards_shown", "dungeon_hand_revealed"}:
            visible.update(event.get("instance_ids", []))
        elif kind == "card_moved":
            visible.discard(event.get("instance_id"))
        elif kind in {"cards_drawn", "turn_hand_discarded"}:
            visible.difference_update(event.get("instance_ids", []))
    return visible


def supply_members(zone_id: str, catalog: dict, index: dict, present: dict) -> tuple[str, list[str]]:
    kind, key = zone_id.split(":", 1)
    group = next((g for g in index.get("groups", [])
                  if g.get("randomizer_id") == key and f"{g.get('kind')}_supply" == kind), None)
    members = list(group["members"]) if group else list(present) or ([key] if key in catalog else [])
    members = [cid for cid in members if cid in catalog]
    members.sort(key=lambda cid: (int(catalog[cid].get("wiki_英雄等级") or 0), cid))
    first = catalog.get(members[0], {}) if members else {}
    name = first.get("subcategory") if kind == "hero_supply" else None
    if not name:
        name = catalog.get(key, {}).get("name") or first.get("name") or key
    return name, members
