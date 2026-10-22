"""Explicitly reviewed bindings for entry, breach, raid, refill and stalk effects."""

import argparse
import csv
import json
from pathlib import Path

from build_action_effects import atom, each, select, seq, target, buy_offer, relocate

ROOT = Path(__file__).resolve().parents[2]
ABILITIES = []
CASES = []
HAND = {"zone": "subject_hand"}
HERO = {**HAND, "tag": "英雄"}
BOUND = {"zone": "bound", "var": "revealed"}


def conditional(query, body):
    return {"op": "if", "condition": {"exists": query}, "then": body}


def choose_remove(query, count=1, op="destroy"):
    body = each({"zone": "bound", "var": "chosen"}, target(op, "victim"), "victim")
    result = select(query, body, minimum=count, maximum=count)
    result["allow_shortfall"] = True
    return conditional(query, result)


def players(body, scope="all"):
    return {"op": "for_players", "scope": scope, "body": body}


def reveal(body, count=5, **extra):
    return {"op": "reveal", "count": count, "bind": "revealed", "then": body, **extra}


def supply_destroy(var="chosen", count=2):
    return {"op": "destroy_supply", "target": {"var": var}, "count": count}


def add(id, event, body, *, zone="event_source", hand=(), draw=(), supplies=(), expected=None,
        conditions=(), active_only=False, scheduled=False):
    ABILITIES.append({"id": id, "source_card_id": id.split("-A")[0], "kind": "triggered",
                      "source_zone": zone, "event": event, "usage": "once_per_event",
                      "conditions": list(conditions), "body": body})
    CASES.append({"ability_id": id, "hand": list(hand), "draw": list(draw),
                  "supplies": list(supplies), "active_only": active_only,
                  "scheduled": scheduled, "expected": expected or {}})


add("TS-0190-A01", "BATTLE_AFTER_OUTCOME", atom("gain_disease"), zone="settings", expected={"diseases": 1})
add("TS-0194-A02", "BATTLE_AFTER_OUTCOME", choose_remove(HAND), zone="settings", hand=("TS-0004",),
    expected={"destroyed": ["TS-0004"]})
for id in ("TS-0484-A01", "TS-0612-A01"):
    add(id, "BREACH", players(atom("gain_disease")), expected={"diseases_each": 1})
for id, count in (("TS-0627-A01", 1), ("TS-0628-A01", 2), ("TS-0629-A02", 1)):
    add(id, "BREACH", players(choose_remove(HERO, count)), hand=("TS-0001", "TS-0302"),
        expected={"destroy_count_each": count})
add("TS-0630-A02", "BREACH", each(HERO, target("destroy")), hand=("TS-0001", "TS-0302"),
    expected={"destroyed": ["TS-0001", "TS-0302"]})
add("TS-0525-A01", "BREACH", players(choose_remove({**HAND, "gold_present": True})),
    hand=("TS-0003",), expected={"destroy_count_each": 1})
add("TS-0529-A01", "BREACH", players(choose_remove({**HAND, "tag": "武器"})),
    hand=("TS-0002",), expected={"destroy_count_each": 1})
add("TS-0666-A01", "BREACH", players(choose_remove(HAND, 2, "discard")),
    hand=("TS-0003", "TS-0004", "TS-0001"), expected={"discard_count_each": 2})
for id, query, fixture in (
    ("TS-0494-A02", {"tag": "英雄", "magic_min": 1}, "TS-0311"),
    ("TS-0592-A01", {"tag": "弓箭手"}, "TS-0302"),
    ("TS-0593-A02", {"tag": "牧师"}, "TS-0426"),
    ("TS-0594-A01", {"tag": "法师"}, "TS-0401"),
):
    add(id, "BREACH", players(reveal(each({**BOUND, **query}, target("destroy")))),
        draw=(fixture, fixture, "TS-0003", "TS-0004", "TS-0002"),
        expected={"destroy_count_each": 2, "discard_count_each": 3})
for id, query, fixture in (
    ("TS-0501-A02", {"card_id": "TS-0001"}, "TS-0001"),
    ("TS-0502-A01", {"tag": "英雄", "level_min": 1, "level_max": 1}, "TS-0302"),
    ("TS-0503-A02", {"tag": "英雄", "level_min": 2, "level_max": 2}, "TS-0303"),
    ("TS-0504-A01", {"vp_present": True}, "TS-0476"),
):
    add(id, "BREACH", players(reveal(choose_remove({**BOUND, **query}))),
        draw=(fixture, fixture, "TS-0003", "TS-0004", "TS-0002"),
        expected={"destroy_count_each": 1, "discard_count_each": 4})
