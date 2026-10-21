"""Rules that remain active across turns, independent of their source zone."""


def applicable_rules(tx, kind):
    return [rule for rule in tx.state.get("continuous_effects", [])
            if rule.get("kind") == kind
            and (rule["scope"] == "all" or rule["player_id"] != tx.player_id)]


def must_enter_dungeon(tx):
    return bool(tx.player.get("forced_dungeon") or applicable_rules(tx, "force_dungeon"))


def expire_rules(tx, event):
    remaining = []
    for rule in tx.state.get("continuous_effects", []):
        if (rule["player_id"] == tx.player_id and rule["created_turn"] < tx.state["turn_number"]
                and rule["until"] == event):
            tx.event("continuous_rule_expired", rule=rule)
        else:
            remaining.append(rule)
    tx.state["continuous_effects"] = remaining
