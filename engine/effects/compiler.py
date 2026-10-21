"""Compile a small, reviewed JSON ruleset; never execute the draft AST."""

from __future__ import annotations

import json
import hashlib
from dataclasses import dataclass
from pathlib import Path

from engine.paths import PROJECT_ROOT
from engine.effects.mechanics import Mechanic, compile_mechanics
from engine.effects.mechanics import FILTER_KEYS, validate_filter


SCHEMA_VERSION = "thunderstone.effects/1"
MAX_DEPTH = 16
MAX_NODES = 128
QUERY_ZONES = {"active_hand", "subject_hand", "active_discard", "subject_discard",
               "village_supply_top", "hero_supply_top", "hall", "bound", "event_source", "active_control", "event_supply_top", "active_hand_or_village_top", "defeated_monster"}
QUERY_ZONES |= {"other_hand", "other_discard", "subject_control", "other_control"}
QUERY_ZONES |= {"event_hero"}
QUERY_ZONES |= {"defeated_this_turn"}
QUERY_ZONES |= {"all_discard", "all_hand", "reveal_zone", "collection"}
ATOM_OPS = {"draw", "destroy", "discard", "gain_xp", "spend_xp",
            "mod_gold", "mod_attack", "mod_magic_attack", "mod_light",
            "gain_card", "grant_buy", "mod_card", "gain_disease", "lose_xp",
            "set_battle_flag"}
ATOM_OPS |= {"mark_destroy", "exclude_combat"}
ATOM_OPS |= {"move", "destroy_supply", "random_discard", "mod_next_hand", "force_dungeon", "mod_next_gold"}
ATOM_OPS |= {"reveal_cycle"}
ATOM_OPS |= {"relocate_hall"}
FLOW_OPS = {"sequence", "if", "select", "cost_gate", "for_each",
            "repeat", "schedule", "for_players", "let"}
FLOW_OPS |= {"reveal"}
FLOW_OPS |= {"buy"}
FLOW_OPS |= {"choose_value", "reorder", "remember", "upgrade"}
ATOM_OPS |= {"show", "show_hand"}
ATOM_OPS |= {"set_retreat_position"}
ATOM_OPS |= {"grant_turn_buff"}
ATOM_OPS |= {"destroy_matching_supply", "destroy_purchased_supply", "destroy_basic_supply", "random_destroy", "convert_card_magic"}
ATOM_OPS |= {"swap_hall", "exchange_hall", "shuffle_hall_top", "mod_monster_health", "collect", "clear_collection", "add_global_rule", "grant_extra_turn", "shuffle_destroyed_traps"}
ATOM_OPS |= {"grant_basic_buy"}
ATOM_OPS |= {"attach_card", "release_attachment"}
ATOM_OPS |= {"borrow_card", "redistribute_discards", "equip_from_supply"}
ATOM_OPS |= {"remove_listener"}
ATOM_OPS |= {"copy_hero"}
FLOW_OPS |= {"listen"}
FLOW_OPS |= {"reuse_ability"}
ALLOWED_EVENTS = {"ACTION_EXITED", "TURN_WILL_END", "DUNGEON_ENTER",
                  "BATTLE_BEFORE_OUTCOME", "BATTLE_AFTER_OUTCOME", "MONSTER_DEFEATED",
                  "TURN_START", "VILLAGE_ENTER", "CARD_PURCHASED", "HERO_UPGRADED"}
ALLOWED_EVENTS |= {"HALL_REVEALED", "BREACH", "TRAP_REVEALED", "HAND_REFILL_COMPLETE"}
ALLOWED_EVENTS |= {"CARD_EQUIPPED"}
ALLOWED_EVENTS |= {"BEFORE_HALL_REFILL"}


class EffectCompileError(ValueError):
    """A reviewed JSON definition is incomplete or unsafe to execute."""


@dataclass(frozen=True)
class Ability:
    id: str
    source_card_id: str
    kind: str
    source_zone: str
    usage: str
    actions: tuple[str, ...]
    event: str | None
    conditions: tuple[dict, ...]
    body: dict


@dataclass(frozen=True)
class EffectsRuleset:
    schema_version: str
    version: str
    abilities: tuple[Ability, ...]
    mechanics: tuple[Mechanic, ...] = ()

    def by_id(self, ability_id: str) -> Ability | None:
        return next((item for item in self.abilities if item.id == ability_id), None)