add("TS-0463-A01", "BREACH", players({"op": "discard_until", "filter": {"tag": "英雄"}, "bind": "revealed",
    "then": each(BOUND, target("destroy"))}), draw=("TS-0003", "TS-0004", "TS-0001", "TS-0302"),
    expected={"destroy_count_each": 1, "discard_count_each": 2, "draw_remaining_each": 1})

for id, query, count in (
    ("TS-0461-A02", {"zone": "village_supply_top", "gold_min": 3}, 2),
    ("TS-0521-A01", {"zone": "village_supply_top", "light_min": 1}, 3),
    ("TS-0564-A01", {"zone": "hero_supply_top"}, 1),
    ("TS-0585-A02", {"zone": "hero_supply_top"}, 2),
):
    fixture = "TS-0233" if id == "TS-0461-A02" else "TS-0003" if id == "TS-0521-A01" else "TS-0302"
    add(id, "BREACH", each(query, supply_destroy(count=count)),
        supplies=({"card_id": fixture, "count": 4, "kind": "hero" if query["zone"] == "hero_supply_top" else "village"},),
        expected={"supply_destroyed": count})
add("TS-0565-A01", "BREACH", seq(each({"zone": "hero_supply_top"}, supply_destroy()),
    each({"zone": "village_supply_top"}, supply_destroy())),
    supplies=({"card_id": "TS-0302", "count": 4, "kind": "hero"}, {"card_id": "TS-0226", "count": 4, "kind": "village"}),
    expected={"supply_destroyed": 4})
add("TS-0603-A01", "BREACH", seq(each({"zone": "hero_supply_top"}, supply_destroy(count=1)),
    each({"zone": "village_supply_top", "tag": "村民"}, supply_destroy(count=1))),
    supplies=({"card_id": "TS-0302", "count": 4, "kind": "hero"}, {"card_id": "TS-0226", "count": 4, "kind": "village"}),
    expected={"supply_destroyed": 2})
q = {"zone": "hero_supply_top", "max_by": "pile_size"}
add("TS-0631-A02", "BREACH", conditional(q, select(q, supply_destroy(count=10000))),
    supplies=({"card_id": "TS-0302", "count": 4, "kind": "hero"}, {"card_id": "TS-0339", "count": 2, "kind": "hero"}),
    expected={"supply_destroyed": 4})
for id, extremum, number in (("TS-0556-A01", "min_by", 1), ("TS-0557-A01", "min_by", 2),
                            ("TS-0558-A01", "max_by", 1), ("TS-0559-A01", "max_by", 2), ("TS-0560-A01", "max_by", 2)):
    q = {"zone": "village_supply_top", "cost_present": True, extremum: "purchase_cost"}
    body = select(q, supply_destroy())
    if number == 2:
        second = {**q, "exclude_pile_var": "first"}
        body = select(q, {"op": "if", "condition": {"exists": second},
            "then": select(second, seq(supply_destroy("first"), supply_destroy())),
            "else": supply_destroy("first")}, bind="first")
    add(id, "HALL_REVEALED", conditional(q, body),
        supplies=({"card_id": "TS-0226", "count": 4, "kind": "village"}, {"card_id": "TS-0210", "count": 4, "kind": "village"}),
        expected={"supply_destroyed": 2 * number})

for id, body in (
    ("TS-0515-A01", atom("mod_next_gold", -2)),
    ("TS-0516-A01", choose_remove(HAND, 1, "discard")),
    ("TS-0517-A01", atom("gain_disease")),
    ("TS-0518-A01", atom("random_discard")),
    ("TS-0519-A01", {"op": "force_dungeon"}),
):
    expected = {"gold_adjustment": -2} if id == "TS-0515-A01" else {"diseases": 1} if id == "TS-0517-A01" else {"forced_dungeon": 1} if id == "TS-0519-A01" else {"discard_count_each": 1}
    add(id, "HALL_REVEALED", {"op": "schedule", "event": "TURN_START", "body": body},
        hand=("TS-0004",), active_only=True, scheduled=True, expected=expected)

