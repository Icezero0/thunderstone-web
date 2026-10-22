"""Participant order remains fixed; only surviving players take part in play."""


def active_players(state: dict) -> list[str]:
    return [player for player in state["player_order"]
            if not state["players"][player].get("eliminated", False)]
