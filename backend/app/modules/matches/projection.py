"""Build a participant's view from an authoritative, private match snapshot.

This is an allowlist, never a filtered copy of GameState. RNG, hidden hand
identities, raw events and interpreter continuations remain on the server.
"""

from collections import Counter
from copy import deepcopy
from datetime import datetime
from typing import Any

from backend.app.core.exceptions import AppError
from backend.app.modules.cards.presentation import public_card
from backend.app.modules.matches.interaction_view import (
    collect_references, command_view, event_view, fields, result_view,
)
from backend.app.modules.matches.table_projection import public_hand_instances, supply_members


def build_match_view(match: Any, viewer_user_id: int, *, legal_commands: list | None = None,
                     battle_preparation: dict | None = None, abilities: list | None = None,
                     unavailable_reason: str | None = None, profiles: dict | None = None) -> dict:
    """Expose board, unordered inventories, shown hand cards and the viewer's own cards."""
    members = match.frozen_players
    viewer = next((p for p in members if p["user_id"] == viewer_user_id), None)
    if viewer is None:
        raise AppError("你不在这场对局中", code="match_forbidden", status_code=403)
    player_id = viewer["player_id"]
    state = match.state or {}
    zones, instances = state.get("zones", {}), state.get("instances", {})
    catalog = match.catalog_snapshot["cards"]
    visible_cards: dict[str, dict] = {}

    def include_card(card_id: str) -> str:
        if card_id in catalog and card_id not in visible_cards:
            visible_cards[card_id] = public_card(card_id, catalog[card_id])
        return card_id

    def card_instances(ids: list[str]) -> list[dict]:
        return [{"instance_id": item, "card_id": include_card(instances[item]["card_id"])}
                for item in ids if item is not None]

    def inventory(ids: list[str], pid: str, zone: str) -> list[dict]:
        ordered = sorted(ids, key=lambda item: (instances[item]["card_id"], item))
        return [{"instance_id": item if pid == player_id else f"inventory:{pid}:{zone}:{i}",
                 "card_id": include_card(instances[item]["card_id"])} for i, item in enumerate(ordered)]

    revealed = public_hand_instances(getattr(match, "events", []))

    players = []
    for member in members:
        pid = member["player_id"]
        profile = (profiles or {}).get(member["user_id"])
        hand = zones.get(f"player:{pid}:hand", [])
        whole_hand_public = pid == state.get("active_player_id") and state.get("turn_hand_public", False)
        visible_hand = [{"instance_id": item, "card_id": include_card(instances[item]["card_id"]),
                         "revealed": whole_hand_public or item in revealed} if pid == player_id or whole_hand_public or item in revealed else
                        {"instance_id": f"hidden:{pid}:{i}", "revealed": False}
                        for i, item in enumerate(hand)]
        players.append({
            "user_id": member["user_id"], "player_id": pid,
            "display_name": (profile.username or f"玩家 {profile.id}") if profile else member["display_name"],
            "avatar_url": profile.avatar_url if profile else None,
            "is_you": pid == player_id, "is_active": pid == state.get("active_player_id"),
            "eliminated": bool(state.get("players", {}).get(pid, {}).get("eliminated")),
            "xp": state.get("players", {}).get(pid, {}).get("xp", 0),
            **{f"{part}_count": len(zones.get(f"player:{pid}:{part}", []))
               for part in ("hand", "draw", "discard")},
            "control": card_instances(zones.get(f"player:{pid}:control", [])),
            "cards": {"hand": visible_hand,
                      "draw": inventory(zones.get(f"player:{pid}:draw", []), pid, "draw"),
                      "discard": inventory(zones.get(f"player:{pid}:discard", []), pid, "discard")},
        })

    supplies = []
    rules = state.get("supply_rules", {})
    for card_id in rules.get("basic_card_ids", []):
        include_card(card_id)
        supplies.append({"zone_id": f"basic_supply:{card_id}", "kind": "basic",
                         "top_card_id": card_id, "remaining": None, "infinite": True,
                         "cards": [{"card_id": card_id, "count": None}]})
    for zone_id, pile in sorted(zones.items()):
        kind = "village" if zone_id.startswith("village_supply:") else (
            "hero" if zone_id.startswith("hero_supply:") else None)
        if kind is None:
            continue
        counts = Counter(instances[item]["card_id"] for item in pile)
        name, members = supply_members(zone_id, catalog, match.catalog_snapshot.get("setup_index", {}), counts)
        supplies.append({
            "zone_id": zone_id, "kind": kind, "name": name,
            "top_card_id": include_card(instances[pile[0]]["card_id"]) if pile else None,
            "remaining": len(pile), "infinite": False,
            "cards": [{"card_id": include_card(cid), "count": count}
                      for cid in members for count in [counts.get(cid, 0)]],
        })

    dungeons = []
    for zone_id, pile in sorted(zones.items()):
        if not zone_id.startswith("dungeon:"):
            continue
        dungeon_id = zone_id.removeprefix("dungeon:")
        hall_zone = f"hall:{dungeon_id}"
        hall = [{"rank": 0, **entry} for entry in card_instances(zones.get(f"{hall_zone}:rank0", []))]
        for rank, item in enumerate(zones.get(hall_zone, []), start=1):
            if item is not None:
                hall.append({"rank": rank, **card_instances([item])[0]})
        dungeons.append({"id": dungeon_id, "deck_count": len(pile), "hall": hall,
                         "rank_count": max(3, len(zones.get(hall_zone, [])))})

    disease_supply = None
    if rules:
        disease_supply = {"mode": rules["disease_mode"], "infinite": True,
                          "cards": [{"card_id": include_card(cid), "weight": rules["disease_weights"][cid]}
                                    for cid in rules["disease_card_ids"]]}

    choice = None
    if match.status == "setup_pending" and match.setup_choice:
        raw = match.setup_choice
        if raw.get("kind") == "two_dungeons":
            choice = {"kind": "two_dungeons", "group_a_count": raw["group_a_count"],
                      "group_ids": [include_card(cid) for cid in raw["group_ids"]],
                      "feature_ids": [include_card(cid) for cid in raw["feature_ids"]]}

    turn = None
    if state:
        turn = {"number": state["turn_number"], "round": state["round_number"],
                "active_player_id": state["active_player_id"], "first_player_id": state["first_player_id"],
                "phase": state["phase"], "subphase": state["subphase"],
                "chosen_action": state.get("chosen_action"), "timing_window": state.get("timing_window"),
                "resolving_event": state.get("resolving_event")}
    raw_pending = state.get("pending_choice")
    actor = (raw_pending.get("player_id") if raw_pending else state.get("active_player_id")) \
        if match.status == "active" and state.get("phase") == "PLAYING" else None
    can_act = actor == player_id and unavailable_reason is None
    commands = [item for raw in (legal_commands or []) if (item := command_view(raw)) is not None] if can_act else []
    pending = None
    if raw_pending and actor:
        pending = {"kind": raw_pending["kind"], "player_id": actor, "can_resolve": can_act}
        if can_act:
            pending.update(fields(raw_pending, ("ability_id", "source_instance_id", "stage", "event")))
            if raw_pending.get("node", {}).get("kind") in {"number", "player", "dungeon", "enum"}:
                pending["value_kind"] = raw_pending["node"]["kind"]
    command_instances, ability_descriptions = {}, {}
    ability_index = {item["id"]: item for item in abilities or []}

    def add_instance(instance_id):
        if instance_id in instances:
            item = instances[instance_id]
            command_instances[instance_id] = {"instance_id": instance_id, "card_id": include_card(item["card_id"]),
                                               "owner_player_id": item.get("owner_player_id")}

    def add_ability(ability_id):
        if ability_id in ability_index:
            item = ability_index[ability_id]
            ability_descriptions[ability_id] = {"source_card_id": include_card(item["source_card_id"]),
                                                "source_line": item.get("source_line", "")}

    collect_references(commands, add_instance, include_card, add_ability)
    if can_act and pending:
        collect_references(pending, add_instance, include_card, add_ability)
    preparation = deepcopy(battle_preparation) if can_act and not raw_pending \
        and state.get("subphase") == "DUNGEON_PREPARE" else None
    # Only the shared engine's dedicated projectBattleContext result is accepted
    # here, never the authoritative GameState. Its contract is tested in engine/.
    if preparation:
        for card_id in preparation["context"]["cards"]:
            include_card(card_id)
    logs = event_view(getattr(match, "events", []), instances, include_card)
    resources = state.get("players", {}).get(player_id, {})
    created_at = match.created_at.isoformat() if isinstance(match.created_at, datetime) else match.created_at
    return {
        "id": match.id, "room_id": match.room_id, "status": match.status, "version": match.version,
        "host_user_id": match.host_user_id, "viewer_player_id": player_id,
        "can_resolve_setup": match.status == "setup_pending" and viewer_user_id == match.host_user_id,
        "created_at": created_at, "players": players, "turn": turn,
        "actor_player_id": actor, "legal_commands": commands, "pending_choice": pending,
        "command_instances": command_instances, "abilities": ability_descriptions,
        "battle_preparation": preparation, "unavailable_reason": unavailable_reason,
        "viewer_resources": {key: resources.get(key, 0) for key in
                             ("xp", "temporary_gold", "purchases_remaining", "extra_basic_purchases")},
        "event_log": logs, "result": result_view(state),
        "hand": card_instances(zones.get(f"player:{player_id}:hand", [])),
        "draw": inventory(zones.get(f"player:{player_id}:draw", []), player_id, "draw"),
        "discard": card_instances(zones.get(f"player:{player_id}:discard", [])),
        "aside": card_instances([item for zone, pile in zones.items()
                                  if zone in {f"player:{player_id}:aside", f"player:{player_id}:refill_add"}
                                  for item in pile]),
        "supplies": supplies, "dungeons": dungeons,
        "settings": card_instances(zones.get("settings", [])),
        "disease_supply": disease_supply, "setup_choice": choice, "cards": visible_cards,
    }
