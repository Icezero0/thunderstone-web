"""Allowlisted command and event descriptions for the authenticated participant."""

from copy import deepcopy


# The engine supplies legality. This layer only describes the offered inputs;
# interpreter nodes, queries, bindings and continuations never cross this boundary.
COMMAND_FIELDS = {
    "UpdatePreparationEquipment": (),
    "ChooseAction": ("actions",), "FinishAbilities": (), "FinishBuying": (),
    "FinishUpgrading": (), "SkipRestDestroy": (), "FinishTurn": (),
    "ActivateAbility": (), "BuyCard": ("card_ids",), "UpgradeHero": (),
    "RestDestroy": ("instance_ids",), "UnequipWeapon": ("instance_ids",), "EquipWeapon": (),
    "SubmitBattleTeam": ("requires_draft",), "DeclareBattleTarget": ("instance_ids",), "ReviseBattleTeam": (),
    "AssignStrengthPenalty": ("hero_instance_ids",),
    "AssignDiseasePenalty": ("instance_ids", "attack_types"),
    "ResolveChoice": ("instance_ids", "ability_id", "min_count", "max_count", "highest_by"),
    "ResolveCardOrder": ("instance_ids",), "ResolveValueChoice": ("options",),
    "ResolveTrap": ("instance_ids",),
    "ResolveReusedAbility": ("ability_ids", "source_instance_id"), "ResolveEffectOrder": (),
    "ResolveEffectPurchase": ("may_skip",), "ResolveEffectUpgrade": ("may_skip",),
    "ResolveResponse": ("stage", "may_decline"), "ResolveDiseaseReplacement": ("stage", "may_decline"),
}
OPTION_FIELDS = {
    "ActivateAbility": ("ability_id", "source_instance_id"),
    "BuyCard": ("card_id", "price"),
    "UpgradeHero": ("source_instance_id", "target_card_id", "xp_cost"),
    "ResolveEffectUpgrade": ("source_instance_id", "target_card_id", "xp_cost"),
    "ResolveEffectPurchase": ("card_id", "price", "budget"),
    "EquipWeapon": ("hero_instance_id", "weapon_instance_id"),
    "ResolveResponse": ("source_instance_id", "ability_id", "action"),
    "ResolveDiseaseReplacement": ("source_instance_id", "ability_id", "action"),
}
FILTER_FIELDS = set((
    "gold_present cost_present vp_present equipped unused participating unmarked duplicate_names "
    "revealed_only movable in_hand in_selected_dungeon used equipment_space same_family_as_event in_discard "
    "tag card_id card_type subcategory name exclude_card_id exclude_card_type exclude_var name_in_var "
    "equipper_card_id same_name_as_var without_weapon_tag semantic_type adjacent_to_var equippable_by_var "
    "tags_any tags_none equipper_tags_any gold_min light_min level_min level_max magic_min strength_min "
    "strength_max weight_min weight_max gold_max vp_min vp_max rank magic_max"
).split())


def primitive(value):
    return value is None or isinstance(value, (str, bool, int, float))


def fields(raw, names):
    """Copy named scalar or flat scalar-list fields, never nested caller values."""
    return {key: deepcopy(raw[key]) for key in names if key in raw and
            (primitive(raw[key]) or isinstance(raw[key], list) and all(primitive(item) for item in raw[key]))}


def command_view(raw):
    kind = raw.get("type")
    if kind not in COMMAND_FIELDS:
        return None
    result = {"type": kind, **fields(raw, COMMAND_FIELDS[kind])}
    if "player_id" in raw:
        result.update(fields(raw, ("player_id",)))
    if kind in OPTION_FIELDS:
        names = OPTION_FIELDS[kind]
        result["options"] = [fields(option, names) if isinstance(option, dict) else option
                             for option in raw.get("options", []) if isinstance(option, dict) or primitive(option)]
    if kind == "AssignStrengthPenalty":
        result["penalties"] = [fields(item, ("instance_id", "hero_instance_id", "amount"))
                               for item in raw.get("penalties", [])]
    if kind == "ResolveEffectOrder":
        result["effects"] = [fields(item, ("effect_id", "ability_id", "source_instance_id"))
                             for item in raw.get("effects", [])]
    if kind == "ResolveChoice":
        result["constraints"] = [{"maximum": item["maximum"],
                                  "filter": fields(item.get("filter", {}), FILTER_FIELDS)}
                                 for item in raw.get("constraints", [])]
    return result


