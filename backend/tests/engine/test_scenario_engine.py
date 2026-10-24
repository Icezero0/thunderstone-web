"""Public-command regressions for Banishing, elimination and turn schedules."""

from copy import deepcopy
import json
import unittest

from backend.app.integrations.game_engine.catalog.repository import load_catalog
from backend.app.integrations.game_engine.effects.compiler import load_ruleset
from backend.tests.migration.reference.python_engine.effects.runtime import dispatch_event
from backend.app.integrations.game_engine.setup import start_game
from backend.app.integrations.game_engine.turn import apply_command, legal_commands, TurnError
from backend.tests.migration.reference.python_engine.turn.state import validate_turn_state
from backend.tests.migration.reference.python_engine.turn.workflow import queue_steps
from backend.tests.support.effects.mechanic_cases import Fixture
from backend.tests.support.setup import config, request


class ScenarioEngineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.snapshot = load_catalog()
        cls.ruleset = load_ruleset(cls.snapshot.cards)
        rules = config()
        rules["selection"]["dungeon_features"]["mode"] = "manual"
        rules["selection"]["environment"]["fixed_card_ids"] = ["TS-0199"]
        rules["selection"]["guardian"]["fixed_card_ids"] = ["TS-0683"]
        rules["selection"]["thunderstone"]["fixed_card_ids"] = [
            f"TS-{number:04d}" for number in range(707, 714)]
        req = request(rules, seed="banishing-runtime")
        req.update(player_ids=["alice", "bob", "carol"],
                   first_player={"mode": "fixed", "player_id": "alice"})
        cls.base = start_game(req, snapshot=cls.snapshot)["state"]

    def fixture(self):
        f = Fixture(self.base, self.snapshot.cards, self.ruleset, self.ruleset.mechanics[0])
        f.tx.ruleset = self.ruleset
        for zone in list(f.tx.state["zones"]):
            if zone.startswith(("hall:", "dungeon:")):
                f.tx.state["zones"]["destroyed"].extend(f.tx.state["zones"][zone])
                f.tx.state["zones"][zone] = []
        return f

    def run_command(self, state, kind, **values):
        before = deepcopy(state)
        actor = state["pending_choice"]["player_id"] if state["pending_choice"] else state["active_player_id"]
        result = apply_command(state, {"type": kind, "player_id": actor, **values}, snapshot=self.snapshot)
        self.assertEqual(state, before)
        # The current engine validates its own phases; the frozen Python
        # reference does not know the new explicit ACTION_END state.
        legal_commands(result["state"], snapshot=self.snapshot)
        return result

    def test_ritual_allows_dungeon_and_doomheart_destroys_hand_trophies_on_entry(self):
        f = self.fixture()
        target = f.add("TS-0683", "hall:main")
        trophy = f.add("TS-0476")
        hero = f.add("TS-0302")
        state = f.tx.state
        state.update(subphase="TURN_START", chosen_action=None, battle_context=None)
        self.assertIn("dungeon", legal_commands(state, snapshot=self.snapshot)[0]["actions"])
        result = self.run_command(state, "ChooseAction", action="dungeon")
        self.assertIn(trophy, result["state"]["zones"]["destroyed"])
        self.assertIn(hero, result["state"]["zones"]["player:alice:hand"])
        self.assertEqual(result["state"]["zones"]["hall:main"], [target])

    def test_ritual_stone_acquired_after_rank_one_victory_does_not_end_game(self):
        f = self.fixture()
        monster = f.add("TS-0476", "hall:main")
        stone = f.add("TS-0707", "hall:main")
        f.add("TS-0476", "hall:main")
        for _ in range(3):
            f.add("TS-0476", "dungeon:main")
        f.tx.state["battle_context"]["modifiers"] = {"attack": 100}
        result = self.run_command(f.tx.state, "DeclareBattleTarget", target_instance_id=monster)
        state = result["state"]
        self.assertEqual(state["phase"], "PLAYING")
        self.assertEqual(state["active_player_id"], "alice")
        self.assertEqual(state["subphase"], "ACTION_END")
        self.assertEqual(state["instances"][stone]["owner_player_id"], "alice")
        self.assertEqual(len(state["zones"]["hall:main"]), 3)
        self.assertIsNone(state["end_condition"])
        self.assertEqual(self.run_command(state, "FinishTurn")["state"]["active_player_id"], "bob")

    def test_ritual_unclaimed_stone_returns_to_deck_bottom(self):
        f = self.fixture()
        stone = f.add("TS-0707", "hall:main")
        for _ in range(2):
            f.add("TS-0476", "hall:main")
        for _ in range(3):
            f.add("TS-0476", "dungeon:main")
        queue_steps(f.tx, [{"op": "refill_hall", "hall_zone": "hall:main", "acquire_stone": False}])
        self.assertEqual(f.tx.state["phase"], "PLAYING")
        self.assertEqual(f.tx.state["zones"]["dungeon:main"][-1], stone)
        self.assertIsNone(f.tx.state["instances"][stone]["owner_player_id"])
        self.assertEqual(len(f.tx.state["zones"]["hall:main"]), 3)
        validate_turn_state(f.tx.state, self.snapshot.cards)

    def test_heart_victory_scores_once_before_any_refill_or_next_turn(self):
        f = self.fixture()
        heart = f.add("TS-0683", "hall:main")
        next_card = f.add("TS-0476", "dungeon:main")
        f.tx.state["battle_context"]["modifiers"] = {"attack": 100}
        result = self.run_command(f.tx.state, "DeclareBattleTarget", target_instance_id=heart)
        state = result["state"]
        self.assertEqual(state["phase"], "SETTLING")
        self.assertEqual(state["end_condition"]["reason"], "heart_of_doom_defeated")
        self.assertEqual(state["instances"][heart]["owner_player_id"], "alice")
        self.assertEqual(state["result"]["players"]["alice"]["victory_points"], 15)
        self.assertEqual(state["zones"]["dungeon:main"], [next_card])
        self.assertEqual(sum(e["kind"] == "game_scored" for e in result["events"]), 1)
        self.assertFalse(any(e["kind"] == "turn_passed" for e in result["events"]))
        self.assertEqual(result["legal_commands"], [])

    def test_heart_breach_ends_without_moving_it_to_rank_zero(self):
        f = self.fixture()
        heart = f.add("TS-0683", "hall:main")
        for _ in range(2):
            f.add("TS-0476", "hall:main")
        queue_steps(f.tx, [{"op": "refill_hall", "hall_zone": "hall:main"}, {"op": "finish_turn"}])
        state = f.tx.state
        self.assertEqual(state["phase"], "SETTLING")
        self.assertEqual(state["end_condition"]["reason"], "heart_of_doom_breached")
        self.assertEqual(state["zones"]["hall:main"][0], heart)
        self.assertNotIn(heart, state["zones"].get("hall:main:rank0", []))
        self.assertEqual(state["workflow_steps"], [])
        self.assertFalse(any(e["kind"] == "turn_passed" for e in f.tx.events))

    def test_failed_attack_eliminates_only_attacker_and_later_turns_skip_them(self):
        f = self.fixture()
        f.add("TS-0476", "hall:main")
        heart = f.add("TS-0683", "hall:main")
        held = f.add("TS-0003")
        untouched = f.add("TS-0001", "player:alice:draw")
        result = self.run_command(f.tx.state, "DeclareBattleTarget", target_instance_id=heart)
        state = json.loads(json.dumps(result["state"]))
        self.assertEqual(state["phase"], "PLAYING")
        self.assertTrue(state["players"]["alice"]["eliminated"])
        self.assertFalse(state["players"]["bob"].get("eliminated", False))
        self.assertFalse(state["players"]["carol"].get("eliminated", False))
        self.assertEqual(state["active_player_id"], "bob")
        self.assertIn(heart, state["zones"]["hall:main"])
        self.assertEqual(state["zones"]["player:alice:draw"], [untouched])
        self.assertIn(held, state["zones"]["player:alice:discard"])
        with self.assertRaisesRegex(TurnError, "only the active"):
            apply_command(state, {"type": "ChooseAction", "player_id": "alice", "action": "rest"}, snapshot=self.snapshot)
        for expected in ("carol", "bob"):
            state = self.run_command(state, "ChooseAction", action="rest")["state"]
            state = self.run_command(state, "SkipRestDestroy")["state"]
            state = self.run_command(state, "FinishTurn")["state"]
            self.assertEqual(state["active_player_id"], expected)
        self.assertEqual(state["round_number"], 2)

    def test_last_failed_attacker_ends_game_with_no_winner(self):
        f = self.fixture()
        for player in ("bob", "carol"):
            f.tx.state["players"][player]["eliminated"] = True
        heart = f.add("TS-0683", "hall:main")
        result = self.run_command(f.tx.state, "DeclareBattleTarget", target_instance_id=heart)
        self.assertEqual(result["state"]["end_condition"]["reason"], "all_players_eliminated")
        self.assertEqual(result["state"]["result"]["winner_ids"], [])
        self.assertEqual(result["legal_commands"], [])

    def test_stones_each_gain_six_magic_only_when_fighting_heart(self):
        f = self.fixture()
        stones = [f.add("TS-0707"), f.add("TS-0708")]
        heart = f.add("TS-0683", "hall:main")
        result = self.run_command(f.tx.state, "DeclareBattleTarget", target_instance_id=heart)
        battle = next(e for e in result["events"] if e["kind"] == "battle_resolved")
        components = {c["instance_id"]: c for c in battle["calculation"]["components"]}
        self.assertEqual([components[item]["magic_attack"] for item in stones], [6, 6])

    def test_next_own_turn_schedule_survives_other_players_elimination(self):
        f = self.fixture()
        guardian = f.add("TS-0675", "hall:main:rank0")
        f.tx.state["event_context"] = {"source_instance_id": f.add("TS-0476", "player:alice:discard")}
        self.assertTrue(dispatch_event(f.tx, self.ruleset, "MONSTER_DEFEATED"))
        self.assertEqual(len(f.tx.state["scheduled_effects"]), 1)
        f.tx.state.pop("event_context")
        f.tx.state["players"]["carol"]["eliminated"] = True
        f.tx.finish_turn()
        state = f.tx.state
        self.assertEqual(state["active_player_id"], "bob")
        self.assertFalse(state["players"]["bob"].get("forced_dungeon"))
        state = self.run_command(state, "ChooseAction", action="rest")["state"]
        state = self.run_command(state, "SkipRestDestroy")["state"]
        state = self.run_command(state, "FinishTurn")["state"]
        self.assertEqual(state["active_player_id"], "alice")
        self.assertTrue(state["players"]["alice"]["forced_dungeon"])
        self.assertEqual(state["scheduled_effects"], [])
        self.assertIn(guardian, state["zones"]["hall:main:rank0"])

    def test_multiplayer_effect_does_not_prompt_eliminated_player(self):
        f = self.fixture()
        source = f.add("TS-0439")
        bob_cards = [f.add("TS-0002", player="bob") for _ in range(2)]
        carol_cards = [f.add("TS-0002", player="carol") for _ in range(2)]
        f.tx.state["players"]["carol"]["eliminated"] = True
        result = self.run_command(f.tx.state, "ActivateAbility", source_instance_id=source, ability_id="TS-0439-A02")
        state = json.loads(json.dumps(result["state"]))
        self.assertEqual(state["pending_choice"]["player_id"], "bob")
        result = self.run_command(state, "ResolveChoice", instance_id=bob_cards[0])
        self.assertIsNone(result["state"]["pending_choice"])
        self.assertEqual(result["state"]["zones"]["player:carol:hand"], carol_cards)


if __name__ == "__main__":
    unittest.main()
