"""Private Python transport for shared TypeScript ability availability rules."""

from dataclasses import asdict

from backend.app.integrations.game_engine.shared.client import client
from tests.migration.reference.python_engine.shared.evaluation import evaluation_input


def _payload(tx, ruleset):
    return {
        "evaluation": evaluation_input(tx),
        "abilities": [asdict(ability) for ability in ruleset.abilities if ability.kind == "activated"],
        "turn_number": tx.state["turn_number"],
        "ability_uses": tx.state.get("ability_uses", {}),
    }


def available_activations(tx, ruleset):
    return client.call("available_activations", _payload(tx, ruleset))


def reusable_abilities(tx, instance_id):
    return client.call("reusable_abilities", {
        **_payload(tx, tx.ruleset), "instance_id": instance_id})


def validate_reuse_choice(tx, selected):
    return client.call("validate_reuse_choice", {
        **_payload(tx, tx.ruleset),
        "choice": tx.state["pending_choice"],
        "selected": selected,
    })
