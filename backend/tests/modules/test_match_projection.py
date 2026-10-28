"""Private instance data must never cross the participant-view boundary."""

from copy import deepcopy
import json
import unittest

from backend.app.core.exceptions import AppError
from backend.app.modules.matches.projection import build_match_view
from backend.app.modules.matches.interaction_view import event_view
from backend.tests.support.match_projection import sample_match




class MatchProjectionTests(unittest.TestCase):
    def test_public_effects_are_shared_display_data_without_per_card_buffs(self):
        match = sample_match()
        effects = [{"kind": "buff", "source_card_id": "TS-0288", "source_name": "指引之光",
                    "description": "所有玩家光照 +1。"}]
        for viewer in (1, 2):
            view = build_match_view(match, viewer, public_effects=effects)
            self.assertEqual(view["public_effects"], effects)
            self.assertTrue(all(not card.get("statuses") for card in view["hand"]))
            view["public_effects"][0]["description"] = "changed"
            self.assertEqual(effects[0]["description"], "所有玩家光照 +1。")
        self.assertEqual(build_match_view(match, 1)["public_effects"], [])

    def test_authorized_inventory_targets_match_their_original_browser_without_disclosing_other_instance_ids(self):
        match = sample_match()
        match.state["pending_choice"] = {"kind": "effect_select", "player_id": "alice"}
        command = {"type": "ResolveChoice", "instance_ids": ["secret-bob-discard"], "min_count": 1, "max_count": 1}
        view = build_match_view(match, 1, legal_commands=[command])
        bob = next(player for player in view["players"] if player["player_id"] == "bob")
        self.assertEqual(bob["cards"]["discard"][0]["instance_id"], "secret-bob-discard")
        self.assertNotEqual(bob["cards"]["draw"][0]["instance_id"], "secret-bob-draw")
        spectator = build_match_view(match, 2, legal_commands=[command])
        self.assertEqual(spectator["legal_commands"], [])
        alice = next(player for player in spectator["players"] if player["player_id"] == "alice")
        self.assertNotEqual(alice["cards"]["discard"][0]["instance_id"], "alice-discard")

    def test_destruction_replacement_exposes_public_discard_movement_without_buff_internals(self):
        rows = event_view([{"kind": "card_destruction_replaced", "sequence": 1, "card_id": "TS-0001", "instance_id": "private-hero",
                            "source": "player:alice:hand", "destination": "player:alice:discard", "reason": "after_battle",
                            "replacement": {"source_instance_id": "private-blade", "buff": "discard_instead_of_destroy"}}], {}, lambda _: None)
        self.assertEqual(rows[0]["cause"], "after_battle")
        self.assertEqual(rows[0]["source"], "hand")
        self.assertEqual(rows[0]["destination"], "discard")
        self.assertEqual(rows[0]["player_id"], "alice")
        self.assertNotIn("private-", json.dumps(rows))
        self.assertNotIn("replacement", rows[0])

    def test_trap_stays_public_in_the_hall_but_only_the_actor_can_trigger_it(self):
        match = sample_match()
        match.state["pending_choice"] = {"kind": "trap_activation", "player_id": "alice", "instance_id": "hall-trap"}
        match.state["zones"]["hall:main"].append("hall-trap")
        match.state["instances"]["hall-trap"] = {"card_id": "TS-0008"}
        match.catalog_snapshot["cards"]["TS-0008"]["subcategory"] = "陷阱"
        command = {"type": "ResolveTrap", "player_id": "alice", "instance_ids": ["hall-trap"]}
        for user in (1, 2):
            view = build_match_view(match, user, legal_commands=[command])
            self.assertTrue(any(card["instance_id"] == "hall-trap" for card in view["dungeons"][0]["hall"]))
            self.assertEqual(view["legal_commands"], [command] if user == 1 else [])
            self.assertEqual(view["pending_choice"]["can_resolve"], user == 1)
        rows = event_view([{"sequence": 1, "kind": "trap_removed", "instance_id": "hall-trap", "hall_zone": "hall:main",
                            "rank": 3, "hall_rank_count": 3, "private": "continuation"}], match.state["instances"], lambda _: None)
        self.assertEqual(rows, [{"sequence": 1, "kind": "trap_removed", "card_id": "TS-0008", "hall_zone": "hall:main", "rank": 3, "hall_rank_count": 3}])

    def test_destruction_cause_is_semantic_and_never_exposes_interpreter_reasons(self):
        reasons = ["hero_upgrade", "after_battle", "trap_resolved", "private-ability-secret"]
        rows = event_view([{"kind": "card_destroyed", "sequence": i + 1, "card_id": "TS-0001", "reason": reason}
                           for i, reason in enumerate(reasons)], {}, lambda _: None)
        self.assertEqual([row["cause"] for row in rows], ["hero_upgrade", "after_battle", "trap_resolved", "effect"])
        self.assertNotIn("private-ability-secret", json.dumps(rows))
        removed = event_view([{"kind": "disease_gain_destroyed", "sequence": 1, "instance_id": "private-disease", "card_id": "TS-0714"},
                              {"kind": "card_destroyed", "sequence": 2, "instance_id": "private-disease", "card_id": "TS-0714", "reason": "private-ability"}], {}, lambda _: None)
        self.assertEqual(removed[1]["cause"], "disease_gain")
        self.assertNotIn("private-", json.dumps(removed))

    def test_statuses_are_copied_only_onto_visible_instances(self):
        match = sample_match()
        statuses = {"alice-hand": [{"kind": "buff", "source_name": "Own source", "source_card_id": "TS-0002", "description": "Strength +2"}],
                    "secret-bob-hand": [{"kind": "destroy", "source_name": "secret-status-source", "description": "private mark"}]}
        own = build_match_view(match, 1, card_statuses=statuses)
        self.assertEqual(own["hand"][0]["statuses"][0]["source_name"], "Own source")
        self.assertNotIn("secret-status-source", json.dumps(own))
        self.assertNotIn("card_statuses", own)
        own["hand"][0]["statuses"][0]["description"] = "changed"
        self.assertEqual(statuses["alice-hand"][0]["description"], "Strength +2")

    def test_empty_extra_ranks_use_engine_counts_for_all_viewers(self):
        match = sample_match()
        for viewer in (1, 2):
            view = build_match_view(match, viewer, hall_rank_counts={"hall:main": 5})
            self.assertEqual(view["dungeons"][0]["rank_count"], 5)

    def test_retreat_events_expose_public_origin_and_capacity_without_hidden_deck_order(self):
        match = sample_match()
        match.events = [{"sequence": 1, "kind": "monster_returned_to_deck", "target_instance_id": "hall-monster",
                         "hall_zone": "hall:main", "deck_zone": "dungeon:main", "rank": 4,
                         "position": "bottom", "hall_rank_count": 3, "private_order": ["secret-dungeon"]}]
        view = build_match_view(match, 1)
        event = view["event_log"][0]
        self.assertEqual(event["hall_rank_count"], 3)
        self.assertEqual(event["deck_zone"], "dungeon:main")
        self.assertEqual(event["card_id"], match.state["instances"]["hall-monster"]["card_id"])
        self.assertNotIn("target_instance_id", event)
        self.assertNotIn("private_order", event)

    def test_own_cards_and_public_board_without_hidden_ids_or_definitions(self):
        match = sample_match()
        view = build_match_view(match, 1)
        text = json.dumps(view)
        for private in ("secret-bob-hand", "secret-bob-draw", "secret-bob-discard", "secret-dungeon", "secret-seed", "secret-continuation", "secret-flag", "secret-deck-order"):
            self.assertNotIn(private, text)
        self.assertNotIn("internal-note", text)
        self.assertEqual(view["hand"], [{"instance_id": "alice-hand", "card_id": "TS-0001"}])
        self.assertEqual(view["players"][1]["hand_count"], 1)
        self.assertEqual(view["players"][1]["draw_count"], 1)
        self.assertEqual(view["players"][1]["discard_count"], 1)
        self.assertEqual(view["players"][1]["control"][0]["instance_id"], "public-control")
        self.assertEqual([c["rank"] for c in view["dungeons"][0]["hall"]], [0, 1])
        self.assertEqual(view["dungeons"][0]["deck_count"], 1)
        self.assertEqual(set(view["cards"]), {"TS-0001", "TS-0002", "TS-0003", "TS-0005", "TS-0006", "TS-0007", "TS-0009",
                                              "TS-0010", "TS-0011", "TS-0012"})
        supply = view["supplies"][0]
        self.assertEqual(supply["top_card_id"], "TS-0011")
        self.assertEqual(supply["remaining"], 3)
        self.assertEqual(supply["cards"], [{"card_id": "TS-0011", "count": 1},
                                           {"card_id": "TS-0012", "count": 2}])

    def test_viewer_identity_changes_private_cards_without_mutating_snapshot(self):
        match = sample_match()
        before = deepcopy(vars(match))
        view = build_match_view(match, 2)
        self.assertEqual(view["viewer_player_id"], "bob")
        self.assertEqual(view["hand"][0]["instance_id"], "secret-bob-hand")
        self.assertNotIn("alice-hand", json.dumps(view))
        view["cards"]["TS-0004"]["tags"].append("mutated")
        view["players"][0]["display_name"] = "mutated"
        self.assertEqual(vars(match), before)

    def test_setup_choice_is_public_but_only_host_can_answer(self):
        match = sample_match()
        match.status = "setup_pending"
        match.state = None
        match.setup_choice = {"kind": "two_dungeons", "group_a_count": 2,
                              "group_ids": ["TS-0001", "TS-0002", "TS-0003", "TS-0004"],
                              "feature_ids": ["TS-0005"], "rng_seed": "secret-choice-seed"}
        host = build_match_view(match, 1)
        guest = build_match_view(match, 2)
        self.assertTrue(host["can_resolve_setup"])
        self.assertFalse(guest["can_resolve_setup"])
        self.assertEqual(host["setup_choice"], guest["setup_choice"])
        self.assertNotIn("secret-", json.dumps(host))
        self.assertEqual(host["hand"], [])
        self.assertIsNone(host["turn"])
        self.assertEqual(set(host["cards"]), {f"TS-{n:04d}" for n in range(1, 6)})

    def test_nonparticipant_is_rejected_before_any_projection(self):
        with self.assertRaises(AppError) as caught:
            build_match_view(sample_match(), 99)
        self.assertEqual(caught.exception.status_code, 403)