def _keys(value: object, required: set[str], optional: set[str], place: str) -> dict:
    if not isinstance(value, dict) or not required <= value.keys() or (
            value.keys() - required - optional):
        raise EffectCompileError(f"{place}: invalid or missing keys")
    return value


def _integer(value: object, place: str, *, minimum: int = -10000,
             maximum: int = 10000) -> None:
    if (not isinstance(value, int) or isinstance(value, bool)
            or not minimum <= value <= maximum):
        raise EffectCompileError(f"{place}: expected bounded integer")


def _string(value: object, place: str) -> None:
    if not isinstance(value, str) or not value:
        raise EffectCompileError(f"{place}: expected nonempty string")


def _query(query: object, place: str) -> None:
    item = _keys(query, {"zone"}, FILTER_KEYS | {"max_by", "min_by", "exclude_source", "var", "exclude_pile_var", "compare_stat", "collection"}, place)
    if "collection" in item:
        _string(item["collection"], place)
    if "compare_stat" in item:
        comparison = _keys(item["compare_stat"], {"field", "op", "value"}, set(), place)
        if comparison["field"] not in ("vp", "cost", "health", "level", "strength", "weight") or comparison["op"] not in ("le", "lt", "eq", "ge", "gt"):
            raise EffectCompileError(f"{place}: invalid stat comparison")
        _expr(comparison["value"], place)
    if item["zone"] not in QUERY_ZONES:
        raise EffectCompileError(f"{place}: unsupported query zone")
    try:
        validate_filter({key: value for key, value in item.items() if key in FILTER_KEYS})
    except ValueError as error:
        raise EffectCompileError(f"{place}: {error}") from error
    if "min_by" in item and "max_by" in item:
        raise EffectCompileError(f"{place}: ambiguous extremum query")
    if "exclude_source" in item and not isinstance(item["exclude_source"], bool):
        raise EffectCompileError(f"{place}: expected boolean")
    if "exclude_pile_var" in item:
        _string(item["exclude_pile_var"], place)
    for key in ("card_id", "card_type", "subcategory", "tag"):
        if key in item:
            _string(item[key], f"{place}.{key}")
    if item["zone"] == "bound":
        _string(item.get("var"), f"{place}.var")
    for key in ("max_by", "min_by"):
        if key in item and item[key] not in ("purchase_cost", "strength", "weight", "attack", "level", "gold", "pile_size"):
            raise EffectCompileError(f"{place}: unsupported extremum selector")


def _expr(value: object, place: str, depth: int = 0) -> None:
    if depth > MAX_DEPTH:
        raise EffectCompileError(f"{place}: expression too deep")
    if isinstance(value, int) and not isinstance(value, bool):
        _integer(value, place)
        return
    item = _keys(value, set(), {"count", "add", "mul", "sub", "div", "min", "max",
                               "sum", "maximum", "resource", "players", "stat", "value", "context", "combat"}, place)
    if len(item) != 1:
        raise EffectCompileError(f"{place}: expression needs one operator")
    op, operand = next(iter(item.items()))
    if op == "count":
        _query(operand, f"{place}.count")
    elif op in ("sum", "maximum"):
        _keys(operand, {"query", "field"}, set(), place)
        _query(operand["query"], f"{place}.query")
        if operand["field"] not in ("attack", "magic_attack", "light", "strength", "weight", "level", "gold", "vp", "health", "cost", "xp_reward"):
            raise EffectCompileError(f"{place}: invalid stat")
    elif op == "stat":
        _keys(operand, {"var", "field"}, set(), place)
        _string(operand["var"], place)
        if operand["field"] not in ("attack", "magic_attack", "light", "strength", "weight", "level", "gold", "vp", "health", "cost", "xp_reward"):
            raise EffectCompileError(f"{place}: invalid stat")
    elif op == "resource":
        if operand not in ("xp", "temporary_gold"):
            raise EffectCompileError(f"{place}: invalid resource")
    elif op == "context":
        if operand not in ("rank", "price"):
            raise EffectCompileError(f"{place}: unsupported event value")
    elif op == "players":
        if operand not in ("all", "others"):
            raise EffectCompileError(f"{place}: invalid player scope")
    elif op == "combat":
        if operand not in ("attack", "magic_attack", "light"):
            raise EffectCompileError(f"{place}: invalid combat value")
    elif op == "value":
        _string(operand, place)
    else:
        if not isinstance(operand, list) or len(operand) != 2:
            raise EffectCompileError(f"{place}.{op}: expected two operands")
        for index, part in enumerate(operand):
            _expr(part, f"{place}.{op}[{index}]", depth + 1)


