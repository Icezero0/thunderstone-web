"""Score every player's owned cards from one immutable final snapshot."""

from backend.tests.migration.reference.python_engine.effects.combat import stat
from backend.tests.migration.reference.python_engine.rules.players import active_players


def score_game(state: dict, cards: dict, ruleset) -> dict:
    eligible = active_players(state)
    owned = {player: [instance_id for instance_id, item in state["instances"].items()
                      if item["owner_player_id"] == player]
             for player in state["player_order"]}
    monster_counts = {player: sum(cards[state["instances"][item]["card_id"]]["subcategory"] == "怪物"
                                  for item in pile) for player, pile in owned.items()}
    results = {}
    for player, pile in owned.items():
        entries = []
        stones = sum(cards[state["instances"][item]["card_id"]]["subcategory"] == "雷霆之石"
                     for item in pile)
        for instance_id in pile:
            card = cards[state["instances"][instance_id]["card_id"]]
            points = stat(card, "vp")
            applied = []
            for rule in ruleset.mechanics:
                if rule.op != "scoring" or rule.source_card_id != card["card_id"]:
                    continue
                p = rule.params
                if "group" in p:
                    points = min(p.get("maximum", 10**6), sum(
                        p["group"] in cards[state["instances"][other]["card_id"]]["tags"].split("|")
                        for other in pile))
                points += p.get("other_stones", 0) * max(0, stones - 1)
                if (p.get("fewest_monsters_bonus") and all(
                        count > monster_counts[player] for other, count in monster_counts.items()
                        if other != player and other in eligible)):
                    points += p["fewest_monsters_bonus"]
                applied.append(rule.id)
            entries.append({"instance_id": instance_id, "card_id": card["card_id"],
                            "victory_points": points, "ability_ids": applied})
        results[player] = {"victory_points": sum(item["victory_points"] for item in entries),
                           "thunderstones": stones, "cards": entries}
    maximum = max((results[player]["victory_points"] for player in eligible), default=0)
    winners = [player for player in eligible if results[player]["victory_points"] == maximum]
    stone_holders = [player for player in winners if results[player]["thunderstones"]]
    return {"players": results, "winner_ids": stone_holders or winners,
            "tie_break": "thunderstone" if stone_holders and len(stone_holders) < len(winners) else None}
