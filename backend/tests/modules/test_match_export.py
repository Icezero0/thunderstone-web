"""Explicit complete downloads are read-only and limited to match participants."""
import json
import unittest
from unittest.mock import patch

from backend.tests.support.matches import MatchApiFixture
from backend.tests.support.setup import config


class MatchExportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = MatchApiFixture()
        cls.f = cls.fixture.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.fixture.__exit__(None, None, None)

    def create(self, tower=False):
        host, guest = self.f.account("房主"), self.f.account("玩家")
        room = self.f.command(guest, self.f.create(host), "join")
        rules = config(); rules["selection"]["dungeon_features"]["mode"] = "manual"
        if tower:
            rules["selection"]["environment"]["fixed_card_ids"] = ["TS-0198"]
        room = self.f.save_config(host, room, rules)
        room = self.f.ready_all(room, host, guest)
        view = self.f.successful(self.f.start(host, room,
            first_player={"mode": "fixed", "user_id": host["id"]}))
        return host, guest, view

    def test_complete_export_matches_persisted_checkpoint_without_engine_or_mutation(self):
        host, guest, view = self.create()
        view = self.f.successful(self.f.play(host, view, {"type": "ChooseAction", "action": "rest"}))
        stored = self.f.stored_match(view["id"])
        with patch("backend.app.modules.matches.service.calculate_options", side_effect=AssertionError("no engine needed")):
            response = self.f.client.get(f"/api/v1/matches/{view['id']}/export", headers=guest["headers"])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertIn(f"-v{view['version']}.json", response.headers["content-disposition"])
        data = response.json()
        self.assertEqual(data["format"], "thunderstone-match")
        self.assertEqual(data["format_version"], 1)
        self.assertTrue(data["exported_at"].endswith("+00:00"))
        for key in ("status", "state", "events", "setup_request", "setup_choice"):
            self.assertEqual(data["snapshot"][key], stored[key])
        self.assertEqual(data["players"], stored["frozen_players"])
        self.assertEqual(data["catalog_snapshot"], stored["catalog_snapshot"])
        self.assertEqual(data["rules"], {key: stored[key] for key in ("engine_version", "effects_version")})
        self.assertEqual(data["match"]["version"], stored["version"])
        self.assertEqual(data["match"]["history_cursor"], stored["history_cursor"])
        self.assertEqual(self.f.stored_match(view["id"]), stored)
        # A normal GET still returns the viewer projection rather than this private archive.
        normal = self.f.successful(self.f.client.get(f"/api/v1/matches/{view['id']}", headers=guest["headers"]))
        self.assertNotIn("snapshot", normal)
        self.assertNotIn("rng_state", json.dumps(normal["history"]))

    def test_export_requires_login_and_membership(self):
        host, _, view = self.create()
        url = f"/api/v1/matches/{view['id']}/export"
        self.assertEqual(self.f.client.get(url).status_code, 401)
        outsider = self.f.account("局外人")
        denied = self.f.client.get(url, headers=outsider["headers"])
        self.assertEqual(denied.status_code, 403)
        self.assertNotIn("snapshot", denied.json())
        self.assertEqual(self.f.client.get("/api/v1/matches/missing/export", headers=host["headers"]).status_code, 404)

    def test_export_preserves_pending_setup_and_random_seed(self):
        host, _, view = self.create(tower=True)
        data = self.f.successful(self.f.client.get(f"/api/v1/matches/{view['id']}/export", headers=host["headers"]))
        stored = self.f.stored_match(view["id"])
        self.assertEqual(data["snapshot"]["status"], "setup_pending")
        self.assertIsNone(data["snapshot"]["state"])
        self.assertEqual(data["snapshot"]["setup_choice"], stored["setup_choice"])
        self.assertEqual(data["snapshot"]["setup_request"], stored["setup_request"])
        self.assertTrue(data["snapshot"]["setup_request"]["rng_seed"])