def _condition(value: object, place: str, depth: int = 0) -> None:
    if depth > MAX_DEPTH:
        raise EffectCompileError(f"{place}: condition too deep")
    item = _keys(value, set(), {"all", "any", "not", "exists", "compare",
                                "action_in", "setting_active", "choice_is", "subject_is_active"}, place)
    if len(item) != 1:
        raise EffectCompileError(f"{place}: condition needs one operator")
    op, operand = next(iter(item.items()))
    if op in ("all", "any"):
        if not isinstance(operand, list) or not operand:
            raise EffectCompileError(f"{place}.{op}: expected nonempty list")
        for index, child in enumerate(operand):
            _condition(child, f"{place}.{op}[{index}]", depth + 1)
    elif op == "not":
        _condition(operand, f"{place}.not", depth + 1)
    elif op == "exists":
        _query(operand, f"{place}.exists")
    elif op == "compare":
        rule = _keys(operand, {"left", "op", "right"}, set(), f"{place}.compare")
        if rule["op"] not in ("eq", "ne", "lt", "le", "gt", "ge"):
            raise EffectCompileError(f"{place}: invalid comparison")
        _expr(rule["left"], f"{place}.left")
        _expr(rule["right"], f"{place}.right")
    elif op == "action_in":
        if (not isinstance(operand, list) or not operand
                or any(action not in ("village", "dungeon", "rest")
                       for action in operand)):
            raise EffectCompileError(f"{place}: invalid action list")
    elif op == "choice_is":
        _keys(operand, {"var", "option"}, set(), place)
        _string(operand["var"], place)
        _string(operand["option"], place)
    elif op == "subject_is_active":
        if not isinstance(operand, bool):
            raise EffectCompileError(f"{place}: expected boolean")
    else:
        _string(operand, place)


def _target(value: object, place: str) -> None:
    item = _keys(value, {"var"}, set(), place)
    _string(item["var"], place)


