"""Compare the serialized TypeScript transition with the frozen Python command path."""

from dataclasses import asdict
from unittest import TestCase

from backend.app.integrations.game_engine.catalog.repository import load_catalog
from backend.app.integrations.game_engine.effects.compiler import load_ruleset
from backend.app.integrations.game_engine.setup import start_game
from backend.app.integrations.game_engine.shared.client import client
from tests.migration.reference.python_turn_service import apply_command as python_command
from tests.migration.reference.python_disease_service import take_disease as python_disease
from tests.test_setup_engine import request


def difference(left, right, path="result"):
    if type(left) is not type(right):
        return f"{path}: {type(left).__name__} != {type(right).__name__}"
    if isinstance(left, dict):
        if left.keys() != right.keys():
            return f"{path}: left-only {left.keys() - right.keys()}, right-only {right.keys() - left.keys()}"
        for key in left:
            found = difference(left[key], right[key], f"{path}.{key}")
            if found:
                return found
    elif isinstance(left, list):
        if len(left) != len(right):
            return f"{path}: lengths {len(left)} != {len(right)}"
        for index, (a, b) in enumerate(zip(left, right)):
            found = difference(a, b, f"{path}[{index}]")
            if found:
                return found
    elif left != right:
        return f"{path}: {left!r} != {right!r}"
    return None


def legacy_contract_result(result):
    """The legacy executor predates the additive SubmitBattleTeam command."""
    if isinstance(result, dict) and "legal_commands" in result:
        return {**result, "legal_commands": [item for item in result["legal_commands"]
                                             if item["type"] != "SubmitBattleTeam"]}
    return result


class FullTurnParity(TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog = load_catalog()
        cls.rules = load_ruleset(cls.catalog.cards)
        cls.payload = {"catalog": {"cards": cls.catalog.cards,
                                   "setup_index": cls.catalog.setup_index},
                       "ruleset": {"version": cls.rules.version,
                                   "abilities": [asdict(item) for item in cls.rules.abilities],
                                   "mechanics": [asdict(item) for item in cls.rules.mechanics]}}

    def compare_command(self, state, kind, **fields):
        command = {"type": kind, "player_id": state["pending_choice"]["player_id"] if state["pending_choice"] else state["active_player_id"],
                   "expected_version": state["game_version"], **fields}
        expected = python_command(state, command, snapshot=self.catalog, effects=self.rules)
        actual = client.call("apply_command", {**self.payload, "state": state, "command": command})
        mismatch = difference(expected, legacy_contract_result(actual))
        self.assertIsNone(mismatch, mismatch)
        return expected["state"]

    def test_village_rest_and_dungeon(self):
        state = start_game(request(seed="turn-village"))["state"]
        for kind, fields in [("ChooseAction", {"action": "village"}),
                             ("BuyCard", {"card_id": "TS-0001"}),
                             ("FinishBuying", {}), ("FinishUpgrading", {}),
                             ("ChooseAction", {"action": "rest"}), ("FinishRest", {})]:
            state = self.compare_command(state, kind, **fields)
        state = start_game(request(seed="turn-dungeon"))["state"]
        state = self.compare_command(state, "ChooseAction", action="dungeon")
        target = state["zones"]["hall:main"][0]
        state["instances"][target]["card_id"] = "TS-0476"
        self.compare_command(state, "DeclareBattleTarget", target_instance_id=target)

    def test_disease_gain_matches_reference(self):
        for seed in ("disease-ordinary", "disease-special"):
            state = start_game(request(seed=seed))["state"]
            player = state["active_player_id"]
            expected = python_disease(state, player, destination="hand",
                                      snapshot=self.catalog, effects=self.rules)
            actual = client.call("take_disease", {**self.payload, "state": state,
                                                  "player_id": player, "destination": "hand"})
            mismatch = difference(expected, actual)
            self.assertIsNone(mismatch, mismatch)
