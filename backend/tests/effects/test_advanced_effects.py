"""Real-card interactions through immutable, JSON-restored public commands."""

from copy import deepcopy
import json
import unittest

from backend.app.integrations.game_engine.catalog.repository import load_catalog
from backend.tests.migration.reference.python_engine.effects.combat import combat_values, stat
from backend.app.integrations.game_engine.effects.compiler import load_ruleset
from backend.app.integrations.game_engine.turn import apply_command, legal_commands, TurnError
from backend.tests.migration.reference.python_engine.turn.operations import Transition
from backend.app.integrations.game_engine.setup import start_game
from backend.tests.support.effects.mechanic_cases import Fixture
from backend.tests.support.setup import config, request


class AdvancedEffectTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.snapshot = load_catalog()
        cls.rules = load_ruleset(cls.snapshot.cards)
        settings = config()
        settings["selection"]["dungeon_features"]["mode"] = "manual"
        cls.base = start_game(request(settings, seed="advanced-card-effects"), snapshot=cls.snapshot)["state"]

    def setUp(self):
        self.f = Fixture(self.base, self.snapshot.cards, self.rules, self.rules.mechanics[0])
        self.f.tx.ruleset = self.rules
        self.state = self.f.tx.state
        self.state["active_settings"] = []
        for zone in list(self.state["zones"]):
            if zone.startswith(("hall:", "dungeon:", "village_supply:")):
                self.state["zones"]["destroyed"].extend(self.state["zones"][zone])
                self.state["zones"][zone] = []
        self.actor = self.f.player
        self.other = next(p for p in self.state["player_order"] if p != self.actor)
        self.events = []
        for _ in range(12):
            self.add("TS-0003", zone=f"player:{self.actor}:draw")

    def add(self, card_id, *, player=None, zone=None):
        self.f.tx.state = self.state
        return self.f.add(card_id, zone, player)

    def do(self, kind, **args):
        state = json.loads(json.dumps(self.state))
        original = deepcopy(state)
        choice = state["pending_choice"]
        actor = choice["player_id"] if choice else state["active_player_id"]
        result = apply_command(state, {"type": kind, "player_id": actor, **args}, snapshot=self.snapshot)
        self.assertEqual(state, original)
        self.state = result["state"]
        self.events.extend(result["events"])
        return result

    def activate(self, card_id, ability_id, *, player=None):
        source = self.add(card_id, player=player)
        self.do("ActivateAbility", ability_id=ability_id, source_instance_id=source)
        return source

    def settle(self, *preferred):
        for _ in range(50):
            choice = self.state["pending_choice"]
            if choice is None:
                if self.state["subphase"] == "ACTION_END":
                    self.do("FinishTurn")
                    continue
                return
            kind = choice["kind"]
            if kind == "effect_select":
                candidates = choice["candidate_instance_ids"]
                chosen = next((p for p in preferred if p in candidates), None)
                items = [chosen] if chosen else candidates[:choice["min_count"]]
                self.do("ResolveChoice", instance_ids=items)
            elif kind == "effect_order":
                self.do("ResolveEffectOrder", effect_ids=[r["effect_id"] for r in choice["effects"]])
            elif kind == "effect_response":
                self.do("ResolveResponse")
            elif kind == "effect_value":
                self.do("ResolveValueChoice", value=choice["options"][0])
            elif kind == "effect_purchase":
                self.do("ResolveEffectPurchase", card_id=None)
            else:
                self.fail(f"unexpected continuation: {kind}")
        self.fail("effect chain did not finish")

    def test_militia_copy_replaces_attack_keeps_attributes_and_resumes_active_effect(self):
        militia = self.add("TS-0001")
        template = self.add("TS-0428")
        disease1, disease2 = self.add("TS-0714"), self.add("TS-0714")
        source = self.activate("TS-0415", "TS-0415-A02")
        self.assertIsNone(self.state["pending_choice"])
        tx = Transition(self.state, self.snapshot.cards, self.rules)
        self.assertEqual(tx.card(militia), self.snapshot.cards["TS-0001"])
        component = next(row for row in combat_values(tx, 1)["components"] if row["instance_id"] == militia)
        self.assertEqual(component["attack"], 3)  # copied +3 replaces militia +1
        self.assertEqual(combat_values(tx, 1)["hero_strength"][militia], stat(tx.card(militia), "strength"))
        self.do("ActivateAbility", ability_id="TS-0428-A02", source_instance_id=militia)
        self.assertEqual(self.state["pending_choice"]["kind"], "effect_select")
        self.do("ResolveChoice", instance_id=disease1)
        self.assertNotIn(disease1, self.state["instances"])
        self.assertIn(disease2, self.state["instances"])
        self.do("ActivateAbility", ability_id="TS-0428-A02", source_instance_id=template)
        self.assertNotIn(disease2, self.state["instances"])
        target = self.add("TS-0486", zone="hall:main")
        self.do("DeclareBattleTarget", target_instance_id=target)
        self.settle(militia)
        self.assertFalse(self.state.get("copied_heroes"))
        self.assertEqual(self.state["instances"][militia]["card_id"], "TS-0001")
        self.assertEqual(self.state["instances"][source]["card_id"], "TS-0415")

    def test_borrowed_weapon_is_equipped_and_destroyed_without_return(self):
        weapon = self.add("TS-0234", player=self.other)
        hero = self.activate("TS-0327", "TS-0327-A03")
        self.settle(weapon)
        self.assertEqual(self.state["battle_context"]["equipped_weapon_by_hero"][hero], weapon)
        target = self.add("TS-0459", zone="hall:main")
        self.do("DeclareBattleTarget", target_instance_id=target)
        self.settle(weapon)
        self.assertIn(weapon, self.state["zones"]["destroyed"])
        self.assertIsNone(self.state["instances"][weapon]["owner_player_id"])
        self.assertFalse(any(e["kind"] == "borrowed_card_returned" and e["instance_id"] == weapon for e in self.events))

    def test_borrowed_hero_destroyed_or_protected_obeys_return_contract(self):
        for protected in (False, True):
            with self.subTest(protected=protected):
                self.setUp()
                hero = self.add("TS-0001", player=self.other)
                source = self.activate("TS-0404", "TS-0404-A03")
                self.settle(hero, source)
                self.assertIn(hero, self.state["zones"][f"player:{self.actor}:hand"])
                if protected:
                    self.activate("TS-0295", "TS-0295-A01")
                target = self.add("TS-0486", zone="hall:main")
                self.do("DeclareBattleTarget", target_instance_id=target)
                self.settle(hero)
                returned = [e for e in self.events if e["kind"] == "borrowed_card_returned" and e["instance_id"] == hero]
                self.assertEqual(bool(returned), protected)
                self.assertEqual(self.state["instances"][hero]["owner_player_id"], self.other if protected else None)
                self.assertIn(hero, self.state["zones"][f"player:{self.other}:discard" if protected else "destroyed"])

    def test_borrowed_item_can_activate_and_destroy_itself_before_return(self):
        item = self.add("TS-0236", player=self.other)
        hero = self.activate("TS-0452", "TS-0452-A02")
        self.settle(item)
        self.do("EquipWeapon", hero_instance_id=hero, weapon_instance_id=item)
        self.do("ActivateAbility", ability_id="TS-0236-A02", source_instance_id=item)
        target = self.add("TS-0486", zone="hall:main")
        self.do("DeclareBattleTarget", target_instance_id=target)
        self.settle()
        self.assertIn(item, self.state["zones"]["destroyed"])
        self.assertFalse(any(e["kind"] == "borrowed_card_returned" and e["instance_id"] == item for e in self.events))

    def test_trap_immunity_covers_all_lines_and_does_not_protect_another_player(self):
        source = self.add("TS-0536", player=self.other)
        hero = self.add("TS-0302")
        other_hand = self.add("TS-0302", player=self.other)
        other_draw = [self.add("TS-0302", zone=f"player:{self.other}:draw") for _ in range(3)]
        # Drive a real refill from an activated card, retaining the original stack.
        banish = self.add("TS-0268")
        victim = self.add("TS-0476", zone="hall:main")
        for _ in range(2):
            self.add("TS-0476", zone="hall:main")
        trap = self.add("TS-0691", zone="dungeon:main")
        for _ in range(4):
            self.add("TS-0476", zone="dungeon:main")
        self.do("ActivateAbility", ability_id="TS-0268-A01", source_instance_id=banish)
        self.do("ResolveChoice", instance_id=victim)
        if self.state["pending_choice"]["kind"] == "effect_order":
            self.do("ResolveEffectOrder", effect_ids=[r["effect_id"] for r in self.state["pending_choice"]["effects"]])
        self.assertEqual(self.state["pending_choice"]["kind"], "effect_response")
        self.assertEqual(self.state["pending_choice"]["player_id"], self.other)
        before = deepcopy(self.state)
        with self.assertRaises(TurnError):
            apply_command(self.state, {"type": "ResolveResponse", "player_id": self.actor,
                                      "source_instance_id": source}, snapshot=self.snapshot)
        with self.assertRaises(TurnError):
            apply_command(self.state, {"type": "ResolveResponse", "player_id": self.other,
                                      "source_instance_id": hero}, snapshot=self.snapshot)
        self.assertEqual(before, self.state)
        self.do("ResolveResponse", source_instance_id=source)
        self.settle()
        self.assertIn(hero, self.state["zones"]["destroyed"])
        self.assertIn(other_hand, self.state["zones"][f"player:{self.other}:hand"])
        self.assertEqual(self.state["zones"][f"player:{self.other}:draw"], other_draw)
        self.assertEqual(sum(e["kind"] == "response_used" for e in self.events), 1)
        self.assertIn(trap, self.state["zones"]["destroyed"])
        self.assertNotIn(trap, self.state.get("trap_responses", {}))

    def village(self):
        self.state.update(chosen_action="village", subphase="VILLAGE_ABILITIES", battle_context=None)
        self.state["players"][self.actor]["temporary_gold"] = 50

    def test_redirected_trap_immunity_covers_the_recipients_later_printed_line(self):
        veteran = self.add("TS-0228")
        bandit = self.add("TS-0536", player=self.other)
        hero = self.add("TS-0302")
        cards = [self.add("TS-0302", zone=f"player:{self.other}:draw") for _ in range(3)]
        banish = self.add("TS-0268")
        victim = self.add("TS-0476", zone="hall:main")
        for _ in range(2):
            self.add("TS-0476", zone="hall:main")
        self.add("TS-0691", zone="dungeon:main")
        for _ in range(4):
            self.add("TS-0476", zone="dungeon:main")
        self.do("ActivateAbility", ability_id="TS-0268-A01", source_instance_id=banish)
        self.do("ResolveChoice", instance_id=victim)
        self.do("ResolveEffectOrder", effect_ids=[r["effect_id"] for r in self.state["pending_choice"]["effects"]])
        self.do("ResolveResponse", source_instance_id=veteran)
        self.do("ResolveResponse", recipient_id=self.other)
        self.do("ResolveResponse", source_instance_id=bandit)
        self.settle()
        self.assertIn(hero, self.state["zones"][f"player:{self.actor}:hand"])
        self.assertEqual(self.state["zones"][f"player:{self.other}:draw"], cards)
        self.assertEqual(sum(e["kind"] == "response_used" and e["source_instance_id"] == bandit for e in self.events), 1)

    def test_staff_reuses_a_spell_via_public_choice_then_destroys_it_at_turn_end(self):
        hero = self.add("TS-0415")
        spell = self.activate("TS-0267", "TS-0267-A01")
        staff = self.add("TS-0244")
        self.do("EquipWeapon", hero_instance_id=hero, weapon_instance_id=staff)
        self.do("ActivateAbility", ability_id="TS-0244-A02", source_instance_id=staff)
        self.assertIsNone(self.state["pending_choice"])
        self.assertEqual(self.state['battle_context']['spell_cast_counts'][spell], 2)
        before = deepcopy(self.state)
        with self.assertRaises(TurnError):
            apply_command(self.state, {"type": "ResolveReusedAbility", "player_id": self.actor,
                                      "ability_id": "TS-0428-A02"}, snapshot=self.snapshot)
        self.assertEqual(before, self.state)
        tx = Transition(self.state, self.snapshot.cards, self.rules)
        component = next(row for row in combat_values(tx, 1)["components"] if row["instance_id"] == hero)
        self.assertEqual(component["attack"], 2)
        target = self.add("TS-0486", zone="hall:main")
        self.do("DeclareBattleTarget", target_instance_id=target)
        self.settle()
        self.assertIn(spell, self.state["zones"]["destroyed"])

    def test_ruby_protects_only_own_hydra_reveal_not_the_other_players_hero(self):
        hero = self.add("TS-0327")
        other_hero = self.add("TS-0302", player=self.other)
        ruby = self.add("TS-0703", zone=f"player:{self.actor}:control")
        hydra = self.add("TS-0463", zone="hall:main")
        self.do("DeclareBattleTarget", target_instance_id=hydra)
        self.do("ResolveResponse", source_instance_id=ruby)
        self.settle()
        self.assertIn(ruby, self.state["zones"]["destroyed"])
        self.assertIn(other_hero, self.state["zones"]["destroyed"])
        self.assertNotIn(hero, self.state["zones"]["destroyed"])
        shown = [iid for e in self.events if e["kind"] == "cards_shown" for iid in e.get("instance_ids", [])]
        self.assertNotIn(hero, shown)

    def test_attached_disease_uses_existing_instance_and_gain_replacement_before_battle(self):
        priest = self.add("TS-0422")
        disease = self.add("TS-0714")
        monster = self.add("TS-0486", zone="hall:main")
        self.do("ActivateAbility", ability_id="TS-0422-A02", source_instance_id=priest)
        self.assertEqual(self.state["zones"]["attached:" + monster], [disease])
        self.assertIsNone(self.state["instances"][disease]["owner_player_id"])
        self.add("TS-0239")  # Plague Breaker destroys a newly received disease.
        rng = self.state["rng_state"]["counter"]
        self.do("DeclareBattleTarget", target_instance_id=monster)
        self.settle()
        self.assertNotIn(disease, self.state["instances"])
        self.assertFalse(self.state.get("attachments"))
        self.assertEqual(self.state["rng_state"]["counter"], rng)
        replacement_event = next(e for e in self.events if e["kind"] == "disease_replacement_applied")
        battle = next(e for e in self.events if e["kind"] == "battle_resolved")
        self.assertLess(replacement_event["sequence"], battle["sequence"])

    def test_blacksmith_listener_is_conditional_once_and_expires(self):
        self.village()
        self.activate("TS-0217", "TS-0217-A01")
        self.do("FinishAbilities")
        self.do("BuyCard", card_id="TS-0002")
        self.assertEqual(self.state["players"][self.actor]["purchases_remaining"], 1)
        self.do("BuyCard", card_id="TS-0002")
        self.assertEqual(self.state["players"][self.actor]["purchases_remaining"], 0)
        self.assertFalse(self.state["registered_triggers"])

    def test_robber_cheaper_gain_does_not_emit_purchase_or_recurse(self):
        self.village()
        cheap = self.add("TS-0217", zone="village_supply:integration")
        expensive = self.add("TS-0246", zone="village_supply:expensive")
        self.activate("TS-0300", "TS-0300-A02")
        self.do("FinishAbilities")
        self.do("BuyCard", card_id="TS-0246")
        self.assertEqual(self.state["pending_choice"]["kind"], "effect_purchase")
        self.do("ResolveEffectPurchase", card_id="TS-0217")
        self.assertIn(cheap, self.state["zones"][f"player:{self.actor}:discard"])
        self.assertIn(expensive, self.state["zones"][f"player:{self.actor}:discard"])
        self.assertEqual(sum(e["kind"] == "rule_timing" and e["event"] == "CARD_PURCHASED" for e in self.events), 1)
        self.assertEqual(sum(e["kind"] == "effect_card_gained" for e in self.events), 1)
        self.assertIsNone(self.state["pending_choice"])

    def test_broadsword_claims_remaining_monster_without_defeat_xp(self):
        hero = self.add("TS-0327")
        sword = self.add("TS-0246")
        self.do("EquipWeapon", hero_instance_id=hero, weapon_instance_id=sword)
        self.do("ActivateAbility", ability_id="TS-0246-A02", source_instance_id=sword)
        target = self.add("TS-0486", zone="hall:main")
        extra_id = next(i for i, c in self.snapshot.cards.items() if c["subcategory"] == "怪物"
                        and stat(c, "vp") in (1, 2) and not c["effect_text"])
        extra = self.add(extra_id, zone="hall:main")
        self.state["battle_context"]["modifiers"] = {"attack": 100}
        self.do("DeclareBattleTarget", target_instance_id=target)
        self.assertEqual(self.state["pending_choice"]["kind"], "effect_select")
        self.do("ResolveChoice", instance_ids=[extra])
        self.settle()
        self.assertEqual(sum(e["kind"] == "monster_defeated" for e in self.events), 1)
        self.assertTrue(any(e["kind"] == "card_moved" and e["instance_id"] == extra
                            and e["destination"] == f"player:{self.actor}:discard" for e in self.events))
        xp = self.state["players"][self.actor]["xp"]
        self.assertEqual(xp, int(self.snapshot.cards["TS-0486"]["defeat_xp_reward"]))

    def test_extra_turn_is_used_before_normal_rotation(self):
        treasure = self.add("TS-0696", zone=f"player:{self.actor}:control")
        target = self.add("TS-0486", zone="hall:main")
        self.state["battle_context"]["modifiers"] = {"attack": 100}
        turn, round_ = self.state["turn_number"], self.state["round_number"]
        self.do("DeclareBattleTarget", target_instance_id=target)
        self.do("ResolveChoice", instance_ids=[treasure])
        self.assertEqual(self.state["subphase"], "ACTION_END")
        self.assertEqual(self.state["turn_number"], turn)
        self.do("FinishTurn")
        self.assertEqual(self.state["active_player_id"], self.actor)
        self.assertEqual(self.state["turn_number"], turn + 1)
        self.assertEqual(self.state["round_number"], round_)
        self.do("ChooseAction", action="rest")
        self.do("SkipRestDestroy")
        self.do("FinishTurn")
        self.assertEqual(self.state["active_player_id"], self.other)

    def test_light_and_forced_action_have_distinct_expiry_windows(self):
        self.add("TS-0288")
        self.activate("TS-0277", "TS-0277-A01")
        target = self.add("TS-0486", zone="hall:main")
        self.state["battle_context"]["modifiers"] = {"attack": 100}
        self.do("DeclareBattleTarget", target_instance_id=target)
        self.settle()
        # An empty hall cannot be attacked, but the forced action must still be
        # the only permitted branch while the duration is active.
        self.add("TS-0486", zone="hall:main")
        options = legal_commands(self.state, snapshot=self.snapshot)
        self.assertEqual(options[0]["actions"], ["dungeon"])
        with self.assertRaises(TurnError):
            apply_command(self.state, {"type": "ChooseAction", "player_id": self.other, "action": "rest"}, snapshot=self.snapshot)
        self.do("ChooseAction", action="dungeon")
        tx = Transition(self.state, self.snapshot.cards, self.rules)
        self.assertEqual(combat_values(tx, 1)["light"], 1)
        self.do("DeclareBattleTarget", target_instance_id=self.state["zones"]["hall:main"][0])
        self.settle()
        self.assertEqual(self.state["active_player_id"], self.actor)
        self.assertEqual([r["kind"] for r in self.state["continuous_effects"]], ["light"])
        self.do("ChooseAction", action="rest")
        self.do("SkipRestDestroy")
        self.do("FinishTurn")
        self.assertFalse(self.state["continuous_effects"])


if __name__ == "__main__":
    unittest.main()
