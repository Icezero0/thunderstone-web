"""Disease replacement arbitration, recipient authority and finite redirection."""

from copy import deepcopy
from dataclasses import replace
import json
import unittest

from backend.app.integrations.game_engine.catalog.repository import load_catalog
from backend.app.integrations.game_engine.disease import take_disease
from backend.app.integrations.game_engine.effects.compiler import load_ruleset, compile_ruleset
from backend.app.integrations.game_engine.setup import start_game
from backend.app.integrations.game_engine.turn import apply_command, TurnError
from backend.tests.mechanic_cases import Fixture
from backend.tests.test_setup_engine import config, request


class DiseaseReplacementTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.snapshot = load_catalog()
        cls.rules = load_ruleset(cls.snapshot.cards)
        settings = config()
        settings["selection"]["dungeon_features"]["mode"] = "manual"
        req = request(settings, seed="disease-replacement")
        req.update(player_ids=["alice", "bob", "carol"], first_player={"mode": "fixed", "player_id": "alice"})
        cls.base = start_game(req, snapshot=cls.snapshot)["state"]

    def fixture(self):
        f = Fixture(self.base, self.snapshot.cards, self.rules, self.rules.mechanics[0])
        f.tx.ruleset = self.rules
        return f

    def take(self, state, player="alice", **kwargs):
        before = deepcopy(state)
        result = take_disease(state, player, snapshot=self.snapshot, effects=self.rules, **kwargs)
        self.assertEqual(state, before)
        return result

    def resolve(self, state, player, **kwargs):
        original = deepcopy(state)
        result = apply_command(state, {"type": "ResolveDiseaseReplacement", "player_id": player, **kwargs}, snapshot=self.snapshot)
        self.assertEqual(state, original)
        return result

    def test_plaguebreaker_in_hand_destroys_new_instance_without_requiring_equipment(self):
        f = self.fixture()
        source = f.add("TS-0239")
        result = self.take(f.tx.state)
        self.assertIsNone(result["instance"])
        self.assertNotIn(result["instance_id"], result["state"]["instances"])
        self.assertNotIn(result["instance_id"], result["state"]["zones"]["destroyed"])
        self.assertIn(source, result["state"]["zones"]["player:alice:hand"])
        self.assertEqual(result["state"]["rng_state"]["counter"], f.tx.state["rng_state"]["counter"] + 1)

    def test_recipient_selects_between_conflicting_replacements(self):
        for selected in ("destroy", "redirect"):
            with self.subTest(selected=selected):
                f = self.fixture()
                plague = f.add("TS-0239")
                sidhe = f.add("TS-0423")
                result = self.take(f.tx.state)
                state = json.loads(json.dumps(result["state"]))
                choice = state["pending_choice"]
                self.assertEqual((choice["player_id"], choice["stage"]), ("alice", "source"))
                self.assertEqual({item["source_instance_id"] for item in choice["options"]}, {plague, sidhe})
                before = deepcopy(state)
                with self.assertRaises(TurnError):
                    self.resolve(state, "bob", source_instance_id=plague)
                with self.assertRaises(TurnError):
                    self.resolve(state, "alice", source_instance_id="CI-999999")
                self.assertEqual(state, before)
                result2 = self.resolve(state, "alice", source_instance_id=plague if selected == "destroy" else sidhe)
                state = result2["state"]
                if selected == "destroy":
                    self.assertNotIn(result["instance_id"], state["instances"])
                    self.assertIsNone(state["pending_choice"])
                else:
                    self.assertEqual(state["pending_choice"]["stage"], "recipient")
                    state = self.resolve(json.loads(json.dumps(state)), "alice", recipient_id="carol")["state"]
                    self.assertIn(result["instance_id"], state["zones"]["player:carol:discard"])

    def test_two_sidhe_sources_can_redirect_back_but_never_apply_twice(self):
        f = self.fixture()
        first = f.add("TS-0423", player="alice")
        second = f.add("TS-0424", player="bob")
        initial_rng = f.tx.state["rng_state"]["counter"]
        result = self.take(f.tx.state, destination="hand")
        state = json.loads(json.dumps(result["state"]))
        self.assertEqual(state["pending_choice"]["options"], ["bob", "carol"])
        to_bob = self.resolve(state, "alice", recipient_id="bob")
        state = json.loads(json.dumps(to_bob["state"]))
        self.assertEqual(state["pending_choice"]["player_id"], "bob")
        final = self.resolve(state, "bob", recipient_id="alice")
        state = final["state"]
        self.assertIsNone(state["pending_choice"])
        self.assertIn(result["instance_id"], state["zones"]["player:alice:discard"])
        self.assertNotIn(result["instance_id"], state["zones"]["player:alice:hand"])
        self.assertEqual(state["rng_state"]["counter"], initial_rng + 1)
        applied = [event["source_instance_id"] for part in (result, to_bob, final)
                   for event in part["events"] if event["kind"] == "disease_replacement_applied"]
        self.assertEqual(applied, [first, second])
        self.assertEqual(state["zones"].get("pending:disease"), [])

    def test_no_other_survivor_means_sidhe_cannot_redirect(self):
        f = self.fixture()
        f.add("TS-0423")
        for player in ("bob", "carol"):
            f.tx.state["players"][player]["eliminated"] = True
        result = self.take(f.tx.state)
        self.assertIsNone(result["state"]["pending_choice"])
        self.assertIn(result["instance_id"], result["state"]["zones"]["player:alice:discard"])

    def test_batch_disease_gain_waits_for_each_recipient_choice_before_next_draw(self):
        f = self.fixture()
        for zone in list(f.tx.state["zones"]):
            if zone.startswith(("hall:", "dungeon:")):
                f.tx.state["zones"]["destroyed"].extend(f.tx.state["zones"][zone])
                f.tx.state["zones"][zone] = []
        f.add("TS-0423")
        target = f.add("TS-0476", "hall:main")
        compiled = compile_ruleset({"schema_version": "thunderstone.effects/1", "abilities": [{
            "id": "TS-0476-A99", "source_card_id": "TS-0476", "kind": "triggered", "source_zone": "battle_target",
            "event": "BATTLE_BEFORE_OUTCOME", "usage": "once_per_event", "conditions": [],
            "body": {"op": "gain_disease", "count": 2}}]}, self.snapshot.cards)
        effects = replace(self.rules, abilities=compiled.abilities)
        initial_rng = f.tx.state["rng_state"]["counter"]
        state = f.tx.state
        events = []
        result = apply_command(state, {"type": "DeclareBattleTarget", "player_id": "alice", "target_instance_id": target},
                               snapshot=self.snapshot, effects=effects)
        state = json.loads(json.dumps(result["state"]))
        events.extend(result["events"])
        self.assertEqual(state["pending_choice"]["kind"], "disease_replacement")
        self.assertEqual(state["rng_state"]["counter"], initial_rng + 1)
        self.assertFalse(any(event["kind"] == "battle_resolved" for event in events))
        for expected_draws in (2, 2):
            result = apply_command(state, {"type": "ResolveDiseaseReplacement", "player_id": "alice", "recipient_id": "carol"},
                                   snapshot=self.snapshot, effects=effects)
            state = json.loads(json.dumps(result["state"]))
            events.extend(result["events"])
            self.assertEqual(state["rng_state"]["counter"], initial_rng + expected_draws)
        self.assertIsNone(state["pending_choice"])
        self.assertEqual(len(state["zones"]["player:carol:discard"]), 2)
        self.assertEqual(sum(event["kind"] == "battle_resolved" for event in events), 1)
        self.assertEqual([e["sequence"] for e in events], list(range(events[0]["sequence"], events[-1]["sequence"] + 1)))


if __name__ == "__main__":
    unittest.main()
