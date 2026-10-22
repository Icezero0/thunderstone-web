"""Choice authority, bounds, permutations and JSON continuation with real cards."""

from copy import deepcopy
import json
import unittest

from backend.app.integrations.game_engine.catalog.repository import load_catalog
from backend.app.integrations.game_engine.effects.compiler import load_ruleset, compile_ruleset, EffectCompileError
from backend.app.integrations.game_engine.setup import start_game
from backend.app.integrations.game_engine.turn import apply_command, TurnError
from tests.mechanic_cases import Fixture
from tests.test_setup_engine import config, request


class EffectChoiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.snapshot = load_catalog()
        cls.rules = load_ruleset(cls.snapshot.cards)
        settings = config()
        settings["selection"]["dungeon_features"]["mode"] = "manual"
        req = request(settings, seed="typed-choices")
        req.update(player_ids=["alice", "bob", "carol"],
                   first_player={"mode": "fixed", "player_id": "alice"})
        cls.base = start_game(req, snapshot=cls.snapshot)["state"]

    def fixture(self):
        f = Fixture(self.base, self.snapshot.cards, self.rules, self.rules.mechanics[0])
        f.tx.ruleset = self.rules
        for zone in list(f.tx.state["zones"]):
            if zone.startswith(("hall:", "dungeon:")):
                f.tx.state["zones"]["destroyed"].extend(f.tx.state["zones"][zone])
                f.tx.state["zones"][zone] = []
        for _ in range(3):
            f.add("TS-0476", "hall:main")
        return f

    def do(self, state, kind, **values):
        before = deepcopy(state)
        result = apply_command(state, {"type": kind, "player_id": "alice", **values}, snapshot=self.snapshot)
        self.assertEqual(state, before)
        return json.loads(json.dumps(result["state"]))

    def test_number_choice_enforces_xp_limit_and_rejects_boolean_and_wrong_actor(self):
        for spent in (0, 2):
            with self.subTest(spent=spent):
                f = self.fixture()
                source = f.add("TS-0273")
                f.tx.player["xp"] = 2
                state = self.do(f.tx.state, "ActivateAbility", source_instance_id=source, ability_id="TS-0273-A02")
                self.assertEqual(state["pending_choice"]["options"], [0, 1, 2])
                original = deepcopy(state)
                for invalid in (-1, 3, True, "2", None):
                    with self.assertRaises(TurnError):
                        self.do(state, "ResolveValueChoice", value=invalid)
                    self.assertEqual(state, original)
                with self.assertRaisesRegex(TurnError, "only the active"):
                    apply_command(state, {"type": "ResolveValueChoice", "player_id": "bob", "value": 2}, snapshot=self.snapshot)
                state = self.do(state, "ResolveValueChoice", value=spent)
                self.assertIsNone(state["pending_choice"])
                self.assertEqual(state["players"]["alice"]["xp"], 2 - spent)
                self.assertEqual(state["battle_context"]["modifiers"]["magic_attack"], spent)

    def test_reorder_requires_a_permutation_and_preserves_other_dungeon(self):
        f = self.fixture()
        source = f.add("TS-0453")
        main = [f.add("TS-0476", "dungeon:main") for _ in range(3)]
        second = [f.add(card, "dungeon:second") for card in ("TS-0476", "TS-0477", "TS-0478", "TS-0479")]
        state = self.do(f.tx.state, "ActivateAbility", source_instance_id=source, ability_id="TS-0453-A02")
        self.assertEqual(state["pending_choice"]["options"], ["dungeon:main", "dungeon:second"])
        state = self.do(state, "ResolveValueChoice", value="dungeon:second")
        self.assertEqual(state["pending_choice"]["kind"], "effect_reorder")
        self.assertEqual(state["pending_choice"]["candidate_instance_ids"], second[:3])
        before = deepcopy(state)
        for invalid in (second[:2], [second[0]] * 3, [*second[:2], main[0]], second):
            with self.assertRaises(TurnError):
                self.do(state, "ResolveCardOrder", instance_ids=invalid)
            self.assertEqual(state, before)
        state = self.do(state, "ResolveCardOrder", instance_ids=list(reversed(second[:3])))
        self.assertEqual(state["zones"]["dungeon:main"], main)
        self.assertEqual(state["zones"]["dungeon:second"], [*reversed(second[:3]), second[3]])
        self.assertFalse(any(zone.startswith("revealed:") for zone in state["zones"]))
        self.assertIsNone(state["pending_choice"])

    def test_select_other_player_reveals_only_that_players_top_card(self):
        f = self.fixture()
        source = f.add("TS-0289")
        f.add("TS-0001", "player:alice:draw")
        bob = f.add("TS-0003", "player:bob:draw")
        carol = f.add("TS-0001", "player:carol:draw")
        state = self.do(f.tx.state, "ActivateAbility", source_instance_id=source, ability_id="TS-0289-A01")
        self.assertEqual(state["pending_choice"]["options"], ["bob", "carol"])
        with self.assertRaises(TurnError):
            self.do(state, "ResolveValueChoice", value="alice")
        state = self.do(state, "ResolveValueChoice", value="carol")
        self.assertEqual(state["zones"]["player:bob:draw"], [bob])
        self.assertEqual(state["zones"]["player:carol:discard"], [carol])
        self.assertEqual(state["battle_context"]["modifiers"]["magic_attack"], 2)

    def test_short_dungeon_peek_does_not_create_cards_or_draw_from_other_zones(self):
        f = self.fixture()
        source = f.add("TS-0453")
        only = f.add("TS-0476", "dungeon:main")
        instances = set(f.tx.state["instances"])
        state = self.do(f.tx.state, "ActivateAbility", source_instance_id=source, ability_id="TS-0453-A02")
        self.assertIsNone(state["pending_choice"])
        self.assertEqual(state["zones"]["dungeon:main"], [only])
        self.assertEqual(set(state["instances"]), instances)

    def test_titan_rejects_keeping_two_weaker_heroes(self):
        f = self.fixture()
        weak = [f.add("TS-0001") for _ in range(2)]
        strong = f.add("TS-0302")
        target = f.add("TS-0534", "hall:main")
        state = self.do(f.tx.state, "DeclareBattleTarget", target_instance_id=target)
        self.assertEqual(state["pending_choice"]["highest_by"], "strength")
        before = deepcopy(state)
        with self.assertRaisesRegex(TurnError, "highest values"):
            self.do(state, "ResolveChoice", instance_ids=weak)
        self.assertEqual(state, before)
        state = self.do(state, "ResolveChoice", instance_ids=[strong, weak[0]])
        self.assertIn(weak[1], state["zones"]["destroyed"])
        self.assertNotIn(strong, state["zones"]["destroyed"])

    def test_basilisk_rejects_two_heroes_but_allows_hero_and_item(self):
        f = self.fixture()
        heroes = [f.add("TS-0001"), f.add("TS-0302")]
        item = f.add("TS-0003")
        target = f.add("TS-0555", "hall:main")
        state = self.do(f.tx.state, "DeclareBattleTarget", target_instance_id=target)
        before = deepcopy(state)
        with self.assertRaisesRegex(TurnError, "constraints"):
            self.do(state, "ResolveChoice", instance_ids=heroes)
        self.assertEqual(state, before)
        state = self.do(state, "ResolveChoice", instance_ids=[heroes[0], item])
        self.assertIn(heroes[0], state["zones"]["destroyed"])
        self.assertIn(item, state["zones"]["destroyed"])
        self.assertNotIn(heroes[1], state["zones"]["destroyed"])

    def test_wyvern_returns_at_requested_depth_after_hero_selection_and_refill(self):
        f = self.fixture()
        f.tx.destroy_card(f.tx.state["zones"]["hall:main"][0])
        target = f.add("TS-0672", "hall:main")
        f.add("TS-0001")
        f.add("TS-0302")
        f.add("TS-0401")
        deck = [f.add("TS-0476", "dungeon:main") for _ in range(4)]
        state = self.do(f.tx.state, "DeclareBattleTarget", target_instance_id=target)
        self.assertEqual(state["pending_choice"]["min_count"], 2)
        excluded = state["pending_choice"]["candidate_instance_ids"][:2]
        state = self.do(state, "ResolveChoice", instance_ids=excluded)
        # Two monsters were already in the hall, so refill consumes one of the
        # two cards which were placed before the returning Wyvern.
        self.assertEqual(state["zones"]["dungeon:main"], [deck[1], target, deck[2], deck[3]])
        self.assertTrue(all(item in state["zones"]["destroyed"] for item in excluded))

    def test_compiler_rejects_reserved_choice_binding_and_unbound_bounds(self):
        ability = {"id": "TS-0001-A99", "source_card_id": "TS-0001", "kind": "activated",
                   "source_zone": "active_hand", "actions": ["dungeon"], "usage": "once_per_turn",
                   "conditions": [], "body": {"op": "choose_value", "kind": "number", "bind": "source",
                                               "min": 0, "max": 5, "then": {"op": "draw", "count": 1}}}
        for change in ({}, {"bind": "chosen", "max": {"value": "missing"}}):
            with self.subTest(change=change):
                candidate = deepcopy(ability)
                candidate["body"].update(change)
                with self.assertRaises(EffectCompileError):
                    compile_ruleset({"schema_version": "thunderstone.effects/1", "abilities": [candidate]}, self.snapshot.cards)

    def test_effect_upgrade_returns_new_hero_to_hand_and_prevents_second_level_same_turn(self):
        for skip in (True, False):
            with self.subTest(skip=skip):
                f = self.fixture()
                source = f.add("TS-0698", "player:alice:control")
                militia = f.add("TS-0001")
                next_hero = f.add("TS-0302", "hero_supply:upgrade")
                f.add("TS-0303", "hero_supply:upgrade")
                f.tx.player["xp"] = 100
                state = self.do(f.tx.state, "ActivateAbility", ability_id="TS-0698-A01", source_instance_id=source)
                self.assertEqual(state["pending_choice"]["kind"], "effect_upgrade")
                original = deepcopy(state)
                with self.assertRaisesRegex(TurnError, "invalid effect hero upgrade"):
                    self.do(state, "ResolveEffectUpgrade", source_instance_id=militia, target_card_id="TS-0303")
                self.assertEqual(state, original)
                state = self.do(state, "ResolveEffectUpgrade", **({} if skip else {
                    "source_instance_id": militia, "target_card_id": "TS-0302"}))
                if skip:
                    self.assertEqual(state["players"]["alice"]["xp"], 100)
                    self.assertIn(source, state["zones"]["player:alice:control"])
                    self.assertIn(militia, state["zones"]["player:alice:hand"])
                else:
                    self.assertEqual(state["players"]["alice"]["xp"], 97)
                    self.assertIn(source, state["zones"]["player:alice:discard"])
                    self.assertIn(militia, state["zones"]["destroyed"])
                    self.assertIn(next_hero, state["zones"]["player:alice:hand"])
                    from tests.migration.reference.python_engine.turn.operations import Transition
                    from tests.migration.reference.python_engine.turn.village import upgrade_options
                    options = upgrade_options(Transition(state, self.snapshot.cards, self.rules))
                    self.assertFalse(any(item["source_instance_id"] == next_hero for item in options))


if __name__ == "__main__":
    unittest.main()
