"""Public-command effect scenarios and their temporary visualization endpoint."""

from __future__ import annotations

import unittest

from fastapi.testclient import TestClient

from backend.tests.support.sandbox_app import create_sandbox_app
from backend.devtools.effect_lab.service import CASES, run_case
from backend.app.integrations.game_engine.setup import start_game
from backend.app.integrations.game_engine.turn import apply_command
from backend.tests.support.setup import request


class EffectLabTests(unittest.TestCase):
    def test_every_scenario_has_a_reproducible_passing_trace(self) -> None:
        for case in CASES:
            with self.subTest(case=case["id"]):
                result = run_case(case["id"])
                self.assertTrue(result["passed"], result["checks"])
                self.assertTrue(result["steps"])
                self.assertTrue(result["abilities"])
                self.assertTrue(all("before" in step and "after" in step
                                    for step in result["steps"]))
                commands = [step for step in result["steps"]
                            if step["type"] == "command"]
                self.assertTrue(commands)
                self.assertTrue(any(step["events"] for step in commands))
        first = run_case("disease-choice")
        self.assertEqual(first, run_case("disease-choice"))

    def test_choice_variants_resolve_different_instances(self) -> None:
        for case_id in ("disease-choice", "thornwood-tie", "cost-gain-discard", "deferred-destruction"):
            with self.subTest(case=case_id):
                left = run_case(case_id, choice_index=0)
                right = run_case(case_id, choice_index=1)
                self.assertTrue(left["passed"] and right["passed"])
                selected = lambda result: next(
                    event["selected_instance_id"]
                    for step in result["steps"] for event in step["events"]
                    if event["kind"] == "effect_choice_resolved")
                self.assertNotEqual(selected(left), selected(right))

    def test_destruction_replacement_trace_exposes_buff_expiry_and_payment_choice(self):
        for index in (0, 1):
            trace = run_case("destroy-cost-replacement", choice_index=index)
            self.assertTrue(trace["passed"], trace["checks"])
            self.assertTrue(any(step["after"]["hero_statuses"] for step in trace["steps"]))
            self.assertEqual(trace["steps"][-1]["after"]["hero_statuses"], [])
            if index == 1:
                final = trace["steps"][-1]
                battle = next(e for step in trace["steps"] for e in step["events"] if e["kind"] == "battle_resolved")
                target = battle["target_instance_id"]
                self.assertEqual(battle["outcome"], "loss")
                self.assertTrue(all(target not in [c["instance_id"] for c in hall["cards"]]
                                    for hall in final["after"]["halls"]))
                self.assertIn(target, [c["instance_id"] for deck in final["after"]["dungeons"] for c in deck["top"]])
        with self.assertRaises(ValueError):
            run_case("destroy-cost-replacement", choice_index=2)

    def test_invalid_choice_and_rejected_cost(self) -> None:
        with self.assertRaises(ValueError):
            run_case("disease-choice", choice_index=99)
        with self.assertRaises(KeyError):
            run_case("unknown")
        trace = run_case("cost-rollback")
        rejected = next(step for step in trace["steps"] if step["type"] == "rejected")
        self.assertEqual(rejected["before"], rejected["after"])
        self.assertEqual(rejected["events"], [])
        self.assertTrue(trace["passed"])

    def test_debug_trace_shows_actual_dsl_branches(self) -> None:
        flow = run_case("condition-schedule")
        flow_nodes = [node for step in flow["steps"]
                      for node in step.get("effect_trace", [])]
        self.assertTrue({"sequence", "if", "for_each", "repeat", "schedule"}
                        <= {node["op"] for node in flow_nodes})
        self.assertTrue(any(node.get("branch") == "then" for node in flow_nodes))
        self.assertTrue(any(node.get("repeat_count") == 2 for node in flow_nodes))

        negative = run_case("condition-false")
        negative_nodes = [node for step in negative["steps"]
                          for node in step.get("effect_trace", [])]
        self.assertTrue(any(node.get("branch") == "else"
                            and node.get("condition_result") is False
                            for node in negative_nodes))
        self.assertFalse(any(node["ability_id"] == "TS-0001-A94"
                             for node in negative_nodes))

    def test_debug_trace_does_not_change_authoritative_result(self) -> None:
        state = start_game(request(seed="trace-parity"))["state"]
        player = state["active_player_id"]
        source = f"CI-{state['next_instance_sequence']:06d}"
        state["next_instance_sequence"] += 1
        state["instances"][source] = {
            "card_id": "TS-0428", "owner_player_id": player,
            "origin": "test_fixture", "flags": {},
        }
        state["zones"][f"player:{player}:hand"].append(source)
        entered = apply_command(state, {"type": "ChooseAction", "player_id": player,
                                        "action": "village"})["state"]
        command = {"type": "ActivateAbility", "player_id": player,
                   "ability_id": "TS-0428-A03", "source_instance_id": source}
        plain = apply_command(entered, command)
        traced = apply_command(entered, command, trace_effects=True)
        self.assertEqual(traced["state"], plain["state"])
        self.assertEqual(traced["events"], plain["events"])
        self.assertNotIn("effect_trace", plain)
        self.assertEqual([node["op"] for node in traced["effect_trace"]], ["draw"])

    def test_read_only_case_api_in_isolated_test_app(self) -> None:
        client = TestClient(create_sandbox_app())
        self.addCleanup(client.close)
        self.assertEqual(client.get("/effect-lab").status_code, 404)
        self.assertEqual(len(client.get("/effect-lab/cases").json()["cases"]), len(CASES))
        coverage = client.get("/effect-lab/coverage").json()
        self.assertEqual(coverage["total"], 520)
        self.assertEqual(coverage["complete"], 520)
        self.assertTrue(all(row["test_name"] == "test_effect_" + row["card_id"].replace("-", "_")
                            for row in coverage["cards"]))
        result = client.get("/effect-lab/cases/monster-count/run")
        self.assertEqual(result.status_code, 200)
        self.assertTrue(result.json()["passed"])
        self.assertEqual(client.get("/effect-lab/cases/missing/run").status_code, 404)
        self.assertEqual(client.get("/effect-lab/cases/disease-choice/run?choice_index=99").status_code, 422)


if __name__ == "__main__":
    unittest.main()
