"""Reviewed monster battle effects and independent hand fixtures."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

from build_action_effects import atom, each, mod, select, seq, target


ROOT = Path(__file__).resolve().parents[2]
ABILITIES = []
CASES = []
ANY = {"zone": "subject_hand", "tags_none": ["疾病"], "unmarked": True}
HEROES = {**ANY, "tag": "英雄"}
MILITIA = {**ANY, "card_id": "TS-0001"}


def conditional(query, body):
    return {"op": "if", "condition": {"exists": query}, "then": body}


def destroy(query, count=1):
    if count == 1:
        body = select(query, target("mark_destroy"))
    else:
        body = select(query, each({"zone": "bound", "var": "victims"}, target("mark_destroy")),
                      bind="victims", minimum=count, maximum=count)
        body["allow_shortfall"] = True
    return conditional(query, body)


def add(ability_id, body, *, hand=(), expected=None):
    ABILITIES.append({"id": ability_id, "source_card_id": ability_id.split("-A")[0],
                      "kind": "triggered", "source_zone": "battle_target", "event": "BATTLE_BEFORE_OUTCOME",
                      "usage": "once_per_event", "conditions": [], "body": body})
    CASES.append({"ability_id": ability_id, "hand": list(hand), "expected": expected or {}})


for ability_id in ("TS-0459-A01", "TS-0552-A02", "TS-0577-A01", "TS-0663-A01"):
    add(ability_id, destroy({**ANY, "tag": "武器"}), hand=("TS-0002",), expected={"destroyed": ["TS-0002"]})
for ability_id in ("TS-0467-A02", "TS-0475-A01", "TS-0491-A02"):
    add(ability_id, destroy({**ANY, "tag": "法术"}), hand=("TS-0267",), expected={"destroyed": ["TS-0267"]})
for ability_id in ("TS-0486-A01", "TS-0488-A01", "TS-0527-A02", "TS-0576-A01",
                   "TS-0654-A01", "TS-0665-A02", "TS-0669-A02", "TS-0670-A02"):
    add(ability_id, destroy(MILITIA), hand=("TS-0001",), expected={"destroyed": ["TS-0001"]})
for ability_id in ("TS-0512-A01",):
    add(ability_id, destroy({**ANY, "tag": "佣兵"}), hand=("TS-0226",), expected={"destroyed": ["TS-0226"]})
for ability_id in ("TS-0519-A02", "TS-0569-A02", "TS-0570-A02", "TS-0668-A02"):
    add(ability_id, destroy({**HEROES, "tag": "战士"}), hand=("TS-0339",), expected={"destroyed": ["TS-0339"]})
add("TS-0468-A02", destroy({"zone": "subject_hand", "unmarked": True, "tags_any": ["牧师", "法师"]}),
    hand=("TS-0401",), expected={"destroyed": ["TS-0401"]})
add("TS-0492-A02", destroy({**ANY, "tag": "魔法", "tags_any": ["武器", "物品"]}),
    hand=("TS-0260",), expected={"destroyed": ["TS-0260"]})
add("TS-0460-A01", destroy({**ANY, "tag": "村庄", "max_by": "gold"}),
    hand=("TS-0285", "TS-0210"), expected={"destroyed": ["TS-0285"]})
add("TS-0496-A02", destroy(ANY), hand=("TS-0004",), expected={"destroyed": ["TS-0004"]})
add("TS-0551-A02", destroy({**ANY, "tag": "物品"}), hand=("TS-0003",), expected={"destroyed": ["TS-0003"]})
add("TS-0553-A02", destroy({**ANY, "gold_present": True}), hand=("TS-0003",), expected={"destroyed": ["TS-0003"]})
for ability_id in ("TS-0554-A02", "TS-0664-A01", "TS-0666-A02"):
    add(ability_id, destroy(HEROES), hand=("TS-0302",), expected={"destroyed": ["TS-0302"]})
add("TS-0578-A01", destroy({**ANY, "tag": "食物"}), hand=("TS-0004",), expected={"destroyed": ["TS-0004"]})
add("TS-0584-A02", destroy({**HEROES, "tag": "牧师"}), hand=("TS-0426",), expected={"destroyed": ["TS-0426"]})
add("TS-0632-A01", destroy({**HEROES, "exclude_card_id": "TS-0001"}), hand=("TS-0302",), expected={"destroyed": ["TS-0302"]})
add("TS-0637-A01", destroy({**ANY, "tag": "物品"}), hand=("TS-0003",), expected={"destroyed": ["TS-0003"]})
add("TS-0638-A02", destroy({**ANY, "tags_any": ["武器", "法术"]}), hand=("TS-0002",), expected={"destroyed": ["TS-0002"]})
add("TS-0640-A02", destroy({**HEROES, "level_min": 1, "level_max": 1}), hand=("TS-0302",), expected={"destroyed": ["TS-0302"]})
add("TS-0641-A02", destroy({**HEROES, "level_min": 2, "level_max": 2}), hand=("TS-0303",), expected={"destroyed": ["TS-0303"]})
add("TS-0642-A02", destroy({**ANY, "light_min": 1}), hand=("TS-0003",), expected={"destroyed": ["TS-0003"]})
add("TS-0671-A02", destroy({**HEROES, "tag": "法师"}), hand=("TS-0401",), expected={"destroyed": ["TS-0401"]})
for ability_id in ("TS-0530-A01", "TS-0531-A01"):
    add(ability_id, destroy({**HEROES, "min_by": "strength"}), hand=("TS-0001", "TS-0304"),
        expected={"destroyed": ["TS-0001"]})
add("TS-0667-A02", destroy({**HEROES, "max_by": "strength"}), hand=("TS-0001", "TS-0304"), expected={"destroyed": ["TS-0304"]})
add("TS-0594-A02", destroy({**HEROES, "max_by": "attack"}), hand=("TS-0001", "TS-0304"), expected={"destroyed": ["TS-0304"]})
add("TS-0532-A01", destroy({**HEROES, "strength_max": 4}, 2), hand=("TS-0001", "TS-0001", "TS-0304"),
    expected={"destroyed": ["TS-0001", "TS-0001"]})
add("TS-0533-A01", seq(destroy({**HEROES, "strength_max": 5}, 2), destroy({**ANY, "tag": "武器", "min_by": "weight"})),
    hand=("TS-0001", "TS-0001", "TS-0002"), expected={"destroyed": ["TS-0001", "TS-0001", "TS-0002"]})
for ability_id, strength, attack in (("TS-0469-A02", -4, -1), ("TS-0478-A01", -2, 0),
                                    ("TS-0487-A02", -2, 0), ("TS-0489-A02", -4, 0),
                                    ("TS-0493-A02", -3, 0), ("TS-0567-A01", -2, -1),
                                    ("TS-0569-A01", -2, 0)):
    add(ability_id, each(HEROES, seq(mod("strength", strength), mod("attack", attack))),
        hand=("TS-0304",), expected={"modified": {"strength": strength, "attack": attack}})
for ability_id in ("TS-0485-A01", "TS-0629-A01"):
    q = {**HEROES, "participating": True}
    add(ability_id, conditional(q, select(q, target("exclude_combat"))), hand=("TS-0302",), expected={"excluded": 1})
for ability_id, count in (("TS-0630-A01", 1), ("TS-0631-A01", 2)):
    q = {**HEROES, "participating": True}
    if count == 1:
        body = select(q, seq(target("exclude_combat"), target("mark_destroy")))
    else:
        body = select(q, each({"zone": "bound", "var": "victims"},
                              seq(target("exclude_combat"), target("mark_destroy"))), bind="victims", minimum=2, maximum=2)
        body["allow_shortfall"] = True
    add(ability_id, conditional(q, body), hand=("TS-0302", "TS-0303"), expected={"excluded": count, "destroy_count": count})
for ability_id in ("TS-0592-A02", "TS-0655-A01"):
    add(ability_id, each({**HEROES, "tag": "弓箭手"}, target("mark_destroy")),
        hand=("TS-0302", "TS-0303"), expected={"destroyed": ["TS-0302", "TS-0303"]})
add("TS-0639-A02", each(MILITIA, target("mark_destroy")), hand=("TS-0001", "TS-0001"), expected={"destroyed": ["TS-0001", "TS-0001"]})
add("TS-0585-A03", each({"zone": "subject_hand", "unmarked": True, "tags_any": ["牧师", "法师"]}, target("mark_destroy")),
    hand=("TS-0401", "TS-0426"), expected={"destroyed": ["TS-0401", "TS-0426"]})
add("TS-0464-A02", each({**ANY, "duplicate_names": True}, target("mark_destroy")),
    hand=("TS-0001", "TS-0001", "TS-0004"), expected={"destroyed": ["TS-0001", "TS-0001"]})
for ability_id, q, amount in (("TS-0633-A01", {**ANY, "tag": "物品", "tags_any": ["光照"]}, 1),
                             ("TS-0634-A01", {**ANY, "card_id": "TS-0002"}, 4),
                             ("TS-0636-A01", MILITIA, 2),
                             ("TS-0529-A02", {**ANY, "tag": "武器"}, -1)):
    hand = ("TS-0003",) if ability_id == "TS-0633-A01" else ("TS-0001",) if ability_id == "TS-0636-A01" else ("TS-0002", "TS-0001")
    add(ability_id, each(q, mod("attack", amount)), hand=hand, expected={"modified": {"attack": amount}})
    if ability_id in ("TS-0634-A01", "TS-0529-A02"):
        CASES[-1]["equipment"] = ["TS-0001", "TS-0002"]
for ability_id in ("TS-0479-A01", "TS-0524-A02"):
    add(ability_id, atom("gain_disease", 2), expected={"diseases": 2})
add("TS-0484-A02", seq(atom("gain_disease", 2), {"op": "for_players", "scope": "others", "body": atom("gain_disease", 1)}),
    expected={"diseases": 2, "other_diseases": 1})
add("TS-0498-A02", {"op": "for_players", "scope": "all", "body": atom("gain_disease", 1)}, expected={"diseases": 1, "other_diseases": 1})
add("TS-0661-A01", seq(atom("gain_disease", {"count": MILITIA}), each(MILITIA, target("mark_destroy"))),
    hand=("TS-0001", "TS-0001"), expected={"diseases": 2, "destroyed": ["TS-0001", "TS-0001"]})
add("TS-0662-A02", atom("gain_disease", {"count": {**HEROES, "tags_any": ["民兵", "战士"]}}),
    hand=("TS-0001", "TS-0339"), expected={"diseases": 2})
q = {**ANY, "tag": "食物"}
add("TS-0586-A01", seq(each(q, target("mark_destroy")), atom("gain_disease", {"count": {"zone": "subject_hand", "tag": "食物"}})),
    hand=("TS-0004", "TS-0004"), expected={"diseases": 2, "destroyed": ["TS-0004", "TS-0004"]})
q = {**ANY, "tag": "物品", "tags_any": ["光照"]}
add("TS-0587-A01", conditional(q, select(q, seq(target("mark_destroy"), atom("gain_disease", 1)))),
    hand=("TS-0003",), expected={"diseases": 1, "destroyed": ["TS-0003"]})
q = MILITIA
body = select(q, each({"zone": "bound", "var": "victims"}, seq(target("mark_destroy"), atom("gain_disease", 1))), bind="victims", minimum=2, maximum=2)
body["allow_shortfall"] = True
add("TS-0588-A01", conditional(q, body), hand=("TS-0001", "TS-0001"), expected={"diseases": 2, "destroyed": ["TS-0001", "TS-0001"]})
for ability_id, q, field, hand in (("TS-0589-A01", {**HEROES, "tag": "战士"}, "level", ("TS-0340",)),
                                  ("TS-0590-A01", {**ANY, "tag": "怪物"}, "xp_reward", ("TS-0476",))):
    add(ability_id, conditional(q, select(q, seq(target("mark_destroy"), atom("gain_disease", {"stat": {"var": "chosen", "field": field}})))),
        hand=hand, expected={"diseases_from_stat": {"card_id": hand[0], "field": field}, "destroyed": list(hand)})
add("TS-0591-A01", {"op": "if", "condition": {"exists": {"zone": "subject_hand", "tag": "疾病"}},
                    "then": atom("gain_disease", 2), "else": atom("gain_disease", 1)},
    hand=("TS-0714",), expected={"diseases": 2})
add("TS-0483-A01", {"op": "repeat", "times": {"min": [100, {"count": {"zone": "subject_hand", "tag": "疾病"}}]},
                    "limit": 100, "body": destroy(ANY)}, hand=("TS-0714", "TS-0004"), expected={"destroyed": ["TS-0004"]})

add("TS-0527-A03", {"op": "for_players", "scope": "all", "body": atom("lose_xp")}, expected={"xp_loss_each": 1})
add("TS-0504-A02", {"op": "for_players", "scope": "all", "body": destroy({**ANY, "tag": "怪物"})},
    hand=("TS-0476",), expected={"destroy_count_each": 1})
for id in ("TS-0613-A01", "TS-0614-A01"):
    add(id, {"op": "for_players", "scope": "all", "body": atom("gain_disease")}, expected={"diseases": 1, "other_diseases": 1})
add("TS-0613-A03", destroy({**HEROES, "tag": "牧师"}), hand=("TS-0426",), expected={"destroyed": ["TS-0426"]})
add("TS-0614-A03", destroy({**HEROES, "level_min": 1}), hand=("TS-0302",), expected={"destroyed": ["TS-0302"]})
add("TS-0507-A02", each({**HEROES, "equipped": False, "magic_max": 0}, target("mark_destroy")),
    hand=("TS-0001", "TS-0311"), expected={"destroyed": ["TS-0001"]})
add("TS-0579-A01", {"op": "if", "condition": {"not": {"exists": {**HEROES, "equipped": True}}},
    "then": destroy(HEROES)}, hand=("TS-0001",), expected={"destroyed": ["TS-0001"]})
add("TS-0607-A01", each({**HEROES, "equipped": True}, mod("attack", 1)),
    hand=("TS-0001", "TS-0002"), expected={"modified": {"attack": 1}})
CASES[-1]["equipment"] = ["TS-0001", "TS-0002"]

add("TS-0683-A03", seq(
    each({"zone": "active_hand", "tag": "雷霆之石"}, mod("magic_attack", 6)),
    {"op": "set_battle_flag", "flag": "lose_on_battle_loss", "value": True}),
    hand=("TS-0707", "TS-0708"), expected={"modified": {"magic_attack": 6}})


def flag(name, value):
    return {"op": "set_battle_flag", "flag": name, "value": value}


def keep_heroes(count=2, *, highest=False):
    body = select(HEROES, each({**HEROES, "exclude_var": "kept"}, target("mark_destroy")),
                  bind="kept", minimum=count, maximum=count)
    body["allow_shortfall"] = True
    if highest:
        body["highest_by"] = "strength"
    return body


weapons = {**ANY, "tag": "武器"}
keep_weapon = select({**weapons, "max_by": "weight"},
    each({**weapons, "exclude_var": "kept_weapon"}, target("mark_destroy")), bind="kept_weapon")
add("TS-0534-A01", seq(keep_heroes(highest=True), conditional(weapons, keep_weapon)),
    hand=("TS-0001", "TS-0001", "TS-0302", "TS-0002", "TS-0238"), expected={"destroy_count": 2})
add("TS-0595-A02", keep_heroes(), hand=("TS-0001", "TS-0001", "TS-0302"), expected={"destroy_count": 1})
basilisk = select(ANY, each({"zone": "bound", "var": "victims"}, target("mark_destroy")),
                  bind="victims", minimum=2, maximum=2)
basilisk.update(allow_shortfall=True, constraints=[{"filter": {"tag": "英雄"}, "maximum": 1}])
add("TS-0555-A02", basilisk, hand=("TS-0001", "TS-0302", "TS-0003"), expected={"destroy_count": 2})
CASES[-1]["variants"] = [{"hand": ["TS-0001", "TS-0302"], "expected": {"destroy_count": 1}}]
acid_items = {**ANY, "tag": "物品", "unused": True}
add("TS-0635-A01", select(acid_items, seq(
    each({"zone": "bound", "var": "sacrificed"}, target("mark_destroy")),
    atom("mod_attack", {"mul": [3, {"count": {"zone": "bound", "var": "sacrificed"}}]})),
    bind="sacrificed", minimum=0, maximum=100), hand=("TS-0003", "TS-0003"),
    expected={"destroy_count": 2, "attack_bonus": 6})
CASES[-1]["variants"] = [{"used_card_ids": ["TS-0003"], "expected": {"destroy_count": 1, "attack_bonus": 3}},
                          {"choose_count": 0, "expected": {"destroy_count": 0, "attack_bonus": 0}}]

for ability_id, predicate, count, removal, fixture in (
    ("TS-0470-A01", {"tag": "食物"}, 1, "destroy", ("TS-0004",)),
    ("TS-0471-A01", {"tag": "英雄"}, 1, "destroy", ("TS-0001",)),
    ("TS-0472-A01", None, 2, "spend_xp", ()),
    ("TS-0473-A01", {"tag": "怪物"}, 1, "destroy", ("TS-0476",)),
    ("TS-0474-A01", {}, 3, "discard", ("TS-0001", "TS-0003", "TS-0004")),
):
    if predicate is None:
        payable = {"compare": {"left": {"resource": "xp"}, "op": "ge", "right": count}}
        payment = seq(atom("spend_xp", count), flag("cannot_defeat", False))
    else:
        query = {"zone": "active_hand", **predicate}
        payable = {"compare": {"left": {"count": query}, "op": "ge", "right": count}}
        payment = select(query, seq(each({"zone": "bound", "var": "paid"}, target(removal)),
                                    flag("cannot_defeat", False)), bind="paid", minimum=count, maximum=count)
    choice = {"op": "choose_value", "kind": "enum", "bind": "payment", "options": ["pay", "decline"],
              "then": {"op": "if", "condition": {"choice_is": {"var": "payment", "option": "pay"}}, "then": payment}}
    add(ability_id, seq(flag("cannot_defeat", True), {"op": "if", "condition": payable, "then": choice}),
        hand=fixture, expected={"outcome": "win", **({"immediate_destroyed": list(fixture)} if removal == "destroy" else {}),
                                **({"xp_spent": 2} if removal == "spend_xp" else {})})
    CASES[-1].update(attack=100, values=["pay"], assert_failed_departure=True)
    CASES[-1]["variants"] = [{"values": ["decline"], "expected": {"outcome": "loss", "immediate_destroyed": []}},
                              {"hand": [], "xp": 0, "expected": {"outcome": "loss", "immediate_destroyed": []}}]

class_count = 0
for tag in ("战士", "盗贼", "弓箭手", "法师", "牧师"):
    class_count = {"add": [class_count, {"min": [1, {"count": {**HEROES, "tag": tag}}]}]}
exclude = select(HEROES, each({"zone": "bound", "var": "excluded"}, target("exclude_combat")),
                 bind="excluded", minimum=class_count, maximum=class_count)
exclude["allow_shortfall"] = True
add("TS-0672-A01", exclude, hand=("TS-0001", "TS-0302", "TS-0401"), expected={"excluded": 2})
CASES[-1]["variants"] = [{"hand": ["TS-0001"], "expected": {"excluded": 0}}]
add("TS-0672-A02", each({**HEROES, "participating": False}, target("mark_destroy")), expected={})
CASES[-1]["variants"] = [{"hand": ["TS-0001", "TS-0302"], "excluded_card_ids": ["TS-0001"], "expected": {"destroy_count": 1}}]
add("TS-0672-A03", {"op": "set_retreat_position", "amount": 3}, expected={"retreat_position": 3})


same_name = {"zone": "subject_hand", "tag": "英雄", "participating": True, "same_name_as_var": "hero"}
add("TS-0464-A01", each({"zone": "subject_hand", "tag": "英雄"},
    {"op": "if", "condition": {"compare": {"left": {"count": same_name}, "op": "gt", "right": 1}},
     "then": select(same_name, each({**same_name, "exclude_var": "kept"}, target("exclude_combat")), bind="kept")}, bind="hero"),
    hand=("TS-0302", "TS-0302"), expected={"excluded": 1})
CASES[-1]["variants"] = [{"hand": ["TS-0302", "TS-0303"], "expected": {"excluded": 0}},
                         {"hand": ["TS-0302"] * 3, "expected": {"excluded": 2}}]
add("TS-0509-A02", {"op": "schedule", "event": "BATTLE_AFTER_OUTCOME",
    "body": {"op": "random_destroy", "filter": {"tag": "元素"}}}, hand=("TS-0003",),
    expected={"random_destroyed": 1})
CASES[-1]["variants"] = [{"hand": ["TS-0495"], "expected": {"random_destroyed": 0}}]
add("TS-0560-A02", each({"zone": "subject_hand", "tag": "村庄"},
    {"op": "destroy_matching_supply", "target": {"var": "chosen"}, "count": 1}),
    hand=("TS-0226", "TS-0226"), expected={"supply_destroyed": 2})
CASES[-1]["supplies"] = [{"card_id": "TS-0226", "kind": "village", "count": 4}]
add("TS-0604-A01", each({"zone": "subject_hand", "tag": "英雄", "participating": True},
    {"op": "destroy_matching_supply", "target": {"var": "chosen"}, "count": 1, "family": True, "from_bottom": True}),
    hand=("TS-0302",), expected={"supply_destroyed": 1, "supply_destroyed_cards": ["TS-0304"]})
CASES[-1]["supplies"] = [{"card_id": "TS-0302", "kind": "hero", "count": 1},
                          {"card_id": "TS-0304", "kind": "hero", "count": 1, "pile": 0}]
unarmed = {"zone": "subject_hand", "tag": "英雄", "without_weapon_tag": "锋利"}
add("TS-0656-A01", seq(conditional(unarmed, select(unarmed, target("destroy"))),
    each(unarmed, target("mark_destroy"))), hand=("TS-0302", "TS-0303"),
    expected={"immediate_destroyed": ["TS-0302"], "destroyed": ["TS-0303"]})
CASES[-1]["variants"] = [{"hand": ["TS-0302", "TS-0002"], "equipment": ["TS-0302", "TS-0002"],
                         "expected": {"immediate_destroyed": [], "destroyed": []}}]


shown_heroes = {"zone": "bound", "var": "shown"}
show_two = select({"zone": "subject_hand", "tag": "英雄"}, seq(
    each(shown_heroes, target("show")), {"op": "collect", "collection": "heroes", "query": shown_heroes}),
    bind="shown", minimum=2, maximum=2)
show_two["allow_shortfall"] = True
add("TS-0463-A02", seq({"op": "clear_collection", "collection": "heroes"},
    {"op": "for_players", "scope": "all", "body": seq({"op": "if", "condition": {"compare": {
        "left": {"count": {"zone": "subject_hand", "tag": "英雄"}}, "op": "lt", "right": 2}}, "then": {"op": "show_hand"}}, show_two)},
    conditional({"zone": "collection", "collection": "heroes"}, select({"zone": "collection", "collection": "heroes", "max_by": "strength"},
        {"op": "mark_destroy", "target": {"var": "chosen"}, "as_owner": True}))),
    hand=("TS-0001", "TS-0302"), expected={"destroyed": ["TS-0304"]})
CASES[-1]["other_hand"] = ["TS-0304", "TS-0304"]


def build():
    with (ROOT / "cards" / "contracts" / "battle-contracts.csv").open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            add(row["ability_id"], atom("gain_disease", 1), expected={"diseases": 1})
    draft = json.loads(next((ROOT / "docs").rglob("thunderstone_card_rules_v0.3.2_engine.json")).read_text(encoding="utf-8-sig"))
    lines = {a["id"]: a["source_line"] for c in draft["cards"] for a in c["abilities"]}
    with (ROOT / "cards" / "cards.csv").open(encoding="utf-8-sig", newline="") as handle:
        cards = {c["card_id"]: c for c in csv.DictReader(handle)}
    for ability, case in zip(ABILITIES, CASES):
        line = lines[ability["id"]]
        if line not in cards[ability["source_card_id"]]["effect_text"].splitlines():
            raise ValueError(f"stale card line: {ability['id']}")
        case["source_line"] = line
    return {"battle-reviewed.json": {"schema_version": "thunderstone.effects/1", "abilities": ABILITIES},
            "battle-contracts.json": CASES}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    for name, artifact in build().items():
        content = (json.dumps(artifact, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        directory = "effects" if name.endswith("-reviewed.json") else "contracts"
        path = ROOT / "cards" / directory / name
        if args.check:
            if not path.is_file() or path.read_bytes() != content:
                raise ValueError(f"stale artifact: {name}")
        else:
            path.write_bytes(content)
    print(f"{len(ABILITIES)} reviewed battle bindings and card scenarios")


if __name__ == "__main__":
    main()
