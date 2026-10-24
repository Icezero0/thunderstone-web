"""Monster-specific battle contracts exercised through actual turn commands."""

from copy import deepcopy
from dataclasses import replace

from backend.tests.migration.reference.python_engine.effects.combat import stat, matches, is_hero
from backend.app.integrations.game_engine.turn import apply_command
from backend.tests.support.effects.mechanic_cases import Fixture


def verify_battle_case(test, base, snapshot, ruleset, case, *, empty=False):
    cards = snapshot.cards
    ability = ruleset.by_id(case["ability_id"])
    isolated = replace(ruleset, abilities=(ability,))
    f = Fixture(base, cards, isolated, ruleset.mechanics[0])
    f.tx.ruleset = isolated
    state = f.tx.state
    for zone in list(state["zones"]):
        if zone.startswith(("hall:", "dungeon:")):
            state["zones"].setdefault("destroyed", []).extend(state["zones"][zone])
            state["zones"][zone] = []
    for card_id in (() if empty else case["hand"]):
        f.add(card_id)
    for index, spec in enumerate(case.get("supplies", [])):
        for _ in range(spec["count"]):
            f.add(spec["card_id"], f"{spec['kind']}_supply:battle{spec.get('pile', index)}")
    if case.get("attack"):
        state["battle_context"]["modifiers"] = {"attack": case["attack"]}
    for card in case.get("used_card_ids", []):
        item = next(item for item in f.tx.zone("hand") if f.tx.card(item)["card_id"] == card)
        state.setdefault("used_cards", []).append(item)
    for card in case.get("excluded_card_ids", []):
        item = next(item for item in f.tx.zone("hand") if f.tx.card(item)["card_id"] == card)
        state["battle_context"].setdefault("excluded_participants", []).append(item)
    for player in state["player_order"]:
        state["players"][player]["xp"] = case.get("xp", 5)
        if player != f.player and (case["expected"].get("destroy_count_each") or case.get("other_hand")) and not empty:
            for card_id in case.get("other_hand", case["hand"]):
                f.add(card_id, player=player)
        for _ in range(12):
            f.add("TS-0001", f"player:{player}:draw")
    target = f.add(ability.source_card_id, "hall:main")
    if case.get("assert_failed_departure"):
        for _ in range(3):
            f.add("TS-0510", "dungeon:main")
    if case.get("equipment") and not empty:
        hero_card, weapon_card = case["equipment"]
        owner = next(item for item in f.tx.zone("hand") if f.tx.card(item)["card_id"] == hero_card)
        weapon = next(item for item in f.tx.zone("hand") if f.tx.card(item)["card_id"] == weapon_card)
        state["battle_context"]["equipped_weapon_by_hero"][owner] = weapon
    test.assertIn(case["source_line"], cards[ability.source_card_id]["effect_text"].splitlines())
    original = deepcopy(state)
    result = apply_command(state, {"type": "DeclareBattleTarget", "player_id": f.player,
                                   "target_instance_id": target}, snapshot=snapshot, effects=isolated)
    test.assertEqual(state, original, "battle command mutated input")
    events = list(result["events"])
    state = result["state"]
    choices = 0
    values = list(case.get("values", []))
    while state["pending_choice"]:
        choices += 1
        test.assertLess(choices, 100)
        choice = state["pending_choice"]
        if choice["kind"] == "effect_response":
            command = {"type": "ResolveResponse"}
        elif choice["kind"] == "effect_order":
            command = {"type": "ResolveEffectOrder", "effect_ids": [item["effect_id"] for item in choice["effects"]]}
        elif choice["kind"] == "effect_value":
            command = {"type": "ResolveValueChoice", "value": values.pop(0) if values else choice["options"][0]}
        else:
            candidates = list(choice["candidate_instance_ids"])
            if choice.get("highest_by"):
                candidates.sort(key=lambda item: stat(cards[state["instances"][item]["card_id"]], choice["highest_by"]), reverse=True)
            picked = []
            count = min(case.get("choose_count", 100), choice.get("max_count", 1))
            for item in candidates:
                if len(picked) == count:
                    break
                if all(sum(matches(cards[state["instances"][candidate]["card_id"]], constraint["filter"])
                               for candidate in [*picked, item]) <= constraint["maximum"]
                       for constraint in choice.get("constraints", [])):
                    picked.append(item)
            command = {"type": "ResolveChoice", "instance_ids": picked}
        result = apply_command(state, {**command, "player_id": choice["player_id"]},
                               snapshot=snapshot, effects=isolated)
        state = result["state"]
        events.extend(result["events"])
    expected = {} if empty else case["expected"]
    battle = next(event for event in events if event["kind"] == "battle_resolved")
    if "health_bonus" in expected:
        test.assertEqual(battle["health"], stat(cards[ability.source_card_id], "health") + expected["health_bonus"])
    if "damage_divisor" in expected:
        scales = [event for event in events if event["kind"] == "effect_damage_scaled"
                  and event["ability_id"] == ability.id]
        test.assertEqual(len(scales), 1)
        test.assertEqual(scales[0]["combined_divisor"], expected["damage_divisor"])
        test.assertEqual(battle["calculation"]["attack"], case["attack"] // expected["damage_divisor"])
    if "random_destroyed" in expected:
        removed = [e for e in events if e["kind"] == "card_destroyed" and e["reason"] == case["ability_id"]]
        test.assertEqual(len(removed), expected["random_destroyed"])
        test.assertTrue(all(e["sequence"] > battle["sequence"] for e in removed))
    if "supply_destroyed" in expected:
        removed = [e for e in events if e["kind"] == "card_destroyed" and e["source"].startswith(("village_supply:", "hero_supply:"))]
        test.assertEqual(len(removed), expected["supply_destroyed"])
        if "supply_destroyed_cards" in expected:
            test.assertCountEqual([e["card_id"] for e in removed], expected["supply_destroyed_cards"])
    if "outcome" in expected:
        test.assertEqual(battle["outcome"], expected["outcome"])
    if case.get("assert_failed_departure") and battle["outcome"] == "loss":
        test.assertEqual(state["zones"]["dungeon:main"][-1], target)
        test.assertTrue(all(target not in pile for zone, pile in state["zones"].items()
                            if zone.startswith(("hall:", "player:"))))
        test.assertIsNone(state["instances"][target]["owner_player_id"])
        test.assertEqual(state["players"][f.player]["xp"], case.get("xp", 5))
        test.assertFalse(any(e["kind"] == "monster_defeated" for e in events))
        retreat = next(e for e in events if e["kind"] == "monster_returned_to_deck")
        test.assertEqual(retreat["target_instance_id"], target)
        test.assertEqual(retreat["position"], "bottom")
    if "attack_bonus" in expected:
        test.assertEqual(battle["calculation"]["modifiers"].get("attack", 0), expected["attack_bonus"])
    if "retreat_position" in expected:
        test.assertEqual(next(e for e in events if e["kind"] == "monster_returned_to_deck")["position"], expected["retreat_position"])
    if "immediate_destroyed" in expected:
        immediate = [e for e in events if e["kind"] == "card_destroyed" and e["reason"] == case["ability_id"]]
        test.assertCountEqual([e["card_id"] for e in immediate], expected["immediate_destroyed"])
        test.assertTrue(all(e["sequence"] < battle["sequence"] for e in immediate))
    if "xp_spent" in expected:
        test.assertEqual(sum(e["amount"] for e in events if e["kind"] == "effect_resource_changed" and e["op"] == "spend_xp"), expected["xp_spent"])
    destroys = [event for event in events if event["kind"] == "card_destroyed" and event["reason"] == "after_battle"]
    if "destroyed" in expected:
        test.assertCountEqual([event["card_id"] for event in destroys], expected["destroyed"])
    elif "destroy_count" in expected:
        test.assertEqual(len(destroys), expected["destroy_count"])
    elif "destroy_count_each" in expected:
        for player in state["player_order"]:
            test.assertEqual(sum(e["source"] == f"player:{player}:hand" for e in destroys), expected["destroy_count_each"])
    else:
        test.assertEqual(len(destroys), 0)
    for event in destroys:
        test.assertGreater(event["sequence"], battle["sequence"], "battle destruction happened before combat evaluation")
    disease = [event for event in events if event["kind"] == "disease_taken_from_supply"]
    amount = expected.get("diseases", 0)
    if "diseases_from_stat" in expected:
        spec = expected["diseases_from_stat"]
        amount = stat(cards[spec["card_id"]], spec["field"])
    test.assertEqual(sum(event["player_id"] == f.player for event in disease), amount)
    for opponent in state["player_order"]:
        if "xp_loss_each" in expected:
            # The active player can also earn the defeated target's printed XP.
            earned = sum(e["xp_gained"] for e in events if e["kind"] == "monster_defeated" and e["player_id"] == opponent)
            test.assertEqual(state["players"][opponent]["xp"], 5 - expected["xp_loss_each"] + earned)
        if opponent != f.player:
            test.assertEqual(sum(event["player_id"] == opponent for event in disease), expected.get("other_diseases", 0))
    for field, amount in expected.get("modified", {}).items():
        test.assertTrue(any(event["kind"] == "effect_card_modified" and event["stat"] == field
                            and event["amount"] == amount for event in events), f"missing {field} modifier")
    if "excluded" in expected:
        test.assertEqual(sum(event["kind"] == "effect_card_marked" and event["mark"] == "exclude_combat"
                             for event in events), expected["excluded"])


def verify_battles(test, base, snapshot, ruleset, cases):
    for case in cases:
        with test.subTest(ability=case["ability_id"], scenario="eligible targets"):
            verify_battle_case(test, base, snapshot, ruleset, case)
        if case["expected"].get("destroyed") or case["expected"].get("destroy_count"):
            with test.subTest(ability=case["ability_id"], scenario="no eligible target"):
                verify_battle_case(test, base, snapshot, ruleset, case, empty=True)
        for variant in case.get("variants", []):
            with test.subTest(ability=case["ability_id"], variant=variant):
                verify_battle_case(test, base, snapshot, ruleset, {**case, **variant})
