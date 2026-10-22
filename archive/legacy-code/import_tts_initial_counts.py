"""One-time import of TTS starting stack quantities into data/cards.csv.

This script is for asset migration and verification. Game setup reads the CSV
column written here; it never needs the original TTS save.
"""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
CARDS_PATH = ROOT / "data" / "cards.csv"
TTS_PATH = ROOT / "game_TTS" / "TDS_CN.json"
FIELD = "initial_copy_count"


def leaves(obj: dict) -> list[int]:
    children = obj.get("ContainedObjects", [])
    if children:
        return [card_id for child in children for card_id in leaves(child)]
    return [obj["CardID"]] if obj.get("CardID") is not None else []


def find_object(save: dict, name: str, nickname: str) -> dict:
    matches = [obj for obj in save["ObjectStates"]
               if obj.get("Name") == name and obj.get("Nickname") == nickname]
    if len(matches) != 1:
        raise ValueError(f"expected one TTS {name} {nickname!r}; found {len(matches)}")
    return matches[0]


def import_counts(cards_path: Path, tts_path: Path, check: bool) -> None:
    raw = cards_path.read_bytes()
    line_ending = "\r\n" if b"\r\n" in raw else "\n"
    with cards_path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        fields = list(reader.fieldnames or [])
        cards = list(reader)
    if FIELD not in fields:
        fields.insert(fields.index("tts_copy_count") + 1, FIELD)
    by_tts_id = {int(card["tts_card_id"]): card["card_id"]
                 for card in cards if card["tts_card_id"]}
    if len(by_tts_id) != sum(bool(card["tts_card_id"]) for card in cards):
        raise ValueError("duplicate tts_card_id")

    save = json.loads(tts_path.read_text(encoding="utf-8"))
    sources = [
        ("Bag", "Village cards"), ("Bag", "Heros"), ("Bag", "Monsters"),
        ("Bag", "\u5b88\u62a4\u8005"), ("Bag", "thunderstones"),
        ("Bag", "treasures"), ("Bag", "settings"), ("Bag", "traps"),
        ("Bag", "Diseases"),
        ("DeckCustom", "HeroRandomizers"),
        ("DeckCustom", "VillageRandomizers"),
        ("Deck", "MonsterRandomizers"),
        ("Deck", "Militia"), ("Deck", "Torch"),
        ("Deck", "Dagger"), ("Deck", "IronRations"),
    ]
    counts: Counter[str] = Counter()
    for name, nickname in sources:
        obj = find_object(save, name, nickname)
        current = Counter(by_tts_id.get(tts_id) for tts_id in leaves(obj))
        if None in current:
            raise ValueError(f"unmapped TTS card in {nickname!r}")
        for card_id, count in current.items():
            # This setup card is in the monster supply bag as well as the
            # randomizer deck. Only its randomizer-deck copies are used here.
            if nickname == "Monsters" and card_id == "TS-0018":
                continue
            if card_id in counts:
                raise ValueError(f"card {card_id} has multiple initial sources")
            counts[card_id] = count

    feature_ids = {f"TS-{number:04d}" for number in range(200, 210)}
    reference_id = "TS-REFERENCE-001"
    for obj in save["ObjectStates"]:
        if obj.get("Name") != "Deck" or obj.get("Nickname"):
            continue
        current = Counter(by_tts_id.get(tts_id) for tts_id in leaves(obj))
        ids = set(current)
        if ids == feature_ids or ids == {reference_id}:
            for card_id, count in current.items():
                if card_id in counts:
                    raise ValueError(f"duplicate initial source for {card_id}")
                counts[card_id] = count

    wanted = {card["card_id"] for card in cards
              if card["slot_kind"] == "front" or card["card_id"] == reference_id}
    if set(counts) != wanted:
        raise ValueError(f"initial count coverage mismatch: missing={wanted - set(counts)}, "
                         f"extra={set(counts) - wanted}")
    if counts["TS-0018"] != 10:
        raise ValueError("TS-0018 must use the randomizer deck's 10 copies")
    changed = []
    for card in cards:
        value = str(counts[card["card_id"]]) if card["card_id"] in counts else ""
        if card.get(FIELD, "") != value:
            changed.append(card["card_id"])
        card[FIELD] = value
    if check:
        if changed:
            raise ValueError(f"{len(changed)} imported quantities differ from CSV")
        print(f"verified {len(counts)} initial counts in {cards_path}")
        return
    with cards_path.open("w", encoding="utf-8-sig" if raw.startswith(b"\xef\xbb\xbf") else "utf-8",
                         newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, lineterminator=line_ending)
        writer.writeheader()
        writer.writerows(cards)
    print(f"wrote {len(counts)} initial counts to {cards_path}; changed {len(changed)} rows")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cards", type=Path, default=CARDS_PATH)
    parser.add_argument("--tts", type=Path, default=TTS_PATH)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    import_counts(args.cards, args.tts, args.check)


if __name__ == "__main__":
    main()