def _node(value: object, place: str, counter: list[int], depth: int = 0) -> None:
    counter[0] += 1
    if counter[0] > MAX_NODES or depth > MAX_DEPTH:
        raise EffectCompileError(f"{place}: effect tree exceeds safety bounds")
    node = _keys(value, {"op"}, {"children", "condition", "then", "else",
                                 "query", "bind", "min", "max", "cost",
                                 "body", "times", "limit", "event", "target",
                                 "count", "amount", "card_id", "destination", "scope",
                             "stat", "flag", "value", "allow_shortfall", "when", "until", "from_bottom", "filter", "goal", "defeat", "payment", "kind", "options", "as_subject", "zone", "highest_by", "constraints", "buff", "family", "other", "collection", "as_owner", "recipient", "conditions", "once", "maximum_cost", "anchor", "destroy_anchor", "equipper", "return_destroyed", "preserve_attack", "full_card"}, place)
    op = node["op"]
    if op not in FLOW_OPS | ATOM_OPS:
        raise EffectCompileError(f"{place}: unsupported operation {op}")
    if op == "sequence":
        _keys(node, {"op", "children"}, set(), place)
        if not isinstance(node["children"], list):
            raise EffectCompileError(f"{place}: children must be a list")
        for index, child in enumerate(node["children"]):
            _node(child, f"{place}.children[{index}]", counter, depth + 1)
    elif op == "if":
        _keys(node, {"op", "condition", "then"}, {"else"}, place)
        _condition(node["condition"], f"{place}.condition")
        _node(node["then"], f"{place}.then", counter, depth + 1)
        if "else" in node:
            _node(node["else"], f"{place}.else", counter, depth + 1)
    elif op in ("select", "for_each"):
        required = {"op", "query", "bind", "then"} if op == "select" else {
            "op", "query", "bind", "body"}
        _keys(node, required, {"min", "max", "allow_shortfall", "highest_by", "constraints"} if op == "select" else set(), place)
        _query(node["query"], f"{place}.query")
        _string(node["bind"], f"{place}.bind")
        if node["bind"].startswith("_") or node["bind"] == "source":
            raise EffectCompileError(f"{place}: source is a reserved binding")
        if op == "select":
            _expr(node.get("min", 1), place)
            _expr(node.get("max", 1), place)
            if not isinstance(node.get("allow_shortfall", False), bool):
                raise EffectCompileError(f"{place}: invalid shortfall flag")
            if isinstance(node.get("min", 1), int) and isinstance(node.get("max", 1), int) and node.get("min", 1) > node.get("max", 1):
                raise EffectCompileError(f"{place}: invalid choice bounds")
            if "highest_by" in node and node["highest_by"] not in ("strength", "weight", "level", "attack"):
                raise EffectCompileError(f"{place}: invalid selection ranking")
            if "constraints" in node:
                if not isinstance(node["constraints"], list) or len(node["constraints"]) > 1:
                    raise EffectCompileError(f"{place}: invalid selection constraints")
                for constraint in node["constraints"]:
                    _keys(constraint, {"filter", "maximum"}, set(), place)
                    try:
                        validate_filter(constraint["filter"])
                    except ValueError as error:
                        raise EffectCompileError(str(error)) from error
                    _integer(constraint["maximum"], place, minimum=0, maximum=100)
            _node(node["then"], f"{place}.then", counter, depth + 1)
        else:
            _node(node["body"], f"{place}.body", counter, depth + 1)
    elif op == "remember":
        _keys(node, {"op", "query", "bind", "then"}, set(), place)
        _query(node["query"], place)
        _string(node["bind"], place)
        if node["bind"] == "source" or node["bind"].startswith("_"):
            raise EffectCompileError(f"{place}: reserved binding")
        _node(node["then"], place, counter, depth + 1)
    elif op == "choose_value":
        kind = node.get("kind")
        extras = ({"min", "max"} if kind == "number" else {"scope", "as_subject"}
                  if kind == "player" else {"options"} if kind == "enum" else set())
        _keys(node, {"op", "kind", "bind", "then"}, extras, place)
        if kind not in ("number", "player", "enum", "dungeon"):
            raise EffectCompileError(f"{place}: invalid value choice kind")
        _string(node["bind"], place)
        if node["bind"] == "source" or node["bind"].startswith("_"):
            raise EffectCompileError(f"{place}: reserved binding")
        if kind == "number":
            _expr(node.get("min", 0), place)
            _expr(node.get("max", 0), place)
        elif kind == "player":
            if node.get("scope", "all") not in ("all", "others") or not isinstance(node.get("as_subject", False), bool):
                raise EffectCompileError(f"{place}: invalid player choice")
        elif kind == "enum":
            values = node.get("options")
            if (not isinstance(values, list) or not 1 <= len(values) <= 20
                    or any(not isinstance(item, str) or not item for item in values)
                    or len(set(values)) != len(values)):
                raise EffectCompileError(f"{place}: invalid enum choices")
        _node(node["then"], f"{place}.then", counter, depth + 1)
    elif op == "reorder":
        _keys(node, {"op", "query", "destination"}, set(), place)
        _query(node["query"], place)
        if node["destination"] not in ("draw_top", "dungeon_top"):
            raise EffectCompileError(f"{place}: invalid reorder destination")
    elif op == "cost_gate":
        _keys(node, {"op", "cost", "then"}, set(), place)
        if not isinstance(node["cost"], dict) or node["cost"].get("op") not in (
                "destroy", "discard", "spend_xp"):
            raise EffectCompileError(f"{place}: cost must be payable atom")
        _node(node["cost"], f"{place}.cost", counter, depth + 1)
        _node(node["then"], f"{place}.then", counter, depth + 1)
    elif op == "for_players":
        _keys(node, {"op", "scope", "body"}, set(), place)
        if node["scope"] not in ("all", "others", "active"):
            raise EffectCompileError(f"{place}: unsupported player scope")
        _node(node["body"], f"{place}.body", counter, depth + 1)
    elif op == "let":
        _keys(node, {"op", "bind", "value", "then"}, set(), place)
        _string(node["bind"], place)
        if node["bind"] == "source" or node["bind"].startswith("_"):
            raise EffectCompileError(f"{place}: reserved binding")
        _expr(node["value"], place)
        _node(node["then"], f"{place}.then", counter, depth + 1)
    elif op == "repeat":
        _keys(node, {"op", "times", "limit", "body"}, set(), place)
        _expr(node["times"], f"{place}.times")
        _integer(node["limit"], f"{place}.limit", minimum=1, maximum=100)
        _node(node["body"], f"{place}.body", counter, depth + 1)
    elif op == "schedule":
        _keys(node, {"op", "event", "body"}, set(), place)
        if node["event"] not in ("TURN_WILL_END", "TURN_START", "HAND_REFILL_COMPLETE", "BATTLE_AFTER_OUTCOME", "BEFORE_HALL_REFILL"):
            raise EffectCompileError(f"{place}: unsupported scheduled event")
        _node(node["body"], f"{place}.body", counter, depth + 1)
    elif op == "reveal":
        _keys(node, {"op", "count", "bind", "then"}, {"until", "from_bottom", "zone"}, place)
        if node.get("zone", "subject_draw") not in ("subject_draw", "dungeon"):
            raise EffectCompileError(f"{place}: invalid reveal zone")
        _expr(node["count"], place)
        _string(node["bind"], place)
        if node["bind"] == "source" or node["bind"].startswith("_"):
            raise EffectCompileError(f"{place}: reserved binding")
        if "until" in node:
            _query({"zone": "bound", "var": node["bind"], **node["until"]}, place)
        if "from_bottom" in node and not isinstance(node["from_bottom"], bool):
            raise EffectCompileError(f"{place}: invalid reveal direction")
        _node(node["then"], f"{place}.then", counter, depth + 1)
    elif op == "copy_hero":
        _keys(node, {"op", "target", "other", "preserve_attack"}, {"full_card"}, place)
        _target(node["target"], place)
        _target(node["other"], place)
        if not isinstance(node["preserve_attack"], bool) or not isinstance(node.get("full_card", False), bool):
            raise EffectCompileError(f"{place}: invalid copy attack policy")
    elif op == "reuse_ability":
        _keys(node, {"op", "target"}, set(), place)
        _target(node["target"], place)
    elif op == "redistribute_discards":
        _keys(node, {"op", "query"}, set(), place)
        _query(node["query"], place)
    elif op == "borrow_card":
        _keys(node, {"op", "target", "when", "return_destroyed"}, {"equipper"}, place)
        _target(node["target"], place)
        if "equipper" in node:
            _target(node["equipper"], place)
        if node["when"] not in ("after_battle", "turn_end") or not isinstance(node["return_destroyed"], bool):
            raise EffectCompileError(f"{place}: invalid borrowing contract")
    elif op == "equip_from_supply":
        _keys(node, {"op", "target", "equipper"}, set(), place)
        _target(node["target"], place)
        _target(node["equipper"], place)
    elif op == "attach_card":
        from engine.effects.attachments import KINDS
        _keys(node, {"op", "target", "anchor", "kind"}, set(), place)
        _target(node["target"], place)
        _target(node["anchor"], place)
        if node["kind"] not in KINDS:
            raise EffectCompileError(f"{place}: invalid attachment kind")
    elif op == "release_attachment":
        _keys(node, {"op", "target"}, {"recipient", "destroy_anchor"}, place)
        _target(node["target"], place)
        if node.get("recipient", "owner") not in ("owner", "active") or not isinstance(node.get("destroy_anchor", True), bool):
            raise EffectCompileError(f"{place}: invalid attachment release")
    elif op == "listen":
        _keys(node, {"op", "event", "body"}, {"conditions", "once"}, place)
        if node["event"] not in ALLOWED_EVENTS or not isinstance(node.get("once", False), bool):
            raise EffectCompileError(f"{place}: invalid listener")
        for condition in node.get("conditions", []):
            _condition(condition, place)
        _node(node["body"], place, counter, depth + 1)
    elif op in ("swap_hall", "exchange_hall"):
        _keys(node, {"op", "target", "other"}, set(), place)
        _target(node["target"], place)
        _target(node["other"], place)
    elif op == "shuffle_hall_top":
        _keys(node, {"op", "target", "count"}, set(), place)
        _target(node["target"], place)
        _integer(node["count"], place, minimum=0, maximum=100)
    elif op == "mod_monster_health":
        _keys(node, {"op", "target", "amount"}, set(), place)
        _target(node["target"], place)
        _expr(node["amount"], place)
    elif op in ("collect", "clear_collection"):
        _keys(node, {"op", "collection"} | ({"query"} if op == "collect" else set()), set(), place)
        _string(node["collection"], place)
        if op == "collect":
            _query(node["query"], place)
    elif op == "add_global_rule":
        _keys(node, {"op", "kind", "until", "scope", "amount"}, set(), place)
        if node["kind"] not in ("light", "force_dungeon") or node["until"] not in ("owner_next_turn_start", "owner_next_turn_end") or node["scope"] not in ("all", "others"):
            raise EffectCompileError(f"{place}: invalid global rule")
        _integer(node["amount"], place, minimum=0, maximum=10)
    elif op in ("grant_extra_turn", "shuffle_destroyed_traps", "grant_basic_buy", "remove_listener"):
        _keys(node, {"op"}, set(), place)
    elif op == "destroy_matching_supply":
        _keys(node, {"op", "target", "count"}, {"family", "from_bottom"}, place)
        _target(node["target"], place)
        _expr(node["count"], place)
        if any(not isinstance(node[key], bool) for key in ("family", "from_bottom") if key in node):
            raise EffectCompileError(f"{place}: invalid supply flags")
    elif op == "destroy_purchased_supply":
        _keys(node, {"op"}, set(), place)
    elif op == "destroy_basic_supply":
        _keys(node, {"op", "card_id", "count"}, set(), place)
        _string(node["card_id"], place)
        _expr(node["count"], place)
    elif op == "random_destroy":
        _keys(node, {"op", "filter"}, set(), place)
        validate_filter(node["filter"])
    elif op == "convert_card_magic":
        _keys(node, {"op", "target"}, set(), place)
        _target(node["target"], place)
    elif op == "grant_turn_buff":
        from engine.effects.status import TURN_BUFFS
        _keys(node, {"op", "target", "buff"}, set(), place)
        _keys(node["target"], {"var"}, set(), place)
        _string(node["target"]["var"], place)
        if not isinstance(node["buff"], str) or node["buff"] not in TURN_BUFFS:
            raise EffectCompileError(f"{place}: unsupported turn buff")
    elif op in ("destroy", "discard", "mark_destroy", "exclude_combat", "show"):
        _keys(node, {"op", "target"}, ({"when", "as_owner"} if op == "mark_destroy" else {"as_owner"}), place)
        if "as_owner" in node and not isinstance(node["as_owner"], bool):
            raise EffectCompileError(f"{place}: invalid owner scope")
        _target(node["target"], f"{place}.target")
        if op == "mark_destroy" and node.get("when", "after_battle") not in ("after_battle", "turn_end"):
            raise EffectCompileError(f"{place}: invalid deferred destruction timing")
    elif op in ("draw", "gain_xp", "spend_xp", "lose_xp", "gain_disease", "mod_gold", "grant_buy",
                "mod_attack", "mod_magic_attack", "mod_light", "random_discard", "mod_next_hand", "mod_next_gold", "set_retreat_position"):
        field = "count" if op in ("draw", "gain_disease", "random_discard") else "amount"
        _keys(node, {"op", field}, {"bind", "then"} if op == "draw" else set(), place)
        _expr(node[field], f"{place}.{field}")
        if op == "draw" and ("bind" in node or "then" in node):
            _keys(node, {"op", field, "bind", "then"}, set(), place)
            _string(node["bind"], place)
            if node["bind"] == "source" or node["bind"].startswith("_"):
                raise EffectCompileError(f"{place}: reserved binding")
            _node(node["then"], f"{place}.then", counter, depth + 1)
    elif op == "force_dungeon":
        _keys(node, {"op"}, set(), place)
    elif op == "show_hand":
        _keys(node, {"op"}, set(), place)
    elif op == "buy":
        _keys(node, {"op", "filter", "destination"}, {"payment", "maximum_cost"}, place)
        if "maximum_cost" in node:
            _expr(node["maximum_cost"], place)
        try:
            validate_filter(node["filter"])
        except ValueError as error:
            raise EffectCompileError(str(error)) from error
        if node["destination"] not in ("hand", "discard") or node.get("payment", "none") not in ("none", "discard_source", "destroy_source"):
            raise EffectCompileError(f"{place}: invalid effect purchase")
    elif op == "upgrade":
        _keys(node, {"op", "destination"}, {"payment"}, place)
        if node["destination"] not in ("hand", "discard") or node.get("payment", "none") not in ("none", "discard_source"):
            raise EffectCompileError(f"{place}: invalid effect upgrade")
    elif op == "reveal_cycle":
        _keys(node, {"op", "filter", "goal"}, set(), place)
        try:
            validate_filter(node["filter"])
        except ValueError as error:
            raise EffectCompileError(str(error)) from error
        _integer(node["goal"], place, minimum=1, maximum=10)
    elif op == "move":
        _keys(node, {"op", "target", "destination"}, {"recipient"}, place)
        if "recipient" in node and node["recipient"] not in ("active", "subject", "owner"):
            _target(node["recipient"], place)
        _target(node["target"], place)
        if node["destination"] not in ("hand", "discard", "draw_top", "refill_add", "control"):
            raise EffectCompileError(f"{place}: invalid move destination")
    elif op == "relocate_hall":
        _keys(node, {"op", "target", "destination"}, {"defeat"}, place)
        _target(node["target"], place)
        if node["destination"] not in ("dungeon_bottom", "discard", "rank3"):
            raise EffectCompileError(f"{place}: invalid hall destination")
        if "defeat" in node and (not isinstance(node["defeat"], bool) or node["destination"] != "discard"):
            raise EffectCompileError(f"{place}: invalid direct defeat")
    elif op == "destroy_supply":
        _keys(node, {"op", "target", "count"}, {"from_bottom"}, place)
        _target(node["target"], place)
        _expr(node["count"], place)
        if "from_bottom" in node and not isinstance(node["from_bottom"], bool):
            raise EffectCompileError(f"{place}: invalid supply direction")
    elif op == "mod_card":
        _keys(node, {"op", "target", "stat", "amount"}, set(), place)
        _target(node["target"], place)
        if node["stat"] not in ("attack", "magic_attack", "strength", "light"):
            raise EffectCompileError(f"{place}: invalid modified stat")
        _expr(node["amount"], place)
    elif op == "set_battle_flag":
        _keys(node, {"op", "flag", "value"}, set(), place)
        if node["flag"] not in ("zero_weapon_weight", "convert_all_magic", "convert_equipped_magic", "lose_on_battle_loss", "cannot_defeat") or not isinstance(node["value"], bool):
            raise EffectCompileError(f"{place}: invalid battle flag")
    elif op == "gain_card":
        _keys(node, {"op", "card_id"}, {"destination"}, place)
        _string(node["card_id"], f"{place}.card_id")
        if node.get("destination", "discard") not in ("hand", "discard"):
            raise EffectCompileError(f"{place}: invalid card destination")


