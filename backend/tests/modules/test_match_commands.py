"""Authoritative commands through authenticated APIs and a migrated temporary DB."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import json
import sqlite3
import unittest
from unittest.mock import patch
from uuid import uuid4

from backend.app.integrations.game_engine.api import EffectCompileError, SharedEngineUnavailable
from backend.tests.support.matches import MatchApiFixture
from backend.tests.support.setup import config


class MatchCommandTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = MatchApiFixture()
        cls.f = cls.fixture.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.fixture.__exit__(None, None, None)

    def match(self, *, tower=False):
        a, b = self.f.account("房主"), self.f.account("玩家")
        room = self.f.command(b, self.f.create(a), "join")
        rules = config(); rules["selection"]["dungeon_features"]["mode"] = "manual"
        if tower:
            rules["selection"]["environment"]["fixed_card_ids"] = ["TS-0198"]
        room = self.f.save_config(a, room, rules)
        room = self.f.ready_all(room, a, b)
        view = self.f.successful(self.f.start(a, room, first_player={"mode": "fixed", "user_id": a["id"]}))
        if tower:
            prompt = view["setup_choice"]
            view = self.f.successful(self.f.client.post(f"/api/v1/matches/{view['id']}/setup-choice",
                headers=a["headers"], json={"expected_version": view["version"], "command_id": uuid4().hex,
                    "group_a_ids": prompt["group_ids"][:2], "group_a_feature_ids": []}))
        return a, b, view

    def latest(self, account, view):
        return self.f.successful(self.f.client.get(f"/api/v1/matches/{view['id']}", headers=account["headers"]))

    def test_hand_disclosure_begins_before_action_and_new_refill_hides_until_next_turn(self):
        for action in ('village', 'dungeon', 'rest'):
            with self.subTest(action=action):
                a, b, view = self.match()
                player_id = view['viewer_player_id']
                public_hand = lambda current: next(player for player in current['players'] if player['player_id'] == player_id)['cards']['hand']
                shown = public_hand(self.latest(b, view))
                self.assertTrue(all(item['revealed'] for item in shown))
                self.assertEqual([item['instance_id'] for item in shown], [item['instance_id'] for item in view['hand']])
                view = self.play(a, view, 'ChooseAction', action=action)
                self.assertTrue(all(item['revealed'] for item in public_hand(self.latest(b, view))))
                if action == 'rest':
                    view = self.play(a, view, 'SkipRestDestroy'); view = self.play(a, view, 'FinishTurn')
                    b_view = self.latest(b, view)
                    self.assertTrue(all(not item['revealed'] and 'card_id' not in item for item in public_hand(b_view)))
                    new_active = next(player for player in view['players'] if player['is_active'])
                    self.assertTrue(all(item['revealed'] for item in new_active['cards']['hand']))
                    self.assertEqual(self.latest(b, view), b_view)

    def test_rest_destroy_waits_for_end_and_cannot_be_used_twice(self):
        a, b, view = self.match()
        view = self.play(a, view, "ChooseAction", action="rest")
        turn = view["turn"]["number"]
        victim, other = view["hand"][:2]
        view = self.play(a, view, "RestDestroy", instance_id=victim["instance_id"])
        self.assertEqual(view["turn"]["number"], turn)
        self.assertEqual(view["turn"]["subphase"], "ACTION_END")
        self.assertEqual(view["turn"]["chosen_action"], "rest")
        self.assertEqual(view["actor_player_id"], view["viewer_player_id"])
        self.assertEqual(len(view["hand"]), 5)
        self.assertEqual([item["type"] for item in view["legal_commands"]], ["FinishTurn"])
        public = self.latest(b, view)
        signal = next(event for event in reversed(public["event_log"]) if event["kind"] == "card_destroyed")
        self.assertEqual(signal["card_id"], victim["card_id"])
        self.assertEqual(signal["player_id"], view["viewer_player_id"])
        self.assertNotIn("instance_id", signal)
        rejected = self.f.play(a, view, {"type": "RestDestroy", "instance_id": other["instance_id"]})
        self.assertEqual(rejected.status_code, 422)
        self.assertEqual(self.latest(a, view)["version"], view["version"])
        finished = self.play(a, view, "FinishTurn")
        self.assertEqual(finished["turn"]["number"], turn + 1)
        self.assertEqual(len(finished["hand"]), 6)

    def play(self, account, view, kind, **args):
        return self.f.successful(self.f.play(account, view, {"type": kind, **args}))

    def replace_hand_card(self, view, card_id):
        """Arrange a real-card effect without exposing any state-write API."""
        state = self.f.stored_match(view["id"])["state"]
        instance = state["zones"][f"player:{view['viewer_player_id']}:hand"][0]
        state["instances"][instance]["card_id"] = card_id
        with closing(sqlite3.connect(self.f.db_path)) as db:
            db.execute("UPDATE matches SET state=? WHERE id=?", (json.dumps(state), view["id"]))
            db.commit()
        return instance

    def test_http_version_is_distinct_from_engine_version_and_snapshot_is_frozen(self):
        a, b, view = self.match(tower=True)
        before = self.f.stored_match(view["id"])
        self.assertEqual(view["version"], 2)
        self.assertEqual(before["state"]["game_version"], 1)
        with patch("backend.app.modules.matches.service.load_catalog_snapshot", side_effect=AssertionError("frozen catalogue")):
            view = self.play(a, view, "ChooseAction", action="rest")
        after = self.f.stored_match(view["id"])
        self.assertEqual((view["version"], after["state"]["game_version"]), (3, 2))
        self.assertEqual(after["events"][:len(before["events"])], before["events"])
        self.assertGreater(len(after["events"]), len(before["events"]))
        self.assertEqual(after["catalog_snapshot"], before["catalog_snapshot"])
        view = self.play(a, view, "SkipRestDestroy")
        self.assertEqual(view["turn"]["subphase"], "ACTION_END")
        self.assertEqual(self.latest(a, view)["turn"], view["turn"])
        view = self.play(a, view, "FinishTurn")
        self.assertEqual(view["actor_player_id"], f"u-{b['id']}")
        self.assertEqual(view["legal_commands"], [])
        self.assertEqual(self.latest(b, view)["legal_commands"][0]["type"], "ChooseAction")

    def test_authentication_member_and_current_actor_are_required(self):
        a, b, view = self.match(); outsider = self.f.account()
        before = self.f.stored_match(view["id"])
        body = {"expected_version": view["version"], "command_id": uuid4().hex,
                "command": {"type": "ChooseAction", "action": "rest"}}
        self.assertEqual(self.f.client.post(f"/api/v1/matches/{view['id']}/commands", json=body).status_code, 401)
        for account in (b, outsider):
            result = self.f.play(account, view, body["command"])
            self.assertEqual((result.status_code, result.json()["error"]["code"]), (403, "match_forbidden"))
        self.assertEqual(self.f.stored_match(view["id"]), before)

    def test_whitelist_rejects_authority_fields_unknown_commands_and_nested_state(self):
        a, _, view = self.match()
        before = self.f.stored_match(view["id"])
        attempts = [
            {"type": "ChooseAction", "action": "rest", "player_id": "intruder"},
            {"type": "ChooseAction", "action": "rest", "expected_version": 1},
            {"type": "ChooseAction", "action": "rest", "state": {}},
            {"type": "TakeDisease"}, {"type": "DeclareBattleTarget", "target_instance_id": "CI-000001"},
            {"type": "ResolveValueChoice", "value": {"state": {}}},
            {"type": "SubmitBattleTeam", "draft": {"target_instance_id": "CI-000001",
                "hero_instance_ids": [], "support_instance_ids": [], "equipment": {}, "player_id": "intruder"}},
        ]
        for command in attempts:
            with self.subTest(command=command):
                self.assertEqual(self.f.play(a, view, command).status_code, 422)
        self.assertEqual(self.f.stored_match(view["id"]), before)

    def test_invalid_and_stale_commands_roll_back_and_failed_key_can_be_retried(self):
        a, _, view = self.match(); before = self.f.stored_match(view["id"]); key = uuid4().hex
        result = self.f.play(a, view, {"type": "SkipRestDestroy"}, key)
        self.assertEqual((result.status_code, result.json()["error"]["code"]), (422, "invalid_game_command"))
        self.assertEqual(self.f.stored_match(view["id"]), before)
        result = self.f.play(a, view, {"type": "ChooseAction", "action": "rest"}, key)
        accepted = self.f.successful(result)
        stale = self.f.play(a, view, {"type": "SkipRestDestroy"})
        self.assertEqual(stale.json()["error"]["code"], "match_version_conflict")
        self.assertEqual(self.f.stored_match(view["id"])["version"], accepted["version"])

    def test_retry_returns_original_safe_view_even_after_a_later_command(self):
        a, _, view = self.match(); key = uuid4().hex; command = {"type": "ChooseAction", "action": "rest"}
        original = self.f.successful(self.f.play(a, view, command, key))
        later = self.play(a, original, "SkipRestDestroy")
        with patch("backend.app.modules.matches.service.calculate_command", side_effect=AssertionError("never replay engine")):
            self.assertEqual(self.f.successful(self.f.play(a, view, command, key)), original)
        self.assertEqual(self.f.stored_match(view["id"])["version"], later["version"])
        reused = self.f.play(a, original, {"type": "SkipRestDestroy"}, key)
        self.assertEqual(reused.json()["error"]["code"], "command_reused")

    def test_concurrent_commands_commit_once_and_identical_retries_share_receipt(self):
        for same_key in (False, True):
            with self.subTest(same_key=same_key):
                a, _, view = self.match(); before = self.f.stored_match(view["id"])
                keys = [uuid4().hex, uuid4().hex]
                if same_key: keys[1] = keys[0]
                with ThreadPoolExecutor(max_workers=2) as pool:
                    results = list(pool.map(lambda key: self.f.play(a, view,
                        {"type": "ChooseAction", "action": "rest"}, key), keys))
                self.assertEqual(sorted(r.status_code for r in results), [200, 200] if same_key else [200, 409])
                if same_key: self.assertEqual(results[0].json(), results[1].json())
                after = self.f.stored_match(view["id"])
                self.assertEqual(after["version"], before["version"]+1)
                self.assertEqual(after["state"]["game_version"], before["state"]["game_version"]+1)

    def test_rules_change_and_worker_failure_do_not_mutate_and_old_view_can_be_cancelled(self):
        a, _, view = self.match(); before = self.f.stored_match(view["id"])
        cases = [({"return_value": {"engine_version": "changed", "effects_version": before["effects_version"]}}, 409),
                 ({"side_effect": EffectCompileError("old cards")}, 409),
                 ({"side_effect": SharedEngineUnavailable("offline")}, 503)]
        for override, code in cases:
            with self.subTest(code=code), patch("backend.app.modules.matches.service.rules_revision", **override):
                result = self.f.play(a, view, {"type": "ChooseAction", "action": "rest"})
                self.assertEqual(result.status_code, code, result.text)
                current = self.latest(a, view)
                self.assertEqual(current["legal_commands"], [])
                self.assertTrue(current["unavailable_reason"])
            self.assertEqual(self.f.stored_match(view["id"]), before)
        with patch("backend.app.modules.matches.service.rules_revision", side_effect=SharedEngineUnavailable("offline")):
            result = self.f.client.post(f"/api/v1/matches/{view['id']}/cancel", headers=a["headers"],
                json={"expected_version": view["version"], "command_id": uuid4().hex})
        cancelled = self.f.successful(result)
        self.assertEqual(cancelled["status"], "cancelled")
        self.assertEqual(self.f.play(a, cancelled, {"type": "ChooseAction", "action": "rest"}).json()["error"]["code"],
                         "match_not_active")

    def test_real_card_effect_pauses_for_other_player_and_resumes_after_refresh(self):
        a, b, view = self.match()
        source = self.replace_hand_card(view, "TS-0298")
        view = self.play(a, view, "ChooseAction", action="dungeon")
        view = self.play(a, view, "ActivateAbility", ability_id="TS-0298-A01", source_instance_id=source)
        self.assertEqual(view["pending_choice"]["player_id"], f"u-{a['id']}")
        own_choices = view["legal_commands"][0]["instance_ids"]
        view = self.play(a, view, "ResolveChoice", instance_ids=[next(i for i in own_choices if i != source)])
        self.assertEqual(view["actor_player_id"], f"u-{b['id']}")
        waiting = self.latest(a, view)
        self.assertEqual(waiting["legal_commands"], [])
        self.assertEqual(waiting["command_instances"], {})
        self.assertIsNone(waiting["viewer_resources"]["gold_income_preview"])
        saved = self.f.stored_match(view["id"])
        self.assertEqual(self.f.play(a, view, {"type": "ResolveChoice", "instance_ids": []}).status_code, 403)
        other = self.latest(b, view)
        self.assertEqual(self.f.play(b, other, {"type": "ResolveChoice", "instance_ids": []}).status_code, 422)
        self.assertEqual(self.f.stored_match(view["id"]), saved)
        other = self.play(b, other, "ResolveChoice", instance_ids=[other["legal_commands"][0]["instance_ids"][0]])
        view = self.latest(a, other)
        view = self.play(a, view, "ResolveChoice", instance_ids=[view["legal_commands"][0]["instance_ids"][0]])
        self.assertIsNone(view["pending_choice"])
        self.assertEqual(view["turn"]["subphase"], "DUNGEON_PREPARE")

    def test_battle_draft_only_choices_are_accepted_and_hidden_card_cannot_join_team(self):
        a, _, view = self.match()
        view = self.play(a, view, "ChooseAction", action="dungeon")
        prep = view["battle_preparation"]
        draft = {key: prep["draft"][key] for key in ("hero_instance_ids", "support_instance_ids", "equipment")}
        draft["target_instance_id"] = prep["options"]["target_instance_ids"][0]
        saved = self.f.stored_match(view["id"])
        hidden = saved["state"]["zones"][f"player:{view['viewer_player_id']}:draw"][0]
        rejected = self.f.play(a, view, {"type": "SubmitBattleTeam", "draft": {**draft, "hero_instance_ids": [hidden]}})
        self.assertEqual(rejected.status_code, 422)
        self.assertEqual(self.f.stored_match(view["id"]), saved)
        accepted = self.play(a, view, "SubmitBattleTeam", draft=draft)
        after = self.f.stored_match(view["id"])
        self.assertEqual(accepted["version"], view["version"]+1)
        self.assertTrue(any(e["kind"] == "battle_team_submitted" for e in after["events"][len(saved["events"]):]))
