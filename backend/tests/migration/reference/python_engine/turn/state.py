"""Invariants checked before and after every basic turn command."""

from __future__ import annotations

from backend.tests.migration.reference.python_engine.turn.operations import TurnError
from backend.tests.migration.reference.python_engine.effects.status import validate_turn_buffs


SUBPHASES = {"TURN_START", "VILLAGE_ABILITIES", "VILLAGE_BUY",
             "VILLAGE_UPGRADE", "REST", "DUNGEON_PREPARE",
             "ACTION_EXIT_EFFECTS", "TURN_END_EFFECTS", "GAME_END"}
SUBPHASES |= {"BATTLE_EFFECTS", "BATTLE_AFTER_EFFECTS"}


def validate_turn_state(state: dict, cards: dict[str, dict[str, str]]) -> None:
    if state.get("phase") not in ("PLAYING", "SETTLING"):
        raise TurnError("game is not in a turn or settlement phase")
    if state.get("subphase") not in SUBPHASES:
        raise TurnError("unknown turn subphase")
    if state["phase"] == "SETTLING" and state["subphase"] != "GAME_END":
        raise TurnError("settling game has no end subphase")
    order = state.get("player_order")
    if (not isinstance(order, list) or not order or len(set(order)) != len(order)
            or state.get("active_player_id") not in order
            or set(state.get("players", {})) != set(order)):
        raise TurnError("invalid player order or active player")
    if (state["phase"] == "PLAYING"
            and state["players"][state["active_player_id"]].get("eliminated")):
        raise TurnError("eliminated player cannot have an active turn")
    for name in ("game_version", "turn_number", "round_number",
                 "next_instance_sequence", "next_event_sequence"):
        value = state.get(name)
        if not isinstance(value, int) or isinstance(value, bool) or value < 1:
            raise TurnError(f"invalid {name}")
    choice = state.get("pending_choice")
    frames = state.get("resolution_frames")
    if not isinstance(frames, list) or not isinstance(state.get("scheduled_effects"), list):
        raise TurnError("invalid effect continuation or schedule")
    if not isinstance(state.get("ability_uses", {}), dict):
        raise TurnError("invalid ability usage record")
    if (choice is None) != (not frames):
        raise TurnError("effect choice and continuation must occur together")
    if choice is not None and (not isinstance(choice, dict)
                               or choice.get("player_id") not in order
                               or choice.get("kind") not in ("effect_select", "effect_order", "effect_purchase", "effect_value", "effect_reorder", "effect_upgrade", "disease_replacement", "effect_reuse", "effect_response")
                               or not isinstance(frames, list) or len(frames) != 1):
        raise TurnError("invalid pending effect choice")
    seen: set[str] = set()
    zones = state.get("zones", {})
    instances = state.get("instances", {})
    for zone, pile in zones.items():
        if not isinstance(pile, list):
            raise TurnError(f"invalid zone: {zone}")
        for instance_id in pile:
            if instance_id in seen or instance_id not in instances:
                raise TurnError(f"duplicate or unknown instance: {instance_id}")
            seen.add(instance_id)
            item = instances[instance_id]
            if item["card_id"] not in cards:
                raise TurnError(f"unknown card: {item['card_id']}")
            validate_turn_buffs(state, item, cards[item["card_id"]])
            if zone.startswith("player:"):
                parts = zone.split(":")
                if len(parts) != 3 or item["owner_player_id"] != parts[1]:
                    raise TurnError(f"wrong instance owner in {zone}: {instance_id}")
            elif item["owner_player_id"] is not None:
                raise TurnError(f"owned instance outside player zone: {instance_id}")
    if seen != set(instances):
        raise TurnError("some instances have no zone")
    for player_id in order:
        for part in ("draw", "hand", "discard", "control"):
            if f"player:{player_id}:{part}" not in zones:
                raise TurnError(f"missing player zone: {player_id}:{part}")
        player = state["players"][player_id]
        if any(not isinstance(player.get(key), int) or player[key] < 0
               for key in ("xp", "temporary_gold", "purchases_remaining")):
            raise TurnError(f"invalid player resources: {player_id}")
        if not isinstance(player.get("eliminated", False), bool):
            raise TurnError(f"invalid player elimination status: {player_id}")
