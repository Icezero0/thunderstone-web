"""Cross-card timing, source-zone and continuation regression scenarios."""

from copy import deepcopy
from dataclasses import replace
import json
import unittest

from backend.app.integrations.game_engine.catalog.repository import load_catalog
from backend.app.integrations.game_engine.effects.compiler import load_ruleset, compile_ruleset, EffectCompileError
from tests.migration.reference.python_engine.effects.combat import stat
from backend.app.integrations.game_engine.setup import start_game
from backend.app.integrations.game_engine.turn import apply_command, TurnError
from tests.migration.reference.python_engine.turn.hall import remember_fronts
from tests.migration.reference.python_engine.turn.workflow import queue_steps
from tests.mechanic_cases import Fixture
from tests.test_setup_engine import config, request


class EffectIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.snapshot = load_catalog()
        cls.rules = load_ruleset(cls.snapshot.cards)
        settings = config()
        settings["selection"]["dungeon_features"]["mode"] = "manual"
        cls.base = start_game(request(settings, seed="effect-integration"), snapshot=cls.snapshot)["state"]

    def fixture(self):
        f = Fixture(self.base, self.snapshot.cards, self.rules, self.rules.mechanics[0])
        f.tx.ruleset = self.rules
        for zone in list(f.tx.state["zones"]):
            if zone.startswith(("hall:", "dungeon:")):
                f.tx.state["zones"]["destroyed"].extend(f.tx.state["zones"][zone])
                f.tx.state["zones"][zone] = []
        return f

    def test_trophy_magic_is_hand_only_and_battle_disease_is_target_only(self):
        f = self.fixture()
        hand = [f.add("TS-0582") for _ in range(2)]
        monster = f.add("TS-0582", "hall:main")
        original = deepcopy(f.tx.state)
        result = apply_command(original, {"type": "DeclareBattleTarget", "player_id": f.player,
                                          "target_instance_id": monster}, snapshot=self.snapshot)
        self.assertEqual(original, f.tx.state)
        calculation = next(e["calculation"] for e in result["events"] if e["kind"] == "battle_resolved")
        self.assertEqual(calculation["magic_attack"], 2)
        self.assertEqual({e["instance_id"] for e in calculation["components"]}, set(hand))
        self.assertEqual(sum(e["kind"] == "disease_taken_from_supply" for e in result["events"]), 1)

    def test_battle_lines_resolve_in_card_order_and_destroy_after_calculation(self):
        f = self.fixture()
        hero = f.add("TS-0339")
        target = f.add("TS-0569", "hall:main")
        result = apply_command(f.tx.state, {"type": "DeclareBattleTarget", "player_id": f.player,
                                           "target_instance_id": target}, snapshot=self.snapshot)
        events = result["events"]
        self.assertIsNone(result["state"]["pending_choice"])
        strength = next(e for e in events if e["kind"] == "effect_card_modified" and e["stat"] == "strength")
        marked = next(e for e in events if e["kind"] == "effect_card_marked")
        battle = next(e for e in events if e["kind"] == "battle_resolved")
        destruction = next(e for e in events if e["kind"] == "card_destroyed" and e["instance_id"] == hero)
        self.assertLess(strength["sequence"], marked["sequence"])
        self.assertLess(marked["sequence"], battle["sequence"])
        self.assertGreater(destruction["sequence"], battle["sequence"])

    def test_other_player_choice_survives_json_and_blocks_wrong_actor(self):
        f = self.fixture()
        source = f.add("TS-0439")
        others = [p for p in f.tx.state["player_order"] if p != f.player]
        for p in others:
            f.add("TS-0002", player=p)
            f.add("TS-0002", player=p)
        result = apply_command(f.tx.state, {"type": "ActivateAbility", "player_id": f.player,
                                           "ability_id": "TS-0439-A02", "source_instance_id": source}, snapshot=self.snapshot)
        state = json.loads(json.dumps(result["state"]))
        choice = state["pending_choice"]
        self.assertEqual(choice["player_id"], others[0])
        original = deepcopy(state)
        with self.assertRaises(TurnError):
            apply_command(state, {"type": "ResolveChoice", "player_id": f.player,
                                  "instance_id": choice["candidate_instance_ids"][0]}, snapshot=self.snapshot)
        self.assertEqual(state, original)
        resumed = apply_command(state, {"type": "ResolveChoice", "player_id": others[0],
                                        "instance_id": choice["candidate_instance_ids"][0]}, snapshot=self.snapshot)
        self.assertIsNone(resumed["state"]["pending_choice"])
        self.assertEqual(len(resumed["state"]["zones"][f"player:{others[0]}:discard"]), 1)

    def test_trap_resolves_before_breach_of_new_front(self):
        f = self.fixture()
        for p in f.tx.state["player_order"]:
            f.add("TS-0004", player=p)
        trap = f.add("TS-0686", "dungeon:main")
        for _ in range(4):
            f.add("TS-0484", "dungeon:main")
        remember_fronts(f.tx)
        queue_steps(f.tx, [{"op": "refill_hall", "hall_zone": "hall:main"}])
        timings = [e["event"] for e in f.tx.events if e["kind"] == "rule_timing"]
        self.assertLess(timings.index("TRAP_REVEALED"), timings.index("BREACH"))
        self.assertIn(trap, f.tx.state["zones"]["destroyed"])
        self.assertEqual(sum(e["kind"] == "disease_taken_from_supply" for e in f.tx.events), len(f.tx.state["player_order"]))

    def test_compiler_checks_nested_expression_bindings_and_filter_types(self):
        raw = {"schema_version": "thunderstone.effects/1", "abilities": [{
            "id": "TS-0001-A99", "source_card_id": "TS-0001", "kind": "activated", "source_zone": "active_hand",
            "usage": "once_per_turn", "actions": ["dungeon"], "conditions": [], "body": {}}]}
        bad = [
            {"op": "draw", "count": {"count": {"zone": "bound", "var": "not_bound"}}},
            {"op": "draw", "count": {"stat": {"var": "not_bound", "field": "level"}}},
            {"op": "draw", "count": {"count": {"zone": "active_hand", "level_min": True}}},
            {"op": "draw", "count": {"count": {"zone": "active_hand", "tags_any": "hero"}}},
        ]
        for body in bad:
            with self.subTest(body=body), self.assertRaises(EffectCompileError):
                raw["abilities"][0]["body"] = body
                compile_ruleset(raw, self.snapshot.cards)

    def test_refill_trap_choice_then_original_ability_choice_resume_in_order(self):
        f = self.fixture()
        source = f.add("TS-0268")
        militia = f.add("TS-0001")
        f.add("TS-0302")
        torch = f.add("TS-0003")
        for _ in range(3):
            f.add("TS-0476", "hall:main")
            f.add("TS-0001", f"player:{f.player}:draw")
        trap = f.add("TS-0688", "dungeon:main")
        for _ in range(4):
            f.add("TS-0476", "dungeon:main")
        state = f.tx.state
        events = []

        def do(kind, **kwargs):
            nonlocal state
            actor = state["pending_choice"]["player_id"] if state["pending_choice"] else f.player
            result = apply_command(json.loads(json.dumps(state)), {"type": kind, "player_id": actor, **kwargs}, snapshot=self.snapshot)
            state = result["state"]
            events.extend(result["events"])

        do("ActivateAbility", ability_id="TS-0268-A01", source_instance_id=source)
        do("ResolveChoice", instance_id=state["pending_choice"]["candidate_instance_ids"][0])
        self.assertEqual(state["pending_choice"]["ability_id"], "TS-0688-A01")
        self.assertNotIn(torch, state["zones"]["destroyed"])
        do("ResolveChoice", instance_id=militia)
        self.assertEqual(state["pending_choice"]["ability_id"], "TS-0268-A01")
        self.assertIn(trap, state["zones"]["destroyed"])
        do("ResolveChoice", instance_id=torch)
        self.assertIsNone(state["pending_choice"])
        self.assertEqual(state["workflow_steps"], [])
        self.assertIn(torch, state["zones"]["destroyed"])
        self.assertTrue(any(e["kind"] == "effect_draw" and e["ability_id"] == "TS-0268-A01" for e in events))
        self.assertEqual(state["subphase"], "DUNGEON_PREPARE")

    def test_two_spoils_purchases_each_use_full_surviving_hand_gold(self):
        f = self.fixture()
        f.add("TS-0332")
        f.add("TS-0340")
        for _ in range(3):
            f.add("TS-0003")
        target = f.add("TS-0476", "hall:main")
        for _ in range(2):
            f.add("TS-0476", "hall:main")
        for _ in range(5):
            f.add("TS-0476", "dungeon:main")
        f.tx.state["battle_context"]["modifiers"] = {"attack": 100}
        result = apply_command(f.tx.state, {"type": "DeclareBattleTarget", "player_id": f.player,
                                           "target_instance_id": target}, snapshot=self.snapshot)
        state, events = result["state"], list(result["events"])
        for _ in range(8):
            choice = state["pending_choice"]
            if choice is None:
                break
            command = ({"type": "ResolveEffectOrder", "effect_ids": [e["effect_id"] for e in choice["effects"]]}
                       if choice["kind"] == "effect_order" else {"type": "ResolveEffectPurchase", "card_id": "TS-0002"})
            result = apply_command(state, {**command, "player_id": choice["player_id"]}, snapshot=self.snapshot)
            state = result["state"]
            events.extend(result["events"])
        purchases = [e for e in events if e["kind"] == "effect_purchase_completed"]
        self.assertEqual(len(purchases), 2)
        self.assertEqual([e["budget"] for e in purchases], [6, 6])
        self.assertIsNone(state["pending_choice"])

    def test_declining_treasure_purchase_keeps_source_and_rejects_bad_option(self):
        f = self.fixture()
        source = f.add("TS-0699", f"player:{f.player}:control")
        for _ in range(3):
            f.add("TS-0003")
        result = apply_command(f.tx.state, {"type": "ActivateAbility", "player_id": f.player,
            "ability_id": "TS-0699-A01", "source_instance_id": source}, snapshot=self.snapshot)
        state = result["state"]
        before = deepcopy(state)
        with self.assertRaises(TurnError):
            apply_command(state, {"type": "ResolveEffectPurchase", "player_id": f.player, "card_id": "TS-0683"}, snapshot=self.snapshot)
        self.assertEqual(state, before)
        result = apply_command(state, {"type": "ResolveEffectPurchase", "player_id": f.player, "card_id": None}, snapshot=self.snapshot)
        self.assertIn(source, result["state"]["zones"][f"player:{f.player}:control"])
        self.assertFalse(any(e["kind"] == "effect_purchase_completed" for e in result["events"]))


if __name__ == "__main__":
    unittest.main()
