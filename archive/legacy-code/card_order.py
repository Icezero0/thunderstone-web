"""Canonical order for playable Thunderstone card definitions."""

from __future__ import annotations

from collections import Counter, defaultdict


TYPE_ORDER = {
    "基础牌": 0,
    "游戏设置牌": 1,
    "村庄牌": 2,
    "英雄牌": 3,
    "地下城牌": 4,
    "疾病牌": 5,
}
SUBCATEGORY_ORDER = {
    "游戏设置牌": {"随机牌": 0, "环境牌": 1, "地下城特征牌": 2, "": 3},
    "地下城牌": {"怪物": 0, "守护者": 1, "陷阱": 2, "宝藏": 3, "雷霆之石": 4},
}
FIRST_DISEASE_IDS = ("deck_01_4x2_r01_c02", "deck_01_4x2_r01_c03")
LAST_GUARDIAN_ID = "deck_07_5x2_r02_c01"  # 末日之心
DRAGON_COLOR_TAGS = {"白龙", "红龙", "绿龙", "蓝龙", "黑龙"}
BASIC_CARD_ORDER = (
    "deck_18_10x7_r06_c04",  # 民兵
    "deck_18_10x7_r03_c01",  # 匕首
    "deck_19_10x3_r02_c08",  # 火把
    "deck_18_10x7_r05_c06",  # 应急干粮
)


def source_id(card: dict[str, str]) -> str:
    return card.get("source_card_id") or card["card_id"]


def tag_group(card: dict[str, str]) -> tuple[str, ...]:
    """Cards with the same tags group together even if tag order differs."""
    return tuple(sorted(set(filter(None, card.get("tags", "").split("|")))))


def printed_tags(card: dict[str, str]) -> tuple[str, ...]:
    """Keep the order printed on the waist of the card."""
    return tuple(dict.fromkeys(filter(None, card.get("tags", "").split("|"))))


def is_color_dragon(card: dict[str, str]) -> bool:
    """Group color dragons together despite their distinct second tags."""
    if card["card_type"] != "地下城牌" or card["subcategory"] != "怪物":
        return False
    tags = printed_tags(card)
    return len(tags) == 2 and tags[0] == "龙" and tags[1] in DRAGON_COLOR_TAGS


def tag_group_key(card: dict[str, str]) -> tuple:
    subcategory = card["subcategory"] if card["card_type"] in SUBCATEGORY_ORDER else ""
    return card["card_type"], subcategory, tag_group(card)


def preferred_tag_orders(cards: list[dict[str, str]]) -> dict[tuple, tuple[str, ...]]:
    """Pick one printed order per exact tag set, preferring the common form."""
    variants: dict[tuple, Counter] = defaultdict(Counter)
    for card in cards:
        if card["slot_kind"] != "front":
            continue
        group = tag_group_key(card)
        variants[group][printed_tags(card)] += 1
    return {
        group: min(counts, key=lambda order: (-counts[order], order))
        for group, counts in variants.items()
    }


def card_sort_key(card: dict[str, str], tag_orders: dict[tuple, tuple[str, ...]] | None = None) -> tuple:
    """Sort game cards by category, tags, then category-specific rules."""
    kind = card["slot_kind"]
    if kind != "front":
        return (6 if kind == "reference" else 7, 0, 0, (), "", 0, "", source_id(card))
    card_type = card["card_type"]
    subcategory = card["subcategory"]
    if card_type not in TYPE_ORDER:
        raise ValueError(f"Unknown card type for sorting: {source_id(card)}: {card_type}")
    category_rank = TYPE_ORDER[card_type]
    subcategory_rank = SUBCATEGORY_ORDER.get(card_type, {}).get(subcategory, 0)
    if card_type in SUBCATEGORY_ORDER and subcategory not in SUBCATEGORY_ORDER[card_type]:
        raise ValueError(f"Unknown subcategory for sorting: {source_id(card)}: {subcategory}")

    special_rank = 0
    if card_type == "基础牌":
        old_id = source_id(card)
        special_rank = BASIC_CARD_ORDER.index(old_id) if old_id in BASIC_CARD_ORDER else len(BASIC_CARD_ORDER)
    elif card_type == "疾病牌":
        old_id = source_id(card)
        special_rank = FIRST_DISEASE_IDS.index(old_id) if old_id in FIRST_DISEASE_IDS else 2
    elif card_type == "游戏设置牌" and subcategory == "环境牌" and card["name"] == "放逐仪式":
        special_rank = 1
    elif card_type == "地下城牌" and subcategory == "守护者" and source_id(card) == LAST_GUARDIAN_ID:
        special_rank = 1

    subject = card["name"]
    number = 0
    if card_type == "英雄牌":
        subject = subcategory or card["name"]
        value = card["wiki_英雄等级"]
        if not value:
            raise ValueError(f"Hero level missing: {source_id(card)}")
        number = int(value)
    elif card_type == "地下城牌" and subcategory == "怪物":
        subject = ""
        value = card["wiki_胜利点"]
        number = int(value) if value else float("inf")
    tag_identity = tag_group_key(card)
    ordered_tags = tag_orders.get(tag_identity, printed_tags(card)) if tag_orders is not None else printed_tags(card)
    if is_color_dragon(card):
        ordered_tags = ("龙",)
    return (
        category_rank, subcategory_rank, special_rank, ordered_tags, subject,
        number, card["name"], source_id(card),
    )


def ordered_cards(cards: list[dict[str, str]]) -> list[dict[str, str]]:
    tag_orders = preferred_tag_orders(cards)
    return sorted(cards, key=lambda card: card_sort_key(card, tag_orders))
