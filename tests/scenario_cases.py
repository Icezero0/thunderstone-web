"""Scenario-specific end conditions tested with real stone instances."""

from dataclasses import replace

from engine.turn.state import validate_turn_state
from engine.turn.workflow import queue_steps
from tests.mechanic_cases import Fixture


def verify_flying_spire(test, base, snapshot, ruleset):
    for acquire in (True, False):
        with test.subTest(first_stone_acquired=acquire):
            f = Fixture(base, snapshot.cards, ruleset, ruleset.mechanics[0])
            tx = f.tx
            tx.ruleset = replace(ruleset, abilities=(), mechanics=())
            state = tx.state
            state["active_settings"] = ["TS-0198"]
            state["selected_thunderstones"] = ["TS-0707", "TS-0708"]
            for zone in list(state["zones"]):
                if zone.startswith(("hall:", "dungeon:")):
                    state["zones"]["destroyed"].extend(state["zones"][zone])
                    state["zones"][zone] = []
            first = f.add("TS-0707", "hall:a")
            second = f.add("TS-0708", "hall:b")
            for suffix in ("a", "b"):
                for _ in range(2):
                    f.add("TS-0476", f"hall:{suffix}")
                for _ in range(3):
                    f.add("TS-0476", f"dungeon:{suffix}")
            queue_steps(tx, [{"op": "refill_hall", "hall_zone": "hall:a", "acquire_stone": acquire}])
            if acquire:
                test.assertEqual(state["phase"], "PLAYING")
                test.assertIn(first, tx.zone("discard"))
                test.assertEqual(len(state["zones"]["hall:a"]), 3)
                queue_steps(tx, [{"op": "refill_hall", "hall_zone": "hall:b", "acquire_stone": True}])
                test.assertEqual(state["phase"], "SETTLING")
                test.assertIn(second, tx.zone("discard"))
                test.assertEqual(len(state["acquired_stones"]), 2)
            else:
                test.assertEqual(state["phase"], "SETTLING")
                test.assertIn(first, state["zones"]["hall:a"])
                test.assertIsNone(state["end_condition"]["acquired_by"])
            test.assertIn("result", state)
            validate_turn_state(state, snapshot.cards)


def verify_banishing(test, base, snapshot, ruleset, kind):
    from engine.setup import start_game
    from engine.turn import apply_command
    from tests.test_setup_engine import config, request

    if kind == "banishing_setup":
        settings = config()
        selection = settings["selection"]
        selection["dungeon_features"]["mode"] = "manual"
        selection["environment"]["fixed_card_ids"] = ["TS-0199"]
        selection["guardian"]["fixed_card_ids"] = ["TS-0683"]
        selection["thunderstone"]["fixed_card_ids"] = [f"TS-{number:04d}" for number in range(707, 714)]
        state = start_game(request(settings, seed="banishing-contract"), snapshot=snapshot)["state"]
        test.assertEqual(len(state["selected_thunderstones"]), 7)
        test.assertEqual(state["instances"][state["zones"]["dungeon:main"][-1]]["card_id"], "TS-0683")
        test.assertTrue(all(snapshot.cards[state["instances"][item]["card_id"]]["subcategory"] == "怪物"
                            for item in state["zones"]["hall:main"]))
        return
    for success in (True, False):
        with test.subTest(success=success):
            f = Fixture(base, snapshot.cards, ruleset, ruleset.mechanics[0])
            tx = f.tx
            tx.ruleset = ruleset
            s = tx.state
            s["active_settings"] = ["TS-0199"]
            for zone in list(s["zones"]):
                if zone.startswith(("hall:", "dungeon:")):
                    s["zones"]["destroyed"].extend(s["zones"][zone])
                    s["zones"][zone] = []
            if kind == "banishing_stones":
                stone = f.add("TS-0707", "hall:main")
                for _ in range(2):
                    f.add("TS-0476", "hall:main")
                for _ in range(3):
                    f.add("TS-0476", "dungeon:main")
                queue_steps(tx, [{"op": "refill_hall", "hall_zone": "hall:main", "acquire_stone": success}])
                test.assertEqual(s["phase"], "PLAYING")
                if success:
                    test.assertIn(stone, tx.zone("discard"))
                else:
                    test.assertEqual(s["zones"]["dungeon:main"][-1], stone)
            else:
                # Keep the Heart behind rank one so a failed attack is not a breach.
                f.add("TS-0476", "hall:main")
                heart = f.add("TS-0683", "hall:main")
                if success:
                    s["battle_context"]["modifiers"] = {"attack": 100}
                result = apply_command(s, {"type": "DeclareBattleTarget", "player_id": f.player,
                                           "target_instance_id": heart}, snapshot=snapshot)
                s = result["state"]
                if success:
                    test.assertEqual(s["phase"], "SETTLING")
                    test.assertEqual(s["end_condition"]["reason"], "heart_of_doom_defeated")
                else:
                    test.assertEqual(s["phase"], "PLAYING")
                    test.assertTrue(s["players"][f.player]["eliminated"])
                    test.assertNotEqual(s["active_player_id"], f.player)
                    test.assertIn(heart, s["zones"]["hall:main"])
            validate_turn_state(s, snapshot.cards)
