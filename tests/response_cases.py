"""Behavior contracts for each reviewed response source."""

from engine.effects.responses import resolve_response
from engine.effects.runtime import activate, dispatch_event, resolve_choice
from engine.effects.choices import resolve_value
from engine.turn.dungeon import declare_battle_target
from engine.turn.state import validate_turn_state


def settle(test, tx, source=None, recipient=None):
    for _ in range(30):
        choice = tx.state["pending_choice"]
        if choice is None:
            return
        kind = choice["kind"]
        if kind == "effect_response":
            if choice["stage"] == "recipient":
                completed = resolve_response(tx, recipient_id=recipient or choice["options"][0])
            else:
                offered = [item["source_instance_id"] for item in choice["options"]]
                completed = resolve_response(tx, source_instance_id=source if source in offered else None)
        elif kind == "effect_select":
            completed = resolve_choice(tx, choice["candidate_instance_ids"][:choice["min_count"]])
        elif kind == "effect_value":
            completed = resolve_value(tx, choice["options"][0])
        else:
            test.fail(f"unexpected response continuation: {kind}")
        if completed and tx.state.get("effect_resume"):
            tx.resume_after_effects()
    test.fail("response continuation did not terminate")


def verify_response(test, base, cards, ruleset, rule):
    from tests.mechanic_cases import Fixture
    f = Fixture(base, cards, ruleset, rule)
    tx = f.tx
    tx.ruleset = ruleset
    tx.state["active_settings"] = []
    for zone in list(tx.state["zones"]):
        if zone.startswith(("hall:", "dungeon:")):
            tx.state["zones"]["destroyed"].extend(tx.state["zones"][zone])
            tx.state["zones"][zone] = []
    actor = f.player
    other = next(player for player in tx.state["player_order"] if player != actor)
    action = rule.params["action"]
    if action in ("ignore_trap", "redirect_trap"):
        source = f.add(rule.source_card_id)
        hero = f.add("TS-0302")
        enemy = f.add("TS-0302", player=other)
        enemy2 = f.add("TS-0302", player=other) if action == "redirect_trap" else None
        trap = f.add("TS-0688", "revealed:main")
        tx.state["event_context"] = {"source_instance_id": trap}
        dispatch_event(tx, ruleset, "TRAP_REVEALED")
        test.assertEqual(tx.state["pending_choice"]["kind"], "effect_response")
        settle(test, tx, source=source, recipient=other)
        test.assertIn(hero, tx.zone("hand", actor))
        test.assertIn(enemy, tx.state["zones"]["destroyed"])
        if enemy2:
            test.assertIn(enemy2, tx.state["zones"]["destroyed"])
        if rule.params.get("once_per_turn"):
            trap2 = f.add("TS-0688", "revealed:main")
            tx.state["event_context"] = {"source_instance_id": trap2}
            dispatch_event(tx, ruleset, "TRAP_REVEALED")
            settle(test, tx)
            test.assertIn(hero, tx.state["zones"]["destroyed"])
    elif action == "ignore_battle":
        source = f.add(rule.source_card_id, f"player:{actor}:control")
        f.add("TS-0302")
        target = f.add("TS-0476", "hall:main")
        declare_battle_target(tx, target)
        test.assertEqual(tx.state["pending_choice"]["kind"], "effect_response")
        settle(test, tx, source=source)
        test.assertIn(source, tx.state["zones"]["destroyed"])
        test.assertFalse(any(event["kind"] == "disease_taken_from_supply" for event in tx.events))
        test.assertEqual(sum(event["kind"] == "battle_resolved" for event in tx.events), 1)
    elif action == "prevent_destroy":
        source = f.add(rule.source_card_id)
        hero = f.add("TS-0001")
        for _ in range(8):
            f.add("TS-0003", f"player:{actor}:draw")
        target = f.add("TS-0486", "hall:main")
        declare_battle_target(tx, target)
        test.assertTrue(any(event["kind"] == "battle_resolved" for event in tx.events))
        test.assertEqual(tx.state["pending_choice"]["kind"], "effect_response")
        settle(test, tx, source=source)
        test.assertNotIn(hero, tx.state["zones"]["destroyed"])
        test.assertIn(source, tx.state["zones"]["destroyed"])
        test.assertEqual(sum(event["kind"] == "hero_destruction_prevented" for event in tx.events), 1)
    elif action == "redirect_opponent":
        source = f.add(rule.source_card_id, player=other)
        own = f.add("TS-0302")
        enemy = f.add("TS-0302", player=other)
        assassin = f.add("TS-0392")
        activate(tx, ruleset, "TS-0392-A02", assassin)
        test.assertEqual(tx.state["pending_choice"]["player_id"], other)
        settle(test, tx, source=source)
        test.assertIn(own, tx.zone("discard", actor))
        test.assertIn(enemy, tx.zone("hand", other))
        test.assertIn(source, tx.zone("hand", other))
    validate_turn_state(tx.state, cards)
