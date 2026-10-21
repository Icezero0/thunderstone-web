"""Integration checks for deterministic game setup and environment branches."""

from __future__ import annotations

import copy
import csv
import json
import unittest
from collections import Counter
from pathlib import Path

from engine.input_config import load_panel_catalog
from engine.disease import take_disease
from engine.setup import SetupChoiceRequired, SetupError, SetupRng, start_game
from scripts.run_config_panel import setup_response


def config() -> dict:
    return {
        "mode": "classic",
        "counts": {"village_groups": 8, "hero_groups": 4, "monster_groups": 3},
        "selection": {
            "village": {"fixed_randomizer_ids": []},
            "hero": {"fixed_randomizer_ids": []},
            "monster": {"fixed_randomizer_ids": []},
            "dungeon_features": {"mode": "classic_random"},
            "guardian": {"random_count": 0, "fixed_card_ids": []},
            "environment": {"random_count": 0, "fixed_card_ids": []},
            "trap": {"random_count": 0, "fixed_group_ids": []},
            "treasure": {"random_count": 0, "fixed_group_ids": []},
            "thunderstone": {"fixed_card_ids": []},
        },
        "instance_multipliers": {"village": 1, "hero": 1, "monster": 1},
    }


def request(rules: dict | None = None, seed: str = "setup-test") -> dict:
    return {"match_id": "match-1", "player_ids": ["alice", "bob"],
            "rng_seed": seed, "config": rules if rules is not None else config()}


class SetupEngineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.catalog = load_panel_catalog()

    def test_default_setup_is_repeatable_and_has_complete_zones(self) -> None:
        result = start_game(request())
        self.assertEqual(result, start_game(request()))
        state = result["state"]
        self.assertEqual(state["phase"], "PLAYING")
        self.assertEqual({kind: len(groups) for kind, groups in state["selected_groups"].items()},
                         {"monster": 3, "hero": 4, "village": 8})
        self.assertEqual(len(state["zones"]["hall:main"]), 3)
        self.assertEqual(len(state["selected_thunderstones"]), 1)
        bottom = state["zones"]["dungeon:main"][-11:]
        self.assertEqual(sum(state["instances"][item]["card_id"] in
                             state["selected_thunderstones"] for item in bottom), 1)
        for player in ("alice", "bob"):
            hand = state["zones"][f"player:{player}:hand"]
            draw = state["zones"][f"player:{player}:draw"]
            self.assertEqual((len(hand), len(draw)), (6, 6))
            cards = [state["instances"][item]["card_id"] for item in hand + draw]
            self.assertEqual({item: cards.count(item) for item in set(cards)},
                             {"TS-0001": 6, "TS-0002": 2,
                              "TS-0003": 2, "TS-0004": 2})
        all_zone_ids = [item for pile in state["zones"].values() for item in pile]
        self.assertEqual(len(all_zone_ids), len(set(all_zone_ids)))
        self.assertEqual(set(all_zone_ids), set(state["instances"]))
        self.assertTrue(any(event["kind"] == "setup_complete" for event in result["events"]))

    def test_fixed_environment_adjusts_counts_and_multipliers(self) -> None:
        rules = config()
        rules["selection"]["dungeon_features"]["mode"] = "manual"
        rules["selection"]["environment"]["fixed_card_ids"] = ["TS-0191"]
        rules["instance_multipliers"]["monster"] = 2
        state = start_game(request(rules))["state"]
        self.assertEqual(len(state["selected_groups"]["monster"]), 4)
        group_id = state["selected_groups"]["monster"][0]
        member_id = next(group["members"][0] for group in self.catalog["groups"]["monster"]
                         if group["id"] == group_id)
        copies = sum(instance["card_id"] == member_id
                     for instance in state["instances"].values())
        with (Path(__file__).resolve().parents[1] / "data" / "cards.csv").open(
                encoding="utf-8-sig", newline="") as handle:
            source = next(row for row in csv.DictReader(handle) if row["card_id"] == member_id)
        self.assertEqual(copies, int(source["initial_copy_count"]) * 2)
        self.assertEqual(state["active_settings"], ["TS-0191"])

    def test_classic_feature_entry_resolves_to_real_treasure_cards(self) -> None:
        result = start_game(request(seed="1"))
        state = result["state"]
        self.assertIn("TS-0200", state["selected_features"]["treasure"])
        self.assertEqual(len(state["selected_groups"]["monster"]), 3)
        self.assertTrue(any(event["kind"] == "feature" and
                            event["feature_id"] == "TS-0200" for event in result["events"]))
        member_ids = next(group["members"] for group in self.catalog["dungeon_groups"]["treasure"]
                          if group["id"] == "TS-0200")
        self.assertTrue(all(any(instance["card_id"] == member_id
                                for instance in state["instances"].values())
                            for member_id in member_ids))

    def test_random_environment_discards_excess_fixed_hero_group(self) -> None:
        rules = config()
        rules["selection"]["dungeon_features"]["mode"] = "manual"
        rules["selection"]["environment"]["random_count"] = 1
        fixed = [group["id"] for group in self.catalog["groups"]["hero"][:4]]
        rules["selection"]["hero"]["fixed_randomizer_ids"] = fixed
        environments = [item["id"] for item in self.catalog["dungeon_cards"]["environment"]]
        target_index = environments.index("TS-0192")
        seed = next(str(value) for value in range(1000)
                    if SetupRng(str(value)).randbelow(len(environments)) == target_index)
        result = start_game(request(rules, seed))
        state = result["state"]
        self.assertEqual(state["selected_features"]["environment"], ["TS-0192"])
        self.assertEqual(len(state["selected_groups"]["hero"]), 3)
        self.assertEqual(len(set(fixed) - set(state["selected_groups"]["hero"])), 1)
        self.assertEqual(len([event for event in result["events"]
                              if event["kind"] == "group_removed_by_environment"]), 1)

    def test_dragonspire_requires_explicit_split_and_builds_two_dungeons(self) -> None:
        rules = config()
        rules["selection"]["dungeon_features"]["mode"] = "manual"
        rules["selection"]["environment"]["fixed_card_ids"] = ["TS-0198"]
        frozen = request(rules)
        with self.assertRaises(SetupChoiceRequired) as context:
            start_game(frozen)
        choice = context.exception.choice
        self.assertEqual(len(choice["group_ids"]), 4)
        frozen["scenario_choices"] = {"two_dungeons": {
            "group_a_ids": choice["group_ids"][:2], "group_a_feature_ids": []}}
        state = start_game(frozen)["state"]
        self.assertEqual(len(state["selected_thunderstones"]), 2)
        for suffix in ("a", "b"):
            self.assertEqual(len(state["zones"][f"hall:{suffix}"]), 3)
            bottom = state["zones"][f"dungeon:{suffix}"][-6:]
            self.assertEqual(sum(state["instances"][item]["card_id"] in
                                 state["selected_thunderstones"] for item in bottom), 1)

    def test_random_dragonspire_discards_one_of_five_fixed_monster_groups(self) -> None:
        rules = config()
        rules["counts"]["monster_groups"] = 5
        rules["selection"]["dungeon_features"]["mode"] = "manual"
        rules["selection"]["environment"]["random_count"] = 1
        fixed = [group["id"] for group in self.catalog["groups"]["monster"][:5]]
        rules["selection"]["monster"]["fixed_randomizer_ids"] = fixed
        environments = [item["id"] for item in self.catalog["dungeon_cards"]["environment"]]
        target_index = environments.index("TS-0198")
        seed = next(str(value) for value in range(1000)
                    if SetupRng(str(value)).randbelow(len(environments)) == target_index)
        frozen = request(rules, seed)
        with self.assertRaises(SetupChoiceRequired) as context:
            start_game(frozen)
        choice = context.exception.choice
        self.assertEqual(len(choice["group_ids"]), 4)
        frozen["scenario_choices"] = {"two_dungeons": {
            "group_a_ids": choice["group_ids"][:2], "group_a_feature_ids": []}}
        result = start_game(frozen)
        self.assertEqual(len(set(fixed) - set(result["state"]["selected_groups"]["monster"])), 1)
        self.assertEqual(len([event for event in result["events"]
                              if event["kind"] == "group_removed_by_environment"]), 1)

    def test_banishing_ritual_places_heart_at_bottom(self) -> None:
        rules = config()
        rules["selection"]["dungeon_features"]["mode"] = "manual"
        rules["selection"]["environment"]["fixed_card_ids"] = ["TS-0199"]
        rules["selection"]["guardian"]["fixed_card_ids"] = ["TS-0683"]
        rules["selection"]["thunderstone"]["fixed_card_ids"] = [
            card["id"] for card in self.catalog["thunderstones"]]
        state = start_game(request(rules))["state"]
        self.assertEqual(len(state["selected_thunderstones"]), 7)
        bottom = state["zones"]["dungeon:main"][-1]
        self.assertEqual(state["instances"][bottom]["card_id"], "TS-0683")

    def test_banishing_ritual_skips_stones_in_initial_hall(self) -> None:
        rules = config()
        selection = rules["selection"]
        selection["dungeon_features"]["mode"] = "manual"
        selection["village"]["fixed_randomizer_ids"] = ["TS-0088"]
        selection["hero"]["fixed_randomizer_ids"] = ["TS-0164"]
        selection["environment"]["fixed_card_ids"] = ["TS-0199"]
        selection["thunderstone"]["fixed_card_ids"] = [
            f"TS-{number:04d}" for number in range(707, 714)]
        selection["guardian"]["random_count"] = 3
        selection["guardian"]["fixed_card_ids"] = ["TS-0683"]
        status, result = setup_response(request(rules, "b1885f4d5c7a7c9b"))
        self.assertEqual((status, result["status"]), (200, "ready"))
        state = result["state"]
        hall_cards = [state["instances"][item]["card_id"]
                      for item in state["zones"]["hall:main"]]
        self.assertEqual(len(hall_cards), 3)
        self.assertTrue(all(card_id not in state["selected_thunderstones"]
                            for card_id in hall_cards))
        skipped = [event["instance_id"] for event in result["events"]
                   if event["kind"] == "setup_hall_stone_skipped"]
        self.assertTrue(skipped)
        deck = state["zones"]["dungeon:main"]
        self.assertEqual(deck[:len(skipped)], skipped)
        self.assertEqual(state["instances"][deck[-1]]["card_id"], "TS-0683")
        self.assertEqual({state["instances"][item]["card_id"] for item in deck}
                         & set(state["selected_thunderstones"]),
                         set(state["selected_thunderstones"]))
        guardian_cards = {state["instances"][item]["card_id"] for item in deck[-11:-1]}
        self.assertTrue(set(state["selected_features"]["guardian"]) - {"TS-0683"}
                        <= guardian_cards)

    def test_other_environment_setup_effects(self) -> None:
        rules = config()
        rules["selection"]["dungeon_features"]["mode"] = "manual"
        rules["selection"]["environment"]["fixed_card_ids"] = ["TS-0188"]
        state = start_game(request(rules))["state"]
        self.assertEqual(len(state["zones"]["hall:main"]), 4)
        rules["selection"]["environment"]["fixed_card_ids"] = ["TS-0197"]
        result = start_game(request(rules))
        state = result["state"]
        self.assertEqual(len(state["zones"]["hall:main"]), 3)
        destroyed = state["zones"]["destroyed"]
        supply_zones = [zone for zone in state["zones"] if zone.startswith("village_supply:")]
        self.assertEqual(len(destroyed), 2 * len(supply_zones))
        self.assertEqual(len([event for event in result["events"]
                              if event["kind"] == "stormhold_supply_destroyed"]),
                         len(supply_zones))

    def test_normal_disease_supply_is_infinite_and_creates_owned_instances(self) -> None:
        rules = config()
        rules["selection"]["dungeon_features"]["mode"] = "manual"
        for kind, count in (("monster", 3), ("hero", 4)):
            rules["selection"][kind]["fixed_randomizer_ids"] = [
                group["id"] for group in self.catalog["groups"][kind]
                if group["id"] not in ("TS-0034", "TS-0035", "TS-0148")][:count]
        initial = start_game(request(rules, "disease-test"))["state"]
        self.assertEqual(initial["supply_rules"]["disease_mode"], "normal")
        self.assertEqual(initial["supply_rules"]["disease_weights"], {"TS-0714": 24})
        self.assertFalse(any(zone.startswith("disease") for zone in initial["zones"]))
        self.assertFalse(any(instance["card_id"] == "TS-0714"
                             for instance in initial["instances"].values()))

        state = initial
        instance_ids = []
        for _ in range(26):
            result = take_disease(state, "alice")
            state = result["state"]
            instance_ids.append(result["instance_id"])
            self.assertEqual(result["instance"]["card_id"], "TS-0714")
            self.assertEqual(result["instance"]["owner_player_id"], "alice")
            self.assertEqual(state["zones"]["player:alice:discard"][-1],
                             result["instance_id"])
        self.assertEqual(len(set(instance_ids)), 26)
        self.assertEqual(len(state["zones"]["player:alice:discard"]), 26)
        self.assertEqual(state["game_version"], initial["game_version"] + 26)
        self.assertEqual(state["rng_state"]["counter"],
                         initial["rng_state"]["counter"] + 26)
        self.assertEqual(initial["zones"]["player:alice:discard"], [])
        with self.assertRaises(SetupError):
            take_disease(initial, "unknown")

    def test_special_disease_triggers_use_weighted_supply(self) -> None:
        expected = {"TS-0715": 10, "TS-0716": 3, "TS-0717": 3,
                    "TS-0718": 3, "TS-0719": 3, "TS-0720": 3}
        for kind, randomizer_id in (("monster", "TS-0034"),
                                    ("monster", "TS-0035"),
                                    ("hero", "TS-0148")):
            rules = config()
            rules["selection"]["dungeon_features"]["mode"] = "manual"
            rules["selection"][kind]["fixed_randomizer_ids"] = [randomizer_id]
            initial = start_game(request(rules, f"special-{randomizer_id}"))["state"]
            self.assertEqual(initial["supply_rules"]["disease_mode"], "special")
            self.assertEqual(initial["supply_rules"]["disease_weights"], expected)
            first = take_disease(initial, "alice")
            restored = json.loads(json.dumps(initial, ensure_ascii=False))
            replayed = take_disease(restored, "alice")
            self.assertEqual(first, replayed)
            self.assertIn(first["instance"]["card_id"], expected)
            self.assertEqual(first["events"][0]["total_weight"], 25)
        observed = Counter()
        state = initial
        for _ in range(100):
            draw = take_disease(state, "alice")
            state = draw["state"]
            observed[draw["instance"]["card_id"]] += 1
        self.assertEqual(set(observed), set(expected))
        self.assertTrue(all(observed["TS-0715"] > observed[card_id]
                            for card_id in expected if card_id != "TS-0715"))

    def test_bad_request_does_not_publish_partial_state(self) -> None:
        frozen = request()
        frozen["player_ids"] = ["alice", "alice"]
        with self.assertRaises(SetupError):
            start_game(frozen)
        frozen = request(copy.deepcopy(config()))
        frozen["config"]["selection"]["hero"]["fixed_randomizer_ids"] = ["TS-9999"]
        with self.assertRaises(SetupError) as context:
            start_game(frozen)
        self.assertTrue(context.exception.issues)

    def test_panel_setup_endpoint_response_shapes(self) -> None:
        status, result = setup_response(request())
        self.assertEqual((status, result["status"]), (200, "ready"))
        self.assertIn("hall:main", result["state"]["zones"])
        self.assertGreater(len(json.dumps(result, ensure_ascii=False)), 1000)
        rules = config()
        rules["selection"]["dungeon_features"]["mode"] = "manual"
        rules["selection"]["environment"]["fixed_card_ids"] = ["TS-0198"]
        frozen = request(rules)
        status, result = setup_response(frozen)
        self.assertEqual((status, result["status"]), (200, "choice_required"))
        self.assertEqual(result["choice"]["group_a_count"], 2)
        frozen["scenario_choices"] = {"two_dungeons": {
            "group_a_ids": result["choice"]["group_ids"][:2],
            "group_a_feature_ids": [],
        }}
        status, result = setup_response(frozen)
        self.assertEqual((status, result["status"]), (200, "ready"))
        self.assertIn("hall:b", result["state"]["zones"])
        bad = request()
        bad["player_ids"] = []
        status, result = setup_response(bad)
        self.assertEqual((status, result["status"]), (422, "error"))


if __name__ == "__main__":
    unittest.main()