INSTANCE_FIELDS = {"instance_id", "source_instance_id", "target_instance_id", "hero_instance_id", "weapon_instance_id"}
INSTANCE_LISTS = {"instance_ids", "hero_instance_ids", "target_instance_ids"}
CARD_FIELDS = {"card_id", "source_card_id", "target_card_id"}


def collect_references(value, add_instance, add_card, add_ability):
    """Only call this on an already allowlisted command/choice."""
    if isinstance(value, list):
        for item in value:
            collect_references(item, add_instance, add_card, add_ability)
    elif isinstance(value, dict):
        for key, item in value.items():
            if key in INSTANCE_FIELDS and isinstance(item, str):
                add_instance(item)
            elif key in INSTANCE_LISTS and isinstance(item, list):
                for instance in item:
                    add_instance(instance)
            elif key in CARD_FIELDS and isinstance(item, str):
                add_card(item)
            elif key == "card_ids" and isinstance(item, list):
                for card in item:
                    add_card(card)
            elif key == "ability_id" and isinstance(item, str):
                add_ability(item)
            elif key == "ability_ids" and isinstance(item, list):
                for ability in item:
                    add_ability(ability)
            else:
                collect_references(item, add_instance, add_card, add_ability)


EVENT_FIELDS = {
    "TURN_STARTED": ("player_id",), "TURN_ENDED": ("player_id",),
    "turn_passed": ("from_player_id", "to_player_id", "turn_number"),
    "ACTION_ENTERED": ("player_id", "action"), "ACTION_EXITED": ("player_id", "action"),
    "village_abilities_started": ("player_id",), "village_abilities_finished": ("player_id",),
    "village_gold_counted": ("player_id", "total"), "village_upgrade_started": ("player_id",),
    "triumph_gold_counted": ("player_id", "total"),
    "card_bought": ("player_id", "card_id", "price", "gold_remaining"),
    "effect_card_gained": ("player_id", "card_id", "source", "destination"),
    "effect_purchase_completed": ("player_id", "card_id", "source", "destination"),
    "hero_upgraded": ("player_id", "source_card_id", "target_card_id", "xp_cost"),
    "ability_activated": ("player_id", "reused"), "spell_used": ("player_id", "card_id"),
    "weapon_equipped": ("player_id",), "battle_team_submitted": ("player_id",),
    "battle_team_revision_required": ("player_id",),
    "rest_card_destroyed": ("player_id", "card_id"),
    "card_destroyed": ("card_id", "hall_zone", "rank"),
    "destruction_returned_to_supply": ("card_id",),
    "card_destruction_replaced": ("card_id", "source", "destination"),
    "cards_drawn": ("player_id",), "turn_hand_discarded": ("player_id",),
    "player_deck_shuffled": ("player_id",),
    "dungeon_hand_revealed": ("player_id",), "cards_shown": ("player_id",),
    "battle_target_declared": ("player_id", "rank"),
    "battle_resolved": ("player_id", "hall_zone", "target_card_id", "rank", "health", "outcome"),
    "monster_defeated": ("player_id", "xp_gained", "hall_zone", "rank", "hall_rank_count"),
    "monster_returned_to_deck": ("deck_zone", "hall_zone", "rank", "position", "hall_rank_count"),
    "thunderstone_returned_to_deck": ("deck_zone", "hall_zone", "rank", "hall_rank_count"),
    "effect_hall_relocated": ("player_id", "card_id", "hall_zone", "rank", "destination", "defeat", "hall_rank_count"),
    "hall_cards_swapped": ("hall_zone", "first_rank", "second_rank"), "hall_card_repositioned": ("hall_zone", "from_rank", "rank"),
    "thunderstone_acquired": ("player_id", "hall_zone", "rank", "hall_rank_count"), "treasure_claimed": ("player_id", "hall_zone", "origin", "hall_rank_count"),
    "hall_card_entered": ("rank", "hall_zone", "hall_rank_count"), "guardian_entered_rank_0": ("hall_zone", "hall_rank_count"),
    "trap_revealed": ("hall_zone", "origin", "rank", "hall_rank_count"),
    "trap_activated": ("player_id", "hall_zone"), "trap_removed": ("hall_zone", "rank", "hall_rank_count"),
    "disease_gain_started": ("player_id", "gain_id", "destination", "card_id", "source_card_id", "source_hall_zone", "source_rank"),
    "disease_gain_completed": ("player_id", "gain_id", "destination", "card_id"),
    "disease_redirected": ("from_player_id", "to_player_id", "gain_id", "card_id"),
    "disease_gain_destroyed": ("gain_id", "card_id"),
    "player_eliminated": ("player_id",), "game_end_triggered": (), "game_scored": (),
}
PUBLIC_INSTANCE_EVENTS = {"battle_target_declared": "target_instance_id", "monster_defeated": "target_instance_id",
                          "monster_returned_to_deck": "target_instance_id",
                          "ability_activated": "source_instance_id",
                          **{kind: "instance_id" for kind in ("thunderstone_acquired", "thunderstone_returned_to_deck", "treasure_claimed",
                             "hall_card_entered", "guardian_entered_rank_0", "trap_revealed", "trap_activated", "trap_removed", "disease_gain_started",
                             "disease_gain_completed", "disease_redirected", "disease_gain_destroyed")}}


