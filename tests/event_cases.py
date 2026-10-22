"""Card-level event scenarios with explicit expected outcomes and timing checks."""

from dataclasses import replace

from tests.migration.reference.python_engine.effects.runtime import dispatch_event, resolve_choice, resolve_effect_order, resolve_purchase
from tests.migration.reference.python_engine.turn.state import validate_turn_state
from tests.mechanic_cases import Fixture


def settle(test, f):
    for _ in range(100):
        choice = f.tx.state["pending_choice"]
        if choice is None:
            return
        if choice["kind"] == "effect_order":
            resolve_effect_order(f.tx, [x["effect_id"] for x in choice["effects"]])
        elif choice["kind"] == "effect_response":
            from tests.migration.reference.python_engine.effects.responses import resolve_response
            resolve_response(f.tx)
        elif choice["kind"] == "effect_purchase":
            resolve_purchase(f.tx, f.purchase_preference)
        else:
            count = min(choice.get("max_count", 1), getattr(f, "choose_count", 100))
            resolve_choice(f.tx, choice["candidate_instance_ids"][:count])
    test.fail("event scenario did not finish")


def verify_events(test, base, snapshot, ruleset, cases):
    for case in cases:
        with test.subTest(ability=case["ability_id"]):
            verify_event(test, base, snapshot, ruleset, case)
        for variant in case.get("variants", []):
            with test.subTest(ability=case["ability_id"], variant=variant):
                verify_event(test, base, snapshot, ruleset, {**case, **variant})


