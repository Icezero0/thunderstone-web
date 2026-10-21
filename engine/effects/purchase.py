"""Effect purchases, each using its own current hand-gold allowance."""

from engine.effects.combat import matches
from engine.effects.economy import printed_gold, purchase_allowed, purchase_price
from engine.turn.operations import TurnError


def offer(tx, predicate: dict, maximum_cost=None) -> list[dict]:
    if maximum_cost is None and not purchase_allowed(tx):
        return []
    budget = (sum(printed_gold(tx, tx.card(item)) for item in tx.zone("hand")) if maximum_cost is None else maximum_cost)
    available = set(tx.state["supply_rules"]["basic_card_ids"])
    available.update(tx.card(pile[0])["card_id"] for zone, pile in tx.state["zones"].items()
                     if zone.startswith(("village_supply:", "hero_supply:")) and pile)
    result = []
    for card_id in sorted(available):
        card = tx.cards[card_id]
        # Basic cards remain members of the village supply in the game rules.
        filtered = {**card, "card_type": "村庄牌"} if card["card_type"] == "基础牌" else card
        if matches(filtered, predicate) and purchase_price(tx, card) <= budget:
            result.append({"card_id": card_id, "price": purchase_price(tx, card), "budget": budget})
    return result


def buy(tx, card_id: str, predicate: dict, destination: str, *, ability_id: str, maximum_cost=None) -> list[dict]:
    option = next((row for row in offer(tx, predicate, maximum_cost) if row["card_id"] == card_id), None)
    if option is None:
        raise TurnError("card is not affordable for this effect purchase")
    supply = None
    zone = f"player:{tx.player_id}:{destination}"
    if card_id in tx.state["supply_rules"]["basic_card_ids"]:
        instance = tx.create_owned(card_id, zone, "effect_purchase")
    else:
        supply = next(place for place, pile in tx.state["zones"].items()
                      if place.startswith(("village_supply:", "hero_supply:")) and pile and tx.card(pile[0])["card_id"] == card_id)
        instance = tx.state["zones"][supply][0]
        tx.state["instances"][instance]["owner_player_id"] = tx.player_id
        tx.move(instance, supply, zone)
    if maximum_cost is None:
        made = tx.state.setdefault("turn_purchases", {})
        made[tx.player_id] = made.get(tx.player_id, 0) + 1
    tx.event("effect_purchase_completed" if maximum_cost is None else "effect_card_gained", ability_id=ability_id, card_id=card_id, instance_id=instance,
             destination=zone, price=option["price"], budget=option["budget"])
    return [] if maximum_cost is not None else [{"op": "event", "event": "CARD_PURCHASED", "context": {
        "source_instance_id": instance, "supply_zone": supply, "price": option["price"]}}]
