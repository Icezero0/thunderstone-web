"""Printed gold and purchase prices after active, sourced economy rules."""

from backend.tests.migration.reference.python_engine.effects.combat import hall_rules, hand_rules


def economy_rules(tx):
    rules = [rule for _, rule in hand_rules(tx, "economy")]
    rules.extend(rule for _, rule in hall_rules(tx, "economy"))
    rules.extend(rule for rule in tx.ruleset.mechanics
                 if rule.op == "economy" and rule.source_card_id in tx.state["active_settings"])
    return rules


def printed_gold(tx, card: dict) -> int:
    from backend.app.integrations.game_engine.shared.client import client
    from backend.tests.migration.reference.python_engine.shared.projection import calculation_input
    return client.call("printed_gold", {"input": calculation_input(tx, card), "card": card})


def purchase_price(tx, card: dict) -> int:
    from backend.app.integrations.game_engine.shared.client import client
    from backend.tests.migration.reference.python_engine.shared.projection import calculation_input
    return client.call("purchase_price", {"input": calculation_input(tx, card), "card": card})


def purchase_allowed(tx) -> bool:
    made = tx.state.get("turn_purchases", {}).get(tx.player_id, 0)
    return not made or not any(rule.params.get("one_purchase") for rule in economy_rules(tx))
