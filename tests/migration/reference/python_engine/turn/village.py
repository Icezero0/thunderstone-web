"""Village purchase, upgrade and rest actions."""

from __future__ import annotations

from tests.migration.reference.python_engine.turn.operations import Transition, TurnError, number
from tests.migration.reference.python_engine.effects.economy import printed_gold, purchase_allowed, purchase_price


GOLD = "wiki_金币值"
PRICE = "wiki_购买价格"
LEVEL = "wiki_英雄等级"


def enter_village(tx: Transition) -> None:
    tx.state["subphase"] = "VILLAGE_ABILITIES"
    tx.state["timing_window"] = "VILLAGE_ABILITIES"
    tx.event("village_abilities_started", player_id=tx.player_id)
    from tests.migration.reference.python_engine.turn.workflow import queue_steps
    queue_steps(tx, [{"op": "event", "event": "VILLAGE_ENTER"}, {"op": "village_entry_done"}])


def village_entry_done(tx: Transition) -> None:
    if tx.ruleset is not None:
        from tests.migration.reference.python_engine.effects.runtime import available_activations
        if available_activations(tx, tx.ruleset):
            return
    finish_abilities(tx)


def finish_abilities(tx: Transition) -> None:
    tx.event("village_abilities_finished", player_id=tx.player_id)
    tx.state["subphase"] = "VILLAGE_BUY"
    tx.state["timing_window"] = "VILLAGE_BUY"
    sources = []
    for instance_id in tx.zone("hand"):
        amount = printed_gold(tx, tx.card(instance_id))
        if amount:
            sources.append({"instance_id": instance_id, "gold": amount})
    tx.player["temporary_gold"] = max(0, tx.player["temporary_gold"] + sum(item["gold"] for item in sources)
                                      + tx.player.pop("turn_gold_adjustment", 0))
    tx.event("village_gold_counted", player_id=tx.player_id,
             sources=sources, total=tx.player["temporary_gold"])


def purchasable_cards(tx: Transition) -> list[str]:
    if (tx.player["purchases_remaining"] < 1 and not tx.player.get("extra_basic_purchases")) or not purchase_allowed(tx):
        return []
    available = set(tx.state["supply_rules"]["basic_card_ids"])
    for zone, pile in tx.state["zones"].items():
        if pile and (zone.startswith("village_supply:") or zone.startswith("hero_supply:")):
            available.add(tx.state["instances"][pile[0]]["card_id"])
    return sorted(card_id for card_id in available
                  if (tx.player["purchases_remaining"] > 0 or card_id == "TS-0001")
                  and purchase_price(tx, tx.cards[card_id])
                  <= tx.player["temporary_gold"])


def buy_card(tx: Transition, card_id: str) -> None:
    if card_id not in purchasable_cards(tx):
        raise TurnError(f"card is not purchasable now: {card_id}")
    price = purchase_price(tx, tx.cards[card_id])
    destination = f"player:{tx.player_id}:discard"
    supply_zone = None
    if card_id in tx.state["supply_rules"]["basic_card_ids"]:
        instance_id = tx.create_owned(card_id, destination, "basic_supply")
    else:
        supply_zone = next((zone for zone, pile in tx.state["zones"].items()
                            if pile and (zone.startswith("village_supply:")
                                         or zone.startswith("hero_supply:"))
                            and tx.state["instances"][pile[0]]["card_id"] == card_id), None)
        if supply_zone is None:
            raise TurnError(f"no supply for {card_id}")
        instance_id = tx.state["zones"][supply_zone][0]
        tx.state["instances"][instance_id]["owner_player_id"] = tx.player_id
        tx.move(instance_id, supply_zone, destination)
    tx.player["temporary_gold"] -= price
    if card_id == "TS-0001" and tx.player.get("extra_basic_purchases"):
        tx.player["extra_basic_purchases"] -= 1
    else:
        tx.player["purchases_remaining"] -= 1
    made = tx.state.setdefault("turn_purchases", {})
    made[tx.player_id] = made.get(tx.player_id, 0) + 1
    tx.event("card_bought", player_id=tx.player_id, card_id=card_id,
             instance_id=instance_id, price=price,
             gold_remaining=tx.player["temporary_gold"])
    from tests.migration.reference.python_engine.turn.workflow import queue_steps
    queue_steps(tx, [{"op": "event", "event": "CARD_PURCHASED", "context": {
        "source_instance_id": instance_id, "supply_zone": supply_zone, "price": price}}])


