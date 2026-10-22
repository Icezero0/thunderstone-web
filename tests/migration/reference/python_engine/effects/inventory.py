"""Supply mutations shared by purchases, combat and setup replacements."""

from tests.migration.reference.python_engine.effects.combat import is_hero


def setting_rule(tx, op):
    return tx.ruleset is not None and any(rule.op == op and rule.source_card_id in tx.state["active_settings"]
                                         for rule in tx.ruleset.mechanics)


def return_destroyed_to_supply(tx, item, source, *, reason):
    card = tx.printed_card(item)
    if (not setting_rule(tx, "return_destroyed_to_supply") or card["card_type"] not in ("英雄牌", "村庄牌", "基础牌")):
        return None
    tx.state["instances"][item]["owner_player_id"] = None
    if card["card_id"] in tx.state["supply_rules"]["basic_card_ids"]:
        destination = "basic_supply"
        tx.state["zones"].setdefault(destination, [])
        tx.move(item, source, destination)
    else:
        destination = matching_supply(tx, card, family=card["card_type"] == "英雄牌")
        if destination is None:
            destination = ("hero_supply:" + tx.state["instances"][item]["origin"] if card["card_type"] == "英雄牌"
                           else "village_supply:" + card["card_id"])
        tx.state["zones"].setdefault(destination, [])
        tx.move(item, source, destination)
        if card["card_type"] == "英雄牌":
            tx.state["zones"][destination].sort(key=lambda instance: int(tx.card(instance)["wiki_英雄等级"] or 0))
    details = {"instance_id": item, "card_id": card["card_id"], "source": source, "destination": destination}
    tx.event("destruction_returned_to_supply", **details, reason=reason)
    return details


def replenish_empty_supplies(tx):
    if not setting_rule(tx, "refill_empty_supply"):
        return
    if tx.setup_index is None:
        from tests.migration.reference.python_engine.turn.operations import TurnError
        raise TurnError("supply replenishment requires the injected catalog index")
    groups = tx.setup_index["groups"]
    used = tx.state.setdefault("used_supply_randomizers", {
        kind: list(tx.state["selected_groups"][kind]) for kind in ("hero", "village")})
    for zone, pile in list(tx.state["zones"].items()):
        if pile or not zone.startswith(("hero_supply:", "village_supply:")):
            continue
        kind = "hero" if zone.startswith("hero_supply:") else "village"
        available = [group for group in groups if group["kind"] == kind and group["randomizer_id"] not in used[kind]]
        if not available:
            continue
        group = available[tx.rng.randbelow(len(available))]
        used[kind].append(group["randomizer_id"])
        del tx.state["zones"][zone]
        destination = ("hero_supply:" + group["randomizer_id"] if kind == "hero"
                       else "village_supply:" + group["members"][0])
        tx.state["zones"][destination] = []
        members = sorted(group["members"], key=lambda card: (int(tx.cards[card]["wiki_英雄等级"] or 0), card))
        multiplier = tx.state["frozen_config"]["instance_multipliers"][kind]
        for card_id in members:
            for _ in range(int(tx.cards[card_id]["initial_copy_count"]) * multiplier):
                item = tx.create_owned(card_id, destination, group["randomizer_id"], emit_event=False)
                tx.state["instances"][item]["owner_player_id"] = None
        tx.event("empty_supply_replenished", exhausted_zone=zone, zone=destination,
                 randomizer_id=group["randomizer_id"], instance_ids=list(tx.state["zones"][destination]))


def matching_supply(tx, card, *, family=False):
    for zone, pile in tx.state["zones"].items():
        if not zone.startswith(("village_supply:", "hero_supply:")) or not pile:
            continue
        if any(tx.card(item)["card_id"] == card["card_id"] or (
                family and is_hero(card) and tx.card(item)["card_type"] == "英雄牌"
                and tx.card(item)["subcategory"] == card["subcategory"]) for item in pile):
            return zone
    return None


def destroy_matching(tx, instance, count, *, family=False, bottom=False, ability_id):
    card = tx.card(instance)
    if card["card_id"] in tx.state["supply_rules"]["basic_card_ids"]:
        tx.event("infinite_supply_destruction", card_id=card["card_id"], count=count, ability_id=ability_id)
        return
    zone = matching_supply(tx, card, family=family)
    if zone:
        for item in (list(reversed(tx.state["zones"][zone])) if bottom else list(tx.state["zones"][zone]))[:count]:
            tx.destroy_card(item, reason=ability_id)


def destroy_purchased(tx, ability_id):
    context = tx.state.get("event_context", {})
    zone = context.get("supply_zone")
    if zone and tx.state["zones"].get(zone):
        tx.destroy_card(tx.state["zones"][zone][0], reason=ability_id)
    elif context.get("source_instance_id") in tx.state["instances"]:
        card_id = tx.card(context["source_instance_id"])["card_id"]
        if card_id in tx.state["supply_rules"]["basic_card_ids"]:
            tx.event("infinite_supply_destruction", card_id=card_id, count=1, ability_id=ability_id)