def event_view(events, instances, add_card):
    summaries = []
    disease_removals = {raw.get("instance_id") for raw in events if raw.get("kind") == "disease_gain_destroyed" and raw.get("instance_id")}
    for raw in events:
        kind = raw.get("kind")
        if kind not in EVENT_FIELDS:
            continue
        row = {"kind": kind, **fields(raw, ("sequence", *EVENT_FIELDS[kind]))}
        if kind in {"card_destroyed", "destruction_returned_to_supply", "card_destruction_replaced"}:
            # A small semantic enum, never an interpreter ability/reason string.
            row["cause"] = "disease_gain" if raw.get("instance_id") in disease_removals else (
                raw.get("reason") if raw.get("reason") in {"hero_upgrade", "after_battle", "trap_resolved"} else "effect")
        if kind in {"disease_gain_started", "disease_gain_completed", "effect_card_gained", "effect_purchase_completed"} and isinstance(row.get("destination"), str):
            row["destination"] = row["destination"].rsplit(":", 1)[-1]
        # Destruction is public: name the destroyed card and its former player,
        # without copying private instance records or the engine's zone data.
        if kind in {"card_destroyed", "destruction_returned_to_supply", "card_destruction_replaced"} and str(raw.get("source", "")).startswith("player:"):
            row["player_id"] = raw["source"].split(":")[1]
        if kind == "card_destroyed" and str(raw.get("source", "")).startswith(("basic_supply:", "hero_supply:", "village_supply:")):
            row["source_supply"] = raw["source"]
        if kind == "card_destruction_replaced":
            for key in ("source", "destination"):
                if isinstance(row.get(key), str):
                    row[key] = row[key].rsplit(":", 1)[-1]
        reference = PUBLIC_INSTANCE_EVENTS.get(kind)
        if reference and raw.get(reference) in instances:
            row["card_id"] = instances[raw[reference]]["card_id"]
        if kind in {"cards_drawn", "turn_hand_discarded"}:
            row["count"] = len(raw.get("instance_ids", []))
        if kind in {"cards_shown", "dungeon_hand_revealed"}:
            row["card_ids"] = [instances[item]["card_id"] for item in raw.get("instance_ids", []) if item in instances]
        if kind == "weapon_equipped":
            row["card_ids"] = [instances[raw[key]]["card_id"] for key in ("hero_instance_id", "weapon_instance_id")
                               if raw.get(key) in instances]
        if kind == "battle_resolved":
            row["calculation"] = fields(raw.get("calculation", {}),
                                        ("attack", "magic_attack", "light", "effective_attack", "darkness_penalty"))
            # Visible card definitions only; never expose private instance IDs or flags.
            row["participants"] = [{"card_id": item["card_id"]} for item in
                                   raw.get("calculation", {}).get("components", []) if item.get("card_id")]
        summaries.append(row)
    # History is public information, but never exposes the instance identity of
    # a card that later re-enters a hidden pile or the order produced by a shuffle.
    # Keep complete committed chains, including long reveal/search effects.
    for row in summaries:
        collect_references(row, lambda _: None, add_card, lambda _: None)
    return summaries


def result_view(state):
    raw = state.get("result")
    if not raw:
        return None
    return {"players": {pid: {**fields(values, ("victory_points", "thunderstones", "card_victory_points", "experience_points")),
                              "eliminated": bool(state.get("players", {}).get(pid, {}).get("eliminated"))}
                         for pid, values in raw.get("players", {}).items() if pid in state.get("players", {})},
            "winner_ids": [pid for pid in raw.get("winner_ids", []) if pid in state.get("players", {})],
            "tie_break": raw.get("tie_break") if raw.get("tie_break") == "thunderstone" else None}