def finish_buying(tx: Transition) -> None:
    tx.state["subphase"] = "VILLAGE_UPGRADE"
    tx.state["timing_window"] = "VILLAGE_UPGRADE"
    tx.event("village_upgrade_started", player_id=tx.player_id)


def upgrade_options(tx: Transition) -> list[dict]:
    options = []
    for source_id in tx.zone("hand"):
        source = tx.card(source_id)
        if tx.state["instances"][source_id]["flags"].get("upgraded_on_turn") == tx.state["turn_number"]:
            continue
        militia = source["card_id"] == "TS-0001"
        if not militia and source["card_type"] != "英雄牌":
            continue
        cost = number(source, "upgrade_xp_cost", default=-1)
        if cost < 0 or tx.player["xp"] < cost:
            continue
        level = number(source, LEVEL, default=-1)
        for zone, pile in tx.state["zones"].items():
            if not zone.startswith("hero_supply:"):
                continue
            for item in pile:
                target = tx.card(item)
                if number(target, LEVEL, default=-1) != level + 1:
                    continue
                if not militia and target["subcategory"] != source["subcategory"]:
                    continue
                option = {"source_instance_id": source_id,
                          "target_card_id": target["card_id"], "xp_cost": cost}
                if option not in options:
                    options.append(option)
    return options


def perform_hero_upgrade(tx: Transition, source_id: str, target_card_id: str, *, destination: str = "discard") -> list[dict]:
    if destination not in ("discard", "hand"):
        raise TurnError("invalid hero upgrade destination")
    option = next((item for item in upgrade_options(tx)
                   if item["source_instance_id"] == source_id
                   and item["target_card_id"] == target_card_id), None)
    if option is None:
        raise TurnError("invalid hero upgrade or insufficient XP/supply")
    source = tx.card(source_id)
    source_card_id = source["card_id"]
    target_zone = next(zone for zone, pile in tx.state["zones"].items()
                       if zone.startswith("hero_supply:") and any(
                           tx.state["instances"][item]["card_id"] == target_card_id
                           for item in pile))
    target_id = next(item for item in tx.state["zones"][target_zone]
                     if tx.state["instances"][item]["card_id"] == target_card_id)
    tx.destroy_card(source_id, reason="hero_upgrade")
    tx.state["instances"][target_id]["owner_player_id"] = tx.player_id
    tx.move(target_id, target_zone, f"player:{tx.player_id}:{destination}")
    tx.state["instances"][target_id]["flags"]["upgraded_on_turn"] = tx.state["turn_number"]
    tx.player["xp"] -= option["xp_cost"]
    tx.event("hero_upgraded", player_id=tx.player_id,
             source_instance_id=source_id, source_card_id=source_card_id,
             target_instance_id=target_id, target_card_id=target_card_id,
             xp_cost=option["xp_cost"])
    return [{"op": "event", "event": "HERO_UPGRADED", "context": {
        "source_instance_id": target_id, "old_instance_id": source_id, "supply_zone": target_zone}}]


def upgrade_hero(tx: Transition, source_id: str, target_card_id: str) -> None:
    from tests.migration.reference.python_engine.turn.workflow import queue_steps
    queue_steps(tx, perform_hero_upgrade(tx, source_id, target_card_id))


def rest_destroy(tx: Transition, instance_id: str) -> None:
    if instance_id not in tx.zone("hand"):
        raise TurnError("rest can only destroy a card in the current hand")
    card = tx.card(instance_id)
    destination = tx.destroy_card(instance_id, reason="rest")["destination"]
    tx.event("rest_card_destroyed", player_id=tx.player_id,
             instance_id=instance_id, card_id=card["card_id"],
             destination=destination)
    tx.finish_turn()
