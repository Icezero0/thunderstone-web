"""Private cost projection for the shared TypeScript effect rules."""

from backend.app.integrations.game_engine.shared.client import client
from backend.tests.migration.reference.python_engine.shared.evaluation import evaluation_input


def evaluate_cost(tx, cost, bindings):
    return client.call("evaluate_cost", {
        "evaluation": evaluation_input(tx),
        "cost": cost,
        "bindings": bindings,
    })
