"""Scenario lifecycle rules, separate from ordinary monster combat."""

from backend.tests.migration.reference.python_engine.rules.players import active_players
from backend.tests.migration.reference.python_engine.turn.settlement import settle_game


BANISHING_RITUAL = "TS-0199"
HEART_OF_DOOM = "TS-0683"


def resolve_heart_outcome(tx, instance_id: str, *, won: bool) -> None:
    if won:
        settle_game(tx, "heart_of_doom_defeated", instance_id=instance_id,
                    defeated_by=tx.player_id)
        return
    if not tx.state["battle_context"].get("lose_on_battle_loss"):
        return
    player = tx.player_id
    tx.player.update(eliminated=True, elimination_reason="heart_of_doom_battle_lost",
                     eliminated_on_turn=tx.state["turn_number"])
    tx.state["scheduled_effects"] = [item for item in tx.state["scheduled_effects"]
                                     if item["player_id"] != player]
    tx.event("player_eliminated", player_id=player, reason="heart_of_doom_battle_lost",
             instance_id=instance_id)
    if not active_players(tx.state):
        settle_game(tx, "all_players_eliminated", instance_id=instance_id)