def _check_references(value: object, bound: frozenset[str], place: str) -> None:
    if isinstance(value, list):
        for item in value:
            _check_references(item, bound, place)
    elif isinstance(value, dict):
        for key in ("var", "exclude_pile_var", "value", "exclude_var", "name_in_var", "same_name_as_var", "adjacent_to_var"):
            if key in value and isinstance(value[key], str) and value[key] not in bound:
                raise EffectCompileError(f"{place}: variable {value[key]} is not bound")
        for item in value.values():
            if isinstance(item, (dict, list)):
                _check_references(item, bound, place)


def _check_bindings(node: dict, bound: frozenset[str], cards: dict,
                    place: str) -> None:
    local = {key: value for key, value in node.items()
             if key not in ("children", "then", "else", "body", "cost")}
    _check_references(local, bound, place)
    op = node["op"]
    if op == "sequence":
        for index, child in enumerate(node["children"]):
            _check_bindings(child, bound, cards, f"{place}.children[{index}]")
    elif op == "if":
        _check_bindings(node["then"], bound, cards, f"{place}.then")
        if "else" in node:
            _check_bindings(node["else"], bound, cards, f"{place}.else")
    elif op in ("select", "for_each", "let", "reveal", "choose_value", "remember") or op == "draw" and "bind" in node:
        child = node["body"] if op == "for_each" else node["then"]
        _check_bindings(child, bound | {node["bind"]}, cards, f"{place}.{op}")
    elif op == "cost_gate":
        _check_bindings(node["cost"], bound, cards, f"{place}.cost")
        _check_bindings(node["then"], bound, cards, f"{place}.then")
    elif op in ("repeat", "schedule", "for_players", "listen"):
        _check_bindings(node["body"], bound, cards, f"{place}.body")
    elif op in ("destroy", "discard", "mod_card", "mark_destroy", "exclude_combat", "move", "destroy_supply", "relocate_hall", "show", "grant_turn_buff") and node["target"]["var"] not in bound:
        raise EffectCompileError(f"{place}: target variable is not bound")
    elif op == "gain_card" and node["card_id"] not in cards:
        raise EffectCompileError(f"{place}: gained card is not in the catalog")