def verify_event(test, base, snapshot, ruleset, case):
    ability = ruleset.by_id(case["ability_id"])
    isolated = replace(ruleset, abilities=(ability,), mechanics=())
    f = Fixture(base, snapshot.cards, isolated, ruleset.mechanics[0])
    tx = f.tx
    f.purchase_preference = case["expected"].get("purchased_card")
    f.choose_count = case.get("choose_count", 100)
    tx.ruleset = isolated
    state = tx.state
    for zone in list(state["zones"]):
        if zone.startswith(("village_supply:", "hero_supply:", "hall:", "dungeon:", "settings")):
            state["zones"]["destroyed"].extend(state["zones"][zone])
            state["zones"][zone] = []
    state["active_settings"] = []
    if case["expected"].get("front_rotated") or case["expected"].get("hall_returned") or case["expected"].get("stone_returned"):
        front_cards = ["TS-0476", "TS-0477", "TS-0478"]
        if case["expected"].get("stone_returned"):
            front_cards[1] = "TS-0707"
        f.hall_fixture = [f.add(card, "hall:main") for card in front_cards]
        for _ in range(5):
            f.add("TS-0476", "dungeon:main")
    if case["expected"].get("front_rotated"):
        state["chosen_action"] = "rest"
    if case["expected"].get("extra_buys"):
        state["chosen_action"] = "village"
    if ability.id.startswith(("TS-0352", "TS-0353")):
        state["turn_defeated_monsters"] = [f.add("TS-0476", f"player:{f.player}:discard")]
    for player in state["player_order"]:
        state["players"][player]["xp"] = 5
        for card_id in case["hand"]:
            f.add(card_id, player=player)
        for card_id in case["draw"]:
            f.add(card_id, f"player:{player}:draw")
    for index, spec in enumerate(case["supplies"]):
        for _ in range(spec["count"]):
            f.add(spec["card_id"], f"{spec['kind']}_supply:event{index}")
    if ability.source_zone == "attached":
        from tests.migration.reference.python_engine.effects.attachments import attach
        source = f.add(ability.source_card_id, f"player:{f.player}:control")
        f.attached_item = f.add("TS-0302")
        f.attachment_kind = "cage" if ability.id.startswith("TS-0684") else "emerald"
        attach(tx, f.attached_item, source, f.attachment_kind, owner=f.player)
    elif ability.source_zone == "settings":
        source = f.add(ability.source_card_id, "settings")
        state["active_settings"] = [ability.source_card_id]
    elif ability.source_zone == "active_control":
        source = f.add(ability.source_card_id, f"player:{f.player}:control")
    elif ability.source_zone == "active_hand":
        source = f.add(ability.source_card_id)
    elif ability.source_zone == "hall":
        source = f.add(ability.source_card_id, "hall:main:rank0" if ability.id in ("TS-0682-A03", "TS-0673-A02") else "hall:main")
    elif ability.source_zone == "battle_target":
        source = f.add(ability.source_card_id, "hall:main")
        state["battle_context"]["target_instance_id"] = source
    elif ability.event == "CARD_EQUIPPED":
        source = f.add(ability.source_card_id)
    else:
        source = f.add(ability.source_card_id, "revealed:main")
    state["event_context"] = {"source_instance_id": source, "rank": 3}
    if ability.id == "TS-0482-A01":
        state["event_context"]["source_instance_id"] = f.add("TS-0476", f"player:{f.player}:discard")
    if ability.event == "MONSTER_DEFEATED" and ("attachment" in case["expected"] or "released" in case["expected"]):
        state["event_context"]["source_instance_id"] = f.add("TS-0464", f"player:{f.player}:discard")
    if case["expected"].get("shuffled_traps"):
        f.trap_fixture = f.add("TS-0688", "destroyed")
        f.add("TS-0476", "dungeon:main")
        state["event_context"]["hall_zone"] = "hall:main"
    if case["expected"].get("extra_turn"):
        state["event_context"]["source_instance_id"] = f.add("TS-0476", f"player:{f.player}:discard")
    if ability.id in ("TS-0562-A01", "TS-0563-A01", "TS-0673-A02"):
        purchased = f.add("TS-0302" if ability.id == "TS-0563-A01" else "TS-0226", f"player:{f.player}:discard")
        state["event_context"]["source_instance_id"] = purchased
        state["event_context"]["supply_zone"] = "village_supply:event0"
    if ability.event == "CARD_EQUIPPED":
        hero = f.add("TS-0302")
        state["battle_context"]["equipped_weapon_by_hero"][hero] = source
        state["event_context"]["hero_instance_id"] = hero
    if case.get("defeated_monster"):
        state["event_context"]["defeated_instance_id"] = f.add(case["defeated_monster"], f"player:{f.player}:discard")
    test.assertIn(case["source_line"], snapshot.cards[ability.source_card_id]["effect_text"].splitlines())
    if ability.id in ("TS-0463-A01", "TS-0689-A01", "TS-0693-A01"):
        # User-confirmed search rules postdate the frozen Python interpreter.
        # Exercise the current shared engine through its ordinary command path.
        from backend.app.integrations.game_engine.turn import apply_command
        state["subphase"] = "TURN_START"
        state["started_turn"] = state["turn_number"]
        state["workflow_steps"] = [{"op": "event", "event": ability.event, "context": {"source_instance_id": source}}]
        result = apply_command(state, {"type": "ChooseAction", "player_id": f.player, "action": "village"},
                               snapshot=snapshot, effects=isolated)
        state.clear()
        state.update(result["state"])
        tx.events.extend(result["events"])
    else:
        dispatch_event(tx, isolated, ability.event)
    settle(test, f)
    if case.get("scheduled"):
        test.assertEqual(len(state["scheduled_effects"]), 1)
        test.assertFalse(any(e["kind"] == "disease_taken_from_supply" for e in tx.events))
        scheduled = state["scheduled_effects"][0]
        # Another player's turn cannot consume this schedule.
        actor = state["active_player_id"]
        state["active_player_id"] = next(p for p in state["player_order"] if p != actor)
        dispatch_event(tx, isolated, scheduled["event"])
        test.assertEqual(len(state["scheduled_effects"]), 1)
        state["active_player_id"] = actor
        state["turn_number"] = scheduled["turn_number"]
        dispatch_event(tx, isolated, scheduled["event"])
        settle(test, f)
        test.assertEqual(state["scheduled_effects"], [])
    expected = case["expected"]
    if "attachment" in expected:
        test.assertEqual(state["attachments"][source][0]["kind"], expected["attachment"])
        test.assertIn(source, state["zones"][f"player:{f.player}:aside"])
    if "released" in expected:
        test.assertNotIn(source, state["attachments"])
        test.assertIn(source, state["zones"]["destroyed"])
        test.assertIn(f.attached_item, tx.zone("discard"))
    if "global_rule" in expected:
        test.assertEqual(state["continuous_effects"][-1]["kind"], expected["global_rule"])
    if "extra_turn" in expected:
        test.assertEqual(tx.player["extra_turns"], expected["extra_turn"])
        test.assertIn(source, state["zones"]["destroyed"])
    if expected.get("shuffled_traps"):
        test.assertNotIn(f.trap_fixture, state["zones"]["destroyed"])
        test.assertIn(f.trap_fixture, state["zones"]["dungeon:main"])
    if "harvested_monsters" in expected:
        opponents = len(state["player_order"]) - 1
        test.assertEqual(sum(tx.card(item)["subcategory"] == "怪物" for item in tx.zone("discard")), opponents * expected["harvested_monsters"])
    if "source_top" in expected:
        test.assertEqual(tx.zone("draw")[0], source)
    if "source_refill" in expected:
        test.assertIn(source, state["zones"][f"player:{f.player}:refill_add"])
    if "refill_count" in expected:
        test.assertEqual(len(state["zones"][f"player:{f.player}:refill_add"]), expected["refill_count"])
    if "extra_buys" in expected:
        test.assertEqual(tx.player["purchases_remaining"], 1 + expected["extra_buys"])
    if expected.get("front_rotated"):
        test.assertEqual(state["zones"]["hall:main"], f.hall_fixture[1:] + f.hall_fixture[:1])
    if expected.get("hall_returned"):
        test.assertEqual(state["zones"]["dungeon:main"][-1], f.hall_fixture[0])
    if expected.get("stone_returned"):
        test.assertIn(f.hall_fixture[1], state["zones"]["dungeon:main"])
        test.assertNotIn(f.hall_fixture[1], state["zones"]["hall:main"])
    if "basic_destruction" in expected:
        test.assertEqual(sum(e["count"] for e in tx.events if e["kind"] == "infinite_supply_destruction"), expected["basic_destruction"])
    if "protected_heroes" in expected:
        test.assertEqual(sum(any(buff["buff"] == "discard_instead_of_destroy"
                                for buff in instance["flags"].get("turn_buffs", []))
                             for instance in state["instances"].values()), expected["protected_heroes"])
    if "active_discard" in expected:
        test.assertEqual(len(tx.zone("discard")), expected["active_discard"])
    removed = [e for e in tx.events if e["kind"] == "card_destroyed"]
    if "destroy_total" in expected:
        test.assertEqual(len(removed), expected["destroy_total"])
    if "reveal_total" in expected:
        test.assertEqual(sum(len(e["instance_ids"]) for e in tx.events if e["kind"] == "cards_revealed"), expected["reveal_total"])
    if "destroyed" in expected:
        test.assertCountEqual([e["card_id"] for e in removed], expected["destroyed"])
    for player in state["player_order"]:
        actual = sum(e["source"].startswith(f"player:{player}:") for e in removed)
        if "destroy_count_each" in expected:
            test.assertEqual(actual, expected["destroy_count_each"])
        if "other_destroy_count" in expected:
            test.assertEqual(actual, expected["other_destroy_count"] if player != f.player else 0)
        if "discard_count_each" in expected and (not case["active_only"] or player == f.player):
            test.assertEqual(len(tx.zone("discard", player)), expected["discard_count_each"])
        if "draw_remaining_each" in expected:
            test.assertEqual(len(tx.zone("draw", player)), expected["draw_remaining_each"])
        diseases = [e for e in tx.events if e["kind"] == "disease_taken_from_supply" and e["player_id"] == player]
        test.assertEqual(len(diseases), expected.get("diseases_each", expected.get("diseases", 0) if player == f.player else 0))
    if "supply_destroyed" in expected:
        test.assertEqual(sum(e["source"].startswith(("village_supply:", "hero_supply:")) for e in removed), expected["supply_destroyed"])
    if "xp" in expected:
        test.assertEqual(tx.player["xp"], expected["xp"])
    if "next_hand" in expected:
        test.assertEqual(tx.player["next_hand_bonus"], expected["next_hand"])
    if "gold_adjustment" in expected:
        test.assertEqual(tx.player["turn_gold_adjustment"], expected["gold_adjustment"])
    if "forced_dungeon" in expected:
        test.assertEqual(tx.player["forced_dungeon"], expected["forced_dungeon"])
    if "gained" in expected:
        test.assertIn(expected["gained"], [tx.card(i)["card_id"] for i in tx.zone("discard")])
    if "purchased_card" in expected:
        purchases = [e for e in tx.events if e["kind"] == "effect_purchase_completed"]
        test.assertEqual(len(purchases), 1)
        test.assertEqual(purchases[0]["card_id"], expected["purchased_card"])
    test.assertFalse(any("revealed_" in zone for zone in state["zones"]))
    validate_turn_state(state, snapshot.cards)
