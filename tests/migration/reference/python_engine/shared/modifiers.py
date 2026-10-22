"""Private combat-modifier projections for shared TypeScript effect atoms."""

from backend.app.integrations.game_engine.shared.client import client
from tests.migration.reference.python_engine.shared.evaluation import evaluation_input


def plan_modifier(tx, operation, node, bindings):
    return client.call(operation, {
        "evaluation": evaluation_input(tx),
        "node": node,
        "bindings": bindings,
        "subphase": tx.state["subphase"],
    })