add("TS-0522-A01", "DUNGEON_ENTER", {"op": "gain_card", "card_id": "TS-0001"}, zone="hall", expected={"gained": "TS-0001"})
add("TS-0676-A01", "VILLAGE_ENTER", atom("gain_disease"), zone="hall", expected={"diseases": 1})
add("TS-0527-A01", "HERO_UPGRADED", atom("lose_xp"), zone="hall", expected={"xp": 4})
add("TS-0683-A01", "DUNGEON_ENTER", each({**HAND, "tag": "怪物"}, target("destroy")),
    zone="hall", hand=("TS-0476", "TS-0476", "TS-0001"), expected={"destroyed": ["TS-0476", "TS-0476"]})
add("TS-0228-A01", "CARD_PURCHASED", atom("gain_xp", 2), expected={"xp": 7})
add("TS-0247-A02", "CARD_EQUIPPED", each({"zone": "event_hero"},
    {"op": "grant_turn_buff", "target": {"var": "chosen"},
     "buff": "discard_instead_of_destroy"}), expected={"protected_heroes": 1})
for id, amount in (("TS-0323-A03", 1), ("TS-0324-A03", 2)):
    add(id, "MONSTER_DEFEATED", atom("gain_xp", amount), zone="active_hand", expected={"xp": 5 + amount})
for id in ("TS-0307-A03", "TS-0365-A03"):
    add(id, "MONSTER_DEFEATED", atom("gain_xp"), zone="active_hand",
        conditions=({"compare": {"left": {"context": "rank"}, "op": "eq", "right": 3}},), expected={"xp": 6})
add("TS-0446-A03", "MONSTER_DEFEATED", atom("mod_next_hand"), zone="active_hand", expected={"next_hand": 1})
for id in ("TS-0523-A02", "TS-0528-A02"):
    body = choose_remove(HAND, 3, "discard") if id == "TS-0523-A02" else seq(
        each(HERO, target("discard")), atom("draw", {"max": [0, {"sub": [6, {"count": HAND}]}]}))
    add(id, "BATTLE_BEFORE_OUTCOME", {"op": "schedule", "event": "HAND_REFILL_COMPLETE", "body": body},
        zone="battle_target", hand=("TS-0001", "TS-0302", "TS-0004", "TS-0003", "TS-0002", "TS-0004"),
        draw=("TS-0003", "TS-0004"), active_only=True, scheduled=True,
        expected={"discard_count_each": 3 if id == "TS-0523-A02" else 2})
add("TS-0561-A01", "TURN_WILL_END", choose_remove({**HAND, "card_id": "TS-0001"}), zone="hall",
    conditions=({"action_in": ["dungeon"]},), hand=("TS-0001",), expected={"destroyed": ["TS-0001"]})
add("TS-0682-A03", "TURN_WILL_END", choose_remove(HAND), zone="hall", hand=("TS-0004",),
    conditions=({"exists": {"zone": "bound", "var": "source", "rank": 0}},), expected={"destroyed": ["TS-0004"]})
for id in ("TS-0235-A02", "TS-0242-A02"):
    add(id, "CARD_EQUIPPED", atom("gain_disease"), expected={"diseases": 1})

add("TS-0686-A01", "TRAP_REVEALED", players(each({**HAND, "tag": "法术"}, target("destroy")), "others"),
    hand=("TS-0267", "TS-0267"), expected={"other_destroy_count": 2})
for id in ("TS-0687-A01", "TS-0691-A01"):
    add(id, "TRAP_REVEALED", choose_remove({**HERO, "min_by": "strength"}), hand=("TS-0001", "TS-0302"),
        expected={"destroyed": ["TS-0001"]})
add("TS-0692-A02", "TRAP_REVEALED", players(reveal(each({**BOUND, "tag": "怪物"}, target("destroy")), 1), "others"),
    draw=("TS-0476", "TS-0003"), expected={"other_destroy_count": 1})

shield = {**HERO, "tags_any": ["牧师", "盗贼"]}
add("TS-0685-A01", "TRAP_REVEALED", players(select(shield, {"op": "if", "condition": {
    "not": {"exists": {"zone": "bound", "var": "shown"}}}, "then": atom("gain_disease")},
    bind="shown", minimum=0, maximum=1)), hand=("TS-0426",))
CASES[-1]["variants"] = [{"hand": ["TS-0004"], "expected": {"diseases_each": 1}}]
add("TS-0688-A01", "TRAP_REVEALED", players(conditional(HERO, select(HERO, {"op": "if",
    "condition": {"not": {"exists": {"zone": "bound", "var": "chosen", "tag": "盗贼"}}}, "then": target("destroy")}))),
    hand=("TS-0001",), expected={"destroy_count_each": 1})
