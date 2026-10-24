"""Validation of the rule draft before players are attached to a match."""

from __future__ import annotations

import unittest
import csv
from pathlib import Path
from backend.app.core.paths import PROJECT_ROOT

from backend.app.integrations.game_engine.api import (effective_copy_count, effective_group_counts,
                                 load_panel_catalog, validate_rules_config)


class RulesInputTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.catalog = load_panel_catalog()

    def draft(self) -> dict:
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

    def test_catalog_options_are_backed_by_cards(self) -> None:
        self.assertEqual([len(self.catalog["groups"][kind])
                          for kind in ("village", "hero", "monster")], [91, 52, 39])
        self.assertEqual([len(self.catalog["dungeon_cards"][kind])
                          for kind in ("guardian", "environment")], [11, 12])
        self.assertEqual([len(self.catalog["dungeon_groups"][kind])
                          for kind in ("trap", "treasure")], [3, 4])
        self.assertEqual([sum(len(group["members"]) for group in self.catalog["dungeon_groups"][kind])
                          for kind in ("trap", "treasure")], [10, 13])
        root = PROJECT_ROOT
        for kind in ("trap", "treasure"):
            for group in self.catalog["dungeon_groups"][kind]:
                self.assertEqual(len(group["images"]), len(group["members"]))
                self.assertTrue(all((root / "cards" / "assets" / image.rsplit("/", 1)[-1]).is_file()
                                    for image in group["images"]))
        for kind in ("guardian", "environment"):
            self.assertTrue(all(item["copy_count"] > 0
                                for item in self.catalog["dungeon_cards"][kind]))

    def test_default_draft_and_fixed_group_are_valid(self) -> None:
        draft = self.draft()
        self.assertEqual(validate_rules_config(draft, self.catalog), [])
        draft["selection"]["hero"]["fixed_randomizer_ids"] = [self.catalog["groups"]["hero"][0]["id"]]
        draft["instance_multipliers"]["hero"] = 4
        self.assertEqual(validate_rules_config(draft, self.catalog), [])
        self.assertNotIn("content_set", draft)
        self.assertNotIn("copy_count_overrides", draft)

    def test_fixed_groups_cannot_exceed_target(self) -> None:
        draft = self.draft()
        draft["counts"]["monster_groups"] = 1
        draft["selection"]["monster"]["fixed_randomizer_ids"] = ["TS-0005", "TS-0006"]
        paths = {issue["path"] for issue in validate_rules_config(draft, self.catalog)}
        self.assertIn("counts.monster_groups", paths)

    def test_invalid_multiplier_and_card_reference_are_reported(self) -> None:
        draft = self.draft()
        draft["selection"]["dungeon_features"]["mode"] = "manual"
        draft["instance_multipliers"]["hero"] = 6
        draft["selection"]["environment"]["fixed_card_ids"] = ["TS-0001"]
        paths = {issue["path"] for issue in validate_rules_config(draft, self.catalog)}
        self.assertIn("instance_multipliers.hero", paths)
        self.assertIn("selection.environment.fixed_card_ids", paths)

    def test_extra_random_and_fixed_cards_or_groups_are_valid(self) -> None:
        draft = self.draft()
        draft["selection"]["dungeon_features"]["mode"] = "manual"
        draft["selection"]["guardian"] = {
                "random_count": 1,
                "fixed_card_ids": [self.catalog["dungeon_cards"]["guardian"][0]["id"]],
        }
        for kind in ("trap", "treasure"):
            draft["selection"][kind] = {
                "random_count": 1,
                "fixed_group_ids": [self.catalog["dungeon_groups"][kind][0]["id"]],
            }
        draft["selection"]["environment"]["random_count"] = 1
        draft["selection"]["thunderstone"]["fixed_card_ids"] = [self.catalog["thunderstones"][0]["id"]]
        self.assertEqual(validate_rules_config(draft, self.catalog), [])

    def test_environment_is_limited_and_random_pool_must_suffice(self) -> None:
        draft = self.draft()
        draft["selection"]["dungeon_features"]["mode"] = "manual"
        draft["selection"]["environment"]["random_count"] = 1
        draft["selection"]["environment"]["fixed_card_ids"] = [
            self.catalog["dungeon_cards"]["environment"][0]["id"]]
        draft["selection"]["trap"]["random_count"] = 3
        draft["selection"]["trap"]["fixed_group_ids"] = [
            self.catalog["dungeon_groups"]["trap"][0]["id"]]
        paths = {issue["path"] for issue in validate_rules_config(draft, self.catalog)}
        self.assertIn("selection.environment", paths)
        self.assertIn("selection.trap.random_count", paths)

    def test_individual_trap_is_not_a_group_choice(self) -> None:
        draft = self.draft()
        draft["selection"]["dungeon_features"]["mode"] = "manual"
        draft["selection"]["trap"]["fixed_group_ids"] = ["TS-0684"]
        paths = {issue["path"] for issue in validate_rules_config(draft, self.catalog)}
        self.assertIn("selection.trap.fixed_group_ids", paths)

    def test_classic_random_and_manual_features_are_exclusive(self) -> None:
        draft = self.draft()
        draft["selection"]["guardian"]["random_count"] = 1
        paths = {issue["path"] for issue in validate_rules_config(draft, self.catalog)}
        self.assertIn("selection.guardian", paths)
        draft["selection"]["dungeon_features"]["mode"] = "manual"
        self.assertEqual(validate_rules_config(draft, self.catalog), [])

    def test_environment_changes_effective_group_targets(self) -> None:
        counts = {"village_groups": 8, "hero_groups": 4, "monster_groups": 3}
        self.assertEqual(effective_group_counts(counts, "TS-0191"),
                         {"village": 8, "hero": 4, "monster": 4})
        self.assertEqual(effective_group_counts(counts, "TS-0192"),
                         {"village": 10, "hero": 3, "monster": 3})
        self.assertEqual(effective_group_counts(counts, "TS-0198"),
                         {"village": 8, "hero": 4, "monster": 4})
        draft = self.draft()
        draft["selection"]["dungeon_features"]["mode"] = "manual"
        draft["selection"]["environment"]["fixed_card_ids"] = ["TS-0191"]
        draft["selection"]["monster"]["fixed_randomizer_ids"] = [
            group["id"] for group in self.catalog["groups"]["monster"][:4]]
        self.assertEqual(validate_rules_config(draft, self.catalog), [])
        draft["selection"]["environment"]["fixed_card_ids"] = ["TS-0192"]
        paths = {issue["path"] for issue in validate_rules_config(draft, self.catalog)}
        self.assertIn("counts.monster_groups", paths)

    def test_special_environment_constraints(self) -> None:
        draft = self.draft()
        draft["selection"]["dungeon_features"]["mode"] = "manual"
        draft["selection"]["environment"]["fixed_card_ids"] = ["TS-0198"]
        draft["selection"]["monster"]["fixed_randomizer_ids"] = [
            group["id"] for group in self.catalog["groups"]["monster"][:4]]
        draft["selection"]["thunderstone"]["fixed_card_ids"] = [
            card["id"] for card in self.catalog["thunderstones"][:2]]
        self.assertEqual(validate_rules_config(draft, self.catalog), [])
        draft["selection"]["environment"]["fixed_card_ids"] = []
        paths = {issue["path"] for issue in validate_rules_config(draft, self.catalog)}
        self.assertIn("selection.thunderstone.fixed_card_ids", paths)
        draft["selection"]["environment"]["fixed_card_ids"] = ["TS-0199"]
        draft["selection"]["monster"]["fixed_randomizer_ids"] = []
        draft["selection"]["thunderstone"]["fixed_card_ids"] = [
            card["id"] for card in self.catalog["thunderstones"]]
        paths = {issue["path"] for issue in validate_rules_config(draft, self.catalog)}
        self.assertIn("selection.guardian.fixed_card_ids", paths)
        draft["selection"]["guardian"]["fixed_card_ids"] = ["TS-0683"]
        self.assertEqual(validate_rules_config(draft, self.catalog), [])

    def test_random_environment_candidates_can_trim_fixed_groups(self) -> None:
        draft = self.draft()
        draft["counts"]["hero_groups"] = 0
        paths = {issue["path"] for issue in validate_rules_config(draft, self.catalog)}
        self.assertIn("counts.hero_groups", paths)
        draft = self.draft()
        draft["selection"]["dungeon_features"]["mode"] = "manual"
        draft["selection"]["environment"]["random_count"] = 1
        draft["counts"]["monster_groups"] = 5
        draft["selection"]["monster"]["fixed_randomizer_ids"] = [
            group["id"] for group in self.catalog["groups"]["monster"][:5]]
        paths = {issue["path"] for issue in validate_rules_config(draft, self.catalog)}
        self.assertNotIn("counts.monster_groups", paths)

    def test_multiplier_applies_to_each_matching_csv_card(self) -> None:
        draft = self.draft()
        draft["instance_multipliers"] = {"village": 2, "hero": 3, "monster": 5}
        with (PROJECT_ROOT / "cards" / "cards.csv").open(
            encoding="utf-8-sig", newline=""
        ) as handle:
            cards = list(csv.DictReader(handle))
        village = next(card for card in cards if card["card_type"] == "村庄牌")
        village_hero = next(card for card in cards if card["card_type"] == "村庄牌"
                            and "英雄" in card["tags"].split("|"))
        heroes = [card for card in cards if card["card_type"] == "英雄牌"]
        monster = next(card for card in cards if card["subcategory"] == "怪物")
        guardian = next(card for card in cards if card["subcategory"] == "守护者")
        self.assertEqual(effective_copy_count(village, draft), int(village["initial_copy_count"]) * 2)
        self.assertEqual(effective_copy_count(village_hero, draft),
                         int(village_hero["initial_copy_count"]) * 2)
        for level in ("1", "4"):
            hero = next(card for card in heroes if card["wiki_英雄等级"] == level)
            self.assertEqual(effective_copy_count(hero, draft), int(hero["initial_copy_count"]) * 3)
        self.assertEqual(effective_copy_count(monster, draft), int(monster["initial_copy_count"]) * 5)
        self.assertEqual(effective_copy_count(guardian, draft), int(guardian["initial_copy_count"]))


if __name__ == "__main__":
    unittest.main()
