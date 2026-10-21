"""Destruction timing, turn buffs and replacement payments through real cards."""

from copy import deepcopy
import json
import unittest

from engine.catalog.repository import load_catalog
from engine.effects.compiler import compile_ruleset, EffectCompileError, load_ruleset
from engine.effects.combat import reconcile_equipment
from engine.setup import start_game
from engine.turn import apply_command
from engine.turn.operations import Transition
from tests.mechanic_cases import Fixture
from tests.test_setup_engine import config, request


class DestructionReplacementTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.snapshot = load_catalog()
        cls.rules = load_ruleset(cls.snapshot.cards)
        settings = config()
        settings["selection"]["dungeon_features"]["mode"] = "manual"
        req = request(settings, seed="destruction-replacements")
        req.update(player_ids=["alice", "bob"],
                   first_player={"mode": "fixed", "player_id": "alice"})
        cls.base = start_game(req, snapshot=cls.snapshot)["state"]

    def fixture(self):
        f = Fixture(self.base, self.snapshot.cards, self.rules, self.rules.mechanics[0])
        f.tx.ruleset = self.rules
        for zone in list(f.tx.state["zones"]):
            if zone.startswith(("hall:", "dungeon:")):
                f.tx.state["zones"]["destroyed"].extend(f.tx.state["zones"][zone])
                f.tx.state["zones"][zone] = []
        # Keep cleanup from shuffling the discarded test heroes straight back.
        for _ in range(8):
            f.add("TS-0003", "player:alice:draw")
        return f

    def do(self, state, kind, **values):
        before = deepcopy(state)
        result = apply_command(state, {"type": kind, "player_id": "alice", **values},
                               snapshot=self.snapshot)
        self.assertEqual(state, before)
        result["state"] = json.loads(json.dumps(result["state"]))
        return result

    def equip_blade(self, f, hero):
        blade = f.add("TS-0247")
        f.tx.state["battle_context"].setdefault("card_modifiers", {})[hero] = {"strength": 100}
        result = self.do(f.tx.state, "EquipWeapon", hero_instance_id=hero, weapon_instance_id=blade)
        f.tx = Transition(result["state"], self.snapshot.cards, self.rules)
        return blade

    def test_ordinary_battle_destruction_retains_hero_attack_until_outcome(self):
        f = self.fixture()
        hero = f.add("TS-0001")
        f.add("TS-0001")
        target = f.add("TS-0486", "hall:main")
        first = self.do(f.tx.state, "DeclareBattleTarget", target_instance_id=target)
        self.assertIn(hero, first["state"]["zones"]["player:alice:hand"])
        self.assertFalse(any(e["kind"] == "card_destroyed" for e in first["events"]))
        final = self.do(first["state"], "ResolveChoice", instance_ids=[hero])
        outcome = next(e for e in final["events"] if e["kind"] == "battle_resolved")
        destruction = next(e for e in final["events"] if e["kind"] == "card_destroyed" and e["instance_id"] == hero)
        self.assertGreater(destruction["sequence"], outcome["sequence"])
        self.assertIn(hero, [c["instance_id"] for c in outcome["calculation"]["components"]])
        self.assertIn(hero, final["state"]["zones"]["destroyed"])

    def test_feast_and_ambrosia_replace_deferred_destruction_after_combat(self):
        for card_id in ("TS-0295", "TS-0296"):
            with self.subTest(card_id=card_id):
                f = self.fixture()
                hero = f.add("TS-0001")
                f.add("TS-0001")
                food = f.add(card_id)
                target = f.add("TS-0486", "hall:main")
                state = self.do(f.tx.state, "ActivateAbility", ability_id=card_id + "-A01", source_instance_id=food)["state"]
                first = self.do(state, "DeclareBattleTarget", target_instance_id=target)
                result = self.do(first["state"], "ResolveChoice", instance_ids=[hero])
                outcome = next(e for e in result["events"] if e["kind"] == "battle_resolved")
                replaced = next(e for e in result["events"] if e["kind"] == "card_destruction_replaced")
                self.assertGreater(replaced["sequence"], outcome["sequence"])
                self.assertIn(hero, [c["instance_id"] for c in outcome["calculation"]["components"]])
                self.assertIn(hero, result["state"]["zones"]["player:alice:discard"])
                self.assertNotIn(hero, result["state"]["zones"]["destroyed"])
                flags = result["state"]["instances"][hero]["flags"]
                self.assertNotIn("pending_after_battle_destruction", flags)
                self.assertNotIn("turn_buffs", flags)

    def test_guardian_blade_discard_pays_immediate_spectral_hero_cost(self):
        f = self.fixture()
        hero = f.add("TS-0302")
        f.add("TS-0001")
        self.equip_blade(f, hero)
        target = f.add("TS-0471", "hall:main")
        f.tx.state["battle_context"]["modifiers"] = {"attack": 100}
        result = self.do(f.tx.state, "DeclareBattleTarget", target_instance_id=target)
        result = self.do(result["state"], "ResolveValueChoice", value="pay")
        self.assertEqual(result["state"]["pending_choice"]["kind"], "effect_select")
        result = self.do(result["state"], "ResolveChoice", instance_ids=[hero])
        replaced = next(e for e in result["events"] if e["kind"] == "card_destruction_replaced")
        outcome = next(e for e in result["events"] if e["kind"] == "battle_resolved")
        self.assertLess(replaced["sequence"], outcome["sequence"])
        self.assertEqual(outcome["outcome"], "win")
        self.assertTrue(outcome["calculation"]["can_defeat"])
        self.assertNotIn(hero, [c["instance_id"] for c in outcome["calculation"]["components"]])
        self.assertEqual(replaced["reason"], "TS-0471-A01")
        self.assertIn(hero, result["state"]["zones"]["player:alice:discard"])

    def test_buff_survives_source_destruction_and_equipment_drop(self):
        f = self.fixture()
        hero = f.add("TS-0302")
        blade = self.equip_blade(f, hero)
        f.tx.destroy_card(blade, reason="remove_protection_source")
        reconcile_equipment(f.tx)
        self.assertEqual(f.tx.state["battle_context"]["equipped_weapon_by_hero"], {})
        result = f.tx.destroy_card(hero)
        self.assertEqual(result["destination"], "player:alice:discard")
        self.assertEqual(f.tx.state["instances"][hero]["owner_player_id"], "alice")
        self.assertTrue(f.tx.state["instances"][hero]["flags"]["turn_buffs"])

    def test_declining_spectral_cost_loses_and_retires_monster_without_reward(self):
        f = self.fixture()
        hero = f.add("TS-0302")
        self.equip_blade(f, hero)
        target = f.add("TS-0471", "hall:main")
        incoming = [f.add("TS-0510", "dungeon:main") for _ in range(3)]
        f.tx.state["battle_context"]["modifiers"] = {"attack": 100}
        xp_before = f.tx.player["xp"]
        started = self.do(f.tx.state, "DeclareBattleTarget", target_instance_id=target)
        self.assertEqual(started["state"]["pending_choice"]["kind"], "effect_value")
        result = self.do(started["state"], "ResolveValueChoice", value="decline")
        state, events = result["state"], result["events"]
        battle = next(e for e in events if e["kind"] == "battle_resolved")
        self.assertEqual(battle["outcome"], "loss")
        self.assertGreaterEqual(battle["calculation"]["effective_attack"], battle["health"])
        self.assertEqual(state["zones"]["hall:main"], incoming)
        self.assertEqual(state["zones"]["dungeon:main"], [target])
        self.assertIsNone(state["instances"][target]["owner_player_id"])
        self.assertNotIn(target, state["zones"]["player:alice:discard"])
        self.assertEqual(state["players"]["alice"]["xp"], xp_before)
        self.assertFalse(any(e["kind"] in ("monster_defeated", "card_destruction_replaced") for e in events))
        self.assertNotIn(hero, state["zones"]["destroyed"])

    def test_buff_is_not_consumed_and_expires_for_next_turn_even_in_discard(self):
        f = self.fixture()
        hero = f.add("TS-0302")
        self.equip_blade(f, hero)
        for _ in range(2):
            self.assertEqual(f.tx.destroy_card(hero)["destination"], "player:alice:discard")
            f.tx.move(hero, "player:alice:discard", "player:alice:hand")
        f.tx.move(hero, "player:alice:hand", "player:alice:discard")
        f.tx.pass_turn()
        state = json.loads(json.dumps(f.tx.state))
        self.assertNotIn("turn_buffs", state["instances"][hero]["flags"])
        tx = Transition(state, self.snapshot.cards, self.rules)
        self.assertEqual(tx.destroy_card(hero)["destination"], "destroyed")

    def test_zero_strength_cleanup_uses_buff_before_it_expires(self):
        f = self.fixture()
        hero = f.add("TS-0302")
        self.equip_blade(f, hero)
        f.tx.state["instances"][hero]["flags"]["pending_turn_end_destruction"] = True
        f.tx.finish_turn()
        events = f.tx.events
        replaced = next(e for e in events if e["kind"] == "card_destruction_replaced")
        expired = next(e for e in events if e["kind"] == "hero_turn_buffs_expired")
        ended = next(e for e in events if e["kind"] == "TURN_ENDED")
        self.assertLess(replaced["sequence"], expired["sequence"])
        self.assertLess(expired["sequence"], ended["sequence"])
        self.assertNotIn("pending_turn_end_destruction", f.tx.state["instances"][hero]["flags"])
        self.assertIn(hero, f.tx.zone("discard", "alice"))

    def test_simultaneous_weapon_and_hero_destruction_has_no_iteration_order_dependency(self):
        for weapon_first in (False, True):
            with self.subTest(weapon_first=weapon_first):
                f = self.fixture()
                hero = f.add("TS-0302")
                blade = self.equip_blade(f, hero)
                state = f.tx.state
                if weapon_first:
                    state["instances"] = {blade: state["instances"][blade],
                                          **{i: v for i, v in state["instances"].items() if i != blade}}
                for instance in (hero, blade):
                    state["instances"][instance]["flags"]["pending_after_battle_destruction"] = True
                target = f.add("TS-0476", "hall:main")
                result = self.do(state, "DeclareBattleTarget", target_instance_id=target)
                self.assertIn(blade, result["state"]["zones"]["destroyed"])
                self.assertIn(hero, result["state"]["zones"]["player:alice:discard"])
                self.assertEqual(sum(e["kind"] == "card_destruction_replaced" for e in result["events"]), 1)

    def test_turn_end_destruction_follows_the_marked_instance_after_it_is_discarded(self):
        for protected in (False, True):
            with self.subTest(protected=protected):
                f = self.fixture()
                hero = f.add("TS-0302")
                if protected:
                    self.equip_blade(f, hero)
                f.tx.state["instances"][hero]["flags"]["pending_turn_end_destruction"] = True
                f.tx.move(hero, "player:alice:hand", "player:alice:discard")
                f.tx.finish_turn()
                self.assertIn(hero, f.tx.zone("discard", "alice") if protected else f.tx.state["zones"]["destroyed"])
                self.assertNotIn("pending_turn_end_destruction", f.tx.state["instances"][hero]["flags"])

    def test_replacement_also_pays_an_effect_upgrade_destruction_cost(self):
        f = self.fixture()
        hero = f.add("TS-0001")
        self.equip_blade(f, hero)
        source = f.add("TS-0437")
        f.add("TS-0302", "hero_supply:replacement")
        f.tx.player["xp"] = 3
        first = self.do(f.tx.state, "ActivateAbility", ability_id="TS-0437-A02", source_instance_id=source)
        result = self.do(first["state"], "ResolveEffectUpgrade", source_instance_id=hero, target_card_id="TS-0302")
        self.assertEqual(result["state"]["players"]["alice"]["xp"], 0)
        self.assertIn(hero, result["state"]["zones"]["player:alice:discard"])
        upgraded = next(e for e in result["events"] if e["kind"] == "hero_upgraded")
        self.assertIn(upgraded["target_instance_id"], result["state"]["zones"]["player:alice:hand"])
        self.assertNotIn("turn_buffs", result["state"]["instances"][upgraded["target_instance_id"]]["flags"])

    def test_unequipped_blade_does_not_protect_heroes(self):
        f = self.fixture()
        f.add("TS-0247")
        hero = f.add("TS-0302")
        self.assertEqual(f.tx.destroy_card(hero)["destination"], "destroyed")

    def test_compiler_rejects_unknown_buffs_and_unbound_targets(self):
        for buff, var in (("arbitrary_python", "source"), ([], "source"), (None, "source"),
                          ("discard_instead_of_destroy", "missing")):
            with self.subTest(buff=buff, var=var), self.assertRaises(EffectCompileError):
                compile_ruleset({"schema_version": "thunderstone.effects/1", "abilities": [{
                    "id": "TS-0295-A99", "source_card_id": "TS-0295", "kind": "activated",
                    "source_zone": "active_hand", "usage": "once_per_turn", "actions": ["dungeon"],
                    "conditions": [], "body": {"op": "grant_turn_buff", "target": {"var": var}, "buff": buff}
                }]}, self.snapshot.cards)


if __name__ == "__main__":
    unittest.main()
