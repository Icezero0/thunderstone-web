"""Read-only calculation payload for the TypeScript engine worker."""

from copy import deepcopy
from dataclasses import asdict


BATTLE_FIELDS = {
    "battle_team",
    "equipped_weapon_by_hero", "card_modifiers", "strength_penalty_assignments",
    "hero_battle_modifiers", "equipment_draw_counts", "zero_weapon_weight",
    "excluded_participants", "convert_all_magic", "convert_equipped_magic", "convert_card_magic",
    "modifiers", "modifier_sources", "disease_order", "disease_penalty_assignments",
    "cannot_defeat", "used_card_tags", "target_instance_id", "target_rank",
    "health_modifier", "monster_health_modifiers", "spell_cast_counts", "damage_divisor",
}


def calculation_input(state: dict, cards: dict, ruleset, target: dict | None = None) -> dict:
    player_id = state["active_player_id"]
    hand_zone = f"player:{player_id}:hand"
    zones = {name: list(pile) for name, pile in state["zones"].items()
             if name == hand_zone or name.startswith("hall:")}
    ids = {item for pile in zones.values() for item in pile}
    instances = {item: {"card_id": state["instances"][item]["card_id"]} for item in ids}
    copied = {item: deepcopy(value) for item, value in state.get("copied_heroes", {}).items() if item in ids}
    card_ids = {item["card_id"] for item in instances.values()} | set(state["active_settings"])
    card_ids.update(card_id for copy in copied.values() for card_id in copy["card_ids"])
    if target is not None:
        card_ids.add(target["card_id"])
    context = state.get("battle_context")
    projected_state = {
        "active_player_id": player_id,
        "active_settings": list(state["active_settings"]),
        "zones": zones,
        "instances": instances,
        "players": {player_id: {"xp": state["players"][player_id]["xp"]}},
        "battle_context": {key: deepcopy(value) for key, value in context.items() if key in BATTLE_FIELDS}
        if context is not None else None,
        "copied_heroes": copied,
        "continuous_effects": [{key: value[key] for key in ("kind", "scope", "player_id", "amount")
                                if key in value} for value in state.get("continuous_effects", [])],
        "attachments": {item: [{"kind": record["kind"]} for record in records]
                        for item, records in state.get("attachments", {}).items() if item in ids},
    }
    mechanics = [asdict(rule) for rule in ruleset.mechanics if rule.source_card_id in card_ids] if ruleset else []
    return deepcopy({"cards": {card_id: cards[card_id] for card_id in sorted(card_ids)},
                     "mechanics": mechanics, "state": projected_state})