def compile_ruleset(data: object, cards: dict[str, dict[str, str]]) -> EffectsRuleset:
    source = _keys(data, {"schema_version", "abilities"}, {"source_draft", "mechanics"}, "ruleset")
    if source["schema_version"] != SCHEMA_VERSION or not isinstance(source["abilities"], list):
        raise EffectCompileError("unsupported effect ruleset schema")
    compiled = []
    seen = set()
    for index, raw in enumerate(source["abilities"]):
        place = f"abilities[{index}]"
        item = _keys(raw, {"id", "source_card_id", "kind", "source_zone",
                           "usage", "conditions", "body"},
                     {"actions", "event"}, place)
        ability_id, card_id = item["id"], item["source_card_id"]
        if (not isinstance(ability_id, str) or not isinstance(card_id, str)
                or not ability_id.startswith(f"{card_id}-A")
                or ability_id in seen or card_id not in cards
                or cards[card_id]["slot_kind"] != "front"):
            raise EffectCompileError(f"{place}: invalid or duplicate ability source")
        seen.add(ability_id)
        if item["kind"] == "activated":
            if (item["source_zone"] not in ("active_hand", "active_control")
                    or item["usage"] not in ("once_per_turn", "repeatable")
                    or "event" in item or not isinstance(item.get("actions"), list)
                    or not item["actions"] or any(action not in ("village", "dungeon")
                                                    for action in item["actions"])):
                raise EffectCompileError(f"{place}: invalid activation")
        elif item["kind"] == "triggered":
            if (item["source_zone"] not in ("settings", "active_hand", "active_control", "attached", "battle_target", "hall", "event_source")
                    or item["usage"] != "once_per_event"
                    or item.get("event") not in ALLOWED_EVENTS or "actions" in item):
                raise EffectCompileError(f"{place}: invalid trigger")
        else:
            raise EffectCompileError(f"{place}: invalid ability kind")
        if not isinstance(item["conditions"], list):
            raise EffectCompileError(f"{place}: conditions must be a list")
        for condition_index, condition in enumerate(item["conditions"]):
            _condition(condition, f"{place}.conditions[{condition_index}]")
            _check_references(condition, frozenset({"source"}), place)
        _node(item["body"], f"{place}.body", [0])
        _check_bindings(item["body"], frozenset({"source"}), cards,
                        f"{place}.body")
        compiled.append(Ability(ability_id, card_id, item["kind"],
                                item["source_zone"], item["usage"],
                                tuple(item.get("actions", [])), item.get("event"),
                                tuple(item["conditions"]), item["body"]))
    try:
        mechanics = compile_mechanics(source.get("mechanics", []), cards)
    except ValueError as error:
        raise EffectCompileError(str(error)) from error
    if seen & {item.id for item in mechanics}:
        raise EffectCompileError("duplicate ability and mechanic ID")
    canonical = json.dumps(source, ensure_ascii=False, sort_keys=True,
                           separators=(",", ":")).encode("utf-8")
    version = hashlib.sha256(canonical).hexdigest()
    return EffectsRuleset(SCHEMA_VERSION, version, tuple(compiled), mechanics)


def load_ruleset(cards: dict[str, dict[str, str]], root: Path = PROJECT_ROOT) -> EffectsRuleset:
    directory = root / "data" / "effects"
    source = json.loads((directory / "classic-v1.json").read_text(encoding="utf-8"))
    simple = json.loads((directory / "simple-reviewed.json").read_text(encoding="utf-8"))
    if simple.get("schema_version") != source.get("schema_version"):
        raise EffectCompileError("reviewed effect files use different schemas")
    source["abilities"].extend(simple["abilities"])
    for filename in ("action-reviewed.json", "battle-reviewed.json", "event-reviewed.json"):
        action_path = directory / filename
        if action_path.is_file():
            actions = json.loads(action_path.read_text(encoding="utf-8"))
            if actions.get("schema_version") != SCHEMA_VERSION:
                raise EffectCompileError(f"{filename} uses a different schema")
            source["abilities"].extend(actions["abilities"])
    mechanics_path = directory / "mechanics.json"
    if mechanics_path.is_file():
        source["mechanics"] = json.loads(mechanics_path.read_text(encoding="utf-8"))
    return compile_ruleset(source, cards)
