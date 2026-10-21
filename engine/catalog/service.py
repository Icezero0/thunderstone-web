"""Catalog options consumed by rule validation and the preview panel."""

from pathlib import Path

from engine.paths import PROJECT_ROOT
from engine.catalog.repository import CatalogSnapshot, load_catalog
from engine.rules.constants import ENVIRONMENT_SETUP_RULES


def load_panel_catalog(root: Path = PROJECT_ROOT, *,
                       snapshot: CatalogSnapshot | None = None) -> dict:
    snapshot = snapshot or load_catalog(root)
    return build_panel_catalog(snapshot.cards, snapshot.setup_index)


def build_panel_catalog(cards: dict[str, dict[str, str]], setup: dict) -> dict:
    """Project a validated repository snapshot into panel options."""

    def card_option(card_id: str) -> dict:
        card = cards[card_id]
        return {
            "id": card_id,
            "name": card["name"],
            "image": f"/cards/{card_id}.png",
            "copy_count": int(card["initial_copy_count"]),
            "tags": card["tags"],
        }

    groups = {kind: [] for kind in ("village", "hero", "monster")}
    for group in setup["groups"]:
        option = card_option(group["randomizer_id"])
        option["members"] = group["members"]
        groups[group["kind"]].append(option)
    dungeon_groups = {kind: [] for kind in ("trap", "treasure")}
    for action in setup["dungeon_features"]:
        if action["kind"] not in ("trap_group", "treasure_group"):
            continue
        kind = action["kind"].removesuffix("_group")
        members = action["members"]
        dungeon_groups[kind].append({
            "id": action["feature_id"],
            "name": cards[action["feature_id"]]["name"],
            "images": [card_option(card_id)["image"] for card_id in members],
            "members": members,
            "member_names": [cards[card_id]["name"] for card_id in members],
        })
    return {
        "catalog_hash": setup["cards_csv_sha256"],
        "card_names": {card_id: card["name"] for card_id, card in cards.items()},
        "groups": groups,
        "dungeon_cards": {
            kind: [card_option(card_id) for card_id, card in cards.items()
                   if card["subcategory"] == subcategory]
            for kind, subcategory in (
                ("guardian", "守护者"), ("environment", "环境牌"),
            )
        },
        "dungeon_groups": dungeon_groups,
        "environment_rules": ENVIRONMENT_SETUP_RULES,
        "thunderstones": [card_option(card_id)
                          for card_id in setup["other_pools"]["thunderstone"]],
    }
