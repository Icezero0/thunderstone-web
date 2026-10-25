"""Viewer-only card movements, independent of the public activity log.

Never transmit a shuffle order, another player's draws, or interpreter frames.
The renderer receives committed movements; it does not run effects to infer them.
"""


def deck_motion_view(events, instances, viewer, catalog, add_card):
    known = {key: value["card_id"] for key, value in instances.items()}
    # Diseases may already have been removed from the instance registry.
    for event in events:
        if event.get("instance_id") and event.get("card_id"):
            known.setdefault(event["instance_id"], event["card_id"])
    revealed_zones = {event["zone"] for event in events if event.get("kind") == "cards_revealed"
                      and "zone" in event and viewer in event.get("visible_to", [])}

    def cards(ids):
        return [{"instance_id": item, "card_id": add_card(known[item])} for item in ids if item in known]

    def zone(raw, instance=None):
        if raw in revealed_zones:
            return "revealed"
        if not isinstance(raw, str) or not raw.startswith(f"player:{viewer}:"):
            return None
        part = raw.split(":", 2)[2]
        if part in ("hand", "draw", "discard"):
            return part
        if part in ("aside", "refill_add"):
            return "aside"
        if part == "control":
            tags = catalog.get(known.get(instance), {}).get("tags", "").split("|")
            return "treasures" if "宝藏" in tags else "aside"
        if part.startswith("revealed_"):
            return "revealed"
        return None

    def move(ids, source, destination):
        return {"kind": "move", "source": source, "destination": destination, "cards": cards(ids)}

    rows = []
    gains = set()
    for index, event in enumerate(events):
        kind = event.get("kind")
        steps = []
        own = event.get("player_id") == viewer
        if kind == "card_moved":
            item = event["instance_id"]
            if any(e.get("kind") == "card_attached" and e.get("instance_id") == item
                   or e.get("kind") == "attachment_released" and item in e.get("instance_ids", [])
                   for e in events[index + 1:index + 9]):
                continue  # Attachment flights have a miniature-card endpoint.
            gains.discard(item)
            source, destination = zone(event.get("source"), item), zone(event.get("destination"), item)
            # Batch ordinary turn cleanup at its semantic event, instead of
            # playing its low-level movements and then playing it again.
            following = index + 1
            while following < len(events) and events[following].get("kind") == "card_moved":
                following += 1
            cleanup = events[following] if following < len(events) else {}
            if source == "hand" and destination == "discard" and cleanup.get("kind") == "turn_hand_discarded" \
                    and cleanup.get("player_id") == viewer and item in cleanup.get("instance_ids", []):
                continue
            if source and destination and source != destination:
                steps = [move([item], source, destination)]
        elif own and kind == "turn_hand_discarded":
            steps = [move(event.get("instance_ids", []), "hand", "discard")]
        elif kind == "card_destroyed" and event.get("reason") not in ("hero_upgrade", "trap_resolved") \
                and zone(event.get("source"), event.get("instance_id")):
            steps = [{"kind": "destroy", "cards": cards([event["instance_id"]])}]
        elif own and kind == "cards_drawn":
            taken = event.get("instance_ids", [])
            previous = events[index - 1] if index else {}
            shuffled = previous.get("order", []) if previous.get("kind") == "player_deck_shuffled" and previous.get("player_id") == viewer else []
            if shuffled:
                # draw() reports the shuffle before its combined draw event.
                # Split the draw by membership, never by the hidden shuffle order.
                pool = set(shuffled)
                before = [item for item in taken if item not in pool]
                after = [item for item in taken if item in pool]
                if before:
                    steps.append(move(before, "draw", "hand"))
                steps.append({"kind": "shuffle"})
                if after:
                    steps.append(move(after, "draw", "hand"))
            elif taken:
                steps = [move(taken, "draw", "hand")]
        elif own and kind == "player_deck_shuffled":
            following = events[index + 1] if index + 1 < len(events) else {}
            if following.get("kind") != "cards_drawn" or following.get("player_id") != viewer:
                steps = [{"kind": "shuffle"}]
        elif own and kind in {"card_bought", "effect_card_gained", "effect_purchase_completed", "card_gained"}:
            source = event.get("source", "")
            if kind == "card_bought":
                source = "supply"  # A purchase always comes from the public supply.
            if isinstance(source, str) and (source == "supply" or source.startswith(("basic_supply:", "hero_supply:", "village_supply:"))):
                if event["instance_id"] in gains:
                    continue
                gains.add(event["instance_id"])
                destination = zone(event.get("destination"), event.get("instance_id")) or "discard"
                steps = [{"kind": "gain", "source": source, "destination": destination, "cards": cards([event["instance_id"]])}]
        elif own and kind == "hero_upgraded":
            source = cards([event.get("source_instance_id")])
            target = cards([event.get("target_instance_id")])
            if source and target:
                steps = [{"kind": "upgrade", "source_card": source[0], "target_card": target[0]}]
        if steps:
            rows.append({"sequence": event["sequence"], "kind": "player_card_motion", "player_id": viewer, "steps": steps})
    return rows
