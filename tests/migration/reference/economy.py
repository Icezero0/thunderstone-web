"""Frozen Python economy formula for migration comparison only."""
from tests.migration.reference.combat import hall_rules, hand_rules, is_hero, stat


def economy_rules(tx):
    rules = [rule for _, rule in hand_rules(tx, "economy")]
    rules.extend(rule for _, rule in hall_rules(tx, "economy"))
    rules.extend(rule for rule in tx.ruleset.mechanics
                 if rule.op == "economy" and rule.source_card_id in tx.state["active_settings"])
    return rules


def printed_gold(tx, card):
    if card["subcategory"] == "怪物" and any(rule.params.get("monster_gold_zero") for rule in economy_rules(tx)):
        return 0
    return stat(card, "gold")


def purchase_price(tx, card):
    if card.get("wiki_购买价格", "") == "":
        return 10**9
    price = stat(card, "cost")
    for rule in economy_rules(tx):
        p = rule.params
        price += p.get("all_surcharge", 0)
        if is_hero(card):
            price += p.get("hero_surcharge", 0) - p.get("hero_discount", 0)
    return max(0, price)
