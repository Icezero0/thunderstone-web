"""Check published IDs, order, and image paths in the final catalog."""

from __future__ import annotations

import csv
import json
import unittest
from collections import defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def tag_group(card: dict[str, str]) -> tuple[str, ...]:
    return tuple(sorted(set(filter(None, card["tags"].split("|")))))


def is_color_dragon(card: dict[str, str]) -> bool:
    tags = [tag for tag in card["tags"].split("|") if tag != "怪物"]
    return (card["card_type"] == "地下城牌" and card["subcategory"] == "怪物"
            and len(tags) == 2 and tags[0] == "龙"
            and tags[1] in {"白龙", "红龙", "绿龙", "蓝龙", "黑龙"})


def read_csv(name: str) -> list[dict[str, str]]:
    with (ROOT / "data" / name).open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


class CatalogIntegrityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.cards = read_csv("cards.csv")
        cls.fronts = [card for card in cls.cards if card["slot_kind"] == "front"]

    def test_ids_and_order_match_published_catalog(self) -> None:
        self.assertEqual(len({card["source_card_id"] for card in self.cards}), len(self.cards))
        self.assertEqual(len({card["card_id"] for card in self.cards}), len(self.cards))
        self.assertEqual([int(card["catalog_order"]) for card in self.cards], list(range(1, len(self.cards) + 1)))
        self.assertEqual([card["card_id"] for card in self.fronts],
                         [f"TS-{index:04d}" for index in range(1, len(self.fronts) + 1)])
        self.assertEqual([card["card_id"] for card in self.cards[-2:]], ["TS-REFERENCE-001", "TS-BACK-001"])

    def test_special_positions_and_grouped_numeric_values(self) -> None:
        self.assertEqual([(card["card_id"], card["name"]) for card in self.fronts[:4]],
                         [("TS-0001", "民兵"), ("TS-0002", "匕首"),
                          ("TS-0003", "火把"), ("TS-0004", "应急干粮")])
        setup = [card for card in self.fronts if card["card_type"] == "游戏设置牌"]
        environments = [card for card in setup if card["subcategory"] == "环境牌"]
        self.assertEqual(environments[-1]["name"], "放逐仪式")
        diseases = [card for card in self.fronts if card["card_type"] == "疾病牌"]
        self.assertEqual([card["source_card_id"] for card in diseases[:2]],
                         ["deck_01_4x2_r01_c02", "deck_01_4x2_r01_c03"])
        guardians = [card for card in self.fronts
                     if card["card_type"] == "地下城牌" and card["subcategory"] == "守护者"]
        self.assertEqual(guardians[-1]["name"], "末日之心")

        heroes: dict[str, list[int]] = defaultdict(list)
        monsters: dict[tuple[str, ...], list[int]] = defaultdict(list)
        for card in self.fronts:
            if card["card_type"] == "英雄牌":
                heroes[card["subcategory"]].append(int(card["wiki_英雄等级"]))
            if card["card_type"] == "地下城牌" and card["subcategory"] == "怪物":
                value = card["wiki_胜利点"]
                monsters[tag_group(card)].append(int(value) if value else float("inf"))
        for levels in heroes.values():
            self.assertEqual(levels, sorted(levels))
        for points in monsters.values():
            self.assertEqual(points, sorted(points))

    def test_dragon_color_and_humanoid_groups_are_distinct(self) -> None:
        colors = [card for card in self.fronts if is_color_dragon(card)]
        humanoids = [card for card in self.fronts if card["card_type"] == "地下城牌"
                     and card["subcategory"] == "怪物" and card["tags"] == "龙|类人生物|怪物"]
        self.assertEqual(len(colors), 5)
        self.assertEqual(len(humanoids), 5)
        self.assertEqual({card["tags"].split("|")[0] for card in colors + humanoids}, {"龙"})
        self.assertEqual({card["tags"] for card in humanoids}, {"龙|类人生物|怪物"})
        for group in (colors, humanoids):
            positions = [int(card["catalog_order"]) for card in group]
            self.assertEqual(positions, list(range(min(positions), max(positions) + 1)))
            points = [int(card["wiki_胜利点"]) for card in group]
            self.assertEqual(points, sorted(points))
        self.assertLess(int(colors[-1]["catalog_order"]), int(humanoids[0]["catalog_order"]))
        self.assertNotIn("random_card_id", self.cards[0])

    def test_updated_random_village_card_matches_published_order(self) -> None:
        card = next(card for card in self.cards if card["source_card_id"] == "deck_12_10x3_r03_c02")
        self.assertEqual(card["card_id"], "TS-0120")
        self.assertEqual((card["card_type"], card["subcategory"]), ("游戏设置牌", "随机牌"))
        self.assertEqual(card["waist_text"], "随机・村庄")
        self.assertEqual(card["tags"], "随机|村庄")
        self.assertEqual(card["review_status"], "reviewed")
        random_village = [row for row in self.fronts
                          if row["card_type"] == "游戏设置牌" and row["subcategory"] == "随机牌"
                          and tag_group(row) == ("村庄", "随机")]
        positions = [int(row["catalog_order"]) for row in random_village]
        self.assertEqual(positions, list(range(min(positions), max(positions) + 1)))
        self.assertIn(card, random_village)

    def test_warhammer_is_grouped_with_blunt_weapons(self) -> None:
        card = next(card for card in self.cards if card["source_card_id"] == "deck_19_10x3_r03_c07")
        self.assertEqual(card["card_id"], "TS-0238")
        self.assertEqual(card["catalog_order"], "238")
        self.assertEqual(card["tags"], "武器|钝器|村庄")
        self.assertEqual(card["waist_text"], "武器・钝器")
        self.assertEqual(card["image_path"], "assets/cards/TS-0238.png")
        group = [row for row in self.fronts
                 if row["card_type"] == "村庄牌" and row["tags"] == "武器|钝器|村庄"]
        positions = [int(row["catalog_order"]) for row in group]
        self.assertEqual(positions, list(range(min(positions), max(positions) + 1)))
        self.assertIn(card, group)

    def test_real_villager_groups_are_adjacent(self) -> None:
        village = [card for card in self.fronts if card["card_type"] == "村庄牌"]
        first = next(index for index, card in enumerate(village) if card["tags"] == "村民|村庄")
        second = next(index for index, card in enumerate(village) if card["tags"] == "村民|佣兵|村庄")
        self.assertEqual(second, first + sum(card["tags"] == "村民|村庄" for card in village))

    def test_experience_fields_match_card_semantics(self) -> None:
        for card in self.cards:
            with self.subTest(card_id=card["card_id"]):
                value = card["wiki_经验值"]
                cost = card["upgrade_xp_cost"]
                reward = card["defeat_xp_reward"]
                self.assertEqual([field for field in (cost, reward) if field], [value] if value else [])
                if cost:
                    self.assertIn("英雄", card["tags"].split("|"))
                if reward:
                    self.assertEqual(card["card_type"], "地下城牌")
                    self.assertIn(card["subcategory"], {"怪物", "守护者"})

    def test_all_hero_cards_have_explicit_semantic_tag_after_printed_tags(self) -> None:
        draft_path = ROOT / "docs/游戏引擎设计参考/thunderstone_card_rules_v0.3.2_engine.json"
        draft = {card["id"]: card for card in json.loads(draft_path.read_text(encoding="utf-8"))["cards"]}
        for card in self.cards:
            if card["card_type"] != "英雄牌":
                continue
            with self.subTest(card_id=card["card_id"]):
                tags = card["tags"].split("|")
                self.assertEqual(tags.count("英雄"), 1)
                printed = list(dict.fromkeys(tag.strip() for tag in card["waist_text"].split("・") if tag.strip()))
                self.assertEqual(tags, list(dict.fromkeys(printed + ["英雄"])))
                self.assertEqual(draft[card["card_id"]]["tags"], tags)

    def test_monsters_and_guardians_have_one_explicit_monster_tag(self) -> None:
        draft_path = ROOT / "docs/游戏引擎设计参考/thunderstone_card_rules_v0.3.2_engine.json"
        draft = {card["id"]: card for card in json.loads(draft_path.read_text(encoding="utf-8"))["cards"]}
        monsters = [card for card in self.fronts if card["card_type"] == "地下城牌"
                    and card["subcategory"] in ("怪物", "守护者")]
        self.assertEqual(len(monsters), 225)
        for card in monsters:
            with self.subTest(card_id=card["card_id"]):
                tags = card["tags"].split("|")
                self.assertEqual(tags.count("怪物"), 1)
                self.assertEqual(tags[-1], "怪物")
                self.assertEqual(draft[card["card_id"]]["tags"], tags)

    def test_published_images_match_card_ids(self) -> None:
        image_dir = ROOT / "assets/cards"
        expected = set()
        for card in self.cards:
            suffix = ".jpg" if card["slot_kind"] == "back" else ".png"
            image_name = card["card_id"] + suffix
            expected.add(image_name)
            self.assertEqual(card["image_path"], f"assets/cards/{image_name}")
        self.assertEqual({path.name for path in image_dir.iterdir()}, expected)


if __name__ == "__main__":
    unittest.main()
