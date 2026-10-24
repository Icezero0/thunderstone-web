"""Complete a multiplayer game using only commands exposed to the real client.

The test never injects an engine state: setup, turns, defeat, hall replenishment,
settlement and room release all go through authenticated production routes.
"""

from copy import deepcopy
import unittest
from unittest.mock import patch
from uuid import uuid4

from backend.tests.support.matches import MatchApiFixture
from backend.tests.support.setup import config


class MatchPlaythroughTests(unittest.TestCase):
    def test_village_rest_dungeon_and_natural_settlement_with_two_accounts(self):
        with MatchApiFixture() as fixture:
            a, b = fixture.account("先手玩家"), fixture.account("另一玩家")
            room = fixture.command(b, fixture.create(a), "join")
            rules = config()
            rules["counts"] = {"village_groups": 1, "hero_groups": 1, "monster_groups": 1}
            rules["selection"]["dungeon_features"]["mode"] = "manual"
            for kind, card_id in (("village", "TS-0088"), ("hero", "TS-0163"), ("monster", "TS-0015")):
                rules["selection"][kind]["fixed_randomizer_ids"] = [card_id]
            rules["selection"]["thunderstone"]["fixed_card_ids"] = ["TS-0707"]
            room = fixture.save_config(a, room, rules)
            room = fixture.ready_all(room, a, b)
            with patch("backend.app.modules.matches.service.secrets.token_hex", return_value="network-playthrough"):
                view = fixture.successful(fixture.start(a, room,
                    first_player={"mode": "fixed", "user_id": a["id"]}))
            match_id = view["id"]
            accounts = {f"u-{account['id']}": account for account in (a, b)}
            seen = set()
            commands_sent = []
            expected_version = view["version"]

            for _ in range(100):
                if view["status"] == "finished":
                    break
                actor = accounts[view["actor_player_id"]]
                view = fixture.successful(fixture.client.get(f"/api/v1/matches/{match_id}",
                    headers=actor["headers"]))
                self.assertEqual(view["version"], expected_version)
                options = {item["type"]: item for item in view["legal_commands"]}
                phase = view["turn"]["subphase"]
                seen.add(phase)
                if "ChooseAction" in options:
                    action = {1: "village", 2: "rest"}.get(view["turn"]["number"], "dungeon")
                    command = {"type": "ChooseAction", "action": action}
                elif "FinishAbilities" in options:
                    command = {"type": "FinishAbilities"}
                elif "BuyCard" in options:
                    choice = next(item for item in options["BuyCard"]["options"] if item["card_id"] == "TS-0001")
                    self.assertLessEqual(choice["price"], view["viewer_resources"]["temporary_gold"])
                    command = {"type": "BuyCard", "card_id": choice["card_id"]}
                elif "FinishBuying" in options:
                    command = {"type": "FinishBuying"}
                elif "FinishUpgrading" in options:
                    command = {"type": "FinishUpgrading"}
                elif "SkipRestDestroy" in options:
                    command = {"type": "SkipRestDestroy"}
                elif "FinishTurn" in options:
                    command = {"type": "FinishTurn"}
                elif "SubmitBattleTeam" in options:
                    preparation = view["battle_preparation"]
                    self.assertIsNotNone(preparation)
                    draft = deepcopy(preparation["draft"])
                    # All cards stay in hand. An empty team loses and cycles the
                    # rank-one monster, eventually exposing the thunderstone.
                    target = next(item for dungeon in view["dungeons"] for item in dungeon["hall"]
                                  if item["rank"] == 1)
                    command = {"type": "SubmitBattleTeam", "draft": {
                        "hero_instance_ids": [], "support_instance_ids": [], "equipment": {},
                        "target_instance_id": target["instance_id"],
                    }}
                    self.assertEqual(draft["player_id"], view["viewer_player_id"])
                else:
                    self.fail(f"Unexpected prompt in simple orc game: {options}")

                observer = b if actor == a else a
                other = fixture.successful(fixture.client.get(f"/api/v1/matches/{match_id}",
                    headers=observer["headers"]))
                self.assertEqual(other["legal_commands"], [])
                self.assertIsNone(other["battle_preparation"])
                previous_hand = [item["instance_id"] for item in view["hand"]]
                view = fixture.successful(fixture.client.post(f"/api/v1/matches/{match_id}/commands",
                    headers=actor["headers"], json={"expected_version": expected_version,
                    "command_id": uuid4().hex, "command": command}))
                expected_version += 1
                self.assertEqual(view["version"], expected_version)
                commands_sent.append(command["type"])
                if command == {"type": "ChooseAction", "action": "dungeon"}:
                    self.assertEqual([item["instance_id"] for item in view["hand"]], previous_hand)
            else:
                self.fail("The real command path did not reach natural settlement")

            self.assertEqual(view["status"], "finished")
            self.assertTrue({"TURN_START", "VILLAGE_BUY", "VILLAGE_UPGRADE", "REST", "DUNGEON_PREPARE"} <= seen)
            self.assertIn("BuyCard", commands_sent)
            self.assertIn("SubmitBattleTeam", commands_sent)
            self.assertIsNotNone(view["result"])
            self.assertEqual(view["legal_commands"], [])
            saved = fixture.stored_match(match_id)
            self.assertEqual(saved["state"]["phase"], "SETTLING")
            self.assertTrue(any(event["kind"] == "battle_resolved" and event["outcome"] == "loss"
                                for event in saved["events"]))
            self.assertTrue(any(event["kind"] == "game_scored" for event in saved["events"]))
            for account in (a, b):
                finished = fixture.successful(fixture.client.get(f"/api/v1/matches/{match_id}", headers=account["headers"]))
                self.assertEqual(finished["result"], view["result"])
                current = fixture.successful(fixture.client.get("/api/v1/rooms/current", headers=account["headers"]))["room"]
                self.assertEqual(current["status"], "waiting")
                self.assertIsNone(current["active_match_id"])
                self.assertFalse(any(player["ready"] for player in current["players"]))
            # The same people can immediately prepare a fresh match.
            room = fixture.ready_all(current, a, b)
            next_game = fixture.successful(fixture.start(a, room))
            self.assertNotEqual(next_game["id"], match_id)

