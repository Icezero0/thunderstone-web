"""Owned set-aside cards and diseases attached to individual hall monsters."""

from tests.migration.reference.python_engine.turn.operations import TurnError
from tests.migration.reference.python_engine.effects.combat import is_monster, is_disease


KINDS = {"cage", "emerald", "sapphire", "disease_before", "disease_after"}


def location(tx, item):
    return next(zone for zone, pile in tx.state["zones"].items() if item in pile)


def attach(tx, item, anchor, kind, *, owner):
    if kind not in KINDS or item == anchor:
        raise TurnError("invalid attachment")
    records = tx.state.setdefault("attachments", {}).setdefault(anchor, [])
    if kind.startswith("disease_"):
        if not is_disease(tx.card(item)) or not is_monster(tx.card(anchor)):
            raise TurnError("disease attachment needs a disease and a monster")
        destination = "attached:" + anchor
        tx.state["instances"][item]["owner_player_id"] = None
    else:
        if records:
            raise TurnError("this attachment source is already occupied")
        destination = f"player:{owner}:aside"
        tx.state["instances"][anchor]["owner_player_id"] = owner
        tx.move(anchor, location(tx, anchor), destination)
        tx.state["instances"][item]["owner_player_id"] = owner
    tx.move(item, location(tx, item), destination)
    records.append({"kind": kind, "instance_id": item, "owner_player_id": owner})
    tx.event("card_attached", instance_id=item, anchor_instance_id=anchor, attachment_kind=kind, player_id=owner)


def release(tx, anchor, *, recipient="owner", destroy_anchor=True):
    records = tx.state.setdefault("attachments", {}).pop(anchor, [])
    for record in records:
        item = record["instance_id"]
        player = record["owner_player_id"] if recipient == "owner" else tx.player_id
        tx.state["instances"][item]["owner_player_id"] = player
        tx.move(item, location(tx, item), f"player:{player}:discard")
    if destroy_anchor:
        tx.destroy_card(anchor, reason="attachment_released")
    else:
        owner = tx.state["instances"][anchor]["owner_player_id"]
        tx.move(anchor, location(tx, anchor), f"player:{owner}:discard")
    tx.event("attachment_released", anchor_instance_id=anchor, recipient=recipient, instance_ids=[r["instance_id"] for r in records])


def disease_gain_steps(tx, anchor, timing):
    records = tx.state.setdefault("attachments", {}).get(anchor, [])
    matching = [record for record in records if record["kind"] == "disease_" + timing]
    steps = []
    for record in matching:
        item = record["instance_id"]
        records.remove(record)
        tx.state["instances"][item]["owner_player_id"] = tx.player_id
        tx.move(item, location(tx, item), f"player:{tx.player_id}:discard")
        steps.append({"op": "resolve_disease_gain", "gain": {"instance_id": item, "player_id": tx.player_id,
            "destination": "discard", "used_sources": []}})
    if not records:
        tx.state["attachments"].pop(anchor, None)
    tx.state["zones"].pop("attached:" + anchor, None) if not records else None
    return steps


def restore_at_game_end(tx):
    for anchor, records in list(tx.state.get("attachments", {}).items()):
        if any(record["kind"] == "sapphire" for record in records):
            release(tx, anchor, destroy_anchor=False)
