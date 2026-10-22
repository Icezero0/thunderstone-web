"""Basic turn flow, immutable transitions and deterministic card movement."""

from __future__ import annotations

import copy
import unittest

from backend.app.integrations.game_engine.catalog.repository import load_catalog
from backend.app.integrations.game_engine.disease import take_disease
from backend.app.integrations.game_engine.setup import start_game
from backend.app.integrations.game_engine.turn import TurnError, apply_command, legal_commands
from backend.tests.migration.reference.python_engine.turn.state import validate_turn_state
from backend.tests.test_setup_engine import request


def run(state: dict, kind: str, **arguments: object) -> dict:
    return apply_command(state, {"type": kind,
                                 "player_id": state["active_player_id"],
                                 "expected_version": state["game_version"],
                                 **arguments})


class TurnEngineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.cards = load_catalog().cards

    def test_village_purchase_then_next_player_rest(self) -> None:
        original = start_game(request(seed="turn-village"))["state"]
        before = copy.deepcopy(original)
        player = original["active_player_id"]
        entered = run(original, "ChooseAction", action="village")
        self.assertEqual(original, before)
        self.assertEqual(entered["state"]["subphase"], "VILLAGE_BUY")
        lifecycle = [event["kind"] for event in entered["events"] if event["kind"] != "rule_timing"]
        self.assertEqual(lifecycle[:3],
                         ["TURN_WILL_START", "TURN_STARTED", "ACTION_WILL_ENTER"])
        bought = run(entered["state"], "BuyCard", card_id="TS-0001")
        self.assertEqual(bought["state"]["players"][player]["purchases_remaining"], 0)
        self.assertEqual(bought["state"]["instances"][bought["events"][0]["instance_id"]][
            "owner_player_id"], player)
        after_buy = run(bought["state"], "FinishBuying")["state"]
        ended = run(after_buy, "FinishUpgrading")
        next_state = ended["state"]
        self.assertEqual(next_state["turn_number"], 2)
        self.assertNotEqual(next_state["active_player_id"], player)
        self.assertEqual(len(next_state["zones"][f"player:{player}:hand"]), 6)
        self.assertEqual(next_state["players"][player]["temporary_gold"], 0)
        self.assertEqual(next_state["players"][player]["purchases_remaining"], 1)
        self.assertEqual(next_state["game_version"], original["game_version"] + 4)
        self.assertEqual([event["sequence"] for event in ended["events"]],
                         list(range(ended["events"][0]["sequence"],
                                    ended["events"][-1]["sequence"] + 1)))
        next_player = next_state["active_player_id"]
        rest = run(next_state, "ChooseAction", action="rest")["state"]
        finished = run(rest, "FinishRest")["state"]
        self.assertEqual(finished["active_player_id"], player)
        self.assertEqual(finished["turn_number"], 3)
        self.assertEqual(finished["round_number"], 2)
        self.assertEqual(len(finished["zones"][f"player:{next_player}:hand"]), 6)
        validate_turn_state(finished, self.cards)

    def test_militia_upgrade_pays_source_cost_and_destroys_source(self) -> None:
        state = start_game(request(seed="turn-upgrade"))["state"]
        player = state["active_player_id"]
        state["players"][player]["xp"] = 3
        militia = next(item for item in state["zones"][f"player:{player}:hand"]
                       if state["instances"][item]["card_id"] == "TS-0001")
        state = run(state, "ChooseAction", action="village")["state"]
        state = run(state, "FinishBuying")["state"]
        options = next(item["options"] for item in legal_commands(state)
                       if item["type"] == "UpgradeHero")
        selected = next(item for item in options if item["source_instance_id"] == militia)
        result = run(state, "UpgradeHero", source_instance_id=militia,
                     target_card_id=selected["target_card_id"])
        updated = result["state"]
        self.assertEqual(updated["players"][player]["xp"], 0)
        self.assertIn(militia, updated["zones"]["destroyed"])
        self.assertIsNone(updated["instances"][militia]["owner_player_id"])
        acquired = next(event["target_instance_id"] for event in result["events"]
                        if event["kind"] == "hero_upgraded")
        self.assertIn(acquired, updated["zones"][f"player:{player}:discard"])
        with self.assertRaises(TurnError):
            run(updated, "UpgradeHero", source_instance_id=militia,
                target_card_id=selected["target_card_id"])
        validate_turn_state(updated, self.cards)

    def test_rest_disease_returns_to_infinite_supply(self) -> None:
        state = start_game(request(seed="turn-disease"))["state"]
        player = state["active_player_id"]
        disease = take_disease(state, player, destination="hand")
        state = run(disease["state"], "ChooseAction", action="rest")["state"]
        result = run(state, "RestDestroy", instance_id=disease["instance_id"])
        self.assertNotIn(disease["instance_id"], result["state"]["instances"])
        self.assertEqual(result["state"]["turn_number"], 2)
        self.assertEqual(next(event["destination"] for event in result["events"]
                              if event["kind"] == "rest_card_destroyed"),
                         "disease_supply")
        validate_turn_state(result["state"], self.cards)

    def test_dungeon_battle_and_equipment_complete_a_turn(self) -> None:
        state = start_game(request(seed="turn-dungeon"))["state"]
        player = state["active_player_id"]
        hand_zone = f"player:{player}:hand"
        draw_zone = f"player:{player}:draw"
        state["zones"][hand_zone].extend(state["zones"][draw_zone])
        state["zones"][draw_zone].clear()
        state = run(state, "ChooseAction", action="dungeon")["state"]
        hand = state["zones"][hand_zone]
        militia = next(item for item in hand
                       if state["instances"][item]["card_id"] == "TS-0001")
        dagger = next(item for item in hand
                      if state["instances"][item]["card_id"] == "TS-0002")
        state = run(state, "EquipWeapon", hero_instance_id=militia,
                    weapon_instance_id=dagger)["state"]
        target = state["zones"]["hall:main"][0]
        # Keep the baseline test independent of newly implemented optional
        # payments on whichever random monster this seed originally selected.
        state["instances"][target]["card_id"] = "TS-0476"
        result = run(state, "DeclareBattleTarget", target_instance_id=target)
        battle = next(event for event in result["events"]
                      if event["kind"] == "battle_resolved")
        self.assertTrue(any(item["instance_id"] == dagger
                            for item in battle["calculation"]["components"]))
        self.assertEqual(battle["calculation"]["attack"], 7)
        self.assertIn(battle["outcome"], ("win", "loss"))
        self.assertEqual(result["state"]["turn_number"], 2)
        validate_turn_state(result["state"], self.cards)

    def test_thunderstone_reaching_rank_one_stops_turn_before_cleanup(self) -> None:
        initial = start_game(request(seed="turn-dungeon"))["state"]
        player = initial["active_player_id"]
        stone_card_id = initial["selected_thunderstones"][0]
        stone = next(item for item in initial["zones"]["dungeon:main"]
                     if initial["instances"][item]["card_id"] == stone_card_id)
        initial["zones"]["dungeon:main"].remove(stone)
        displaced = initial["zones"]["hall:main"][1]
        initial["zones"]["hall:main"][1] = stone
        initial["zones"]["dungeon:main"].insert(0, displaced)
        initial["zones"][f"player:{player}:hand"].extend(
            initial["zones"][f"player:{player}:draw"])
        initial["zones"][f"player:{player}:draw"].clear()
        state = run(initial, "ChooseAction", action="dungeon")["state"]
        target = state["zones"]["hall:main"][0]
        state["instances"][target]["card_id"] = "TS-0476"
        result = run(state, "DeclareBattleTarget", target_instance_id=target)
        self.assertEqual(result["state"]["phase"], "SETTLING")
        self.assertEqual(result["state"]["turn_number"], 1)
        self.assertEqual(result["state"]["end_condition"]["acquired_by"], player)
        self.assertIn(stone, result["state"]["zones"][f"player:{player}:discard"])
        self.assertFalse(any(event["kind"] == "turn_hand_discarded"
                             for event in result["events"]))
        self.assertEqual(result["legal_commands"], [])
        with self.assertRaises(TurnError):
            run(result["state"], "ChooseAction", action="rest")

    def test_invalid_commands_preserve_input_and_replay_matches(self) -> None:
        initial = start_game(request(seed="turn-replay"))["state"]
        snapshot = copy.deepcopy(initial)
        with self.assertRaises(TurnError):
            apply_command(initial, {"type": "ChooseAction", "action": "rest",
                                    "player_id": "intruder"})
        with self.assertRaises(TurnError):
            apply_command(initial, {"type": "ChooseAction", "action": "rest",
                                    "player_id": initial["active_player_id"],
                                    "expected_version": 99})
        with self.assertRaises(TurnError):
            run(initial, "BuyCard", card_id="TS-0001")
        self.assertEqual(initial, snapshot)
        ritual = copy.deepcopy(initial)
        ritual["active_settings"] = ["TS-0199"]
        self.assertIn("dungeon", legal_commands(ritual)[0]["actions"])
        self.assertEqual(run(ritual, "ChooseAction", action="dungeon")["state"]["subphase"],
                         "DUNGEON_PREPARE")

        def four_turns() -> tuple[dict, list[dict]]:
            state = copy.deepcopy(initial)
            events = []
            for _ in range(4):
                chosen = run(state, "ChooseAction", action="rest")
                finished = run(chosen["state"], "FinishRest")
                state = finished["state"]
                events.extend(chosen["events"] + finished["events"])
            return state, events

        state, events = four_turns()
        self.assertEqual((state, events), four_turns())
        self.assertTrue(any(event["kind"] == "player_deck_shuffled" for event in events))
        validate_turn_state(state, self.cards)
