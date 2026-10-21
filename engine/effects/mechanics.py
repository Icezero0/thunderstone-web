"""Validated bindings for continuous rules and rules at dedicated engine hooks."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Mechanic:
    id: str
    source_card_id: str
    source_line: str
    op: str
    params: dict


# All rule parameters are data. Dispatch never resolves a Python name from JSON.
PARAMETERS = {
    "response": {"action", "once_per_turn", "attack"},
    "return_destroyed_to_supply": set(),
    "refill_empty_supply": set(),
    "replace_monster": {"reserve_card_id"},
    "repeat_battle": {"extra"},
    "dungeon_deck_lock": set(),
    "draw_attack": {"amount"},
    "replace_disease": {"action"},
    "rank_bonus": {"minimum", "maximum", "attack", "magic_attack", "light", "scale"},
    "equipment_bonus": {"hero_tag", "hero_card_id", "weapon_tag", "weight_max",
                        "strength_min", "attack", "magic_attack", "light", "strength",
                        "level_scale", "minimum_rank", "target_tags_any"},
    "hand_bonus": {"filter", "metric", "divisor", "minimum", "absent", "flat",
                   "exclude_source", "attack", "magic_attack", "light", "strength"},
    "target_bonus": {"tag", "gives_disease", "minimum_rank", "attack", "magic_attack",
                     "light", "ignore_darkness", "same_family"},
    "excess_light_magic": {"amount"},
    "card_aura": {"filters_any", "attack", "magic_attack", "light"},
    "ignore_darkness": {"minimum_rank", "tag"},
    "double_magic": set(),
    "hero_aura": {"filter", "exclude_source", "equipped", "attack", "magic_attack",
                  "strength", "light"},
    "weapon_aura": {"attack", "magic_attack", "light"},
    "rank_restriction": {"forbidden", "allowed"},
    "target_restriction": {"exclude_tags", "strength_min", "equipped_only", "immune_unarmed", "immune_spells",
                           "immune_weapon_tag", "magic_required", "half_magic",
                           "half_attack_no_magic", "half_attack_no_weapon", "min_heroes",
                           "no_darkness", "forbid_used_spell", "forbid_equipment",
                           "requires_used_spell_or_item", "half_no_element"},
    "target_health": {"filter", "metric", "multiplier", "minimum", "flat",
                      "gold_below_double", "other_tag", "amount", "hall_filter"},
    "hall_target_restriction": {"protected_tag"},
    "hall_movement_lock": set(),
    "hall_aura": {"light", "strength", "health", "rank0_only", "disease_attack",
                  "strength_per_spell", "double_darkness"},
    "light_requirement": {"ranks", "irreducible"},
    "immovable": set(),
    "extra_equipment": {"capacity"},
    "equipment_discount": {"hero_tag", "amount"},
    "disease_strength": {"amount", "single"},
    "economy": {"monster_gold_zero", "hero_discount", "hero_surcharge", "all_surcharge",
                "one_purchase"},
    "scoring": {"group", "maximum", "other_stones", "fewest_monsters_bonus"},
}
FILTER_KEYS = {"tag", "tags_any", "tags_none", "card_id", "card_type",
               "subcategory", "name", "gold_min", "gold_present", "light_min",
               "level_min", "level_max", "magic_min", "exclude_card_id"}
FILTER_KEYS |= {"participating", "unmarked", "strength_min", "strength_max",
                "weight_min", "weight_max", "exclude_card_type", "duplicate_names"}
FILTER_KEYS |= {"cost_present", "vp_present", "gold_max", "vp_min", "vp_max", "equipped", "unused"}
FILTER_KEYS |= {"rank"}
FILTER_KEYS |= {"magic_max"}
FILTER_KEYS |= {"revealed_only"}
FILTER_KEYS |= {"movable"}
FILTER_KEYS |= {"equipper_tags_any"}
FILTER_KEYS |= {"exclude_var", "name_in_var", "in_hand", "equipper_card_id"}
FILTER_KEYS |= {"same_name_as_var", "without_weapon_tag", "semantic_type"}
FILTER_KEYS |= {"adjacent_to_var", "in_selected_dungeon"}
FILTER_KEYS |= {"used", "equipment_space", "same_family_as_event", "in_discard"}


def validate_filter(value: object) -> None:
    if not isinstance(value, dict) or value.keys() - FILTER_KEYS:
        raise ValueError("invalid card filter")
    booleans = {"gold_present", "cost_present", "vp_present", "equipped", "unused",
                "participating", "unmarked", "duplicate_names", "revealed_only", "movable", "in_hand", "in_selected_dungeon", "used", "equipment_space", "same_family_as_event", "in_discard"}
    strings = {"tag", "card_id", "card_type", "subcategory", "name", "exclude_card_id", "exclude_card_type",
               "exclude_var", "name_in_var", "equipper_card_id", "same_name_as_var", "without_weapon_tag", "semantic_type", "adjacent_to_var"}
    for key, item in value.items():
        if key in booleans:
            valid = isinstance(item, bool)
        elif key in strings:
            valid = isinstance(item, str) and bool(item)
        elif key in ("tags_any", "tags_none", "equipper_tags_any"):
            valid = (isinstance(item, list) and all(isinstance(tag, str) and tag for tag in item)
                     and len(item) == len(set(item)))
        else:
            valid = isinstance(item, int) and not isinstance(item, bool) and -100 <= item <= 10000
        if not valid:
            raise ValueError(f"invalid filter value: {key}")


def compile_mechanics(raw: object, cards: dict) -> tuple[Mechanic, ...]:
    if not isinstance(raw, list):
        raise ValueError("mechanics must be a list")
    compiled = []
    seen = set()
    for item in raw:
        if not isinstance(item, dict) or set(item) != {
                "id", "source_card_id", "source_line", "op", "params"}:
            raise ValueError("invalid mechanic keys")
        card_id, ability_id, op = item["source_card_id"], item["id"], item["op"]
        if (not isinstance(card_id, str) or card_id not in cards
                or not isinstance(ability_id, str) or not ability_id.startswith(card_id + "-A")
                or ability_id in seen or op not in PARAMETERS
                or item["source_line"] not in cards[card_id]["effect_text"].splitlines()):
            raise ValueError(f"invalid mechanic source: {ability_id}")
        params = item["params"]
        if not isinstance(params, dict) or params.keys() - PARAMETERS[op]:
            raise ValueError(f"invalid parameters: {ability_id}")
        if op == "replace_disease" and params.get("action") not in ("destroy", "redirect"):
            raise ValueError(f"invalid disease replacement action: {ability_id}")
        if op == "response" and params.get("action") not in ("ignore_trap", "redirect_trap", "redirect_opponent", "ignore_battle", "prevent_destroy"):
            raise ValueError(f"invalid response action: {ability_id}")
        for key, value in params.items():
            if key in ("filter", "hall_filter"):
                validate_filter(value)
            elif key == "filters_any":
                if not isinstance(value, list) or not value:
                    raise ValueError("expected nonempty filter list")
                for predicate in value:
                    validate_filter(predicate)
            elif key == "ranks":
                if (not isinstance(value, dict) or any(
                        not str(rank).isdigit() or not isinstance(amount, int)
                        or not 0 <= amount <= 100 for rank, amount in value.items())):
                    raise ValueError(f"invalid rank values: {ability_id}")
            elif not isinstance(value, (str, int, bool, list)):
                raise ValueError(f"invalid parameter value: {ability_id}.{key}")
            elif isinstance(value, int) and not -100 <= value <= 100:
                raise ValueError(f"mechanic parameter out of bounds: {ability_id}.{key}")
        seen.add(ability_id)
        compiled.append(Mechanic(ability_id, card_id, item["source_line"], op, params))
    return tuple(compiled)
