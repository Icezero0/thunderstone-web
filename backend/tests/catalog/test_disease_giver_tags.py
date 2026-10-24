"""Disease-giver identity is language independent and does not split setup families."""

import csv
import json
import unittest
from pathlib import Path

from backend.scripts.catalog.build_setup_catalog import monster_group_tags

ROOT = Path(__file__).resolve().parents[3]


def gives_disease(value):
    if isinstance(value, dict):
        return value.get("op") == "gain_disease" or any(gives_disease(v) for v in value.values())
    return isinstance(value, list) and any(gives_disease(v) for v in value)


class DiseaseGiverTagTests(unittest.TestCase):
    def test_tags_match_every_monster_ability_including_variable_and_nonbattle_gains(self):
        with (ROOT / "cards/cards.csv").open(encoding="utf-8-sig", newline="") as handle:
            cards = {row["card_id"]: row for row in csv.DictReader(handle)}
        expected = set()
        for path in (ROOT / "cards/effects").glob("*.json"):
            data = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                continue
            for ability in data.get("abilities", []):
                card_id = ability["source_card_id"]
                card = cards[card_id]
                if card["subcategory"] in {"怪物", "守护者"} and gives_disease(ability["body"]):
                    expected.add(card_id)
        tagged = {card_id for card_id, card in cards.items() if "给予疾病" in card["tags"].split("|")}
        self.assertEqual(tagged, expected)
        self.assertEqual(len(tagged), 43)
        self.assertTrue({"TS-0589", "TS-0590", "TS-0612", "TS-0676"} <= tagged)
        for card_id in tagged:
            original = dict(cards[card_id], tags="|".join(t for t in cards[card_id]["tags"].split("|") if t != "给予疾病"))
            self.assertEqual(monster_group_tags(cards[card_id]), monster_group_tags(original))
