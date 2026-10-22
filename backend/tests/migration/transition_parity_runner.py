"""Run existing command scenarios against both transition implementations.

Usage: python -m backend.tests.migration.transition_parity_runner backend.tests.test_turn_engine ...
The Python result remains the scenario's input so a mismatch identifies exactly
the command at which the TypeScript port diverged.
"""

from dataclasses import asdict
from collections import Counter
import importlib
import io
import sys
import unittest

from backend.app.integrations.game_engine.catalog.repository import load_catalog
from backend.app.integrations.game_engine.effects.compiler import load_ruleset
from backend.app.integrations.game_engine.shared.client import SharedRuleError, client
from backend.tests.migration.reference.python_turn_service import apply_command as python_command
from backend.tests.migration.reference.python_turn_service import legal_commands as python_legal
from backend.tests.migration.test_full_turn_parity import difference, legacy_contract_result

_catalog = load_catalog()
_rules = load_ruleset(_catalog.cards)
_rules_cache = {}


def payload(state, snapshot=None, effects=None):
    catalog = snapshot or _catalog
    rules = effects or _rules
    key = id(rules)
    if key not in _rules_cache:
        _rules_cache[key] = (rules, {"version": rules.version,
                                    "abilities": [asdict(item) for item in rules.abilities],
                                    "mechanics": [asdict(item) for item in rules.mechanics]})
    return {"catalog": {"cards": catalog.cards, "setup_index": catalog.setup_index},
            "ruleset": _rules_cache[key][1], "state": state}


def apply_command(state, command, root=None, *, snapshot=None, effects=None, trace_effects=False):
    kwargs = {"snapshot": snapshot, "effects": effects, "trace_effects": trace_effects}
    if root is not None:
        kwargs["root"] = root
    try:
        expected = python_command(state, command, **kwargs)
    except Exception as python_error:
        try:
            client.call("apply_command", {**payload(state, snapshot, effects),
                                           "command": command, "trace_effects": trace_effects})
        except SharedRuleError:
            raise python_error
        raise AssertionError(f"TS accepted Python-rejected {command}: {python_error}") from python_error
    try:
        actual = client.call("apply_command", {**payload(state, snapshot, effects),
                                              "command": command, "trace_effects": trace_effects})
    except Exception as error:
        raise AssertionError(f"TS rejected Python-accepted {command}: {error}") from error
    mismatch = difference(expected, legacy_contract_result(actual))
    if mismatch:
        event_mismatch = difference(expected.get("events"), actual.get("events"), "events")
        raise AssertionError(f"{command}: {mismatch}; {event_mismatch}")
    return expected


def legal_commands(state, root=None, *, snapshot=None, effects=None):
    kwargs = {"snapshot": snapshot, "effects": effects}
    if root is not None:
        kwargs["root"] = root
    expected = python_legal(state, **kwargs)
    actual = client.call("legal_commands", payload(state, snapshot, effects))
    actual = [item for item in actual if item["type"] != "SubmitBattleTeam"]
    mismatch = difference(expected, actual)
    if mismatch:
        raise AssertionError(f"legal_commands: {mismatch}")
    return expected


if __name__ == "__main__":
    args = sys.argv[1:]
    match = None
    if "--match" in args:
        index = args.index("--match")
        match = args[index + 1]
        del args[index:index + 2]
    names = args
    if not names:
        raise SystemExit("provide unittest module names")
    modules = [importlib.import_module(name) for name in names]
    for module in modules:
        if hasattr(module, "apply_command"):
            module.apply_command = apply_command
        if hasattr(module, "legal_commands"):
            module.legal_commands = legal_commands
    # Scenario helpers import the entry points separately.
    for name in ("backend.tests.action_cases", "backend.tests.battle_cases", "backend.tests.event_cases", "backend.tests.system_cases",
                 "backend.tests.setup_effect_cases", "backend.tests.scenario_cases"):
        module = importlib.import_module(name)
        if hasattr(module, "apply_command"):
            module.apply_command = apply_command
        if hasattr(module, "legal_commands"):
            module.legal_commands = legal_commands
    loader = unittest.TestLoader()
    if match:
        loader.testNamePatterns = [f"*{match}*"]
    suite = unittest.TestSuite(loader.loadTestsFromModule(module) for module in modules)
    output = io.StringIO()
    result = unittest.TextTestRunner(stream=output, verbosity=0).run(suite)
    print(f"Ran {result.testsRun} tests; failures={len(result.failures)}, errors={len(result.errors)}")
    groups = Counter()
    samples = {}
    for test, traceback in [*result.failures, *result.errors]:
        lines = traceback.strip().splitlines()
        message = lines[-1] if lines else 'unknown failure'
        key = message.split(': result.', 1)[-1] if ': result.' in message else message
        key = key.split(': ', 1)[0]
        groups[key] += 1
        samples.setdefault(key, (str(test), message))
    for key, count in groups.most_common():
        test, message = samples[key]
        print(f"{count:4} {key} | {test} | {message[:320]}")
    raise SystemExit(0 if result.wasSuccessful() else 1)