CASES[-1]["variants"] = [{"hand": ["TS-0447"], "expected": {"destroy_count_each": 0}}, {"hand": [], "expected": {"destroy_count_each": 0}}]
add("TS-0690-A01", "TRAP_REVEALED", players({"op": "if", "condition": {"not": {"exists": {**HERO, "tags_any": ["盗贼"]}}},
    "then": each({**HAND, "tag": "村民"}, target("destroy"))}), hand=("TS-0226",), expected={"destroy_count_each": 1})
CASES[-1]["variants"] = [{"hand": ["TS-0226", "TS-0447"], "expected": {"destroy_count_each": 0}}]
add("TS-0687-A02", "TRAP_REVEALED", players(reveal({"op": "if", "condition": {"all": [
    {"compare": {"left": {"count": {**BOUND, "tag": "英雄"}}, "op": "eq", "right": 2}},
    {"compare": {"left": {"mul": [2, {"maximum": {"query": BOUND, "field": "strength"}}]}, "op": "ne",
                 "right": {"sum": {"query": BOUND, "field": "strength"}}}}]},
    "then": choose_remove({**BOUND, "tag": "英雄", "min_by": "strength"})}, 2), "others"),
    draw=("TS-0001", "TS-0302"), expected={"other_destroy_count": 1})
CASES[-1]["variants"] = [{"draw": ["TS-0001", "TS-0001"], "expected": {"other_destroy_count": 0}},
                          {"draw": ["TS-0003", "TS-0302"], "expected": {"other_destroy_count": 0}}]
q = {**BOUND, "tag": "英雄"}
add("TS-0691-A02", "TRAP_REVEALED", players(reveal(conditional(q, select({**q, "max_by": "strength"},
    seq(target("discard"), each({**q, "revealed_only": True}, target("destroy"))))), 3), "others"),
    draw=("TS-0001", "TS-0302", "TS-0003"), expected={"other_destroy_count": 1})
for id, query, fixture in (("TS-0689-A01", {"tag": "英雄"}, "TS-0001"), ("TS-0693-A01", {"tag": "武器"}, "TS-0002")):
    add(id, "TRAP_REVEALED", {"op": "reveal_cycle", "filter": query, "goal": 3},
        draw=("TS-0003", fixture, fixture), expected={"destroy_total": 3, "reveal_total": 5})
    CASES[-1]["variants"] = [{"draw": ["TS-0003", "TS-0004"], "expected": {"destroy_total": 0, "reveal_total": 4}}]
add("TS-0692-A01", "TRAP_REVEALED", {"op": "if", "condition": {"not": {"exists": {**HERO, "tags_any": ["盗贼"]}}},
    "then": each({"zone": "defeated_monster"}, target("destroy"))}, expected={"destroyed": ["TS-0476"]})
CASES[-1]["defeated_monster"] = "TS-0476"
CASES[-1]["variants"] = [{"hand": ["TS-0447"], "expected": {"destroyed": []}}]

for id, predicate, purchased, supply in (
    ("TS-0358-A03", {"tag": "武器"}, "TS-0002", None),
    ("TS-0332-A03", {"tag": "武器"}, "TS-0002", None),
    ("TS-0338-A03", {"tag": "村庄", "tags_any": ["佣兵"]}, "TS-0226", "TS-0226"),
    ("TS-0340-A03", {"tag": "武器"}, "TS-0002", None),
    ("TS-0371-A03", {"tag": "物品", "tags_any": ["光照"]}, "TS-0003", None),
    ("TS-0374-A03", {"tag": "村庄"}, "TS-0002", None),
    ("TS-0380-A03", {"tag": "村民"}, "TS-0226", "TS-0226"),
    ("TS-0407-A03", {"tag": "法术"}, "TS-0267", "TS-0267"),
    ("TS-0445-A03", {"tag": "村民"}, "TS-0226", "TS-0226"),
    ("TS-0579-A02", {"tag": "食物"}, "TS-0004", None),
    ("TS-0595-A03", {"tag": "村庄"}, "TS-0002", None),
):
    add(id, "MONSTER_DEFEATED", buy_offer(predicate), zone="event_source" if id.startswith(("TS-0579", "TS-0595")) else "active_hand",
        hand=("TS-0003",) * 5, supplies=({"card_id": supply, "count": 3, "kind": "village"},) if supply else (),
        expected={"purchased_card": purchased})

add("TS-0482-A01", "MONSTER_DEFEATED", players(atom("gain_disease")), zone="hall",
    conditions=({"exists": {"zone": "event_source", "tag": "怪物", "exclude_var": "source"}},),
    expected={"diseases_each": 1})
