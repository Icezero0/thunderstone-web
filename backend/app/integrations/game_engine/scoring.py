"""Compatibility entry point; the shared TypeScript package owns scoring."""
from dataclasses import asdict

from backend.app.integrations.game_engine.shared.client import client


def score_game(state: dict, cards: dict, ruleset) -> dict:
    instances = {item: {"card_id": value["card_id"], "owner_player_id": value["owner_player_id"]}
                 for item, value in state["instances"].items() if value["owner_player_id"] is not None}
    return client.call("score_game", {
        "state": {"player_order": state["player_order"],
                  "players": {player: {"eliminated": state["players"][player].get("eliminated", False)}
                              for player in state["player_order"]}, "instances": instances},
        "cards": {card_id: cards[card_id] for card_id in sorted({value["card_id"] for value in instances.values()})},
        "mechanics": [asdict(rule) for rule in ruleset.mechanics if rule.op == "scoring"],
    })
