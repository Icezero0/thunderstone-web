"""Visible battle contracts and local HTTP transport for selectable battle teams."""

from copy import deepcopy
from unittest import TestCase
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from backend.app.core.database import get_db
from backend.tests.support.sandbox_app import create_sandbox_app
from backend.app.integrations.game_engine.battle import battle_preparation, submit_battle_team
from backend.app.integrations.game_engine.catalog.repository import load_catalog
from backend.app.integrations.game_engine.setup import start_game
from backend.app.integrations.game_engine.turn import apply_command, TurnError
from backend.tests.support.setup import request


class BattleTeamApiTests(TestCase):
    @classmethod
    def setUpClass(cls):
        cls.snapshot = load_catalog()
        state = start_game(request(seed="battle-team-api"))["state"]
        cls.player = state["active_player_id"]
        result = apply_command(state, {"type": "ChooseAction", "player_id": cls.player, "action": "dungeon"})
        cls.state = result["state"]
        for zone, pile in cls.state["zones"].items():
            if zone.startswith("hall:"):
                for instance in pile:
                    cls.state["instances"][instance]["card_id"] = "TS-0476"

    def setUp(self):
        self.app = create_sandbox_app()

        async def database():
            yield None

        self.app.dependency_overrides[get_db] = database
        self.snapshot_patch = patch("backend.devtools.api.battle.load_catalog_snapshot",
                                    new=AsyncMock(return_value=self.snapshot))
        self.snapshot_patch.start()
        self.addCleanup(self.snapshot_patch.stop)
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)

    def preparation(self):
        response = self.client.post("/api/v1/battle/context", json={"state": self.state, "player_id": self.player})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def command(self, preparation):
        draft = preparation["draft"]
        draft["target_instance_id"] = None
        return {"type": "SubmitBattleTeam", "player_id": self.player,
                "expected_version": self.state["game_version"], "draft": draft}

    def test_context_projects_visible_data_without_changing_server_state(self):
        before = deepcopy(self.state)
        prepared = self.preparation()
        projected = prepared["context"]["state"]
        self.assertNotIn("rng_state", projected)
        self.assertNotIn("workflow_steps", projected)
        self.assertEqual(set(projected["players"]), {self.player})
        self.assertTrue(all(zone == f"player:{self.player}:hand" or zone.startswith("hall:")
                            for zone in projected["zones"]))
        self.assertEqual(self.state, before)

    def test_http_submission_and_direct_backend_adapter_return_the_same_result(self):
        command = self.command(self.preparation())
        response = self.client.post("/api/v1/battle/submit", json={"state": self.state, "command": command})
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        direct = submit_battle_team(self.state, command, snapshot=self.snapshot)
        self.assertEqual({key: result[key] for key in direct}, direct)
        self.assertTrue(any(event["kind"] == "battle_team_submitted" for event in result["events"]))
        self.assertEqual(result["state"]["subphase"], "DUNGEON_DECLARE")
        self.assertFalse(any(event["kind"] == "battle_target_declared" for event in result["events"]))
        self.assertEqual(result["state"]["game_version"], self.state["game_version"] + 1)

    def test_submission_rejects_forged_actor_stale_build_version_and_foreign_cards(self):
        command = self.command(self.preparation())
        other = next(player for player in self.state["player_order"] if player != self.player)
        for changes in ({"player_id": other}, {"expected_version": 0},
                        {"draft": {**command["draft"], "engine_version": "old"}},
                        {"draft": {**command["draft"], "hero_instance_ids": ["unknown"]}}):
            response = self.client.post("/api/v1/battle/submit", json={"state": self.state, "command": {**command, **changes}})
            self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.client.post("/api/v1/battle/context", json={"state": self.state, "player_id": other}).status_code, 422)
        with self.assertRaises(TurnError):
            submit_battle_team(self.state, {"type": "DeclareBattleTarget"})

    def test_invalid_json_and_wrong_phase_are_rejected(self):
        self.assertEqual(self.client.post("/api/v1/battle/context", content=b"bad json").status_code, 400)
        self.assertEqual(self.client.post("/api/v1/battle/context", json=[]).status_code, 422)
        with self.assertRaises(TurnError):
            battle_preparation({**self.state, "subphase": "TURN_START"}, self.player)
