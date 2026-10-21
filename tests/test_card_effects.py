"""One executable contract test per card in the reviewed effect cohorts.

The generated test methods have stable card IDs in their names. A card with
other unbound abilities still has only partial semantic coverage; see the
card-level coverage report rather than treating this module as completion.
"""

from __future__ import annotations

import csv
import json
import re
import unittest
from collections import defaultdict
from copy import deepcopy
from dataclasses import replace
from pathlib import Path

from engine.catalog.repository import load_catalog
from engine.effects.compiler import load_ruleset
from engine.disease import take_disease
from engine.setup import start_game
from engine.turn import TurnError, apply_command, legal_commands
from engine.turn.dungeon import _combat_trace
from engine.turn.operations import Transition
from scripts.audit_effects import build_card_rows, build_rows
from tests.test_setup_engine import config, request
from tests.mechanic_cases import verify_card
from tests.action_cases import verify_actions
from tests.battle_cases import verify_battles
from tests.event_cases import verify_events
from tests.system_cases import verify_system


ROOT = Path(__file__).resolve().parents[1]


def _contracts(name: str) -> list[dict[str, str]]:
    with (ROOT / "data" / "effects" / name).open(
            encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


PRINTED = _contracts("printed-contracts.csv")
ACTIVATED = _contracts("activated-contracts.csv")
TARGET = _contracts("target-contracts.csv")
BATTLE = _contracts("battle-contracts.csv")
CARD_COVERAGE = _contracts("card-coverage.csv")
MECHANICS_BY_CARD = defaultdict(list)
ACTION_CASES_BY_CARD = defaultdict(list)
BATTLE_CASES_BY_CARD = defaultdict(list)
EVENT_CASES_BY_CARD = defaultdict(list)
SYSTEM_BY_CARD = defaultdict(list)
for _ability, _kind in json.loads((ROOT / "data/effects/system-contracts.json").read_text(encoding="utf-8")).items():
    SYSTEM_BY_CARD[_ability.split("-A")[0]].append(_kind)
for _case in json.loads((ROOT / "data" / "effects" / "event-contracts.json").read_text(encoding="utf-8")):
    EVENT_CASES_BY_CARD[_case["ability_id"].split("-A")[0]].append(_case)
for _case in json.loads((ROOT / "data" / "effects" / "battle-contracts.json").read_text(encoding="utf-8")):
    BATTLE_CASES_BY_CARD[_case["ability_id"].split("-A")[0]].append(_case)
for _case in json.loads((ROOT / "data" / "effects" / "action-contracts.json").read_text(encoding="utf-8")):
    ACTION_CASES_BY_CARD[_case["ability_id"].split("-A")[0]].append(_case)
for _mechanic in json.loads((ROOT / "data" / "effects" / "mechanics.json").read_text(encoding="utf-8")):
    MECHANICS_BY_CARD[_mechanic["source_card_id"]].append(_mechanic)
PRINTED_BY_CARD: dict[str, list[dict]] = defaultdict(list)
ACTIVATED_BY_CARD: dict[str, list[dict]] = defaultdict(list)
TARGET_BY_CARD: dict[str, list[dict]] = defaultdict(list)
BATTLE_BY_CARD: dict[str, list[dict]] = defaultdict(list)
for row in PRINTED:
    PRINTED_BY_CARD[row["card_id"]].append(row)
for row in ACTIVATED:
    ACTIVATED_BY_CARD[row["card_id"]].append(row)
for row in TARGET:
    TARGET_BY_CARD[row["card_id"]].append(row)
for row in BATTLE:
    BATTLE_BY_CARD[row["card_id"]].append(row)


class CardEffectContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.snapshot = load_catalog()
        cls.cards = cls.snapshot.cards
        cls.ruleset = load_ruleset(cls.cards)
        cls.base = start_game(request(config(), seed="card-effect-contracts"),
                              snapshot=cls.snapshot)["state"]

    def _add_hand(self, state: dict, card_id: str) -> str:
        player = state["active_player_id"]
        instance_id = f"CI-{state['next_instance_sequence']:06d}"
        state["next_instance_sequence"] += 1
        state["instances"][instance_id] = {
            "card_id": card_id, "owner_player_id": player,
            "origin": "card_effect_contract", "flags": {},
        }
        state["zones"][f"player:{player}:hand"].append(instance_id)
        return instance_id

    def _verify_printed(self, card_id: str) -> None:
        card = self.cards[card_id]
        rows = PRINTED_BY_CARD[card_id]
        for row in rows:
            self.assertIn(row["source_line"], card["effect_text"].splitlines())
        state = deepcopy(self.base)
        source = self._add_hand(state, card_id)
        state["chosen_action"] = "dungeon"
        state["subphase"] = "DUNGEON_PREPARE"
        equipped = {}
        strength_changes = {}
        if "武器" in card["tags"].split("|"):
            hero = self._add_hand(state, "TS-0302")
            equipped[hero] = source
            strength_changes[hero] = {"strength": 100}
        state["battle_context"] = {"equipped_weapon_by_hero": equipped,
                                   "card_modifiers": strength_changes}
        baseline = replace(self.ruleset, mechanics=())
        trace = _combat_trace(Transition(state, self.cards, baseline), rank=1)
        component = next(item for item in trace["components"]
                         if item["instance_id"] == source)
        expected = defaultdict(int)
        for row in rows:
            expected[row["stat"]] += int(row["amount"])
        for stat, amount in expected.items():
            self.assertEqual(component[stat], amount,
                             f"{card_id} {stat} from card text")
        if equipped:
            state["battle_context"]["equipped_weapon_by_hero"] = {}
            unequipped = _combat_trace(Transition(state, self.cards, baseline),
                                       rank=1)
            self.assertNotIn(source, [item["instance_id"]
                                      for item in unequipped["components"]])

    def _verify_mechanics(self, card_id: str) -> None:
        verify_card(self, self.base, self.cards, self.ruleset, card_id)

    def _verify_actions(self, card_id: str) -> None:
        verify_actions(self, self.base, self.snapshot, self.ruleset, ACTION_CASES_BY_CARD[card_id])

    def _verify_monster_effects(self, card_id: str) -> None:
        verify_battles(self, self.base, self.snapshot, self.ruleset, BATTLE_CASES_BY_CARD[card_id])

    def _verify_events(self, card_id: str) -> None:
        verify_events(self, self.base, self.snapshot, self.ruleset, EVENT_CASES_BY_CARD[card_id])

    def _verify_system(self, card_id: str) -> None:
        verify_system(self, self.base, self.snapshot, self.ruleset, card_id, SYSTEM_BY_CARD[card_id])

    def _verify_activated(self, card_id: str) -> None:
        card = self.cards[card_id]
        for row in ACTIVATED_BY_CARD[card_id]:
            self.assertIn(row["source_line"], card["effect_text"].splitlines())
            ability = self.ruleset.by_id(row["ability_id"])
            self.assertIsNotNone(ability)
            self.assertEqual(ability.source_card_id, card_id)
            for action in row["actions"].split("|"):
                with self.subTest(ability=row["ability_id"], action=action):
                    state = deepcopy(self.base)
                    source = self._add_hand(state, card_id)
                    player = state["active_player_id"]
                    if row["op"] == "destroy_disease_draw":
                        disease_ids = [self._add_hand(state, "TS-0714")
                                       for _ in range(2)]
                    elif row["op"] == "destroy_militia_xp":
                        militia_ids = [self._add_hand(state, "TS-0001")
                                       for _ in range(2)]
                    entered = apply_command(state, {
                        "type": "ChooseAction", "player_id": player,
                        "action": action,
                    }, snapshot=self.snapshot)["state"]
                    self.assertIn({"ability_id": row["ability_id"],
                                   "source_instance_id": source}, [
                        option for command in legal_commands(
                            entered, snapshot=self.snapshot)
                        for option in command.get("options", [])])
                    command = {"type": "ActivateAbility", "player_id": player,
                               "ability_id": row["ability_id"],
                               "source_instance_id": source}
                    hand_before = len(entered["zones"][f"player:{player}:hand"])
                    xp_before = entered["players"][player]["xp"]
                    buys_before = entered["players"][player]["purchases_remaining"]
                    result = apply_command(entered, command, snapshot=self.snapshot)
                    after = result["state"]
                    amount = int(row["amount"])
                    if row["op"] == "draw":
                        draw = next(event for event in result["events"]
                                    if event["kind"] == "effect_draw")
                        self.assertEqual(draw["requested"], amount)
                        self.assertEqual(len(draw["instance_ids"]), amount)
                        self.assertEqual(len(after["zones"][f"player:{player}:hand"]),
                                         hand_before + amount)
                    elif row["op"] == "gain_xp":
                        self.assertEqual(after["players"][player]["xp"],
                                         xp_before + amount)
                    elif row["op"] in ("mod_attack", "mod_magic_attack"):
                        stat = ("attack" if row["op"] == "mod_attack"
                                else "magic_attack")
                        self.assertEqual(after["battle_context"]["modifiers"][stat],
                                         amount)
                        target = next(command["instance_ids"][0] for command in
                                      legal_commands(after, snapshot=self.snapshot)
                                      if command["type"] == "DeclareBattleTarget")
                        battle = apply_command(after, {
                            "type": "DeclareBattleTarget", "player_id": player,
                            "target_instance_id": target,
                        }, snapshot=self.snapshot, effects=replace(self.ruleset, abilities=tuple(
                            ability for ability in self.ruleset.abilities if ability.kind != "triggered")))
                        outcome = next(event for event in battle["events"]
                                       if event["kind"] == "battle_resolved")
                        self.assertEqual(outcome["calculation"]["modifiers"][stat],
                                         amount)
                    elif row["op"] == "grant_buy":
                        self.assertEqual(after["players"][player]["purchases_remaining"],
                                         buys_before + amount)
                        buying = apply_command(after, {"type": "FinishAbilities",
                                                       "player_id": player},
                                               snapshot=self.snapshot)["state"]
                        for _ in range(2):
                            buying = apply_command(buying, {"type": "BuyCard",
                                                            "player_id": player,
                                                            "card_id": "TS-0001"},
                                                    snapshot=self.snapshot)["state"]
                        self.assertEqual(buying["players"][player]["purchases_remaining"],
                                         0)
                    elif row["op"] == "destroy_self_gold":
                        self.assertIn(source, after["zones"]["destroyed"])
                        self.assertEqual(after["players"][player]["temporary_gold"],
                                         entered["players"][player]["temporary_gold"] + amount)
                    elif row["op"] in ("destroy_disease_draw", "destroy_militia_xp"):
                        candidates = after["pending_choice"]["candidate_instance_ids"]
                        expected_ids = (disease_ids if row["op"] == "destroy_disease_draw"
                                        else militia_ids)
                        self.assertTrue(set(expected_ids) <= set(candidates))
                        chosen = expected_ids[0]
                        resolved = apply_command(after, {
                            "type": "ResolveChoice", "player_id": player,
                            "instance_id": chosen,
                        }, snapshot=self.snapshot)
                        after = resolved["state"]
                        if row["op"] == "destroy_disease_draw":
                            self.assertNotIn(chosen, after["instances"])
                        else:
                            self.assertIn(chosen, after["zones"]["destroyed"])
                            self.assertIsNone(after["instances"][chosen]["owner_player_id"])
                        self.assertIn(expected_ids[1],
                                      after["zones"][f"player:{player}:hand"])
                        if row["op"] == "destroy_disease_draw":
                            draw = next(event for event in resolved["events"]
                                        if event["kind"] == "effect_draw")
                            self.assertEqual(draw["requested"], amount)
                            self.assertEqual(len(draw["instance_ids"]), amount)
                            self.assertEqual(len(after["zones"][f"player:{player}:hand"]),
                                             hand_before - 1 + amount)
                        else:
                            self.assertEqual(after["players"][player]["xp"],
                                             xp_before + amount)
                    else:
                        self.fail(f"unknown activated contract op: {row['op']}")
                    if row["usage"] == "repeatable":
                        self.assertIn({"ability_id": row["ability_id"],
                                       "source_instance_id": source}, [
                            option for next_command in legal_commands(
                                after, snapshot=self.snapshot)
                            for option in next_command.get("options", [])])
                        second = apply_command(after, command, snapshot=self.snapshot)
                        self.assertIsNone(second["state"]["pending_choice"])
                        self.assertNotIn(expected_ids[1], second["state"]["instances"])
                        self.assertFalse(any(
                            option == {"ability_id": row["ability_id"],
                                       "source_instance_id": source}
                            for next_command in legal_commands(
                                second["state"], snapshot=self.snapshot)
                            for option in next_command.get("options", [])))
                    else:
                        with self.assertRaises(TurnError):
                            apply_command(after, command, snapshot=self.snapshot)

    def _verify_target(self, card_id: str) -> None:
        card = self.cards[card_id]
        rows = TARGET_BY_CARD[card_id]
        for row in rows:
            self.assertIn(row["source_line"], card["effect_text"].splitlines())
        state = deepcopy(self.base)
        target = f"CI-{state['next_instance_sequence']:06d}"
        state["next_instance_sequence"] += 1
        state["instances"][target] = {
            "card_id": card_id, "owner_player_id": None,
            "origin": "card_effect_contract", "flags": {},
        }
        state["zones"]["hall:main"].append(target)
        state["chosen_action"] = "dungeon"
        state["subphase"] = "DUNGEON_PREPARE"
        state["timing_window"] = "DUNGEON_PREPARE"
        state["battle_context"] = {
            "equipped_weapon_by_hero": {},
            "modifiers": {"attack": 3, "magic_attack": 5},
        }
        player = state["active_player_id"]
        result = apply_command(state, {
            "type": "DeclareBattleTarget", "player_id": player,
            "target_instance_id": target,
        }, snapshot=self.snapshot, effects=replace(self.ruleset, abilities=()))
        outcome = next(event for event in result["events"]
                       if event["kind"] == "battle_resolved")
        calculation = outcome["calculation"]
        for row in rows:
            self.assertIn(row["rule"], calculation["restrictions"])
            if row["rule"] == "immune_magic_attack":
                self.assertEqual(calculation["magic_attack"], 0)
                self.assertGreater(calculation["attack"], 0)
            else:
                self.assertEqual(calculation["attack"], 0)
                self.assertGreater(calculation["magic_attack"], 0)

    def _verify_battle(self, card_id: str, *, special: bool = False) -> None:
        card = self.cards[card_id]
        for row in BATTLE_BY_CARD[card_id]:
            self.assertIn(row["source_line"], card["effect_text"].splitlines())
        state = deepcopy(self.base)
        if special:
            state["supply_rules"]["disease_mode"] = "special"
            state["supply_rules"]["disease_card_ids"] = ["TS-0715"]
            state["supply_rules"]["disease_weights"] = {"TS-0715": 1}
        target = f"CI-{state['next_instance_sequence']:06d}"
        state["next_instance_sequence"] += 1
        state["instances"][target] = {
            "card_id": card_id, "owner_player_id": None,
            "origin": "card_effect_contract", "flags": {},
        }
        state["zones"]["hall:main"].append(target)
        state["chosen_action"] = "dungeon"
        state["subphase"] = "DUNGEON_PREPARE"
        state["timing_window"] = "DUNGEON_PREPARE"
        state["battle_context"] = {"equipped_weapon_by_hero": {}}
        player = state["active_player_id"]
        expected_disease = take_disease(state, player)
        ability_ids = {row["ability_id"] for row in BATTLE_BY_CARD[card_id]}
        effects = replace(self.ruleset, abilities=tuple(
            ability for ability in self.ruleset.abilities if ability.id in ability_ids))
        result = apply_command(state, {
            "type": "DeclareBattleTarget", "player_id": player,
            "target_instance_id": target,
        }, snapshot=self.snapshot, effects=effects)
        gains = [event for event in result["events"]
                 if event["kind"] == "disease_taken_from_supply"]
        self.assertEqual(len(gains), 1, card_id)
        gain = gains[0]
        self.assertEqual(gain["card_id"], expected_disease["instance"]["card_id"])
        self.assertEqual(gain["roll"], expected_disease["events"][0]["roll"])
        self.assertIn(gain["card_id"],
                      result["state"]["supply_rules"]["disease_card_ids"])
        self.assertEqual(gain["disease_mode"], "special" if special else "normal")
        self.assertEqual(result["state"]["instances"][gain["instance_id"]][
            "owner_player_id"], player)
        self.assertTrue(any(gain["instance_id"] in pile
                            for zone, pile in result["state"]["zones"].items()
                            if zone.startswith(f"player:{player}:")))
        if special:
            self.assertEqual(gain["card_id"], "TS-0715")

    def test_battle_special_disease_supply(self) -> None:
        self._verify_battle("TS-0476", special=True)

    def test_contract_manifest_matches_exact_card_lines(self) -> None:
        pattern = re.compile(r"^(攻击|魔法攻击|光照|光照值) ([+-][0-9]+)。$")
        source = {(card_id, line) for card_id, card in self.cards.items()
                  if card["slot_kind"] == "front"
                  for line in card["effect_text"].splitlines()
                  if pattern.fullmatch(line)}
        frozen = {(row["card_id"], row["source_line"]) for row in PRINTED}
        self.assertEqual(source, frozen)
        self.assertEqual(len(PRINTED), len(frozen))
        self.assertEqual(len({row["ability_id"] for row in ACTIVATED}),
                         len(ACTIVATED))
        target_lines = {"免疫魔法攻击。", "只能使用魔法攻击。"}
        target_source = {(card_id, line) for card_id, card in self.cards.items()
                         if card["subcategory"] == "怪物"
                         for line in card["effect_text"].splitlines()
                         if line in target_lines}
        self.assertEqual(target_source,
                         {(row["card_id"], row["source_line"]) for row in TARGET})
        battle_line = "战斗：获得 1 张疾病。"
        battle_source = {card_id for card_id, card in self.cards.items()
                         if card["subcategory"] == "怪物"
                         and battle_line in card["effect_text"].splitlines()}
        self.assertEqual(battle_source,
                         {row["card_id"] for row in BATTLE})

    def _special_disease(self, kind: str, randomizer_id: str) -> None:
        rules = config()
        rules["selection"][kind]["fixed_randomizer_ids"] = [randomizer_id]
        state = start_game(request(rules, seed=f"disease-{randomizer_id}"),
                           snapshot=self.snapshot)["state"]
        self.assertIn(randomizer_id, state["selected_groups"][kind])
        self.assertEqual(state["supply_rules"]["disease_mode"], "special")
        player = state["active_player_id"]
        gained = take_disease(state, player)
        self.assertIn(gained["instance"]["card_id"],
                      state["supply_rules"]["disease_card_ids"])
        self.assertNotIn("TS-0714", state["supply_rules"]["disease_card_ids"])

    def test_setup_TS_0034(self) -> None:
        self._special_disease("monster", "TS-0034")

    def test_setup_TS_0035(self) -> None:
        self._special_disease("monster", "TS-0035")

    def test_setup_TS_0148(self) -> None:
        self._special_disease("hero", "TS-0148")

    def test_setup_TS_0191(self) -> None:
        rules = config()
        rules["selection"]["dungeon_features"]["mode"] = "manual"
        rules["selection"]["environment"]["fixed_card_ids"] = ["TS-0191"]
        state = start_game(request(rules, seed="doomgate-card-test"),
                           snapshot=self.snapshot)["state"]
        self.assertEqual(state["active_settings"], ["TS-0191"])
        self.assertEqual(len(state["selected_groups"]["monster"]), 4)

    def test_setup_TS_0188(self) -> None:
        rules = config()
        rules["selection"]["dungeon_features"]["mode"] = "manual"
        rules["selection"]["environment"]["fixed_card_ids"] = ["TS-0188"]
        state = start_game(request(rules, seed="swamp-card-test"),
                           snapshot=self.snapshot)["state"]
        self.assertEqual(state["active_settings"], ["TS-0188"])
        self.assertEqual(len(state["zones"]["hall:main"]), 4)

    def _verify_environment_light(self, card_id: str, penalty: int) -> None:
        state = deepcopy(self.base)
        self.assertIn("惩罚", self.cards[card_id]["effect_text"])
        state["active_settings"] = [card_id]
        state["chosen_action"] = "dungeon"
        state["subphase"] = "DUNGEON_PREPARE"
        player = state["active_player_id"]
        state["zones"][f"player:{player}:discard"].extend(state["zones"][f"player:{player}:hand"])
        state["zones"][f"player:{player}:hand"] = []
        state["battle_context"] = {"equipped_weapon_by_hero": {}}
        for rank in (1, 2, 3):
            trace = _combat_trace(Transition(state, self.cards, self.ruleset), rank)
            self.assertEqual(trace["darkness_penalty"], penalty)
            self.assertEqual(trace["effective_attack"],
                             max(0, trace["attack"] + trace["magic_attack"] - penalty))
        if card_id == "TS-0193":
            self._add_hand(state, "TS-0003")
            for rank in (0, 1, 2, 3):
                trace = _combat_trace(Transition(state, self.cards, self.ruleset), rank)
                self.assertEqual(trace["darkness_penalty"], 0)

    def test_environment_TS_0193(self) -> None:
        self._verify_environment_light("TS-0193", 2)

    def test_environment_TS_0194(self) -> None:
        self._verify_environment_light("TS-0194", 0)

    def test_setup_TS_0192(self) -> None:
        rules = config()
        rules["selection"]["dungeon_features"]["mode"] = "manual"
        rules["selection"]["environment"]["fixed_card_ids"] = ["TS-0192"]
        state = start_game(request(rules, seed="sanctuary-card-test"),
                           snapshot=self.snapshot)["state"]
        self.assertEqual(state["active_settings"], ["TS-0192"])
        self.assertEqual(len(state["selected_groups"]["village"]), 10)
        self.assertEqual(len(state["selected_groups"]["hero"]), 3)

    def test_every_complete_card_has_a_named_behavior_test(self) -> None:
        with (ROOT / "data" / "effects" / "card-coverage.csv").open(
                encoding="utf-8-sig", newline="") as handle:
            recorded = list(csv.DictReader(handle))
        current, _ = build_card_rows(build_rows()[0])
        self.assertEqual(recorded, current,
                         "card coverage report must match reviewed rules")
        self.assertEqual({row["card_id"] for row in recorded},
                         {card_id for card_id, card in self.cards.items()
                          if card["slot_kind"] == "front"
                          and card["effect_text"].strip()})
        for row in recorded:
            self.assertTrue(hasattr(self, f"test_effect_{row['card_id'].replace('-', '_')}"),
                            f"effect card lacks a test entry: {row['card_id']}")
        complete = [row["card_id"] for row in recorded
                    if row["status"] == "COMPLETE"]
        self.assertEqual(len(complete), len(recorded),
                         "every effect card must have executable, tested bindings")
        for card_id in complete:
            suffix = card_id.replace("-", "_")
            self.assertTrue(any(hasattr(self, f"test_{kind}_{suffix}")
                                for kind in ("printed", "activated", "target",
                                             "battle", "setup", "environment", "mechanics", "actions", "monster_effects", "events", "system")),
                            f"complete card lacks a named behavior test: {card_id}")


def _make_printed(card_id: str):
    def test(self: CardEffectContractTests) -> None:
        self._verify_printed(card_id)
    return test


def _make_activated(card_id: str):
    def test(self: CardEffectContractTests) -> None:
        self._verify_activated(card_id)
    return test


def _make_target(card_id: str):
    def test(self: CardEffectContractTests) -> None:
        self._verify_target(card_id)
    return test


def _make_battle(card_id: str):
    def test(self: CardEffectContractTests) -> None:
        self._verify_battle(card_id)
    return test


def _make_mechanics(card_id: str):
    def test(self: CardEffectContractTests) -> None:
        self._verify_mechanics(card_id)
    return test


def _make_actions(card_id: str):
    def test(self: CardEffectContractTests) -> None:
        self._verify_actions(card_id)
    return test


def _make_monster_effects(card_id: str):
    def test(self: CardEffectContractTests) -> None:
        self._verify_monster_effects(card_id)
    return test


def _make_card(card_id: str, status: str, pending: str):
    def test(self: CardEffectContractTests) -> None:
        self.assertEqual(status, "COMPLETE", f"unfinished card {card_id}: {pending}")
        if card_id in PRINTED_BY_CARD:
            self._verify_printed(card_id)
        if card_id in ACTIVATED_BY_CARD:
            self._verify_activated(card_id)
        if card_id in TARGET_BY_CARD:
            self._verify_target(card_id)
        if card_id in BATTLE_BY_CARD:
            self._verify_battle(card_id)
        if card_id in MECHANICS_BY_CARD:
            self._verify_mechanics(card_id)
        if card_id in ACTION_CASES_BY_CARD:
            self._verify_actions(card_id)
        if card_id in BATTLE_CASES_BY_CARD:
            self._verify_monster_effects(card_id)
        if card_id in EVENT_CASES_BY_CARD:
            self._verify_events(card_id)
        if card_id in SYSTEM_BY_CARD:
            self._verify_system(card_id)
        for kind in ("setup", "environment"):
            named = getattr(self, f"test_{kind}_{card_id.replace('-', '_')}", None)
            if named is not None:
                named()
    return test


for _card_id in sorted(PRINTED_BY_CARD):
    setattr(CardEffectContractTests, f"test_printed_{_card_id.replace('-', '_')}",
            _make_printed(_card_id))
for _card_id in sorted(ACTIVATED_BY_CARD):
    setattr(CardEffectContractTests, f"test_activated_{_card_id.replace('-', '_')}",
            _make_activated(_card_id))
for _card_id in sorted(TARGET_BY_CARD):
    setattr(CardEffectContractTests, f"test_target_{_card_id.replace('-', '_')}",
            _make_target(_card_id))
for _card_id in sorted(BATTLE_BY_CARD):
    setattr(CardEffectContractTests, f"test_battle_{_card_id.replace('-', '_')}",
            _make_battle(_card_id))
for _row in CARD_COVERAGE:
    _card_id = _row["card_id"]
    setattr(CardEffectContractTests, f"test_effect_{_card_id.replace('-', '_')}",
            _make_card(_card_id, _row["status"], _row["pending_ability_ids"]))
for _card_id in sorted(MECHANICS_BY_CARD):
    setattr(CardEffectContractTests, f"test_mechanics_{_card_id.replace('-', '_')}",
            _make_mechanics(_card_id))
for _card_id in sorted(ACTION_CASES_BY_CARD):
    setattr(CardEffectContractTests, f"test_actions_{_card_id.replace('-', '_')}",
            _make_actions(_card_id))
for _card_id in sorted(BATTLE_CASES_BY_CARD):
    setattr(CardEffectContractTests, f"test_monster_effects_{_card_id.replace('-', '_')}",
            _make_monster_effects(_card_id))
for _card_id in sorted(EVENT_CASES_BY_CARD):
    def _event_test(self, card_id=_card_id):
        self._verify_events(card_id)
    setattr(CardEffectContractTests, f"test_events_{_card_id.replace('-', '_')}", _event_test)
for _card_id in sorted(SYSTEM_BY_CARD):
    def _system_test(self, card_id=_card_id):
        self._verify_system(card_id)
    setattr(CardEffectContractTests, f"test_system_{_card_id.replace('-', '_')}", _system_test)


if __name__ == "__main__":
    unittest.main()
