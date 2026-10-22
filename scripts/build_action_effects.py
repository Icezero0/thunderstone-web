"""Reviewed action bindings with frozen behavioral scenarios for each card."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ABILITIES = []
CASES = []


def seq(*children):
    return {"op": "sequence", "children": list(children)}


def atom(op, value=1):
    return {"op": op, "count" if op in ("draw", "gain_disease", "random_discard") else "amount": value}


def select(query, then, *, bind="chosen", minimum=1, maximum=1):
    return {"op": "select", "query": query, "bind": bind,
            "min": minimum, "max": maximum, "then": then}


def target(op, var="chosen"):
    return {"op": op, "target": {"var": var}}


def mod(field, amount, var="chosen"):
    return {"op": "mod_card", "target": {"var": var}, "stat": field, "amount": amount}


def each(query, body, bind="chosen"):
    return {"op": "for_each", "query": query, "bind": bind, "body": body}


def cost(query, benefit, *, remove="destroy"):
    return select(query, {"op": "cost_gate", "cost": target(remove), "then": benefit})


def add(ability_id, actions, body, *, hand=(), xp=0, expected=None, conditions=(), repeatable=False,
        draw=(), others=None, zone="active_hand", discard=(), choices=(), hall=(), equipment=None, supplies=()):
    ABILITIES.append({"id": ability_id, "source_card_id": ability_id.split("-A")[0],
                      "kind": "activated", "source_zone": zone, "actions": list(actions),
                      "usage": "repeatable" if repeatable else "once_per_turn",
                      "conditions": list(conditions), "body": body})
    CASES.append({"ability_id": ability_id, "actions": list(actions), "hand": list(hand),
                  "xp": xp, "draw": list(draw), "discard": list(discard), "others": others, "zone": zone,
                  "choices": list(choices), "hall": list(hall), "equipment": equipment, "supplies": list(supplies), "expected": expected or {}})


V = ("village",)
D = ("dungeon",)
VD = ("village", "dungeon")
HEROES = {"zone": "active_hand", "tag": "英雄"}
MILITIA = {"zone": "active_hand", "card_id": "TS-0001"}
DISEASE = {"zone": "active_hand", "tag": "疾病"}
MONSTERS = {"zone": "active_hand", "tag": "怪物"}
SPELLS = {"zone": "active_hand", "tag": "法术"}
LIGHT_ITEMS = {"zone": "active_hand", "tag": "物品", "tags_any": ["光照"]}
FOOD = {"zone": "active_hand", "tag": "食物"}
ANY = {"zone": "active_hand"}

for ability_id, amount in (("TS-0004-A01", 2), ("TS-0291-A01", 3),
                            ("TS-0293-A01", 3), ("TS-0530-A02", 3), ("TS-0644-A02", 2)):
    add(ability_id, D, select(HEROES, mod("strength", amount)), hand=("TS-0001",),
        conditions=({"exists": HEROES},), expected={"modified": {"TS-0001": {"strength": amount}}})

add("TS-0211-A02", V, {"op": "cost_gate", "cost": target("destroy", "source"),
                       "then": atom("draw", 3)}, expected={"draw": 3, "destroyed": ["TS-0211"]})
add("TS-0212-A01", V, atom("mod_gold", {"players": "all"}), expected={"gold": 2})
add("TS-0214-A02", V, {"op": "cost_gate", "cost": target("destroy", "source"),
                       "then": atom("mod_gold", {"count": HEROES})}, hand=("TS-0001", "TS-0302"),
    expected={"gold": 2, "destroyed": ["TS-0214"]})
add("TS-0223-A01", V, atom("draw", {"min": [{"div": [{"resource": "xp"}, 2]}, 5]}),
    xp=12, expected={"draw": 5})
add("TS-0223-A02", D, cost(MILITIA, seq(atom("draw", 2), atom("gain_xp", 1))),
    hand=("TS-0001",), conditions=({"exists": MILITIA},),
    expected={"draw": 2, "xp": 1, "destroyed": ["TS-0001"]})
add("TS-0229-A01", VD, seq(atom("draw", 1), select(ANY, target("discard"))),
    expected={"draw": 1, "discard_count": 1})
add("TS-0230-A01", VD, select(DISEASE, each({"zone": "bound", "var": "diseases"},
    seq(target("destroy"), atom("draw", 2))), bind="diseases", minimum=0, maximum=100),
    hand=("TS-0714", "TS-0715"), expected={"draw": 4, "destroyed": ["TS-0714", "TS-0715"]})
add("TS-0231-A02", D, atom("draw", {"count": MILITIA}), hand=("TS-0001", "TS-0001"), expected={"draw": 2})
add("TS-0256-A02", D, {"op": "cost_gate", "cost": target("destroy", "source"),
                       "then": atom("mod_attack", 3)}, expected={"battle_modifiers": {"attack": 3}, "destroyed": ["TS-0256"]})
add("TS-0267-A01", D, each(HEROES, mod("attack", 1)), hand=("TS-0001", "TS-0302"),
    expected={"modified": {"TS-0001": {"attack": 1}, "TS-0302": {"attack": 1}}})
add("TS-0264-A01", D, seq({"op": "set_battle_flag", "flag": "convert_equipped_magic", "value": True}, atom("draw", 1)),
    expected={"draw": 1, "flags": {"convert_equipped_magic": True}})
add("TS-0281-A01", D, seq({"op": "set_battle_flag", "flag": "zero_weapon_weight", "value": True}, atom("draw", 1)),
    expected={"draw": 1, "flags": {"zero_weapon_weight": True}})
add("TS-0276-A01", D, seq(atom("draw", 2), {"op": "for_players", "scope": "others", "body": atom("draw", 1)}),
    expected={"draw": 2, "other_draw": 1})
add("TS-0286-A01", D, each(HEROES, mod("strength", 3)), hand=("TS-0001", "TS-0302"),
    expected={"modified": {"TS-0001": {"strength": 3}, "TS-0302": {"strength": 3}}})
add("TS-0329-A02", VD, atom("draw", {"count": {"zone": "active_hand", "subcategory": "方阵", "exclude_source": True}}),
    hand=("TS-0328", "TS-0328"), expected={"draw": 2})
add("TS-0335-A03", D, atom("draw", {"mul": [2, {"count": {"zone": "active_hand", "tag": "佣兵"}}]}),
    hand=("TS-0226",), expected={"draw": 2})
for ability_id, amount in (("TS-0318-A02", 2), ("TS-0319-A02", 3)):
    add(ability_id, D, mod("attack", amount, "source"), hand=("TS-0476",),
        conditions=({"exists": MONSTERS},), expected={"modified": {ability_id.split("-A")[0]: {"attack": amount}}})
for ability_id, amount in (("TS-0322-A02", 2), ("TS-0323-A02", 4)):
    add(ability_id, D, cost(HEROES, atom("mod_attack", amount)), hand=("TS-0001",),
        conditions=({"exists": HEROES},), expected={"battle_modifiers": {"attack": amount}, "destroy_count": 1})
for ability_id, amount in (("TS-0345-A02", 2), ("TS-0346-A03", 2), ("TS-0348-A02", 3), ("TS-0349-A03", 3)):
    add(ability_id, D, cost(FOOD, atom("mod_attack", amount)), hand=("TS-0004",),
        conditions=({"exists": FOOD},), repeatable=ability_id == "TS-0349-A03",
        expected={"battle_modifiers": {"attack": amount}, "destroyed": ["TS-0004"]})
for ability_id, amount in (("TS-0349-A02", 1), ("TS-0350-A02", 2), ("TS-0427-A02", 1)):
    query = MONSTERS if ability_id != "TS-0427-A02" else {"zone": "active_hand", "tags_any": ["疾病", "怪物"]}
    # Monster identity is the explicit tag, including guardians.
    if ability_id == "TS-0427-A02":
        value = {"add": [{"count": DISEASE}, {"count": MONSTERS}]}
    else:
        value = {"count": query}
    add(ability_id, D, mod("attack", {"mul": [amount, value]}, "source"),
        hand=("TS-0476", "TS-0714"), expected={"modified": {ability_id.split("-A")[0]: {"attack": 2 if ability_id == "TS-0427-A02" else amount}}})
for ability_id, amount in (("TS-0366-A02", 1), ("TS-0367-A02", 2), ("TS-0520-A02", 1)):
    add(ability_id, D, atom("mod_magic_attack", {"mul": [amount, {"count": SPELLS}]}),
        hand=("TS-0267", "TS-0276"), expected={"battle_modifiers": {"magic_attack": 2 * amount}})
add("TS-0373-A02", D, atom("mod_attack", {"count": LIGHT_ITEMS}), hand=("TS-0003", "TS-0003"),
    expected={"battle_modifiers": {"attack": 2}})
add("TS-0377-A02", D, cost(DISEASE, seq(atom("mod_magic_attack", 4), atom("draw", 1))),
    hand=("TS-0714",), repeatable=True, conditions=({"exists": DISEASE},),
    expected={"draw": 1, "battle_modifiers": {"magic_attack": 4}, "destroyed": ["TS-0714"]})
for ability_id in ("TS-0378-A02", "TS-0424-A03"):
    add(ability_id, VD, cost(DISEASE, atom("draw", 1), remove="discard"), hand=("TS-0714",),
        conditions=({"exists": DISEASE},), expected={"draw": 1, "discard_count": 1})
add("TS-0379-A02", D, cost(DISEASE, seq(atom("draw", 1), atom("mod_attack", 1)), remove="discard"),
    hand=("TS-0714",), conditions=({"exists": DISEASE},), expected={"draw": 1, "discard_count": 1, "battle_modifiers": {"attack": 1}})
q = {"zone": "active_hand", "tags_any": ["疾病", "村民"]}
add("TS-0380-A02", D, cost(q, seq(atom("draw", 2), atom("mod_attack", 2)), remove="discard"),
    hand=("TS-0714",), conditions=({"exists": q},), expected={"draw": 2, "discard_count": 1, "battle_modifiers": {"attack": 2}})
for ability_id, amount in (("TS-0381-A02", 3), ("TS-0382-A02", 4)):
    add(ability_id, D, cost(LIGHT_ITEMS, atom("mod_magic_attack", amount)), hand=("TS-0003",),
        repeatable=True, conditions=({"exists": LIGHT_ITEMS},),
        expected={"destroyed": ["TS-0003"], "battle_modifiers": {"magic_attack": amount}})
add("TS-0386-A03", D, cost(ANY, atom("mod_attack", 2), remove="discard"), hand=("TS-0003",),
    expected={"discard_count": 1, "battle_modifiers": {"attack": 2}})
other_hand = {"zone": "subject_hand"}
discard_one = {"op": "if", "condition": {"exists": other_hand},
               "then": select(other_hand, target("discard"))}
for ability_id in ("TS-0391-A02", "TS-0448-A02", "TS-0449-A02", "TS-0457-A03"):
    add(ability_id, D, {"op": "for_players", "scope": "others", "body": discard_one}, expected={"other_discard": 1})
add("TS-0395-A02", D, {"op": "for_players", "scope": "others", "body": atom("lose_xp", 1)}, expected={"other_xp": -1})
add("TS-0400-A02", D, select(ANY, {"op": "let", "bind": "gold", "value": {"stat": {"var": "chosen", "field": "gold"}},
    "then": {"op": "cost_gate", "cost": target("destroy"), "then": atom("mod_magic_attack", {"value": "gold"})}}),
    hand=("TS-0003",), expected={"destroyed": ["TS-0003"], "battle_modifiers": {"magic_attack": 2}})
CASES[-1]["choices"] = ["TS-0003"]
q = {"zone": "active_hand", "gold_present": False}
add("TS-0401-A02", D, cost(q, atom("draw", 2)), hand=("TS-0267",), conditions=({"exists": q},),
    expected={"draw": 2, "destroyed": ["TS-0267"]})
add("TS-0418-A02", D, select(MONSTERS, atom("mod_magic_attack", {"stat": {"var": "chosen", "field": "vp"}})),
    hand=("TS-0476",), conditions=({"exists": MONSTERS},), expected={"magic_equals_monster_vp": "TS-0476"})
add("TS-0419-A02", D, atom("mod_magic_attack", {"sum": {"query": MONSTERS, "field": "vp"}}),
    hand=("TS-0476", "TS-0476"), expected={"magic_sum_monster_vp": ["TS-0476", "TS-0476"]})
add("TS-0420-A02", VD, select(DISEASE, target("destroy")), hand=("TS-0714",),
    conditions=({"exists": DISEASE},), expected={"destroyed": ["TS-0714"]})
add("TS-0429-A03", V, cost(DISEASE, atom("mod_gold", 2)), hand=("TS-0714",),
    conditions=({"exists": DISEASE},), expected={"destroyed": ["TS-0714"], "gold": 2})
for ability_id in ("TS-0441-A02", "TS-0442-A02"):
    add(ability_id, V, atom("mod_gold", {"count": {**HEROES, "exclude_source": True}}),
        hand=("TS-0001", "TS-0302"), expected={"gold": 2})
add("TS-0443-A02", D, mod("attack", 4, "source"), hand=("TS-0003", "TS-0003", "TS-0003"),
    conditions=({"compare": {"left": {"sum": {"query": ANY, "field": "gold"}}, "op": "ge", "right": 5}},),
    expected={"modified": {"TS-0443": {"attack": 4}}})
for ability_id, amount in (("TS-0456-A02", 2), ("TS-0457-A02", 3), ("TS-0458-A02", 4)):
    add(ability_id, D, each({**HEROES, "exclude_source": True}, mod("strength", amount)), hand=("TS-0001",),
        expected={"modified": {"TS-0001": {"strength": amount}}})
add("TS-0522-A02", D, each(MILITIA, mod("strength", 3)), hand=("TS-0001",), expected={"modified": {"TS-0001": {"strength": 3}}})
add("TS-0525-A02", V, atom("mod_gold", {"players": "all"}), expected={"gold": 2})
add("TS-0529-A03", D, each({"zone": "active_hand", "tag": "武器"}, mod("attack", 1)),
    hand=("TS-0002",), expected={"modified": {"TS-0002": {"attack": 1}}})
for ability_id, magic, light in (("TS-0309-A02", 2, 2), ("TS-0310-A02", 4, 3)):
    add(ability_id, D, {"op": "cost_gate", "cost": atom("spend_xp", 1),
                      "then": seq(atom("mod_magic_attack", magic), atom("mod_light", light))},
        xp=1, conditions=({"compare": {"left": {"resource": "xp"}, "op": "ge", "right": 1}},),
        expected={"xp": -1, "battle_modifiers": {"magic_attack": magic, "light": light}})
add("TS-0707-A01", D, {"op": "cost_gate", "cost": target("discard", "source"),
                       "then": {"op": "for_players", "scope": "others", "body": discard_one}},
    expected={"discard_count": 1, "other_discard": 1})

# Additional action contracts use the same bounded interpreter primitives.
def draw_then(count, then):
    return {"op": "draw", "count": count, "bind": "drawn", "then": then}


def if_exists(query, then):
    return {"op": "if", "condition": {"exists": query}, "then": then}


def move(destination, var="chosen"):
    return {"op": "move", "target": {"var": var}, "destination": destination}


q = {**ANY, "gold_present": True}
add("TS-0210-A01", V, select(q, {"op": "let", "bind": "gold", "value": {"stat": {"var": "chosen", "field": "gold"}},
    "then": {"op": "cost_gate", "cost": target("destroy"), "then": atom("mod_gold", {"add": [{"value": "gold"}, 3]})}}),
    hand=("TS-0003",), conditions=({"exists": q},), expected={"gold": 5, "destroyed": ["TS-0003"]})
add("TS-0214-A01", V, select(ANY, {"op": "let", "bind": "hero", "value": {"count": {"zone": "bound", "var": "chosen", "tag": "英雄"}},
    "then": {"op": "cost_gate", "cost": target("destroy"), "then": {"op": "if", "condition": {
        "compare": {"left": {"value": "hero"}, "op": "eq", "right": 0}}, "then": atom("gain_xp")}}}),
    expected={"xp": 1, "destroyed": ["TS-0214"]})
add("TS-0216-A02", V, {"op": "cost_gate", "cost": target("destroy", "source"), "then": cost(HEROES,
    {"op": "for_players", "scope": "others", "body": select({"zone": "subject_hand"},
        each({"zone": "bound", "var": "chosen"}, target("discard", "victim"), "victim"), minimum=2, maximum=2)})},
    hand=("TS-0001",), expected={"destroyed": ["TS-0216", "TS-0001"], "other_discard": 2})
add("TS-0217-A02", V, {"op": "cost_gate", "cost": target("destroy", "source"),
    "then": seq(atom("mod_gold", 2), select(HEROES, move("draw_top")))}, hand=("TS-0001",),
    conditions=({"exists": HEROES},), expected={"gold": 2, "destroyed": ["TS-0217"], "topdeck": "TS-0001"})
add("TS-0218-A02", V, select(HEROES, seq(each({"zone": "bound", "var": "chosen"},
    target("discard", "victim"), "victim"), atom("draw", {"count": {"zone": "bound", "var": "chosen"}})), minimum=0, maximum=100),
    hand=("TS-0001", "TS-0302"), expected={"draw": 2, "discard_count": 2})
add("TS-0221-A02", D, draw_then(1, if_exists({"zone": "bound", "var": "drawn", "tag": "怪物"}, atom("draw"))),
    draw=("TS-0476",), expected={"draw": 2})
add("TS-0222-A02", D, select({**ANY, "tags_any": ["英雄", "佣兵"]}, seq(mod("attack", 3), target("mark_destroy"))),
    hand=("TS-0001",), choices=("TS-0001",), expected={"modified": {"TS-0001": {"attack": 3}}, "marked_count": 1})
add("TS-0225-A03", D, {"op": "cost_gate", "cost": atom("spend_xp"), "then": select(HEROES, mod("attack", 1))},
    hand=("TS-0001",), xp=3, conditions=({"exists": HEROES}, {"compare": {"left": {"resource": "xp"}, "op": "ge", "right": 1}}),
    repeatable=True, expected={"xp": -1, "modified": {"TS-0001": {"attack": 1}}})
add("TS-0236-A02", D, seq(atom("mod_light", 2), atom("mod_attack", 2), target("mark_destroy", "source")),
    expected={"battle_modifiers": {"light": 2, "attack": 2}, "marked_count": 1})
add("TS-0285-A01", D, atom("mod_light", {"maximum": {"query": HEROES, "field": "level"}}),
    hand=("TS-0304", "TS-0001"), expected={"battle_modifiers": {"light": 3}})
add("TS-0257-A02", D, draw_then(1, each({"zone": "bound", "var": "drawn", "tag": "英雄"}, mod("strength", 3))),
    conditions=({"not": {"exists": {**HEROES, "strength_min": 6}}},), expected={"draw": 1, "modified": {"TS-0001": {"strength": 3}}})
q = {**ANY, "tags_any": ["法师", "牧师"]}
add("TS-0269-A02", D, select(q, mod("magic_attack", {"stat": {"var": "chosen", "field": "level"}})),
    hand=("TS-0402",), conditions=({"exists": q},), expected={"modified": {"TS-0402": {"magic_attack": 1}}})
add("TS-0274-A01", D, select(HEROES, mod("magic_attack", {"min": [{"resource": "xp"}, 6]})),
    hand=("TS-0001",), xp=8, conditions=({"exists": HEROES},), expected={"modified": {"TS-0001": {"magic_attack": 6}}})
add("TS-0275-A01", VD, cost(ANY, atom("mod_next_hand")), expected={"destroy_count": 1, "next_hand": 1})
add("TS-0290-A01", D, seq(each(HEROES, seq(mod("attack", 1), mod("strength", 3))),
    {"op": "schedule", "event": "BATTLE_AFTER_OUTCOME", "body": if_exists({**HEROES, "participating": True},
        select({**HEROES, "participating": True}, target("destroy")))}), hand=("TS-0001", "TS-0302"),
    expected={"modified": {"TS-0001": {"attack": 1, "strength": 3}, "TS-0302": {"attack": 1, "strength": 3}}, "scheduled": "BATTLE_AFTER_OUTCOME"})
add("TS-0291-A02", D, {"op": "cost_gate", "cost": target("destroy", "source"), "then": seq(
    select(HEROES, mod("attack", 3)), {"op": "for_players", "scope": "all", "body": atom("gain_disease")})},
    hand=("TS-0001",), conditions=({"exists": HEROES},),
    expected={"destroyed": ["TS-0291"], "modified": {"TS-0001": {"attack": 3}}, "diseases_each": 1})
q = {**ANY, "tags_any": ["武器", "物品"], "exclude_source": True}
add("TS-0297-A01", VD, cost(q, atom("draw", 2)), hand=("TS-0002",),
    conditions=({"exists": q},), expected={"draw": 2, "destroyed": ["TS-0002"]})
q = {**ANY, "tags_any": ["物品", "武器"]}
add("TS-0357-A02", D, cost(q, atom("mod_attack")), hand=("TS-0002",),
    conditions=({"exists": q},), expected={"destroyed": ["TS-0002"], "battle_modifiers": {"attack": 1}})
for id, zone in (("TS-0358-A02", "active_hand"), ("TS-0359-A02", "active_hand_or_village_top")):
    q = {"zone": zone, "tag": "武器"}
    add(id, D, select(q, {"op": "let", "bind": "weight", "value": {"stat": {"var": "chosen", "field": "weight"}},
        "then": {"op": "cost_gate", "cost": target("destroy"), "then": atom("mod_attack", {"value": "weight"})}}),
        hand=("TS-0002",), conditions=({"exists": q},), expected={"destroyed": ["TS-0002"], "battle_modifiers": {"attack": 2}})
for id, tag in (("TS-0385-A02", "食物"), ("TS-0386-A02", "物品")):
    q = {**ANY, "tag": tag}
    add(id, D, cost(q, seq(atom("mod_attack", 2), {"op": "for_players", "scope": "others", "body": discard_one})),
        hand=("TS-0004",), conditions=({"exists": q},), expected={"destroyed": ["TS-0004"], "battle_modifiers": {"attack": 2}, "other_discard": 1})
for id, q in (("TS-0389-A03", {"tag": "物品", "tags_any": ["光照"]}), ("TS-0439-A02", {"tag": "武器"}),
               ("TS-0442-A03", {"gold_present": True})):
    query = {"zone": "subject_hand", **q}
    fixture = "TS-0003" if id == "TS-0389-A03" else "TS-0002" if id == "TS-0439-A02" else "TS-0004"
    add(id, D, {"op": "for_players", "scope": "others", "body": if_exists(query, select(query, target("discard")))},
        others=[fixture], expected={"other_discard": 1})
add("TS-0393-A02", D, {"op": "for_players", "scope": "others", "body": {"op": "if", "condition": {
    "compare": {"left": {"count": {"zone": "subject_hand"}}, "op": "ge", "right": 6}}, "then": atom("random_discard")}},
    others=["TS-0001"] * 6, expected={"other_hand": 5})
add("TS-0394-A02", D, {"op": "for_players", "scope": "others", "body": {"op": "if", "condition": {
    "not": {"exists": {"zone": "subject_hand", "tag": "法术"}}}, "then": discard_one}}, expected={"other_discard": 1})
q = {"zone": "active_discard", "tags_any": ["英雄", "村民"]}
add("TS-0417-A02", D, cost(q, atom("mod_magic_attack")), conditions=({"exists": q},),
    discard=("TS-0001",), expected={"destroyed": ["TS-0001"], "battle_modifiers": {"magic_attack": 1}})
q = {"zone": "subject_hand", "tag": "武器"}
add("TS-0440-A02", D, {"op": "for_players", "scope": "others", "body": if_exists(q,
    select(q, seq(target("discard"), mod("attack", 1, "source"))))}, others=["TS-0002"],
    expected={"other_discard": 1, "modified": {"TS-0440": {"attack": 1}}})
for id in ("TS-0497-A03", "TS-0612-A02"):
    add(id, D, select(DISEASE, target("destroy")), hand=("TS-0714",), conditions=({"exists": DISEASE},),
        expected={"destroyed": ["TS-0714"]})
add("TS-0523-A03", D, seq(atom("draw"), select(ANY, move("draw_top"))), expected={"draw": 1, "topdeck": "TS-0523"})
add("TS-0368-A02", D, {"op": "reveal", "count": 3, "bind": "revealed", "then": if_exists(
    {"zone": "bound", "var": "revealed", "tag": "法术"}, select({"zone": "bound", "var": "revealed", "tag": "法术"}, move("hand")))},
    draw=("TS-0267", "TS-0003", "TS-0004"), expected={"gained_hand": "TS-0267", "revealed_discard": 2})
add("TS-0694-A01", VD, {"op": "cost_gate", "cost": target("destroy", "source"), "then": atom("draw", 3)},
    zone="active_control", expected={"destroyed": ["TS-0694"], "draw": 3})
for id, actions, op, value in (("TS-0700-A01", D, "mod_attack", 3), ("TS-0701-A01", D, "mod_magic_attack", 3),
                               ("TS-0702-A01", V, "mod_gold", 4)):
    expected = {"destroyed": [id.split("-A")[0]]}
    expected["gold" if op == "mod_gold" else "battle_modifiers"] = value if op == "mod_gold" else {"attack" if op == "mod_attack" else "magic_attack": value}
    add(id, actions, {"op": "cost_gate", "cost": target("destroy", "source"), "then": atom(op, value)}, zone="active_control", expected=expected)


def relocate(destination="dungeon_bottom", var="chosen", **extra):
    return {"op": "relocate_hall", "target": {"var": var}, "destination": destination, **extra}


MOVABLE = {"zone": "hall", "tag": "怪物", "movable": True}
add("TS-0241-A02", D, select({**MOVABLE, "rank": 1}, relocate()), hand=("TS-0340",),
    conditions=({"exists": {"zone": "bound", "var": "source", "equipped": True}}, {"exists": {**MOVABLE, "rank": 1}}),
    equipment=["TS-0340", "TS-0241"], hall=("TS-0476",) * 3, expected={"relocations": 1})
add("TS-0245-A02", D, {"op": "cost_gate", "cost": target("destroy", "source"), "then": seq(select(MOVABLE, relocate()), atom("draw"))},
    conditions=({"exists": MOVABLE},), hall=("TS-0476",) * 3, expected={"relocations": 1, "destroyed": ["TS-0245"], "draw": 1})
add("TS-0268-A01", D, seq(select(MOVABLE, relocate()), cost(ANY, atom("draw"))),
    conditions=({"exists": MOVABLE},), hall=("TS-0476",) * 3, expected={"relocations": 1, "destroy_count": 1, "draw": 1})
q = {**MOVABLE, "vp_min": 1, "vp_max": 2}
add("TS-0347-A03", D, cost(FOOD, select(q, relocate("discard"))), hand=("TS-0004",),
    conditions=({"exists": FOOD}, {"exists": q}), hall=("TS-0476",) * 3,
    expected={"relocations": 1, "destroyed": ["TS-0004"], "gained_monster": "TS-0476"})
for id, amount, rank in (("TS-0394-A03", 2, 1), ("TS-0395-A03", 1, None)):
    q = {**MOVABLE, **({"rank": rank} if rank else {})}
    add(id, D, {"op": "cost_gate", "cost": atom("spend_xp", amount), "then": select(q, relocate())}, xp=3,
        conditions=({"exists": q}, {"compare": {"left": {"resource": "xp"}, "op": "ge", "right": amount}}),
        hall=("TS-0476",) * 3, expected={"relocations": 1, "xp": -amount})
add("TS-0410-A02", D, select(MOVABLE, relocate()), conditions=({"exists": MOVABLE},), hall=("TS-0476",) * 3,
    expected={"relocations": 1})


def buy_offer(predicate, destination="discard", payment="none"):
    return {"op": "buy", "filter": predicate, "destination": destination, "payment": payment}


for id, predicate, destination, payment, zone, purchased in (
    ("TS-0301-A02", {"tag": "村庄"}, "discard", "none", "active_hand", "TS-0002"),
    ("TS-0397-A02", {"tag": "英雄"}, "discard", "none", "active_hand", "TS-0302"),
    ("TS-0398-A02", {"tag": "英雄"}, "hand", "none", "active_hand", "TS-0302"),
    ("TS-0697-A01", {"tag": "英雄"}, "hand", "discard_source", "active_control", "TS-0302"),
    ("TS-0699-A01", {"tag": "村庄"}, "hand", "discard_source", "active_control", "TS-0002"),
):
    add(id, D, buy_offer(predicate, destination, payment), hand=("TS-0003",) * 5, zone=zone,
        supplies=({"card_id": "TS-0302", "count": 2, "kind": "hero"},),
        expected={"purchased_card": purchased, "purchase_destination": destination,
                  **({"source_discarded": True} if payment == "discard_source" else {})})


def choose_value(kind, body, *, bind="choice", **options):
    return {"op": "choose_value", "kind": kind, "bind": bind, "then": body, **options}


def remember(query, bind, body):
    return {"op": "remember", "query": query, "bind": bind, "then": body}


def for_others(body):
    return {"op": "for_players", "scope": "others", "body": body}


def discard_or_show(query):
    return {"op": "if", "condition": {"exists": query},
            "then": select(query, target("discard")), "else": {"op": "show_hand"}}


new_discards = {"zone": "other_discard", "exclude_var": "before"}
add("TS-0212-A02", V, {"op": "cost_gate", "cost": target("destroy", "source"),
    "then": remember({"zone": "other_discard"}, "before", seq(
        for_others(discard_or_show({"zone": "subject_hand", "gold_present": True})),
        atom("mod_gold", {"sum": {"query": new_discards, "field": "gold"}})))},
    others=("TS-0003",), expected={"destroyed": ["TS-0212"], "other_discard": 1, "gold": 2})
CASES[-1]["variants"] = [{"others": ["TS-0302"], "expected": {"destroyed": ["TS-0212"], "other_discard": 0, "gold": 0}}]
add("TS-0218-A01", D, remember(ANY, "oldhand", {"op": "draw", "count": 3, "bind": "drawn",
    "then": each({"zone": "bound", "var": "drawn", "name_in_var": "oldhand"}, target("discard"))}),
    hand=("TS-0003",), draw=("TS-0003", "TS-0004", "TS-0004"),
    expected={"draw": 3, "discard_count": 1, "hand_counts": {"TS-0003": 1, "TS-0004": 2}})
add("TS-0219-A01", VD, {"op": "draw", "count": 2, "bind": "drawn", "then": {
    "op": "if", "condition": {"not": {"exists": {"zone": "bound", "var": "drawn", "tag": "法术"}}},
    "then": select({"zone": "bound", "var": "drawn"}, target("discard"))}},
    draw=("TS-0001", "TS-0001"), expected={"draw": 2, "discard_count": 1})
CASES[-1]["variants"] = [{"draw": ["TS-0267", "TS-0001"], "expected": {"draw": 2, "discard_count": 0}}]
cleansing = select({"zone": "bound", "var": "revealed"},
    each({"zone": "bound", "var": "victims"}, target("destroy")), bind="victims", minimum=2, maximum=2)
cleansing["allow_shortfall"] = True
add("TS-0262-A01", VD, choose_value("player", seq(
    {"op": "reveal", "count": 5, "bind": "revealed", "then": cleansing},
    {"op": "if", "condition": {"subject_is_active": False}, "then": {
        "op": "for_players", "scope": "active", "body": target("destroy", "source")}}), as_subject=True),
    expected={"destroy_count": 3, "opponent_revealed_discard": 3})
CASES[-1].update(values=["$other"], opponent_draw=5)
CASES[-1]["variants"] = [{"values": ["$self"], "expected": {"destroy_count": 2, "revealed_discard": 3}}]
add("TS-0451-A02", D, remember({"zone": "other_discard"}, "before", seq(
    for_others(discard_or_show({"zone": "subject_hand", "tag": "物品"})),
    {"op": "if", "condition": {"exists": {**new_discards, "tag": "物品", "tags_any": ["光照"]}},
     "then": atom("mod_light", 1)})), others=("TS-0003",), expected={"other_discard": 1, "battle_modifiers": {"light": 1}})
CASES[-1]["variants"] = [{"others": ["TS-0004"], "expected": {"other_discard": 1}}]
add("TS-0458-A03", D, remember({"zone": "other_discard"}, "before", seq(
    for_others(discard_or_show({"zone": "subject_hand"})),
    {"op": "if", "condition": {"not": {"exists": {**new_discards, "tag": "法术"}}},
     "then": mod("magic_attack", 2, "source")})), others=("TS-0001",),
    expected={"other_discard": 1, "modified": {"TS-0458": {"magic_attack": 2}}})
CASES[-1]["variants"] = [{"others": ["TS-0267"], "expected": {"other_discard": 1, "modified": {}}}]
add("TS-0253-A03", D, atom("draw", 1), hand=("TS-0001",), equipment=("TS-0001", "TS-0253"),
    conditions=({"exists": {"zone": "bound", "var": "source", "equipper_card_id": "TS-0001"}},), expected={"draw": 1})


def reorder_top_three():
    return choose_value("dungeon", {"op": "reveal", "zone": "dungeon", "count": 3,
        "bind": "peeked", "then": {"op": "reorder", "query": {"zone": "bound", "var": "peeked"},
                                     "destination": "dungeon_top"}}, bind="dungeon")


add("TS-0273-A02", D, choose_value("number", {"op": "cost_gate",
    "cost": atom("spend_xp", {"value": "spent"}),
    "then": atom("mod_magic_attack", {"value": "spent"})}, bind="spent",
    min=0, max={"min": [5, {"resource": "xp"}]}), xp=7,
    expected={"xp": -5, "battle_modifiers": {"magic_attack": 5}})
CASES[-1]["values"] = [5]
for ability_id, draw_count in (("TS-0224-A02", 0), ("TS-0280-A02", 2), ("TS-0453-A02", 0)):
    add(ability_id, D, seq(reorder_top_three(), atom("draw", draw_count)) if draw_count else reorder_top_three(),
        expected={"draw": draw_count, "dungeon_top": ["TS-0478", "TS-0477", "TS-0476"]})
    CASES[-1]["dungeon"] = ["TS-0476", "TS-0477", "TS-0478", "TS-0479"]
add("TS-0224-A01", V, seq(atom("draw", 3), select(ANY,
    {"op": "reorder", "query": {"zone": "bound", "var": "putback"}, "destination": "draw_top"},
    bind="putback", minimum=3, maximum=3)), draw=("TS-0001", "TS-0002", "TS-0003"),
    choices=(["TS-0001", "TS-0002", "TS-0003"],),
    expected={"draw": 3, "draw_top": ["TS-0003", "TS-0002", "TS-0001"]})
add("TS-0289-A01", D, seq(atom("draw", 1), choose_value("player", {
    "op": "reveal", "count": 1, "bind": "revealed", "then": {
        "op": "if", "condition": {"exists": {"zone": "bound", "var": "revealed", "tag": "英雄"}},
        "then": atom("mod_magic_attack", 2)}}, scope="others", as_subject=True)),
    expected={"draw": 1, "battle_modifiers": {"magic_attack": 2}})
add("TS-0413-A03", D, atom("mod_magic_attack", {"combat": "light"}),
    hand=("TS-0003", "TS-0003"), expected={"battle_modifiers": {"magic_attack": 2}})
add("TS-0270-A01", VD, seq(atom("draw", 1), select({**ANY, "unused": True, "exclude_source": True},
    {"op": "move", "target": {"var": "chosen"}, "destination": "refill_add"})),
    hand=("TS-0003",), choices=("TS-0003",), expected={"draw": 1, "set_aside": "TS-0003"})
salvage = {"zone": "bound", "var": "salvage", "revealed_only": True}
add("TS-0283-A01", V, {"op": "reveal", "count": 3, "from_bottom": True, "bind": "salvage",
    "then": seq(select(salvage, target("discard")), select(salvage, target("destroy")),
                each(salvage, {"op": "move", "target": {"var": "chosen"}, "destination": "hand"}))},
    choices=("TS-0003", "TS-0002"), expected={"destroyed": ["TS-0002"], "revealed_discard": 1, "gained_hand": "TS-0001"})
CASES[-1]["draw_exact"] = ["TS-0001", "TS-0002", "TS-0003"]
nonheroes = {"zone": "active_hand", "tags_none": ["英雄"]}
# Card type heroes also acquire the implicit hero tag in the shared query matcher.
add("TS-0695-A01", VD, {"op": "let", "bind": "destroyed", "value": {"add": [1, {"count": nonheroes}]},
    "then": seq(target("destroy", "source"), each(nonheroes, target("destroy")),
                atom("draw", {"mul": [2, {"value": "destroyed"}]}))},
    hand=("TS-0001", "TS-0003", "TS-0004"), zone="active_control",
    expected={"draw": 6, "destroyed": ["TS-0695", "TS-0003", "TS-0004"]})
add("TS-0706-A01", V, select(ANY, {"op": "let", "bind": "destroyed",
    "value": {"add": [1, {"count": {"zone": "bound", "var": "sacrificed"}}]},
    "then": seq(target("destroy", "source"), each({"zone": "bound", "var": "sacrificed"}, target("destroy")),
                atom("gain_xp", {"value": "destroyed"}))}, bind="sacrificed", minimum=0, maximum=100),
    hand=("TS-0001", "TS-0004"), zone="active_control",
    expected={"xp": 3, "destroyed": ["TS-0706", "TS-0001", "TS-0004"]})

for ability_id, zone, payment in (("TS-0437-A02", "active_hand", "none"),
                                 ("TS-0698-A01", "active_control", "discard_source")):
    add(ability_id, D, {"op": "upgrade", "destination": "hand", "payment": payment},
        hand=("TS-0001",), xp=3, zone=zone,
        supplies=({"card_id": "TS-0302", "kind": "hero", "count": 2},),
        expected={"xp": -3, "upgraded_card": "TS-0302", "gained_hand": "TS-0302",
                  **({"source_discarded": True} if payment == "discard_source" else {})})


for ability_id in ("TS-0295-A01", "TS-0296-A01"):
    add(ability_id, D, each(HEROES, seq(mod("strength", 2), mod("attack", 1),
        {"op": "grant_turn_buff", "target": {"var": "chosen"},
         "buff": "discard_instead_of_destroy"})), hand=("TS-0001", "TS-0302"),
        expected={"modified": {"TS-0001": {"strength": 2, "attack": 1},
                               "TS-0302": {"strength": 2, "attack": 1}},
                  "protected_heroes": 2})


add("TS-0292-A01", D, seq(each(HEROES, seq(mod("strength", 2), mod("magic_attack", 1))),
    {"op": "set_battle_flag", "flag": "convert_all_magic", "value": True}), hand=("TS-0001",),
    expected={"modified": {"TS-0001": {"strength": 2, "magic_attack": 1}}, "flags": {"convert_all_magic": True}})
add("TS-0294-A01", D, select(HEROES, seq(mod("strength", 3), target("convert_card_magic"))),
    hand=("TS-0001",), expected={"modified": {"TS-0001": {"strength": 3}}, "converted_card": "TS-0001"})
add("TS-0259-A02", D, select(MONSTERS, atom("mod_magic_attack", {"div": [{"stat": {"var": "chosen", "field": "health"}}, 2]})),
    conditions=({"exists": {"zone": "bound", "var": "source", "equipper_tags_any": ["法师", "牧师"]}},),
    hand=("TS-0401", "TS-0476"), equipment=("TS-0401", "TS-0259"), expected={"battle_modifiers": {"magic_attack": 2}})
declared = {"zone": "bound", "var": "flipped"}
branches = []
for kind in ("hero", "village", "monster"):
    branches.append({"op": "if", "condition": {"all": [{"choice_is": {"var": "declared", "option": kind}},
        {"exists": {**declared, "tag": {"hero": "英雄", "village": "村庄", "monster": "怪物"}[kind]}}]}, "then": atom("draw", 2)})
add("TS-0299-A01", VD, choose_value("enum", {"op": "reveal", "count": 1, "bind": "flipped", "then": seq(
    each(declared, target("discard")), *branches)}, bind="declared", options=["hero", "village", "monster"]),
    draw=("TS-0001",), expected={"draw": 2})
CASES[-1]["values"] = ["hero"]
CASES[-1]["variants"] = [{"values": ["monster"], "expected": {"draw": 0}}]
add("TS-0392-A02", D, for_others(choose_value("enum", {"op": "if",
    "condition": {"choice_is": {"var": "payment", "option": "hero"}},
    "then": discard_or_show({"zone": "subject_hand", "tag": "英雄"}),
    "else": {**select({"zone": "subject_hand"}, each({"zone": "bound", "var": "chosen"}, target("discard", "victim"), "victim"), minimum=2, maximum=2), "allow_shortfall": True}},
    bind="payment", options=["hero", "two_cards"])), others=("TS-0001", "TS-0001"), expected={"other_discard": 1})


hall_monsters = {"zone": "hall", "tag": "怪物", "movable": True}
normal_hall_monsters = {**hall_monsters, "exclude_var": "rank_zero"}
add("TS-0226-A03", D, seq(select(hall_monsters, {"op": "shuffle_hall_top", "target": {"var": "chosen"}, "count": 3}), atom("draw")),
    hall=("TS-0476", "TS-0477", "TS-0478"), expected={"draw": 1, "hall_shuffle": True})
add("TS-0232-A02", D, remember({"zone": "hall", "rank": 0}, "rank_zero",
    select(normal_hall_monsters, select({**normal_hall_monsters, "adjacent_to_var": "first"},
    {"op": "swap_hall", "target": {"var": "first"}, "other": {"var": "chosen"}}), bind="first")),
    hall=("TS-0476", "TS-0477", "TS-0478"), choices=("TS-0477", "TS-0478"),
    expected={"hall_order": ["TS-0476", "TS-0478", "TS-0477"]})
swap_reveal = select({"zone": "reveal_zone", "tag": "怪物"},
    each({"zone": "bound", "var": "incoming"}, select({**hall_monsters, "in_selected_dungeon": True},
        {"op": "exchange_hall", "target": {"var": "chosen"}, "other": {"var": "new_monster"}}), bind="new_monster"),
    bind="incoming", minimum=0, maximum=1)
add("TS-0263-A01", D, seq(choose_value("dungeon", {"op": "reveal", "zone": "dungeon", "count": 1,
    "bind": "peeked", "then": swap_reveal}, bind="deck"), atom("draw")), expected={"draw": 1, "exchanged": True})
CASES[-1]["dungeon"] = ["TS-0477", "TS-0478", "TS-0479"]
swap_front = select({"zone": "reveal_zone", "tag": "怪物"},
    each({"zone": "bound", "var": "incoming"}, select({**hall_monsters, "in_selected_dungeon": True, "rank": 1},
        {"op": "exchange_hall", "target": {"var": "chosen"}, "other": {"var": "new_monster"}}), bind="new_monster"),
    bind="incoming", minimum=0, maximum=1)
add("TS-0454-A02", D, choose_value("dungeon", {"op": "reveal", "zone": "dungeon", "count": 3,
    "bind": "peeked", "then": seq(swap_front, {"op": "reorder", "query": {"zone": "reveal_zone"}, "destination": "dungeon_top"})}, bind="deck"),
    expected={"exchanged": True})
CASES[-1]["dungeon"] = ["TS-0477", "TS-0478", "TS-0479", "TS-0480"]
add("TS-0455-A02", D, for_others({"op": "reveal", "count": 5, "bind": "shown", "then": seq(
    each({"zone": "reveal_zone", "tag": "英雄"}, target("discard")),
    {"op": "reorder", "query": {"zone": "reveal_zone"}, "destination": "draw_top"})}), expected={"opponent_discarded_heroes": 2})
CASES[-1]["opponent_draw_cards"] = ["TS-0003", "TS-0001", "TS-0004", "TS-0302", "TS-0002"]
highest_caster = {**HEROES, "tags_any": ["法师", "牧师"], "max_by": "level"}
add("TS-0266-A01", D, select(highest_caster, select({"zone": "hall", "tag": "怪物",
    "compare_stat": {"field": "vp", "op": "le", "value": {"add": [{"stat": {"var": "caster", "field": "level"}}, 2]}}},
    relocate("discard", defeat=True)), bind="caster"), hand=("TS-0401",), hall=("TS-0476", "TS-0477", "TS-0478"),
    expected={"xp": 1, "direct_defeats": 1})
add("TS-0271-A01", D, seq(for_others(atom("gain_disease")), each({"zone": "hall", "tag": "怪物"},
    {"op": "mod_monster_health", "target": {"var": "chosen"}, "amount": -2}),
    each({**hall_monsters, "compare_stat": {"field": "health", "op": "le", "value": 0}}, relocate("discard"))),
    hall=("TS-0476", "TS-0477", "TS-0478"), expected={"health_reductions": 3, "other_diseases": 1})
add("TS-0246-A02", D, {"op": "listen", "event": "BEFORE_HALL_REFILL", "once": True,
    "body": select({**hall_monsters, "vp_min": 1, "vp_max": 2},
        each({"zone": "bound", "var": "taken"}, relocate("discard")), bind="taken", minimum=0, maximum=1)},
    expected={"listener": "BEFORE_HALL_REFILL"})
add("TS-0277-A01", D, seq({"op": "add_global_rule", "kind": "force_dungeon", "until": "owner_next_turn_start", "scope": "others", "amount": 1},
    target("destroy", "source"), atom("draw", 2)), expected={"draw": 2, "destroyed": ["TS-0277"], "global_rule": "force_dungeon"})
add("TS-0421-A02", D, select(DISEASE, choose_value("player", seq(
    {"op": "move", "target": {"var": "chosen"}, "destination": "discard"},
    {"op": "for_players", "scope": "active", "body": atom("mod_magic_attack")}),
    bind="recipient", scope="others", as_subject=True)), hand=("TS-0714",), expected={"transferred_disease": 1, "battle_modifiers": {"magic_attack": 1}})
add("TS-0396-A02", V, {"op": "cost_gate", "cost": target("destroy", "source"),
    "then": select({"zone": "other_control", "subcategory": "宝藏"},
        {"op": "move", "target": {"var": "chosen"}, "destination": "control", "recipient": "active"})},
    expected={"destroyed": ["TS-0396"], "stolen_treasure": 1})
CASES[-1]["other_control"] = ["TS-0697"]
add("TS-0416-A02", D, cost(MILITIA, select({"zone": "hero_supply_top"}, seq(
    {"op": "move", "target": {"var": "chosen"}, "destination": "hand"}, target("mark_destroy"))), remove="discard"),
    hand=("TS-0001",), supplies=({"card_id": "TS-0302", "kind": "hero", "count": 2},),
    choices=("TS-0302",), expected={"discard_count": 1, "gained_hand": "TS-0302", "marked_count": 1})


add("TS-0217-A01", V, seq(atom("draw"), {"op": "listen", "event": "CARD_PURCHASED", "once": True,
    "conditions": [{"exists": {"zone": "event_source", "tag": "武器"}}], "body": atom("grant_buy")}),
    expected={"draw": 1, "listener": "CARD_PURCHASED"})
add("TS-0231-A01", V, seq(atom("draw"), {"op": "grant_basic_buy"}), expected={"draw": 1, "basic_buy": 1})
add("TS-0221-A01", V, select(ANY, {"op": "let", "bind": "limit", "value": {"add": [{"stat": {"var": "chosen", "field": "cost"}}, 2]},
    "then": seq(target("destroy"), {"op": "buy", "filter": {"tag": "村庄", "tags_none": ["英雄"]},
                                 "destination": "discard", "maximum_cost": {"value": "limit"}})}),
    hand=("TS-0003",), choices=("TS-0003",), expected={"destroyed": ["TS-0003"], "gained_supply_card": "TS-0004"})
add("TS-0300-A02", VD, {"op": "listen", "event": "CARD_PURCHASED", "body": {"op": "buy",
    "filter": {"tag": "村庄"}, "maximum_cost": {"sub": [{"context": "price"}, 1]}, "destination": "discard"}},
    expected={"listener": "CARD_PURCHASED"})
opponent_hero = {"zone": "bound", "var": "revealed_hero", "tag": "英雄"}
add("TS-0216-A01", V, select(HEROES, {"op": "let", "bind": "strength", "value": {"stat": {"var": "chosen", "field": "strength"}},
    "then": seq(target("discard"), choose_value("player", {"op": "discard_until",
        "filter": {"tag": "英雄"}, "bind": "revealed_hero", "then": seq(
            each({"zone": "reveal_zone"}, target("discard")), {"op": "if", "condition": {"all": [
                {"exists": opponent_hero}, {"compare": {"left": {"value": "strength"}, "op": "gt",
                    "right": {"maximum": {"query": opponent_hero, "field": "strength"}}}}]},
                "then": seq(each(opponent_hero, target("destroy")), {"op": "for_players", "scope": "active", "body": atom("gain_xp")})})},
        scope="others", as_subject=True))}), hand=("TS-0304",), expected={"discard_count": 1, "xp": 1, "other_hero_destroyed": 1})
add("TS-0317-A02", D, seq({"op": "clear_collection", "collection": "militia"}, for_others({"op": "if",
    "condition": {"exists": {"zone": "subject_hand", "card_id": "TS-0001"}},
    "then": select({"zone": "subject_hand", "card_id": "TS-0001"}, seq(target("show"),
        {"op": "collect", "collection": "militia", "query": {"zone": "bound", "var": "chosen"}})),
    "else": atom("random_discard")}), atom("mod_attack", {"mul": [2, {"add": [{"count": MILITIA},
        {"count": {"zone": "collection", "collection": "militia"}}]}]})), hand=("TS-0001",), others=("TS-0001",),
    expected={"battle_modifiers": {"attack": 4}})
add("TS-0362-A03", D, remember({"zone": "hall", "rank": 0}, "rank_zero", select(MONSTERS, select({**normal_hall_monsters,
    "compare_stat": {"field": "vp", "op": "le", "value": {"add": [{"stat": {"var": "offered", "field": "vp"}}, 1]}}},
    {"op": "exchange_hall", "target": {"var": "chosen"}, "other": {"var": "offered"}}), bind="offered")),
    hand=("TS-0476",), hall=("TS-0477", "TS-0478", "TS-0479"), expected={"exchanged": True})


add("TS-0422-A02", D, select({"zone": "hall", "tag": "怪物"},
    seq(atom("mod_magic_attack", {"mul": [2, {"count": DISEASE}]}),
        each(DISEASE, {"op": "attach_card", "target": {"var": "disease"}, "anchor": {"var": "monster"}, "kind": "disease_before"}, bind="disease")), bind="monster"),
    hand=("TS-0714", "TS-0714"), hall=("TS-0476", "TS-0477", "TS-0478"),
    expected={"battle_modifiers": {"magic_attack": 4}, "attached_diseases": 2})
add("TS-0425-A02", D, select(DISEASE, each({"zone": "bound", "var": "diseases"},
    select({"zone": "hall", "tag": "怪物"}, {"op": "attach_card", "target": {"var": "disease"},
        "anchor": {"var": "chosen"}, "kind": "disease_after"}), bind="disease"),
    bind="diseases", minimum=0, maximum=100), hand=("TS-0714", "TS-0714"),
    hall=("TS-0476", "TS-0477", "TS-0478"), expected={"attached_diseases": 2})


add("TS-0265-A01", D, select({**HEROES, "equipment_space": True}, select({"zone": "village_supply_top", "tag": "武器",
    "compare_stat": {"field": "weight", "op": "le", "value": {"stat": {"var": "hero", "field": "strength"}}}},
    {"op": "equip_from_supply", "target": {"var": "chosen"}, "equipper": {"var": "hero"}}), bind="hero"),
    hand=("TS-0302",), supplies=({"card_id": "TS-0234", "kind": "village", "count": 2},), choices=("TS-0234",),
    expected={"draw": 1, "gained_hand": "TS-0234", "marked_count": 1, "supplied_weapon_equipped": True})
add("TS-0244-A02", D, select({"zone": "active_hand", "tag": "法术", "used": True}, {"op": "reuse_ability", "target": {"var": "chosen"}}),
    conditions=({"exists": {"zone": "bound", "var": "source", "equipper_tags_any": ["法师", "牧师"]}},),
    hand=("TS-0401", "TS-0281"), equipment=("TS-0401", "TS-0244"), expected={"draw": 1, "reused_spell": "TS-0281"})
CASES[-1]["pre_activate"] = ["TS-0281-A01"]
new_chaos_discards = {"zone": "all_discard", "exclude_var": "old"}
discard_one = select({"zone": "subject_hand"}, target("discard"))
discard_one["allow_shortfall"] = True
add("TS-0298-A01", D, remember({"zone": "all_discard"}, "old", seq(
    {"op": "for_players", "scope": "all", "body": discard_one},
    select(new_chaos_discards, seq({"op": "move", "target": {"var": "chosen"}, "destination": "hand", "recipient": "active"},
        {"op": "redistribute_discards", "query": new_chaos_discards})), atom("draw"))),
    hand=("TS-0004",), others=("TS-0001",), choices=("TS-0004", "TS-0001", "TS-0001"),
    expected={"draw": 1, "redistributed": 1, "gained_hand": "TS-0001"})


dropped_monsters = {"zone": "bound", "var": "dropped", "in_discard": True, "same_family_as_event": True, "vp_max": 5}
add("TS-0320-A02", D, remember({"zone": "all_discard"}, "before", seq(
    {"op": "for_players", "scope": "all", "body": discard_or_show({"zone": "subject_hand", "tag": "怪物"})},
    remember({"zone": "all_discard", "exclude_var": "before", "tag": "怪物"}, "dropped",
        {"op": "listen", "event": "MONSTER_DEFEATED", "conditions": [{"exists": dropped_monsters}],
         "body": select(dropped_monsters, each({"zone": "bound", "var": "claimed"}, seq(
            {"op": "move", "target": {"var": "chosen"}, "destination": "discard", "recipient": "active"}, {"op": "remove_listener"})),
            bind="claimed", minimum=0, maximum=1)}))), hand=("TS-0476",), others=("TS-0476",),
    expected={"discard_count": 1, "other_discard": 1, "listener": "MONSTER_DEFEATED"})


for ability_id, predicate, scope, timing, hand, others in (
    ("TS-0404-A03", {"tag": "英雄"}, "all", "after_battle", ("TS-0001",), ("TS-0302",)),
    ("TS-0327-A03", {"tag": "武器"}, "all", "after_battle", ("TS-0002",), ("TS-0234",)),
    ("TS-0452-A02", {"tag": "物品"}, "others", "turn_end", (), ("TS-0003",)),
):
    eligible = {"zone": "all_discard", "exclude_var": "before", **predicate}
    if ability_id.startswith("TS-0327"):
        eligible["compare_stat"] = {"field": "weight", "op": "le", "value": {"stat": {"var": "source", "field": "strength"}}}
    borrowed = {"op": "borrow_card", "target": {"var": "borrowed"}, "when": timing, "return_destroyed": False}
    if ability_id.startswith("TS-0327"):
        borrowed["equipper"] = {"var": "source"}
    add(ability_id, D, remember({"zone": "all_discard"}, "before", seq(
        {"op": "for_players", "scope": scope, "body": discard_or_show({"zone": "subject_hand", **predicate})},
        select(eligible, each({"zone": "bound", "var": "taken"}, borrowed, bind="borrowed"), bind="taken", minimum=0, maximum=1))),
        hand=hand, others=others, expected={"borrowed": 1, "return_when": timing})
    CASES[-1]["choices"] = (["TS-0001", "TS-0302", "TS-0302"] if ability_id.startswith("TS-0404")
                           else ["TS-0234"] if ability_id.startswith("TS-0327") else ["TS-0003"])
add("TS-0415-A02", D, select(MILITIA, select({**HEROES, "exclude_var": "militia", "exclude_source": True},
    {"op": "copy_hero", "target": {"var": "militia"}, "other": {"var": "chosen"}, "preserve_attack": False, "full_card": False}), bind="militia"),
    conditions=({"exists": MILITIA}, {"compare": {"left": {"count": {**HEROES, "exclude_source": True}}, "op": "ge", "right": 2}}),
    hand=("TS-0001", "TS-0430"), expected={"copied_hero": "TS-0430"})


def build():
    draft = json.loads(next((ROOT / "docs").rglob("thunderstone_card_rules_v0.3.2_engine.json")).read_text(encoding="utf-8-sig"))
    lines = {a["id"]: a["source_line"] for c in draft["cards"] for a in c["abilities"]}
    with (ROOT / "data" / "cards.csv").open(encoding="utf-8-sig", newline="") as handle:
        cards = {c["card_id"]: c for c in csv.DictReader(handle)}
    for ability, case in zip(ABILITIES, CASES):
        line = lines[ability["id"]]
        if line not in cards[ability["source_card_id"]]["effect_text"].splitlines():
            raise ValueError(f"stale card line: {ability['id']}")
        case["source_line"] = line
    return {"action-reviewed.json": {"schema_version": "thunderstone.effects/1", "abilities": ABILITIES},
            "action-contracts.json": CASES}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    for name, artifact in build().items():
        content = (json.dumps(artifact, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        path = ROOT / "data" / "effects" / name
        if args.check:
            if not path.is_file() or path.read_bytes() != content:
                raise ValueError(f"stale artifact: {name}")
        else:
            path.write_bytes(content)
    print(f"{len(ABILITIES)} reviewed action bindings and card scenarios")


if __name__ == "__main__":
    main()