class MatchInteractionProjectionTests(unittest.TestCase):
    def test_pending_disease_is_public_without_raw_instance_or_replacement_continuations(self):
        match = sample_match()
        match.catalog_snapshot["cards"]["TS-0714"] = {"card_id": "TS-0714", "name": "疾病", "tags": "疾病", "effect_text": "攻击 -1。"}
        match.state["instances"]["secret-disease-instance"] = {"card_id": "TS-0714", "flags": {"secret": "secret-flag"}}
        match.state["zones"]["pending:disease"] = ["secret-disease-instance"]
        match.state["pending_choice"] = {"kind": "disease_replacement", "player_id": "alice", "stage": "recipient", "options": ["bob"]}
        match.state["resolution_frames"] = [{"kind": "disease_gain", "gain": {"instance_id": "secret-disease-instance", "gain_id": "DG-10",
                                                "player_id": "alice", "used_sources": ["secret-source"]}}]
        for user_id in (1, 2):
            view = build_match_view(match, user_id, legal_commands=[{"type": "ResolveDiseaseReplacement", "stage": "recipient", "may_decline": True, "options": ["bob"]}])
            self.assertEqual(view["pending_disease"], {"gain_id": "DG-10", "card_id": "TS-0714", "player_id": "alice"})
            self.assertIn("TS-0714", view["cards"])
            self.assertNotIn("secret-disease-instance", json.dumps(view))
            self.assertNotIn("secret-source", json.dumps(view))
            if user_id == 1:
                self.assertTrue(view["legal_commands"][0]["may_decline"])
            else:
                self.assertEqual(view["legal_commands"], [])

    def test_disease_events_preserve_public_card_after_deletion_but_exclude_sampling_and_private_identity(self):
        rows = event_view([{"kind": kind, "sequence": index, "gain_id": "DG-1", "card_id": "TS-0714",
                            "instance_id": "secret-disease", "roll": 12, "candidates": ["secret-next"], "destination": "player:alice:discard"}
                           for index, kind in enumerate(("disease_gain_started", "disease_gain_destroyed", "disease_gain_completed"), 1)], {}, lambda _: None)
        self.assertTrue(all(row["card_id"] == "TS-0714" and row["gain_id"] == "DG-1" for row in rows))
        self.assertEqual(rows[2]["destination"], "discard")
        self.assertNotIn("secret-", json.dumps(rows))
        self.assertNotIn("roll", json.dumps(rows))

    def test_disease_origin_exposes_only_public_monster_card_and_hall_position(self):
        row = event_view([{"kind": "disease_gain_started", "sequence": 1, "gain_id": "DG-1", "card_id": "TS-0714",
                           "source_card_id": "TS-0679", "source_hall_zone": "hall:b:rank0", "source_rank": 0,
                           "source_instance_id": "secret-source", "roll": 42, "deck_order": ["secret-next"]}], {}, lambda _: None)[0]
        self.assertEqual(row["source_card_id"], "TS-0679")
        self.assertEqual(row["source_hall_zone"], "hall:b:rank0")
        self.assertEqual(row["source_rank"], 0)
        self.assertNotIn("secret", json.dumps(row))
        self.assertNotIn("roll", row)

    def test_revealed_dungeon_events_supply_animation_origin_without_hidden_instance_or_deck_order(self):
        instances = {"private-instance": {"card_id": "TS-0009"}}
        known_cards = set()
        for kind in ("trap_revealed", "treasure_claimed", "hall_card_entered"):
            row = event_view([{"kind": kind, "sequence": 1, "instance_id": "private-instance",
                               "hall_zone": "hall:b", "origin": "deck", "rank": 3,
                               "deck_order": ["private-instance", "secret-next"]}], instances, known_cards.add)[0]
            self.assertEqual(row["hall_zone"], "hall:b")
            self.assertEqual(row["card_id"], "TS-0009")
            if kind != "hall_card_entered":
                self.assertEqual(row["origin"], "deck")
            self.assertNotIn("private-instance", json.dumps(row))
            self.assertNotIn("secret-next", json.dumps(row))
        self.assertIn("TS-0009", known_cards)

    def test_unequip_intent_and_projection_preserve_only_the_instance_selection(self):
        from backend.app.modules.matches.command_schemas import InstanceAction
        intent = InstanceAction(type="UnequipWeapon", instance_id="alice-hand")
        self.assertEqual(intent.model_dump(), {"type": "UnequipWeapon", "instance_id": "alice-hand"})
        match = sample_match()
        view = build_match_view(match, 1, legal_commands=[{"type": "UnequipWeapon", "instance_ids": ["alice-hand"], "private": "secret"}])
        self.assertEqual(view["legal_commands"], [{"type": "UnequipWeapon", "instance_ids": ["alice-hand"]}])

    def test_every_choice_kind_is_actionable_only_by_its_recipient(self):
        choices = [
            ("effect_select", {"type": "ResolveChoice", "instance_ids": ["alice-hand"],
                               "min_count": 0, "max_count": 1, "highest_by": "strength",
                               "constraints": [{"filter": {"tag": "英雄", "hidden": "secret-query"}, "maximum": 1}]}),
            ("effect_reorder", {"type": "ResolveCardOrder", "instance_ids": ["alice-hand"]}),
            ("effect_value", {"type": "ResolveValueChoice", "options": [0, 1, 2]}),
            ("effect_purchase", {"type": "ResolveEffectPurchase", "may_skip": True,
                                 "options": [{"card_id": "TS-0011", "price": 2, "budget": 4}]}),
            ("effect_upgrade", {"type": "ResolveEffectUpgrade", "may_skip": True,
                                "options": [{"source_instance_id": "alice-hand", "target_card_id": "TS-0012", "xp_cost": 2}]}),
            ("effect_order", {"type": "ResolveEffectOrder", "effects": [{"effect_id": "E1",
                              "ability_id": "A1", "source_instance_id": "alice-hand", "body": "secret-body"}]}),
            ("effect_reuse", {"type": "ResolveReusedAbility", "ability_ids": ["A1"]}),
            ("effect_response", {"type": "ResolveResponse", "stage": "source", "may_decline": True,
                                 "options": [{"source_instance_id": "alice-hand", "ability_id": "M1", "action": "ignore_trap"}]}),
            ("disease_replacement", {"type": "ResolveDiseaseReplacement", "stage": "source",
                                     "options": [{"source_instance_id": "alice-hand", "ability_id": "M1", "action": "redirect"}]}),
            ("effect_response", {"type": "ResolveResponse", "stage": "recipient", "may_decline": True, "options": ["bob"]}),
            ("disease_replacement", {"type": "ResolveDiseaseReplacement", "stage": "recipient", "options": ["bob"]}),
        ]
        abilities = [{"id": key, "source_card_id": "TS-0001", "source_line": "可读的能力。", "body": "secret-body"}
                     for key in ("A1", "M1")]
        for kind, offered in choices:
            with self.subTest(kind=kind, stage=offered.get("stage")):
                match = sample_match()
                # A response can belong to somebody other than the active player.
                match.state["active_player_id"] = "bob"
                match.state["pending_choice"] = {"kind": kind, "player_id": "alice", "ability_id": "A1",
                                                  "source_instance_id": "alice-hand", "node": {"kind": "number", "then": "secret-body"},
                                                  "bindings": {"private": "secret-binding"}, "query": "secret-query"}
                raw = {**offered, "player_id": "alice", "body": "secret-body", "bindings": {"x": "secret-binding"}}
                original = deepcopy(vars(match))
                own = build_match_view(match, 1, legal_commands=[raw], abilities=abilities)
                other = build_match_view(match, 2, legal_commands=[raw], abilities=abilities)
                self.assertEqual(own["actor_player_id"], "alice")
                self.assertEqual(own["legal_commands"][0]["type"], offered["type"])
                self.assertTrue(own["pending_choice"]["can_resolve"])
                self.assertEqual(own["abilities"]["A1"]["source_line"], "可读的能力。")
                self.assertIn("alice-hand", own["command_instances"])
                self.assertFalse(any(marker in json.dumps(own) for marker in ("secret-query", "secret-binding", "secret-body")))
                self.assertEqual(other["pending_choice"], {"kind": kind, "player_id": "alice", "can_resolve": False})
                self.assertEqual(other["legal_commands"], [])
                self.assertEqual(other["command_instances"], {})
                self.assertEqual(other["abilities"], {})
                self.assertNotIn("alice-hand", json.dumps(other))
                self.assertEqual(vars(match), original)

    def test_hidden_candidate_is_revealed_only_to_the_authorized_chooser(self):
        match = sample_match()
        match.state["pending_choice"] = {"kind": "effect_select", "player_id": "alice"}
        commands = [{"type": "ResolveChoice", "player_id": "alice", "instance_ids": ["secret-bob-hand"],
                     "min_count": 1, "max_count": 1}]
        own = build_match_view(match, 1, legal_commands=commands)
        self.assertEqual(own["command_instances"]["secret-bob-hand"]["card_id"], "TS-0004")
        self.assertIn("TS-0004", own["cards"])
        # Even an accidentally supplied command list cannot leak chooser-only candidates to the other viewer.
        other = build_match_view(match, 2, legal_commands=commands)
        self.assertEqual(other["command_instances"], {})

    def test_purchase_prices_and_personal_resources_are_not_recomputed(self):
        match = sample_match()
        match.state["players"]["alice"].update(temporary_gold=9, purchases_remaining=2, extra_basic_purchases=1)
        match.state["players"]["bob"]["temporary_gold"] = 1234
        view = build_match_view(match, 1, legal_commands=[{"type": "BuyCard", "card_ids": ["TS-0011"],
                                                         "options": [{"card_id": "TS-0011", "price": 7}]}])
        self.assertEqual(view["legal_commands"][0]["options"], [{"card_id": "TS-0011", "price": 7}])
        self.assertEqual(view["viewer_resources"], {"xp": 3, "temporary_gold": 9, "purchases_remaining": 2, "extra_basic_purchases": 1,
                                                  "gold_income_preview": None})
        self.assertNotIn("1234", json.dumps(view))

    def test_gold_income_preview_is_owned_by_the_turn_player_even_when_another_player_must_respond(self):
        match = sample_match()
        match.state["pending_choice"] = {"kind": "effect_value", "player_id": "bob"}
        own = build_match_view(match, 1, gold_income_preview=7)
        self.assertEqual(own["actor_player_id"], "bob")
        self.assertEqual(own["viewer_resources"]["gold_income_preview"], 7)
        self.assertEqual(own["legal_commands"], [])
        other = build_match_view(match, 2, gold_income_preview=7)
        self.assertIsNone(other["viewer_resources"]["gold_income_preview"])
        unavailable = build_match_view(match, 1, gold_income_preview=7, unavailable_reason="unavailable")
        self.assertIsNone(unavailable["viewer_resources"]["gold_income_preview"])
        match.status = "finished"
        self.assertIsNone(build_match_view(match, 1, gold_income_preview=7)["viewer_resources"]["gold_income_preview"])

    def test_event_and_result_summaries_never_expose_raw_scoring_cards_or_randomness(self):
        match = sample_match()
        match.status = "finished"
        match.state["phase"] = "SETTLING"
        match.state["result"] = {"players": {"alice": {"victory_points": 7, "thunderstones": 1,
                                                      "card_victory_points": 4, "experience_points": 3,
                                                      "cards": [{"instance_id": "secret-alice-draw"}]}},
                                  "winner_ids": ["alice"], "tie_break": None}
        match.events = [
            {"kind": "player_deck_shuffled", "sequence": 1, "order": ["secret-alice-draw"]},
            {"kind": "cards_drawn", "sequence": 2, "player_id": "bob", "instance_ids": ["secret-bob-hand"], "roll": "secret-rng"},
            {"kind": "battle_resolved", "sequence": 3, "target_card_id": "TS-0009", "outcome": "win", "health": 3,
             "calculation": {"attack": 5, "components": [{"instance_id": "secret-bob-hand"}], "rng_state": "secret-rng"}},
            {"kind": "game_scored", "sequence": 4, "result": match.state["result"]},
        ]
        view = build_match_view(match, 1, legal_commands=[{"type": "FinishTurn"}])
        self.assertEqual(view["legal_commands"], [])
        self.assertIsNone(view["actor_player_id"])
        self.assertEqual(view["result"]["players"]["alice"], {"victory_points": 7, "thunderstones": 1,
                         "card_victory_points": 4, "experience_points": 3, "eliminated": False})
        self.assertEqual(view["event_log"][0], {"kind": "player_deck_shuffled", "sequence": 1})
        self.assertEqual(view["event_log"][1], {"kind": "cards_drawn", "sequence": 2, "player_id": "bob", "count": 1})
        self.assertEqual(view["event_log"][2]["calculation"], {"attack": 5})
        self.assertNotIn("secret-", json.dumps([view["event_log"], view["result"]]))

    def test_battle_context_is_only_available_during_the_active_players_uninterrupted_preparation(self):
        match = sample_match()
        preparation = {"context": {"cards": {"TS-0001": {"card_id": "TS-0001"}}}, "options": {}, "draft": {}}
        match.state["subphase"] = "DUNGEON_PREPARE"
        own = build_match_view(match, 1, battle_preparation=preparation)
        self.assertEqual(own["battle_preparation"], preparation)
        own["battle_preparation"]["options"]["changed"] = True
        self.assertEqual(preparation["options"], {})
        self.assertIsNone(build_match_view(match, 2, battle_preparation=preparation)["battle_preparation"])
        match.state["pending_choice"] = {"kind": "effect_value", "player_id": "alice"}
        self.assertIsNone(build_match_view(match, 1, battle_preparation=preparation)["battle_preparation"])
        match.state["pending_choice"] = None
        disabled = build_match_view(match, 1, battle_preparation=preparation, legal_commands=[{"type": "FinishTurn"}], unavailable_reason="版本不可用")
        self.assertIsNone(disabled["battle_preparation"])
        self.assertEqual(disabled["legal_commands"], [])

    def test_public_ability_activation_has_a_card_label_but_never_a_hidden_instance_reference(self):
        match = sample_match()
        match.events = [{"sequence": 1, "kind": "ability_activated", "player_id": "bob",
                         "source_instance_id": "secret-bob-hand", "ability_id": "private-not-for-response", "body": "private-body"}]
        view = build_match_view(match, 1)
        self.assertEqual(view["event_log"], [{"sequence": 1, "kind": "ability_activated", "player_id": "bob", "card_id": "TS-0004"}])
        self.assertIn("TS-0004", view["cards"])
        self.assertNotIn("secret-bob-hand", json.dumps(view))
        self.assertNotIn("private-", json.dumps(view))

    def test_target_command_is_allowlisted_separately_from_team_submission(self):
        view = build_match_view(sample_match(), 1, legal_commands=[
            {"type": "DeclareBattleTarget", "instance_ids": ["hall-monster"]},
            {"type": "SubmitBattleTeam", "target_instance_ids": ["hall-monster"], "requires_draft": True},
        ])
        self.assertEqual([item["type"] for item in view["legal_commands"]], ["DeclareBattleTarget", "SubmitBattleTeam"])
        self.assertEqual(view["legal_commands"][0]["instance_ids"], ["hall-monster"])
        self.assertNotIn("target_instance_ids", view["legal_commands"][1])

    def test_effect_supply_gain_exposes_animation_origin_without_private_instance_or_continuation(self):
        match = sample_match()
        match.events = [{"kind": kind, "sequence": i, "player_id": "alice", "card_id": "TS-0001",
                         "source": "basic_supply:TS-0001", "destination": "player:alice:discard",
                         "instance_id": "private-instance", "ability_id": "private-ability", "bindings": {"private": True}}
                        for i, kind in enumerate(("effect_card_gained", "effect_purchase_completed"), 1)]
        view = build_match_view(match, 1)
        self.assertEqual(len(view["event_log"]), 2)
        for event in view["event_log"]:
            self.assertEqual(event["source"], "basic_supply:TS-0001")
            self.assertEqual(event["destination"], "discard")
            self.assertEqual(event["player_id"], "alice")
        self.assertNotIn("private", json.dumps(view["event_log"]))

    def test_declaration_retains_visible_committed_team_for_active_player_only(self):
        match = sample_match(); match.state["subphase"] = "DUNGEON_DECLARE"
        preparation = {"context": {"cards": {}}, "options": {}, "draft": {"hero_instance_ids": ["alice-hand"]}}
        own = build_match_view(match, 1, battle_preparation=preparation)
        self.assertEqual(own["battle_preparation"], preparation)
        self.assertIsNone(build_match_view(match, 2, battle_preparation=preparation)["battle_preparation"])

