"""Private event-dispatch projection for the shared TypeScript rules package."""

from dataclasses import asdict

from backend.app.integrations.game_engine.shared.client import client
from tests.migration.reference.python_engine.shared.evaluation import evaluation_input


def plan_event_dispatch(tx, ruleset, event):
    return client.call("plan_event_dispatch", {
        "evaluation": evaluation_input(tx),
        "abilities": [asdict(ability) for ability in ruleset.abilities
                      if ability.kind == "triggered" and ability.event == event],
        "listeners": tx.state["registered_triggers"],
        "scheduled": tx.state["scheduled_effects"],
        "event": event,
        "turn_number": tx.state["turn_number"],
        "repeatable_ability_ids": [ability.id for ability in ruleset.abilities
                                   if ability.source_zone == "battle_target"],
    })
