"""Check setup defaults and the CSV-derived randomizer index."""

from __future__ import annotations

import csv
import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


class SetupCatalogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        with (ROOT / "cards" / "cards.csv").open(encoding="utf-8-sig", newline="") as handle:
            cls.cards = {card["card_id"]: card for card in csv.DictReader(handle)}
        cls.setup = json.loads((ROOT / "cards" / "setup_catalog.json").read_text(encoding="utf-8"))

    def test_default_counts_are_in_csv(self) -> None:
        self.assertEqual(sum(card["slot_kind"] == "front" for card in self.cards.values()), 720)
        self.assertTrue(all(int(card["initial_copy_count"]) > 0
                            for card in self.cards.values() if card["slot_kind"] == "front"))
        self.assertEqual(self.cards["TS-0018"]["initial_copy_count"], "10")
        self.assertEqual(self.cards["TS-0018"]["tts_copy_count"], "20")
        self.assertEqual(self.cards["TS-0202"]["initial_copy_count"], "6")
        self.assertEqual(self.cards["TS-BACK-001"]["initial_copy_count"], "")

    def test_setup_index_references_csv_counts(self) -> None:
        self.assertEqual(self.setup["default_count_field"], "initial_copy_count")
        self.assertEqual([len(self.setup["randomizer_pools"][pool])
                          for pool in ("hero", "village", "monster_or_feature")], [52, 91, 40])
        self.assertEqual(len(self.setup["groups"]), 182)
        self.assertFalse(any("default_copies" in str(group) for group in self.setup["groups"]))
        group = next(group for group in self.setup["groups"]
                     if group["randomizer_id"] == "TS-0043")
        self.assertEqual(len(group["members"]), 5)
        self.assertTrue(all(self.cards[card_id]["tags"].split("|")[0] == "\u9f99"
                            for card_id in group["members"]))


if __name__ == "__main__":
    unittest.main()
