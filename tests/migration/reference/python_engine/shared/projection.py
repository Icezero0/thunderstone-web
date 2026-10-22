"""Build only the read-only, visible input needed by the calculation kernel."""
from copy import deepcopy
from dataclasses import asdict


BATTLE_FIELDS = {
    "equipped_weapon_by_hero", "card_modifiers", "strength_penalty_assignments",
    "hero_battle_modifiers", "equipment_draw_counts", "zero_weapon_weight",
    "excluded_participants", "convert_all_magic", "convert_equipped_magic", "convert_card_magic",
    "modifiers", "modifier_sources", "disease_order", "disease_penalty_assignments",
    "cannot_defeat", "used_card_tags", "target_instance_id", "target_rank",
    "health_modifier", "monster_health_modifiers",
}


def calculation_input(tx, target=None) -> dict:
    hand_zone = f"player:{tx.player_id}:hand"
    zones = {name: list(pile) for name, pile in tx.state["zones"].items()
             if name == hand_zone or name.startswith("hall:")}
    ids = {item for pile in zones.values() for item in pile}
    instances = {item: {"card_id": tx.state["instances"][item]["card_id"]} for item in ids}
    copied = {item: deepcopy(value) for item, value in tx.state.get("copied_heroes", {}).items() if item in ids}
    card_ids = {item["card_id"] for item in instances.values()} | set(tx.state["active_settings"])
    card_ids.update(card_id for copy in copied.values() for card_id in copy["card_ids"])
    if target is not None:
        card_ids.add(target["card_id"])
    cards = {card_id: tx.cards[card_id] for card_id in sorted(card_ids)}
    context = tx.state.get("battle_context")
    state = {
        "active_player_id": tx.player_id, "active_settings": list(tx.state["active_settings"]),
        "zones": zones, "instances": instances, "players": {tx.player_id: {"xp": tx.player["xp"]}},
        "battle_context": {key: deepcopy(value) for key, value in context.items() if key in BATTLE_FIELDS} if context is not None else None,
        "copied_heroes": copied,
        "continuous_effects": [{key: value[key] for key in ("kind", "scope", "player_id", "amount") if key in value}
                               for value in tx.state.get("continuous_effects", [])],
        "attachments": {item: [{"kind": record["kind"]} for record in records]
                        for item, records in tx.state.get("attachments", {}).items() if item in ids},
    }
    mechanics = [asdict(rule) for rule in tx.ruleset.mechanics if rule.source_card_id in card_ids] if tx.ruleset else []
    return deepcopy({"cards": cards, "mechanics": mechanics, "state": state})


def preview_context(tx) -> dict:
    if tx.state["subphase"] != "DUNGEON_PREPARE" or tx.state.get("pending_choice") is not None:
        raise ValueError("battle preview requires an uninterrupted dungeon preparation phase")
    from backend.app.integrations.game_engine.shared.client import client
    return {"schema_version": "thunderstone.preview/1", **client.call("runtime_info", {}), "game_version": tx.state["game_version"],
            "catalog_version": tx.state["catalog_version"], "effects_version": tx.state["effects_version"],
            "player_id": tx.player_id, **calculation_input(tx)}
