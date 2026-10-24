"""Generate setup group mappings from cards.csv; counts remain in cards.csv."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CARDS_PATH = ROOT / "cards" / "cards.csv"
OUTPUT_PATH = ROOT / "cards" / "setup_catalog.json"

VILLAGE_ALIASES = {
    "TS-0071": ("TS-0258",), "TS-0078": ("TS-0270",),
    "TS-0081": ("TS-0300", "TS-0301"), "TS-0096": ("TS-0292",),
    "TS-0104": ("TS-0241",), "TS-0129": ("TS-0289",),
}
MONSTER_PREFIX_GROUPS = {"TS-0021", "TS-0034", "TS-0035"}
MONSTER_TAG_ALIASES = {
    "TS-0022": "怪蜥|动物", "TS-0036": "蜘蛛|动物", "TS-0042": "鼠人|动物",
}
COLOR_DRAGONS = {"白龙", "绿龙", "蓝龙", "红龙", "黑龙"}


def monster_group_tags(card: dict) -> list[str]:
    """Setup families exclude identity and effect-processing tags."""
    return [tag for tag in card["tags"].split("|") if tag and tag not in {"怪物", "给予疾病"}]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def members_for_randomizer(randomizer: dict, fronts: list[dict], by_id: dict) -> tuple[str, list[str], str]:
    card_id = randomizer["card_id"]
    kind = randomizer["tags"].split("|")[-1]
    if kind == "英雄":
        members = [card["card_id"] for card in fronts
                   if card["card_type"] == "英雄牌" and card["subcategory"] == randomizer["name"]]
        return "hero", members, "hero_series"
    if kind == "村庄":
        if card_id in VILLAGE_ALIASES:
            members = list(VILLAGE_ALIASES[card_id])
            require(all(member in by_id for member in members), f"missing village alias for {card_id}")
            return "village", members, "village_alias"
        members = [card["card_id"] for card in fronts
                   if card["card_type"] == "村庄牌" and card["name"] == randomizer["name"]]
        return "village", members, "village_name"
    require(kind == "怪物", f"unexpected randomizer kind: {card_id} {kind}")
    monsters = [card for card in fronts if card["subcategory"] == "怪物"]
    if card_id == "TS-0043":
        members = [card["card_id"] for card in monsters
                   if len(monster_group_tags(card)) == 2
                   and monster_group_tags(card)[0] == "龙"
                   and monster_group_tags(card)[1] in COLOR_DRAGONS]
        return "monster", members, "color_dragon_exception"
    if card_id in MONSTER_PREFIX_GROUPS:
        members = [card["card_id"] for card in monsters
                   if monster_group_tags(card)[0] == randomizer["name"]]
        return "monster", members, "monster_first_tag"
    if card_id in MONSTER_TAG_ALIASES:
        members = [card["card_id"] for card in monsters
                   if "|".join(monster_group_tags(card)) == MONSTER_TAG_ALIASES[card_id]]
        return "monster", members, "monster_tag_alias"
    tags = re.sub(r"\s*[・·]\s*", "|", randomizer["name"]).strip()
    members = [card["card_id"] for card in monsters if "|".join(monster_group_tags(card)) == tags]
    return "monster", members, "monster_exact_tags"


def feature_actions(features: list[dict], fronts: list[dict]) -> list[dict]:
    selectors = {
        "TS-0200": ("treasure_group", "宝藏", "乌布里克的宝藏|宝藏"),
        "TS-0203": ("treasure_group", "宝藏", "宝藏|宝石"),
        "TS-0204": ("treasure_group", "宝藏", "护符|宝藏"),
        "TS-0206": ("trap_group", "陷阱", "陷阱|凶险"),
        "TS-0207": ("trap_group", "陷阱", "陷阱|死亡"),
        "TS-0208": ("trap_group", "陷阱", "陷阱|龙族"),
        "TS-0209": ("treasure_group", "宝藏", "雕像|宝藏"),
    }
    actions = []
    for feature in features:
        card_id = feature["card_id"]
        action: dict = {"feature_id": card_id}
        if card_id in selectors:
            kind, subcategory, tags = selectors[card_id]
            members = [card["card_id"] for card in fronts
                       if card["subcategory"] == subcategory and card["tags"] == tags]
            require(bool(members), f"feature {card_id} has no members")
            action.update({"kind": kind, "members": members})
        elif card_id == "TS-0201":
            action.update({"kind": "draw_features", "count": 2})
        elif card_id == "TS-0202":
            action.update({"kind": "draw_guardian", "pool": "guardian"})
        elif card_id == "TS-0205":
            action.update({"kind": "draw_environment", "pool": "environment",
                           "if_environment_exists": "draw_feature"})
        else:
            raise ValueError(f"unhandled dungeon feature {card_id}")
        actions.append(action)
    return actions


def build(cards_path: Path) -> dict:
    with cards_path.open(encoding="utf-8-sig", newline="") as handle:
        cards = list(csv.DictReader(handle))
    by_id = {card["card_id"]: card for card in cards}
    require(len(by_id) == len(cards), "duplicate card_id")
    fronts = [card for card in cards if card["slot_kind"] == "front"]
    require(all(card["initial_copy_count"].isdigit() and int(card["initial_copy_count"]) > 0
                for card in fronts), "every front card needs a positive initial_copy_count")
    randomizers = [card for card in fronts if card["card_type"] == "游戏设置牌"
                   and card["subcategory"] == "随机牌"]
    features = [card for card in fronts if card["card_type"] == "游戏设置牌"
                and card["subcategory"] == "地下城特征牌"]
    require(len(randomizers) == 183 and len(features) == 10,
            "unexpected randomizer or dungeon feature count")
    pools = {"hero": [], "village": [], "monster_or_feature": []}
    groups = []
    coverage: Counter[str] = Counter()
    for randomizer in randomizers:
        card_id = randomizer["card_id"]
        kind = randomizer["tags"].split("|")[-1]
        pool = {"英雄": "hero", "村庄": "village", "怪物": "monster_or_feature"}[kind]
        pools[pool].append(card_id)
        if card_id == "TS-0018":
            continue
        group_kind, members, match_rule = members_for_randomizer(randomizer, fronts, by_id)
        require(bool(members), f"randomizer {card_id} has no members")
        coverage.update(members)
        groups.append({"randomizer_id": card_id, "kind": group_kind,
                       "match_rule": match_rule, "members": members})
    for kind, expected in (
        ("hero", {card["card_id"] for card in fronts if card["card_type"] == "英雄牌"}),
        ("village", {card["card_id"] for card in fronts if card["card_type"] == "村庄牌"}),
        ("monster", {card["card_id"] for card in fronts if card["subcategory"] == "怪物"}),
    ):
        require(all(coverage[card_id] == 1 for card_id in expected),
                f"{kind} cards are missing or duplicated in randomizer groups")
    other_pools = {
        "guardian": [card["card_id"] for card in fronts if card["subcategory"] == "守护者"],
        "environment": [card["card_id"] for card in fronts if card["subcategory"] == "环境牌"],
        "thunderstone": [card["card_id"] for card in fronts if card["subcategory"] == "雷霆之石"],
        "disease": [card["card_id"] for card in fronts if card["card_type"] == "疾病牌"],
    }
    return {
        "schema_version": 1,
        "cards_csv_sha256": hashlib.sha256(cards_path.read_bytes()).hexdigest(),
        "default_count_field": "initial_copy_count",
        "randomizer_pools": pools,
        "dungeon_feature_entry": {"randomizer_id": "TS-0018",
                                  "draw_feature_count": 1, "continue_monster_draw": True},
        "dungeon_features": feature_actions(features, fronts),
        "groups": groups,
        "other_pools": other_pools,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cards", type=Path, default=CARDS_PATH)
    parser.add_argument("--output", type=Path, default=OUTPUT_PATH)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    rendered = json.dumps(build(args.cards), ensure_ascii=False, indent=2) + "\n"
    if args.check:
        require(args.output.read_text(encoding="utf-8") == rendered,
                f"generated catalog differs from {args.output}")
        print(f"verified {args.output}")
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
        print(f"wrote {args.output}")


if __name__ == "__main__":
    main()