add("TS-0675-A01", "MONSTER_DEFEATED", {"op": "schedule", "event": "TURN_START", "body": {"op": "force_dungeon"}},
    zone="hall", scheduled=True, expected={"forced_dungeon": 1})

add("TS-0652-A02", "MONSTER_DEFEATED", reveal(select(BOUND,
    each({"zone": "bound", "var": "victims"}, target("destroy")), bind="victims", minimum=0, maximum=100), 6),
    draw=("TS-0001", "TS-0003", "TS-0004", "TS-0001", "TS-0003", "TS-0004"),
    active_only=True, expected={"destroy_total": 6, "active_discard": 0})
CASES[-1]["variants"] = [{"choose_count": 0, "expected": {"destroy_total": 0, "active_discard": 6}},
                          {"choose_count": 2, "expected": {"destroy_total": 2, "active_discard": 4}}]


add("TS-0195-A01", "TURN_WILL_END", each({"zone": "hall", "rank": 1, "tag": "怪物", "movable": True},
    relocate("rank3")), zone="settings", conditions=({"action_in": ["village", "rest"]},),
    expected={"front_rotated": True})
add("TS-0240-A02", "MONSTER_DEFEATED", select({"zone": "bound", "var": "source", "in_hand": True},
    each({"zone": "bound", "var": "retained"}, {"op": "move", "target": {"var": "chosen"}, "destination": "draw_top"}),
    bind="retained", minimum=0, maximum=1), zone="active_hand", expected={"source_top": True})
for id, destination in (("TS-0352-A02", "draw_top"), ("TS-0353-A02", "refill_add")):
    add(id, "TURN_WILL_END", select({"zone": "bound", "var": "source", "in_hand": True},
        each({"zone": "bound", "var": "retained"}, {"op": "move", "target": {"var": "chosen"}, "destination": destination}),
        bind="retained", minimum=0, maximum=1), zone="active_hand",
        conditions=({"exists": {"zone": "defeated_this_turn", "vp_max": 3}},),
        expected={"source_top": True} if destination == "draw_top" else {"source_refill": True})
add("TS-0344-A04", "MONSTER_DEFEATED", select({"zone": "subject_hand", "tag": "佣兵"},
    each({"zone": "bound", "var": "retained"}, {"op": "move", "target": {"var": "chosen"}, "destination": "refill_add"}),
    bind="retained", minimum=0, maximum=100), zone="active_hand", hand=("TS-0226", "TS-0229"), expected={"refill_count": 2})
add("TS-0409-A02", "MONSTER_DEFEATED", select({"zone": "hall", "tag": "怪物", "movable": True},
    each({"zone": "bound", "var": "returned"}, relocate("dungeon_bottom")),
    bind="returned", minimum=0, maximum=1), zone="active_hand", expected={"hall_returned": True})
add("TS-0678-A02", "TURN_START", each({"zone": "hall", "tag": "雷霆之石"},
    relocate("dungeon_bottom")), zone="hall", expected={"stone_returned": True})
add("TS-0601-A01", "BREACH", {"op": "destroy_basic_supply", "card_id": "TS-0001", "count": 5},
    expected={"basic_destruction": 5})
add("TS-0562-A01", "CARD_PURCHASED", {"op": "if", "condition": {"not": {
    "exists": {"zone": "event_source", "tag": "英雄"}}}, "then": {"op": "destroy_purchased_supply"}},
    zone="hall", supplies=({"card_id": "TS-0226", "kind": "village", "count": 3},), expected={"supply_destroyed": 1})
add("TS-0563-A01", "CARD_PURCHASED", {"op": "if", "condition": {"exists": {
    "zone": "event_source", "tag": "英雄"}}, "then": choose_remove(HERO)}, zone="hall",
    hand=("TS-0302",), expected={"destroyed": ["TS-0302"]})
add("TS-0673-A02", "CARD_PURCHASED", {"op": "destroy_purchased_supply"}, zone="hall",
    conditions=({"exists": {"zone": "bound", "var": "source", "rank": 0}},),
    supplies=({"card_id": "TS-0226", "kind": "village", "count": 3},), expected={"supply_destroyed": 1})
add("TS-0261-A02", "CARD_PURCHASED", seq(atom("grant_buy"), select({"zone": "subject_hand", "card_id": "TS-0001"},
    each({"zone": "bound", "var": "sacrificed"}, target("destroy")), bind="sacrificed", minimum=0, maximum=1)),
    hand=("TS-0001",), expected={"destroyed": ["TS-0001"], "extra_buys": 1})


