"""Keep intentional variants while excluding confirmed duplicate definitions."""

from __future__ import annotations

import csv
import unittest
from collections import defaultdict
from pathlib import Path
from backend.app.core.paths import PROJECT_ROOT


CARDS = PROJECT_ROOT / "cards"


def read_csv(name: str) -> list[dict[str, str]]:
    with (CARDS / name).open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


class DuplicateCardsTests(unittest.TestCase):
    def test_excluded_thornwood_copies_are_absent_and_retained_copies_are_used(self) -> None:
        cards = {card["source_card_id"]: card for card in read_csv("cards.csv")}
        for source_id in (
            "deck_16_10x7_r07_c07", "deck_16_10x7_r07_c08", "deck_16_10x7_r07_c09"
        ):
            self.assertNotIn(source_id, cards)
        thornwood = [card for card in cards.values() if card["subcategory"] == "荆木"]
        self.assertEqual(len(thornwood), 3)
        self.assertTrue(all(int(card["tts_copy_count"]) > 0 for card in thornwood))

    def test_no_other_repeated_english_card_in_one_expansion(self) -> None:
        groups: dict[tuple[str, str], list[str]] = defaultdict(list)
        for card in read_csv("cards.csv"):
            english = card["wiki_英文卡名"]
            if card["slot_kind"] == "front" and english not in {"", "HORDE", "THE SWARM"}:
                groups[(english, card["wiki_卡表扩展"])].append(card["card_id"])
        repeated = {key: ids for key, ids in groups.items() if len(ids) > 1}
        self.assertEqual(repeated, {})


if __name__ == "__main__":
    unittest.main()
