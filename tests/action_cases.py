"""Execute frozen card scenarios through the public command boundary."""

from collections import defaultdict

from backend.app.integrations.game_engine.turn import apply_command, legal_commands, TurnError
from tests.mechanic_cases import Fixture


def verify_action_case(test, base, snapshot, ruleset, case, action):
    cards = snapshot.cards
    f = Fixture(base, cards, ruleset, ruleset.mechanics[0])
    f.tx.ruleset = ruleset
    state = f.tx.state
    state["subphase"] = "TURN_START"
    state["timing_window"] = "TURN_START_BEFORE"
    state["chosen_action"] = None
    state["battle_context"] = None
    card_id = case["ability_id"].split("-A")[0]
    test.assertIn(case["source_line"], cards[card_id]["effect_text"].splitlines())
    source = f.add(card_id, f"player:{f.player}:control" if case.get("zone") == "active_control" else None)
    for extra in case["hand"]:
        f.add(extra)
    for extra in case.get("discard", []):
        f.add(extra, f"player:{f.player}:discard")
    for extra in case.get("draw", []):
        f.add(extra, f"player:{f.player}:draw")
    if case.get("hall"):
        for z in list(state["zones"]):
            if z.startswith(("hall:", "dungeon:")):
                state["zones"]["destroyed"].extend(state["zones"][z])
                state["zones"][z] = []
        for extra in case["hall"]:
            f.add(extra, "hall:main")
        for _ in range(5):
            f.add("TS-0476", "dungeon:main")
    for index, spec in enumerate(case.get("supplies", [])):
        for _ in range(spec["count"]):
            f.add(spec["card_id"], f"{spec['kind']}_supply:action{index}")
    for _ in range(12):
        f.add("TS-0001", f"player:{f.player}:draw")
    if "draw_exact" in case:
        zone = f"player:{f.player}:draw"
        state["zones"]["destroyed"].extend(state["zones"][zone])
        for item in state["zones"][zone]:
            state["instances"][item]["owner_player_id"] = None
        state["zones"][zone] = []
        for card in case["draw_exact"]:
            f.add(card, zone)
    if "dungeon" in case:
        for zone in list(state["zones"]):
            if zone.startswith(("hall:", "dungeon:")):
                state["zones"]["destroyed"].extend(state["zones"][zone])
                state["zones"][zone] = []
        for _ in range(3):
            f.add("TS-0476", "hall:main")
        for card in case["dungeon"]:
            f.add(card, "dungeon:main")
    state["players"][f.player]["xp"] = case["xp"]
    for other in state["player_order"]:
        if other != f.player:
            state["players"][other]["xp"] = 2
            for extra in (case.get("others") if case.get("others") is not None else ["TS-0001"] * 3):
                f.add(extra, player=other)
            for extra in case.get("other_control", []):
                f.add(extra, f"player:{other}:control")
            for card in case.get("opponent_draw_cards", ["TS-0001"] * case.get("opponent_draw", 3)):
                f.add(card, f"player:{other}:draw")
    state = apply_command(state, {"type": "ChooseAction", "player_id": f.player,
                                  "action": action}, snapshot=snapshot)["state"]
    if case.get("equipment"):
        hero_card, weapon_card = case["equipment"]
        hand = state["zones"][f"player:{f.player}:hand"]
        hero = next(i for i in hand if state["instances"][i]["card_id"] == hero_card)
        weapon = next(i for i in hand if state["instances"][i]["card_id"] == weapon_card)
        state = apply_command(state, {"type": "EquipWeapon", "player_id": f.player,
            "hero_instance_id": hero, "weapon_instance_id": weapon}, snapshot=snapshot)["state"]
    for prior in case.get("pre_activate", []):
        card = prior.split("-A")[0]
        instance = next(item for item in state["zones"][f"player:{f.player}:hand"] if state["instances"][item]["card_id"] == card)
        state = apply_command(state, {"type": "ActivateAbility", "player_id": f.player, "ability_id": prior, "source_instance_id": instance}, snapshot=snapshot)["state"]
    option = {"ability_id": case["ability_id"], "source_instance_id": source}
    test.assertTrue(any(option in command.get("options", []) for command in
                        legal_commands(state, snapshot=snapshot)))
    initial = state
    command = {"type": "ActivateAbility", "player_id": f.player,
               "ability_id": case["ability_id"], "source_instance_id": source}
    result = apply_command(state, command, snapshot=snapshot)
    state, events = result["state"], list(result["events"])
    choices = list(case.get("choices", []))
    values = list(case.get("values", []))
    steps = 0
    while state["pending_choice"] is not None:
        steps += 1
        test.assertLess(steps, 20, "effect continuation did not terminate")
        choice = state["pending_choice"]
        if choice["kind"] == "effect_response":
            result = apply_command(state, {"type": "ResolveResponse", "player_id": choice["player_id"]}, snapshot=snapshot)
            state = result["state"]
            events.extend(result["events"])
            continue
        if choice["kind"] == "effect_reuse":
            result = apply_command(state, {"type": "ResolveReusedAbility", "player_id": choice["player_id"], "ability_id": choice["options"][0]}, snapshot=snapshot)
            state = result["state"]
            events.extend(result["events"])
            continue
        if choice["kind"] == "effect_upgrade":
            option = next(item for item in choice["options"] if item["target_card_id"] == case["expected"]["upgraded_card"])
            result = apply_command(state, {"type": "ResolveEffectUpgrade", "player_id": choice["player_id"],
                                           "source_instance_id": option["source_instance_id"],
                                           "target_card_id": option["target_card_id"]}, snapshot=snapshot)
            state = result["state"]
            events.extend(result["events"])
            continue
        if choice["kind"] in ("effect_value", "effect_reorder"):
            if choice["kind"] == "effect_value":
                selected = values.pop(0) if values else choice["options"][0]
                if selected == "$self":
                    selected = f.player
                elif selected == "$other":
                    selected = next(value for value in choice["options"] if value != f.player)
                command_choice = {"type": "ResolveValueChoice", "value": selected}
            else:
                command_choice = {"type": "ResolveCardOrder", "instance_ids": list(reversed(choice["candidate_instance_ids"]))}
            result = apply_command(state, {**command_choice, "player_id": choice["player_id"]}, snapshot=snapshot)
            state = result["state"]
            events.extend(result["events"])
            continue
        if choice["kind"] == "effect_purchase":
            selected = case["expected"].get("purchased_card", case["expected"].get("gained_supply_card"))
            result = apply_command(state, {"type": "ResolveEffectPurchase", "player_id": choice["player_id"], "card_id": selected}, snapshot=snapshot)
            state = result["state"]
            events.extend(result["events"])
            continue
        if choices:
            preferred = choices.pop(0)
            preferred = preferred if isinstance(preferred, list) else [preferred]
            picked = []
            for card in preferred:
                picked.append(next(item for item in choice["candidate_instance_ids"]
                                   if item not in picked and state["instances"][item]["card_id"] == card))
            test.assertTrue(picked)
        else:
            picked = choice["candidate_instance_ids"][:choice.get("max_count", 1)]
        result = apply_command(state, {"type": "ResolveChoice", "player_id": choice["player_id"],
                                       "instance_ids": picked}, snapshot=snapshot)
        state = result["state"]
        events.extend(result["events"])
    expected = case["expected"]
    if "borrowed" in expected:
        test.assertEqual(len(state["borrowed_cards"]), expected["borrowed"])
        for item, obligation in state["borrowed_cards"].items():
            test.assertIn(item, state["zones"][f"player:{f.player}:hand"])
            test.assertEqual(obligation["when"], expected["return_when"])
            test.assertNotEqual(obligation["owner_player_id"], f.player)
    if "copied_hero" in expected:
        test.assertEqual(len(state["copied_heroes"]), 1)
        item, copied = next(iter(state["copied_heroes"].items()))
        test.assertEqual(state["instances"][item]["card_id"], "TS-0001")
        test.assertEqual(copied["card_ids"], [expected["copied_hero"]])
        test.assertFalse(copied["full_card"])
    if "redistributed" in expected:
        test.assertEqual(sum(len(event["assignments"]) for event in events if event["kind"] == "cards_randomly_distributed"), expected["redistributed"])
    if "reused_spell" in expected:
        test.assertTrue(any(instance["card_id"] == expected["reused_spell"] and instance["flags"].get("pending_turn_end_destruction") for instance in state["instances"].values()))
        test.assertEqual(sum(event.get("reused", False) for event in events if event["kind"] == "ability_activated"), 1)
    if expected.get("supplied_weapon_equipped"):
        test.assertTrue(state["battle_context"]["equipped_weapon_by_hero"])
    if "attached_diseases" in expected:
        attached = [record for records in state["attachments"].values() for record in records]
        test.assertEqual(len(attached), expected["attached_diseases"])
        test.assertTrue(all(state["instances"][record["instance_id"]]["owner_player_id"] is None for record in attached))
    if "basic_buy" in expected:
        test.assertEqual(state["players"][f.player]["extra_basic_purchases"], expected["basic_buy"])
    if "gained_supply_card" in expected:
        test.assertTrue(any(event["kind"] == "effect_card_gained" and event["card_id"] == expected["gained_supply_card"] for event in events))
        test.assertEqual(state.get("turn_purchases", {}).get(f.player, 0), 0)
    if "other_hero_destroyed" in expected:
        test.assertEqual(sum(event["kind"] == "card_destroyed" and event["source"].startswith("player:")
                             and not event["source"].startswith(f"player:{f.player}:") for event in events), expected["other_hero_destroyed"])
    if "listener" in expected:
        test.assertTrue(any(item["event"] == expected["listener"] for item in state["registered_triggers"]))
    if "global_rule" in expected:
        test.assertEqual(state["continuous_effects"][-1]["kind"], expected["global_rule"])
    if expected.get("hall_shuffle"):
        test.assertTrue(any(event["kind"] == "dungeon_top_shuffled" and len(event["instance_ids"]) == 4 for event in events))
    if "hall_order" in expected:
        test.assertEqual([state["instances"][item]["card_id"] for item in state["zones"]["hall:main"]], expected["hall_order"])
    if expected.get("exchanged"):
        test.assertEqual(sum(event["kind"] == "hall_monster_exchanged" for event in events), 1)
    if "direct_defeats" in expected:
        test.assertEqual(sum(event["kind"] == "monster_defeated" for event in events), expected["direct_defeats"])
    if "health_reductions" in expected:
        test.assertEqual(len(state["battle_context"]["monster_health_modifiers"]), expected["health_reductions"])
        test.assertTrue(all(value == -2 for value in state["battle_context"]["monster_health_modifiers"].values()))
    if "stolen_treasure" in expected:
        test.assertEqual(len(state["zones"][f"player:{f.player}:control"]), expected["stolen_treasure"])
    for other in state["player_order"]:
        if other == f.player:
            continue
        if "transferred_disease" in expected:
            test.assertEqual(sum(state["instances"][item]["card_id"] == "TS-0714" for item in state["zones"][f"player:{other}:discard"]), expected["transferred_disease"])
        if "other_diseases" in expected:
            test.assertEqual(sum(event["kind"] == "disease_taken_from_supply" and event["player_id"] == other for event in events), expected["other_diseases"])
        if "opponent_discarded_heroes" in expected:
            test.assertEqual(len(state["zones"][f"player:{other}:discard"]), expected["opponent_discarded_heroes"])
    if "protected_heroes" in expected:
        test.assertEqual(sum(any(buff["buff"] == "discard_instead_of_destroy"
                                for buff in instance["flags"].get("turn_buffs", []))
                             for instance in state["instances"].values()), expected["protected_heroes"])
    for key, zone in (("dungeon_top", "dungeon:main"), ("draw_top", f"player:{f.player}:draw")):
        if key in expected:
            test.assertEqual([state["instances"][item]["card_id"] for item in state["zones"][zone][:len(expected[key])]], expected[key])
    if "set_aside" in expected:
        test.assertEqual([state["instances"][item]["card_id"] for item in state["zones"][f"player:{f.player}:refill_add"]], [expected["set_aside"]])
    if "hand_counts" in expected:
        hand_cards = [state["instances"][item]["card_id"] for item in state["zones"][f"player:{f.player}:hand"]]
        for card, count in expected["hand_counts"].items():
            test.assertEqual(hand_cards.count(card), count)
    if "opponent_revealed_discard" in expected:
        for opponent in state["player_order"]:
            if opponent != f.player:
                test.assertEqual(len(state["zones"][f"player:{opponent}:discard"]), expected["opponent_revealed_discard"])
    test.assertEqual(sum(event["requested"] for event in events if event["kind"] == "effect_draw"
                         and event["player_id"] == f.player), expected.get("draw", 0))
    for event in events:
        if event["kind"] == "effect_draw":
            test.assertEqual(len(event["instance_ids"]), event["requested"])
    if "gold" in expected:
        test.assertEqual(state["players"][f.player]["temporary_gold"] - initial["players"][f.player]["temporary_gold"], expected["gold"])
    test.assertEqual(state["players"][f.player]["xp"] - initial["players"][f.player]["xp"], expected.get("xp", 0))
    removed = [event for event in events if event["kind"] == "effect_card_removed"]
    destroyed = [event["card_id"] for event in removed if event["op"] == "destroy"]
    if "destroyed" in expected:
        test.assertCountEqual(destroyed, expected["destroyed"])
    if "destroy_count" in expected:
        test.assertEqual(len(destroyed), expected["destroy_count"])
    if "discard_count" in expected:
        test.assertEqual(sum(event["op"] == "discard" and event["source"] == f"player:{f.player}:hand"
                             for event in removed), expected["discard_count"])
    for other in state["player_order"]:
        if other == f.player:
            continue
        if "other_discard" in expected:
            test.assertEqual(sum(event["op"] == "discard" and event["source"] == f"player:{other}:hand"
                                 for event in removed), expected["other_discard"])
        if "other_draw" in expected:
            test.assertEqual(sum(event["requested"] for event in events if event["kind"] == "effect_draw"
                                 and event["player_id"] == other), expected["other_draw"])
        if "other_xp" in expected:
            test.assertEqual(state["players"][other]["xp"] - initial["players"][other]["xp"], expected["other_xp"])
        if "other_hand" in expected:
            test.assertEqual(len(state["zones"][f"player:{other}:hand"]), expected["other_hand"])
    modified = defaultdict(lambda: defaultdict(int))
    for event in events:
        if event["kind"] == "effect_card_modified":
            changed_card = state["instances"][event["instance_id"]]["card_id"]
            modified[changed_card][event["stat"]] += event["amount"]
    if "modified" in expected:
        test.assertEqual(dict(modified), expected["modified"])
    for field, amount in expected.get("battle_modifiers", {}).items():
        test.assertEqual(state["battle_context"]["modifiers"][field], amount)
    for flag, value in expected.get("flags", {}).items():
        test.assertEqual(state["battle_context"][flag], value)
    if "converted_card" in expected:
        test.assertEqual([state["instances"][item]["card_id"] for item in state["battle_context"]["convert_card_magic"]], [expected["converted_card"]])
    if "next_hand" in expected:
        test.assertEqual(state["players"][f.player]["next_hand_bonus"], expected["next_hand"])
    if "topdeck" in expected:
        test.assertEqual(state["instances"][state["zones"][f"player:{f.player}:draw"][0]]["card_id"], expected["topdeck"])
    if "marked_count" in expected:
        test.assertEqual(sum(i["flags"].get("pending_after_battle_destruction", False) for i in state["instances"].values()), expected["marked_count"])
    if "scheduled" in expected:
        test.assertTrue(any(i["event"] == expected["scheduled"] for i in state["scheduled_effects"]))
    if "diseases_each" in expected:
        for p in state["player_order"]:
            test.assertEqual(sum(e["kind"] == "disease_taken_from_supply" and e["player_id"] == p for e in events), expected["diseases_each"])
    if "gained_hand" in expected:
        test.assertIn(expected["gained_hand"], [state["instances"][i]["card_id"] for i in state["zones"][f"player:{f.player}:hand"]])
    if "upgraded_card" in expected:
        upgrade = [event for event in events if event["kind"] == "hero_upgraded"]
        test.assertEqual(len(upgrade), 1)
        test.assertEqual(upgrade[0]["target_card_id"], expected["upgraded_card"])
        test.assertEqual(state["instances"][upgrade[0]["target_instance_id"]]["flags"]["upgraded_on_turn"], state["turn_number"])
        if expected.get("source_discarded"):
            test.assertIn(source, state["zones"][f"player:{f.player}:discard"])
    if "revealed_discard" in expected:
        test.assertEqual(len(state["zones"][f"player:{f.player}:discard"]), expected["revealed_discard"])
    if "relocations" in expected:
        test.assertEqual(sum(e["kind"] == "effect_hall_relocated" for e in events), expected["relocations"])
        test.assertEqual(len(state["zones"]["hall:main"]), 3)
    if "gained_monster" in expected:
        test.assertIn(expected["gained_monster"], [state["instances"][i]["card_id"] for i in state["zones"][f"player:{f.player}:discard"]])
    if "purchased_card" in expected:
        purchases = [e for e in events if e["kind"] == "effect_purchase_completed"]
        test.assertEqual(len(purchases), 1)
        test.assertEqual(purchases[0]["card_id"], expected["purchased_card"])
        test.assertLessEqual(purchases[0]["price"], purchases[0]["budget"])
        test.assertIn(purchases[0]["instance_id"], state["zones"][f"player:{f.player}:{expected['purchase_destination']}"])
        if expected.get("source_discarded"):
            test.assertIn(source, state["zones"][f"player:{f.player}:discard"])
    if "magic_equals_monster_vp" in expected:
        test.assertEqual(state["battle_context"]["modifiers"]["magic_attack"],
                         int(cards[expected["magic_equals_monster_vp"]]["wiki_胜利点"]))
    if "magic_sum_monster_vp" in expected:
        test.assertEqual(state["battle_context"]["modifiers"]["magic_attack"],
                         sum(int(cards[item]["wiki_胜利点"]) for item in expected["magic_sum_monster_vp"]))
    if ruleset.by_id(case["ability_id"]).usage == "once_per_turn":
        with test.assertRaises(TurnError):
            apply_command(state, command, snapshot=snapshot)


def verify_actions(test, base, snapshot, ruleset, cases):
    for case in cases:
        for action in case["actions"]:
            with test.subTest(ability=case["ability_id"], action=action):
                verify_action_case(test, base, snapshot, ruleset, case, action)
            for variant in case.get("variants", []):
                with test.subTest(ability=case["ability_id"], action=action, variant=variant):
                    verify_action_case(test, base, snapshot, ruleset, {**case, **variant}, action)