add("TS-0288-A01", "MONSTER_DEFEATED", {"op": "add_global_rule", "kind": "light", "scope": "all", "amount": 1,
    "until": "owner_next_turn_end"}, zone="active_hand", expected={"global_rule": "light"})
add("TS-0499-A03", "MONSTER_DEFEATED", players(reveal(each({"zone": "reveal_zone", "tag": "怪物", "vp_max": 3},
    {"op": "move", "target": {"var": "chosen"}, "destination": "discard", "recipient": "active"}), count=3), scope="others"),
    draw=("TS-0476", "TS-0003", "TS-0476"), expected={"harvested_monsters": 2})
add("TS-0526-A01", "BREACH", {"op": "shuffle_destroyed_traps"}, expected={"shuffled_traps": True})
add("TS-0696-A01", "MONSTER_DEFEATED", select({"zone": "bound", "var": "source"},
    each({"zone": "bound", "var": "sacrificed"}, seq(target("destroy"), {"op": "grant_extra_turn"})),
    bind="sacrificed", minimum=0, maximum=1), zone="active_control",
    conditions=({"exists": {"zone": "event_source", "tag": "怪物", "vp_max": 3}},), expected={"extra_turn": 1})


attach_hero = select(HERO, each({"zone": "bound", "var": "captured"},
    {"op": "attach_card", "target": {"var": "chosen"}, "anchor": {"var": "source"}, "kind": "cage"}),
    bind="captured")
attach_hero["allow_shortfall"] = True
add("TS-0684-A01", "TRAP_REVEALED", attach_hero, hand=("TS-0302",), active_only=True, expected={"attachment": "cage"})
add("TS-0684-A02", "MONSTER_DEFEATED", {"op": "release_attachment", "target": {"var": "source"}},
    zone="attached", expected={"released": "cage"})
add("TS-0704-A01", "MONSTER_DEFEATED", select({"zone": "subject_hand"}, each({"zone": "bound", "var": "hidden"},
    {"op": "attach_card", "target": {"var": "chosen"}, "anchor": {"var": "source"}, "kind": "emerald"}),
    bind="hidden", minimum=0, maximum=1), zone="active_control", hand=("TS-0003",), expected={"attachment": "emerald"})
add("TS-0704-A02", "MONSTER_DEFEATED", {"op": "release_attachment", "target": {"var": "source"}, "recipient": "active"},
    zone="attached", conditions=({"exists": {"zone": "event_source", "vp_min": 7}},), expected={"released": "emerald"})
add("TS-0705-A01", "MONSTER_DEFEATED", select({"zone": "event_source", "tag": "怪物"},
    each({"zone": "bound", "var": "captured"}, {"op": "attach_card", "target": {"var": "chosen"},
        "anchor": {"var": "source"}, "kind": "sapphire"}), bind="captured", minimum=0, maximum=1),
    zone="active_control", expected={"attachment": "sapphire"})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    with (ROOT / "cards/cards.csv").open(encoding="utf-8-sig", newline="") as f:
        cards = {row["card_id"]: row for row in csv.DictReader(f)}
    draft = json.loads(next((ROOT / "docs").rglob("thunderstone_card_rules_v0.3.2_engine.json")).read_text(encoding="utf-8-sig"))
    lines = {a["id"]: a["source_line"] for c in draft["cards"] for a in c["abilities"]}
    for case in CASES:
        case["source_line"] = lines[case["ability_id"]]
        assert case["source_line"] in cards[case["ability_id"].split("-A")[0]]["effect_text"].splitlines()
    files = {"event-reviewed.json": {"schema_version": "thunderstone.effects.v1", "abilities": ABILITIES},
             "event-contracts.json": CASES}
    # Keep the established schema spelling from the root ruleset.
    files["event-reviewed.json"]["schema_version"] = json.loads((ROOT / "cards/effects/classic-v1.json").read_text(encoding="utf-8"))["schema_version"]
    for name, value in files.items():
        text = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
        directory = "effects" if name.endswith("-reviewed.json") else "contracts"
        path = ROOT / "cards" / directory / name
        if args.check:
            assert path.read_text(encoding="utf-8") == text, name
        else:
            path.write_text(text, encoding="utf-8")
    print(f"{len(ABILITIES)} reviewed event bindings")


if __name__ == "__main__":
    main()
