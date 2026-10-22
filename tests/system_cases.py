"""Tests for card lines that explicitly reuse one shared engine rule."""

from dataclasses import replace

from tests.migration.reference.python_engine.effects.combat import reconcile_equipment
from tests.migration.reference.python_engine.turn.hall import remember_fronts
from tests.migration.reference.python_engine.turn.state import validate_turn_state
from tests.migration.reference.python_engine.turn.workflow import queue_steps
from tests.mechanic_cases import Fixture


def verify_system(test, base, snapshot, ruleset, card_id, kinds):
    for kind in set(kinds):
        with test.subTest(system_rule=kind):
            if kind == "flying_spire_end":
                from tests.scenario_cases import verify_flying_spire
                verify_flying_spire(test, base, snapshot, ruleset)
                continue
            if kind in ("banishing_setup", "banishing_stones", "heart_of_doom_end"):
                from tests.scenario_cases import verify_banishing
                verify_banishing(test, base, snapshot, ruleset, kind)
                continue
            if kind.startswith("setup_") or kind in ("two_dungeon_setup", "stormhold_setup"):
                from tests.setup_effect_cases import verify_setup_effect
                verify_setup_effect(test, snapshot, kind)
                continue
            f = Fixture(base, snapshot.cards, ruleset, ruleset.mechanics[0])
            tx = f.tx
            tx.ruleset = replace(ruleset, abilities=(), mechanics=())
            s = tx.state
            for zone in list(s["zones"]):
                if zone.startswith(("hall:", "dungeon:")):
                    s["zones"]["destroyed"].extend(s["zones"][zone])
                    s["zones"][zone] = []
            if kind == "sapphire_restore_at_end":
                from tests.migration.reference.python_engine.effects.attachments import attach
                from tests.migration.reference.python_engine.turn.settlement import settle_game
                source = f.add("TS-0705", f"player:{f.player}:control")
                monster = f.add("TS-0464", f"player:{f.player}:discard")
                attach(tx, monster, source, "sapphire", owner=f.player)
                settle_game(tx, "test_sapphire_end")
                test.assertIn(source, tx.zone("discard"))
                test.assertIn(monster, tx.zone("discard"))
                test.assertNotIn(source, s["attachments"])
                test.assertEqual(s["result"]["players"][f.player]["victory_points"], 10)
            elif kind == "zero_strength":
                disease = f.add(card_id)
                hero = f.add("TS-0302")
                s["battle_context"]["card_modifiers"] = {hero: {"strength": -100}}
                reconcile_equipment(tx, during_battle=True)
                reconcile_equipment(tx, during_battle=True)
                test.assertEqual(sum(e["kind"] == "hero_zero_strength_marked" for e in tx.events), 1)
                test.assertIn(hero, tx.zone("hand"), "zero strength destruction is deferred")
                s["battle_context"]["card_modifiers"][hero]["strength"] = 20
                reconcile_equipment(tx, during_battle=True)
                test.assertTrue(s["instances"][hero]["flags"]["pending_turn_end_destruction"])
                tx.finish_turn()
                destroyed = [e for e in tx.events if e["kind"] == "card_destroyed" and e["instance_id"] == hero]
                test.assertEqual(len(destroyed), 1)
                test.assertIn(hero, s["zones"]["destroyed"])
                test.assertIn(disease, s["instances"])
            elif kind in ("guardian_rank0", "extra_hall_rank"):
                source = f.add(card_id, "hall:main")
                for _ in range(2):
                    f.add("TS-0476", "hall:main")
                for _ in range(5):
                    f.add("TS-0476", "dungeon:main")
                remember_fronts(tx)
                queue_steps(tx, [{"op": "refill_hall", "hall_zone": "hall:main"}])
                if kind == "guardian_rank0":
                    test.assertIn(source, s["zones"]["hall:main:rank0"])
                    test.assertEqual(len(s["zones"]["hall:main"]), 3)
                    test.assertEqual(sum(e["kind"] == "guardian_entered_rank_0" for e in tx.events), 1)
                else:
                    test.assertEqual(len(s["zones"]["hall:main"]), 4)
                    tx.destroy_card(source, reason="test_extra_rank_card_leaves")
                    queue_steps(tx, [{"op": "refill_hall", "hall_zone": "hall:main"}])
                    test.assertEqual(len(s["zones"]["hall:main"]), 3)
                    test.assertEqual(len(s["zones"]["dungeon:main"]), 4)
                    from tests.setup_effect_cases import verify_initial_treefolk
                    verify_initial_treefolk(test, snapshot, card_id)
            elif kind == "swamp_delayed_features":
                s["active_settings"] = ["TS-0188"]
                initial = [f.add("TS-0476", "hall:main") for _ in range(3)]
                trap = f.add("TS-0685", "dungeon:main")
                for _ in range(8):
                    f.add("TS-0476", "dungeon:main")
                remember_fronts(tx)
                queue_steps(tx, [{"op": "refill_hall", "hall_zone": "hall:main"}])
                test.assertEqual(s["zones"]["hall:main"], [*initial, trap])
                test.assertFalse(any(e["kind"] == "trap_revealed" for e in tx.events))
                for instance in initial:
                    tx.destroy_card(instance, reason="test_advance")
                queue_steps(tx, [{"op": "refill_hall", "hall_zone": "hall:main"}])
                test.assertIn(trap, s["zones"]["destroyed"])
                test.assertEqual(sum(e["kind"] == "trap_revealed" for e in tx.events), 1)
                test.assertEqual(len(s["zones"]["hall:main"]), 4)
            else:
                test.fail(f"unknown system contract {kind}")
            validate_turn_state(s, snapshot.cards)
