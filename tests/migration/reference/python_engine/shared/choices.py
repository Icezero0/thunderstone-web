"""Private choice-validation projection for the shared TypeScript rules package."""

from backend.app.integrations.game_engine.shared.client import client
from tests.migration.reference.python_engine.shared.evaluation import evaluation_input


def validate_effect_selection(tx, selected_id):
    choice = tx.state["pending_choice"]
    frames = tx.state["resolution_frames"]
    ability = tx.ruleset.by_id(choice["ability_id"]) if choice and choice.get("kind") == "effect_select" else None
    return client.call("validate_effect_selection", {
        "evaluation": evaluation_input(tx),
        "choice": choice,
        "frame": frames[0] if frames else None,
        "source_card_id": ability.source_card_id if ability else None,
        "selected_id": selected_id,
    })


def validate_effect_purchase(tx, card_id):
    choice = tx.state["pending_choice"]
    ability = tx.ruleset.by_id(choice["ability_id"]) if choice and choice.get("kind") == "effect_purchase" else None
    return client.call("validate_effect_purchase", {
        "evaluation": evaluation_input(tx),
        "choice": choice,
        "source_card_id": ability.source_card_id if ability else None,
        "card_id": card_id,
    })
