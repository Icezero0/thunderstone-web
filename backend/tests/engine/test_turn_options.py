"""The options adapter exposes a read-only quote from the shared engine."""

from copy import deepcopy
from unittest import TestCase

from backend.app.integrations.game_engine.api import command_options, load_catalog, start_game, apply_command
from backend.tests.support.setup import request


class TurnOptionsTests(TestCase):
    def test_forecast_roundtrips_through_the_worker_and_matches_production(self):
        snapshot = load_catalog()
        state = start_game(request(seed="turn-village"))["state"]
        player = state["active_player_id"]
        before = deepcopy(state)
        options = command_options(state, player, snapshot=snapshot)
        self.assertIsInstance(options["gold_income_preview"], int)
        self.assertEqual(state, before)
        self.assertIsNone(command_options(state, next(pid for pid in state["player_order"] if pid != player), snapshot=snapshot)["gold_income_preview"])
        entered = apply_command(state, {"type": "ChooseAction", "player_id": player,
            "expected_version": state["game_version"], "action": "village"}, snapshot=snapshot)["state"]
        self.assertEqual(entered["players"][player]["temporary_gold"],
                         state["players"][player]["temporary_gold"] + options["gold_income_preview"])
        self.assertIsNone(command_options(entered, player, snapshot=snapshot)["gold_income_preview"])
