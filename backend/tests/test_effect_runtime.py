"""Reviewed JSON ability compilation, choices, triggers and continuation."""

from __future__ import annotations

import copy
import json
import unittest

from backend.app.integrations.game_engine.catalog.repository import load_catalog
from backend.app.integrations.game_engine.effects.compiler import (EffectCompileError, compile_ruleset,
                                     load_ruleset)
from backend.app.integrations.game_engine.setup import start_game
from backend.app.integrations.game_engine.turn import TurnError, apply_command, legal_commands
from backend.tests.test_setup_engine import config, request


def add_owned_card(state: dict, card_id: str, player_id: str) -> str:
    sequence = state["next_instance_sequence"]
    instance_id = f"CI-{sequence:06d}"
    state["next_instance_sequence"] += 1
    state["instances"][instance_id] = {
        "card_id": card_id, "owner_player_id": player_id,
        "origin": "test_fixture", "flags": {},
    }
    state["zones"][f"player:{player_id}:hand"].append(instance_id)
    return instance_id


def command(state: dict, kind: str, **arguments: object) -> dict:
    return {"type": kind, "player_id": state["active_player_id"],
            "expected_version": state["game_version"], **arguments}


class EffectRuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.cards = load_catalog().cards

    def test_compiler_rejects_draft_and_unbound_operations(self) -> None:
        self.assertEqual(len(load_ruleset(self.cards).abilities), 446)
        with self.assertRaises(EffectCompileError):
            compile_ruleset({"schema_version": "thunderstone.card-engine.atoms/0.3.2",
                             "abilities": []}, self.cards)
        invalid = {"schema_version": "thunderstone.effects/1", "abilities": [{
            "id": "TS-0001-A99", "source_card_id": "TS-0001",
            "kind": "activated", "actions": ["village"],
            "source_zone": "active_hand", "usage": "once_per_turn",
            "conditions": [], "body": {"op": "eval", "code": "state.clear()"},
        }]}
        with self.assertRaises(EffectCompileError):
            compile_ruleset(invalid, self.cards)
        state = start_game(request(seed="effect-version"))["state"]
        state["effects_version"] = "stale"
        with self.assertRaisesRegex(TurnError, "effect revision"):
            apply_command(state, command(state, "ChooseAction", action="rest"))
        invalid["abilities"][0]["body"] = {
            "op": "destroy", "target": {"var": "missing_choice"}}
        with self.assertRaises(EffectCompileError):
            compile_ruleset(invalid, self.cards)

    def test_prophet_disease_cost_choice_resumes_and_draws(self) -> None:
        state = start_game(request(seed="effect-prophet"))["state"]
        player = state["active_player_id"]
        prophet = add_owned_card(state, "TS-0428", player)
        disease_a = add_owned_card(state, "TS-0714", player)
        disease_b = add_owned_card(state, "TS-0714", player)
        entered = apply_command(state, command(state, "ChooseAction", action="village"))
        self.assertEqual(entered["state"]["subphase"], "VILLAGE_ABILITIES")
        self.assertIn({"ability_id": "TS-0428-A02",
                       "source_instance_id": prophet},
                      legal_commands(entered["state"])[0]["options"])
        started = apply_command(entered["state"], command(
            entered["state"], "ActivateAbility", ability_id="TS-0428-A02",
            source_instance_id=prophet))
        pending = json.loads(json.dumps(started["state"], ensure_ascii=False))
        self.assertEqual(set(pending["pending_choice"]["candidate_instance_ids"]),
                         {disease_a, disease_b})
        self.assertEqual(legal_commands(pending)[0]["type"], "ResolveChoice")
        with self.assertRaises(TurnError):
            apply_command(pending, command(pending, "FinishAbilities"))
        with self.assertRaises(TurnError):
            apply_command(pending, command(pending, "ResolveChoice",
                                           instance_id=prophet))
        hand_before = len(pending["zones"][f"player:{player}:hand"])
        resumed = apply_command(pending, command(pending, "ResolveChoice",
                                                 instance_id=disease_a))
        updated = resumed["state"]
        self.assertIsNone(updated["pending_choice"])
        self.assertEqual(updated["resolution_frames"], [])
        self.assertNotIn(disease_a, updated["instances"])
        self.assertIn(disease_b, updated["zones"][f"player:{player}:hand"])
        self.assertEqual(len(updated["zones"][f"player:{player}:hand"]),
                         hand_before + 1)
        self.assertTrue(any(event["kind"] == "effect_draw" and
                            event["requested"] == 2 for event in resumed["events"]))
        with self.assertRaises(TurnError):
            apply_command(updated, command(updated, "ActivateAbility",
                                           ability_id="TS-0428-A02",
                                           source_instance_id=prophet))

    def test_prophet_draws_twice_current_monster_count(self) -> None:
        state = start_game(request(seed="effect-count"))["state"]
        player = state["active_player_id"]
        prophet = add_owned_card(state, "TS-0428", player)
        monster_card = state["instances"][state["zones"]["hall:main"][0]]["card_id"]
        add_owned_card(state, monster_card, player)
        add_owned_card(state, monster_card, player)
        entered = apply_command(state, command(state, "ChooseAction", action="village"))
        result = apply_command(entered["state"], command(
            entered["state"], "ActivateAbility", ability_id="TS-0428-A03",
            source_instance_id=prophet))
        drawn = next(event for event in result["events"]
                     if event["kind"] == "effect_draw")
        self.assertEqual(drawn["requested"], 4)
        self.assertEqual(len(drawn["instance_ids"]), 4)

    def test_thornwood_unique_max_and_tie_pause_before_cleanup(self) -> None:
        rules = config()
        rules["selection"]["dungeon_features"]["mode"] = "manual"
        rules["selection"]["environment"]["fixed_card_ids"] = ["TS-0193"]
        unique = start_game(request(rules, seed="0"))["state"]
        player = unique["active_player_id"]
        prices = {pile[0]: int(self.cards[unique["instances"][pile[0]]["card_id"]][
            "wiki_购买价格"]) for zone, pile in unique["zones"].items()
                  if zone.startswith("village_supply:") and pile}
        highest = max(prices, key=prices.get)
        rest = apply_command(unique, command(unique, "ChooseAction", action="rest"))
        finished = apply_command(rest["state"], command(rest["state"], "FinishRest"))
        self.assertIn(highest, finished["state"]["zones"]["destroyed"])
        self.assertEqual(finished["state"]["turn_number"], 2)
        self.assertEqual(finished["state"]["active_player_id"] != player, True)

        tied = start_game(request(rules, seed="8"))["state"]
        entered = apply_command(tied, command(tied, "ChooseAction", action="rest"))
        paused = apply_command(entered["state"], command(entered["state"], "FinishRest"))
        self.assertEqual(paused["state"]["subphase"], "ACTION_EXIT_EFFECTS")
        self.assertEqual(paused["state"]["turn_number"], 1)
        self.assertGreater(len(paused["state"]["pending_choice"][
            "candidate_instance_ids"]), 1)
        choice = paused["state"]["pending_choice"]["candidate_instance_ids"][0]
        done = apply_command(paused["state"], command(
            paused["state"], "ResolveChoice", instance_id=choice))
        self.assertIn(choice, done["state"]["zones"]["destroyed"])
        self.assertEqual(done["state"]["turn_number"], 2)
        self.assertEqual(done["state"]["subphase"], "TURN_START")

    def test_flow_nodes_condition_loop_and_scheduled_effect(self) -> None:
        custom = {"schema_version": "thunderstone.effects/1", "abilities": [{
            "id": "TS-0001-A99", "source_card_id": "TS-0001",
            "kind": "activated", "actions": ["village"],
            "source_zone": "active_hand", "usage": "once_per_turn",
            "conditions": [{"all": [{"exists": {"zone": "active_hand",
                                                "card_id": "TS-0001"}},
                                   {"not": {"setting_active": "TS-0199"}}]}],
            "body": {"op": "sequence", "children": [
                {"op": "if", "condition": {"compare": {
                    "left": {"count": {"zone": "active_hand", "card_id": "TS-0001"}},
                    "op": "ge", "right": 1}},
                 "then": {"op": "gain_xp", "amount": 1}},
                {"op": "for_each", "query": {"zone": "active_hand",
                                                "card_id": "TS-0001"},
                 "bind": "militia", "body": {"op": "gain_xp", "amount": 1}},
                {"op": "repeat", "times": 2, "limit": 2,
                 "body": {"op": "mod_gold", "amount": 1}},
                {"op": "schedule", "event": "TURN_WILL_END",
                 "body": {"op": "gain_xp", "amount": 3}}
            ]}
        }]}
        effects = compile_ruleset(custom, self.cards)
        state = start_game(request(seed="effect-flow"))["state"]
        state["effects_version"] = effects.version
        player = state["active_player_id"]
        militia = [item for item in state["zones"][f"player:{player}:hand"]
                   if state["instances"][item]["card_id"] == "TS-0001"]
        entered = apply_command(state, command(state, "ChooseAction", action="village"),
                                effects=effects)["state"]
        activated = apply_command(entered, command(
            entered, "ActivateAbility", ability_id="TS-0001-A99",
            source_instance_id=militia[0]), effects=effects)["state"]
        self.assertEqual(activated["players"][player]["xp"], 1 + len(militia))
        abilities_done = apply_command(activated, command(activated, "FinishAbilities"),
                                       effects=effects)["state"]
        gold = sum(int(self.cards[state["instances"][item]["card_id"]]["wiki_金币值"] or 0)
                   for item in state["zones"][f"player:{player}:hand"])
        self.assertEqual(abilities_done["players"][player]["temporary_gold"], gold + 2)
        buying_done = apply_command(abilities_done, command(
            abilities_done, "FinishBuying"), effects=effects)["state"]
        ended = apply_command(buying_done, command(
            buying_done, "FinishUpgrading"), effects=effects)["state"]
        self.assertEqual(ended["players"][player]["xp"], 4 + len(militia))
        self.assertEqual(ended["scheduled_effects"], [])
        self.assertEqual(ended["turn_number"], 2)

    def test_payment_card_gain_discard_and_battle_modifiers(self) -> None:
        custom = {"schema_version": "thunderstone.effects/1", "abilities": [
            {"id": "TS-0001-A96", "source_card_id": "TS-0001",
             "kind": "activated", "actions": ["village"],
             "source_zone": "active_hand", "usage": "once_per_turn",
             "conditions": [], "body": {"op": "sequence", "children": [
                 {"op": "cost_gate", "cost": {"op": "spend_xp", "amount": 2},
                  "then": {"op": "gain_card", "card_id": "TS-0003"}},
                 {"op": "select", "query": {"zone": "active_hand",
                                              "card_id": "TS-0002"},
                  "bind": "dagger", "then": {"op": "discard",
                                               "target": {"var": "dagger"}}}
             ]}},
            {"id": "TS-0001-A97", "source_card_id": "TS-0001",
             "kind": "activated", "actions": ["dungeon"],
             "source_zone": "active_hand", "usage": "once_per_turn",
             "conditions": [], "body": {"op": "sequence", "children": [
                 {"op": "mod_attack", "amount": 2},
                 {"op": "mod_light", "amount": 1}
             ]}}
        ]}
        effects = compile_ruleset(custom, self.cards)
        state = start_game(request(seed="effect-more-atoms"))["state"]
        player = state["active_player_id"]
        state["effects_version"] = effects.version
        state["zones"][f"player:{player}:hand"].extend(
            state["zones"][f"player:{player}:draw"])
        state["zones"][f"player:{player}:draw"].clear()
        militia = next(item for item in state["zones"][f"player:{player}:hand"]
                       if state["instances"][item]["card_id"] == "TS-0001")
        village = apply_command(state, command(state, "ChooseAction", action="village"),
                                effects=effects)["state"]
        original = copy.deepcopy(village)
        with self.assertRaises(TurnError):
            apply_command(village, command(village, "ActivateAbility",
                                           ability_id="TS-0001-A96",
                                           source_instance_id=militia), effects=effects)
        self.assertEqual(village, original)
        village["players"][player]["xp"] = 3
        bought = apply_command(village, command(village, "ActivateAbility",
                                                ability_id="TS-0001-A96",
                                                source_instance_id=militia),
                               effects=effects)["state"]
        self.assertEqual(bought["players"][player]["xp"], 1)
        self.assertTrue(any(bought["instances"][item]["card_id"] == "TS-0003"
                            for item in bought["zones"][f"player:{player}:discard"]))
        dagger = bought["pending_choice"]["candidate_instance_ids"][0]
        completed = apply_command(bought, command(bought, "ResolveChoice",
                                                   instance_id=dagger),
                                  effects=effects)["state"]
        self.assertIn(dagger, completed["zones"][f"player:{player}:discard"])

        battle = apply_command(state, command(state, "ChooseAction", action="dungeon"),
                               effects=effects)["state"]
        modified = apply_command(battle, command(battle, "ActivateAbility",
                                                 ability_id="TS-0001-A97",
                                                 source_instance_id=militia),
                                 effects=effects)["state"]
        self.assertEqual(modified["battle_context"]["modifiers"],
                         {"attack": 2, "light": 1})
        target = next(item["instance_ids"][0] for item in legal_commands(
            modified, effects=effects) if item["type"] == "DeclareBattleTarget")
        resolved = apply_command(modified, command(
            modified, "DeclareBattleTarget", target_instance_id=target),
            effects=effects)
        trace = next(event["calculation"] for event in resolved["events"]
                     if event["kind"] == "battle_resolved")
        self.assertEqual(trace["modifiers"], {"attack": 2, "light": 1})
