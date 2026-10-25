"""Compare the serialized TypeScript transition with the frozen Python command path."""

from dataclasses import asdict
from unittest import TestCase

from backend.app.integrations.game_engine.catalog.repository import load_catalog
from backend.app.integrations.game_engine.effects.compiler import load_ruleset
from backend.app.integrations.game_engine.setup import start_game
from backend.app.integrations.game_engine.shared.client import client
from backend.tests.migration.reference.python_turn_service import apply_command as python_command
from backend.tests.migration.reference.python_disease_service import take_disease as python_disease
from backend.tests.support.setup import request


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
    """Ignore added UI metadata, retaining the legacy rule/state comparison."""
    result = normalize_disease_events(result)
    if isinstance(result, dict) and "legal_commands" in result:
        commands = [{key: value for key, value in item.items()
                     if not (item["type"] == "BuyCard" and key == "options")}
                    for item in result["legal_commands"] if item["type"] not in {"SubmitBattleTeam", "DeclareBattleTarget"}]
        commands = [{**item, "type": "FinishRest"} if item["type"] == "SkipRestDestroy" else item
                    for item in commands]
        return {**result, "legal_commands": commands}
    return result


def normalize_disease_events(result):
    """The public disease spotlight adds events/labels, not a different draw."""
    result = {**result, "state": {**result["state"]}}
    events, added = [], 0
    for raw in result.get("events", []):
        if raw["kind"] == "disease_gain_started":
            added += 1
            continue
        event = {**raw, "sequence": raw["sequence"] - added}
        event.pop("hall_rank_count", None)  # public animation metadata added after the frozen reference
        if raw["kind"] == "monster_returned_to_deck":
            event.pop("hall_zone", None)
            event.pop("rank", None)
        if raw["kind"] == "effect_hall_relocated":
            event.pop("rank", None)
        if raw["kind"] in {"disease_gain_completed", "disease_redirected"}:
            event.pop("gain_id", None)
            event.pop("card_id", None)
        events.append(event)
    result["events"] = events
    result["state"]["next_event_sequence"] -= added
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

    def compare_command(self, state, kind, *, legacy_followups=(), **fields):
        command = {"type": kind, "player_id": state["pending_choice"]["player_id"] if state["pending_choice"] else state["active_player_id"],
                   "expected_version": state["game_version"], **fields}
        expected = python_command(state, command, snapshot=self.catalog, effects=self.rules)
        # The frozen reference requires explicit commands for empty village
        # stages. Complete those stages there without changing its source; the
        # current engine must perform the equivalent transitions atomically.
        for followup in legacy_followups:
            continued = python_command(expected["state"], {"type": followup,
                "player_id": expected["state"]["active_player_id"],
                "expected_version": expected["state"]["game_version"]}, snapshot=self.catalog, effects=self.rules)
            expected = {**continued, "events": expected["events"] + continued["events"]}
        expected["state"]["game_version"] -= len(legacy_followups)
        # The frozen reference predates the explicit end-turn confirmation.
        # Compare equivalent completed actions, while current-engine tests cover
        # the new persisted ACTION_END boundary independently.
        current_command = {**command, "type": "SkipRestDestroy"} if kind == "FinishRest" else command
        if kind == "DeclareBattleTarget":
            current_command = {key: value for key, value in current_command.items() if key != "expected_version"}
        actual = client.call("apply_command", {**self.payload, "state": state, "command": current_command})
        if actual["state"]["subphase"] == "ACTION_END":
            ended = client.call("apply_command", {**self.payload, "state": actual["state"], "command": {
                "type": "FinishTurn", "player_id": actual["state"]["active_player_id"],
                "expected_version": actual["state"]["game_version"]}})
            actual = {**ended, "events": actual["events"] + ended["events"]}
            actual["state"]["game_version"] -= 1  # one additional confirmation command
        mismatch = difference(legacy_contract_result(expected), legacy_contract_result(actual))
        self.assertIsNone(mismatch, mismatch)
        return expected["state"]

    def test_village_rest_and_dungeon(self):
        state = start_game(request(seed="turn-village"))["state"]
        for kind, fields in [("ChooseAction", {"action": "village"}),
                             ("BuyCard", {"card_id": "TS-0001"}),
                             ("ChooseAction", {"action": "rest"}), ("FinishRest", {})]:
            state = self.compare_command(state, kind,
                legacy_followups=("FinishBuying", "FinishUpgrading") if kind == "BuyCard" else (), **fields)
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
            mismatch = difference(normalize_disease_events(expected), normalize_disease_events(actual))
            self.assertIsNone(mismatch, mismatch)
