"""Dungeon combat baseline and reviewed card effects."""

from __future__ import annotations

from tests.migration.reference.python_engine.turn.operations import Transition, TurnError, number
from tests.migration.reference.python_engine.effects.hall import can_move_monster
from tests.migration.reference.python_engine.effects.combat import (combat_values, monster_health, is_hero, is_monster,
                                   equipment_pairs, hand_rules, stat, reconcile_equipment,
                                   equipment_capacity)


ATTACK = "正文_基础攻击"
MAGIC_ATTACK = "正文_基础魔法攻击"
LIGHT = "wiki_光照"
STRENGTH = "wiki_力量"
WEIGHT = "wiki_重量"
HEALTH = "wiki_生命值"


def enter_dungeon(tx: Transition) -> None:
    tx.state["subphase"] = "DUNGEON_PREPARE"
    tx.state["timing_window"] = "DUNGEON_PREPARE"
    tx.state["battle_context"] = {"equipped_weapon_by_hero": {}}
    tx.event("dungeon_hand_revealed", player_id=tx.player_id,
             instance_ids=list(tx.zone("hand")))
    tx.player.pop("forced_dungeon", None)
    from tests.migration.reference.python_engine.turn.workflow import queue_steps
    queue_steps(tx, [{"op": "event", "event": "DUNGEON_ENTER"}])


def equip_weapon(tx: Transition, hero_id: str, weapon_id: str, *, defer_events: bool = False):
    hand = tx.zone("hand")
    if hero_id not in hand or weapon_id not in hand or hero_id == weapon_id:
        raise TurnError("hero and weapon must be distinct cards in the current hand")
    hero = tx.card(hero_id)
    weapon = tx.card(weapon_id)
    if not is_hero(hero) or "武器" not in weapon["tags"].split("|"):
        raise TurnError("equipment requires a hero and a weapon")
    equipped = tx.state["battle_context"]["equipped_weapon_by_hero"]
    pairs = equipment_pairs(tx.state["battle_context"])
    capacity = equipment_capacity(tx, hero_id)
    if sum(h == hero_id for h, _ in pairs) >= capacity or any(w == weapon_id for _, w in pairs):
        raise TurnError("a hero or weapon is already equipped")
    strength = combat_values(tx, rank=1)["hero_strength"][hero_id]
    discount = sum(rule.params["amount"] for source, rule in hand_rules(tx, "equipment_discount")
                   if source == weapon_id and rule.params["hero_tag"] in hero["tags"].split("|"))
    weight = 0 if tx.state["battle_context"].get("zero_weapon_weight") else number(weapon, WEIGHT, default=10**9)
    if weight > strength + discount:
        raise TurnError("weapon is heavier than the hero's strength")
    previous = equipped.get(hero_id)
    equipped[hero_id] = ([*(previous if isinstance(previous, list) else [previous]), weapon_id]
                         if previous else weapon_id)
    tx.event("weapon_equipped", player_id=tx.player_id,
             hero_instance_id=hero_id, weapon_instance_id=weapon_id)
    from tests.migration.reference.python_engine.turn.workflow import queue_steps
    steps = [{"op": "event", "event": "CARD_EQUIPPED", "context": {
        "source_instance_id": weapon_id, "hero_instance_id": hero_id}}]
    if defer_events:
        return steps
    queue_steps(tx, steps)


def equipment_options(tx: Transition) -> list[dict[str, str]]:
    hand = tx.zone("hand")
    equipped = tx.state["battle_context"]["equipped_weapon_by_hero"]
    options = []
    for hero_id in hand:
        hero = tx.card(hero_id)
        pairs = equipment_pairs(tx.state["battle_context"])
        capacity = equipment_capacity(tx, hero_id)
        if sum(h == hero_id for h, _ in pairs) >= capacity or not is_hero(hero):
            continue
        for weapon_id in hand:
            weapon = tx.card(weapon_id)
            if (any(w == weapon_id for _, w in pairs) or weapon_id == hero_id
                    or "武器" not in weapon["tags"].split("|")):
                continue
            strength = combat_values(tx, rank=1)["hero_strength"][hero_id]
            discount = sum(rule.params["amount"] for source, rule in hand_rules(tx, "equipment_discount")
                           if source == weapon_id and rule.params["hero_tag"] in hero["tags"].split("|"))
            weight = 0 if tx.state["battle_context"].get("zero_weapon_weight") else number(weapon, WEIGHT, default=10**9)
            if weight <= strength + discount:
                options.append({"hero_instance_id": hero_id,
                                "weapon_instance_id": weapon_id})
    return options


def attack_targets(tx: Transition) -> list[str]:
    targets = []
    for zone, pile in tx.state["zones"].items():
        if not zone.startswith("hall:"):
            continue
        for instance_id in pile:
            if (is_monster(tx.card(instance_id))
                    and tx.card(instance_id)[HEALTH] != ""):
                targets.append(instance_id)
    return targets


def _target_location(tx: Transition, target_id: str) -> tuple[str, int]:
    for zone, pile in tx.state["zones"].items():
        if not zone.startswith("hall:") or target_id not in pile:
            continue
        return zone, 0 if zone.endswith(":rank0") else pile.index(target_id) + 1
    raise TurnError("battle target is not in a dungeon hall")


def _combat_trace(tx: Transition, rank: int,
                  target: dict[str, str] | None = None) -> dict:
    return combat_values(tx, rank, target)


def _settle_on_stone(tx: Transition, stone_id: str, *, acquire: bool) -> bool:
    from tests.migration.reference.python_engine.turn.scenarios import BANISHING_RITUAL
    ritual = BANISHING_RITUAL in tx.state["active_settings"]
    stone_zone, _ = _target_location(tx, stone_id)
    if any(pile for zone, pile in tx.state["zones"].items()
           if zone.startswith("hall:") and zone.endswith(":rank0")):
        acquire = False
    if acquire:
        tx.state["instances"][stone_id]["owner_player_id"] = tx.player_id
        tx.move(stone_id, stone_zone, f"player:{tx.player_id}:discard")
        acquired = tx.state.setdefault("acquired_stones", [])
        if stone_id not in acquired:
            acquired.append(stone_id)
        tx.event("thunderstone_acquired", player_id=tx.player_id, instance_id=stone_id)
        if ritual or "TS-0198" in tx.state["active_settings"] and len(acquired) < 2:
            return False
    elif ritual:
        deck_zone = stone_zone.replace("hall:", "dungeon:")
        tx.move(stone_id, stone_zone, deck_zone)
        tx.event("thunderstone_returned_to_deck", instance_id=stone_id, deck_zone=deck_zone,
                 reason="banishing_ritual_breach")
        return False
    from tests.migration.reference.python_engine.turn.settlement import settle_game
    settle_game(tx, "thunderstone_entered_rank_1", instance_id=stone_id,
                acquired_by=tx.player_id if acquire else None)
    return True


def declare_battle_target(tx: Transition, target_id: str) -> None:
    if target_id not in attack_targets(tx):
        raise TurnError("target must be a monster or guardian in a hall")
    hall_zone, rank = _target_location(tx, target_id)
    from tests.migration.reference.python_engine.turn.hall import remember_fronts
    remember_fronts(tx)
    target = tx.card(target_id)
    if target[HEALTH] == "":
        raise TurnError(f"target {target['card_id']} has no recorded health")
    tx.state["battle_context"]["target_rank"] = rank
    reconcile_equipment(tx, during_battle=True)
    trace = _combat_trace(tx, rank, target)
    health = monster_health(tx, target, rank=rank, target_id=target_id)
    if not trace["can_attack"]:
        raise TurnError("target's attack restrictions are not satisfied")
    won = trace["can_defeat"] and trace["effective_attack"] >= health
    tx.event("battle_target_declared", player_id=tx.player_id,
             target_instance_id=target_id, hall_zone=hall_zone, rank=rank)
    tx.state["battle_context"].update(target_instance_id=target_id, hall_zone=hall_zone)
    tx.state["subphase"] = "BATTLE_EFFECTS"
    tx.state["timing_window"] = "BATTLE_BEFORE_OUTCOME"
    from tests.migration.reference.python_engine.turn.workflow import queue_steps
    queue_steps(tx, [{"op": "release_battle_diseases", "target_id": target_id, "timing": "before"},
                     {"op": "event", "event": "BATTLE_BEFORE_OUTCOME"},
                     {"op": "resolve_battle_outcome"}])


def resolve_battle_outcome(tx: Transition) -> None:
    context = tx.state["battle_context"]
    target_id = context["target_instance_id"]
    target = tx.card(target_id)
    hall_zone, rank = _target_location(tx, target_id)
    reconcile_equipment(tx, during_battle=True)
    trace = _combat_trace(tx, rank, target)
    health = monster_health(tx, target, rank=rank, target_id=target_id)
    won = trace["can_defeat"] and trace["effective_attack"] >= health
    tx.event("battle_resolved", target_instance_id=target_id,
             target_card_id=target["card_id"], rank=rank, health=health,
             outcome="win" if won else "loss", calculation=trace,
             card_effects="reviewed_ruleset")
    context["outcome"] = "win" if won else "loss"
    from tests.migration.reference.python_engine.turn.workflow import queue_steps
    queue_steps(tx, [{"op": "release_battle_diseases", "target_id": target_id, "timing": "after"},
                     {"op": "destroy_battle_marks"}, {"op": "battle_departure"}])


def destroy_battle_marks(tx):
    from tests.migration.reference.python_engine.turn.workflow import queue_steps
    queue_steps(tx, [{"op": "destroy_one", "instance_id": instance_id, "reason": "after_battle"}
                     for instance_id, instance in list(tx.state["instances"].items())
                     if instance["flags"].get("pending_after_battle_destruction")], front=True)


def battle_departure(tx):
    context = tx.state["battle_context"]
    target_id = context["target_instance_id"]
    target = tx.card(target_id)
    hall_zone, rank = _target_location(tx, target_id)
    won = context["outcome"] == "win"
    departed = False
    if won:
        xp = number(target, "defeat_xp_reward")
        tx.state.setdefault("turn_defeated_monsters", []).append(target_id)
        tx.state["instances"][target_id]["owner_player_id"] = tx.player_id
        tx.move(target_id, hall_zone, f"player:{tx.player_id}:discard")
        tx.player["xp"] += xp
        tx.event("monster_defeated", player_id=tx.player_id,
                 target_instance_id=target_id, xp_gained=xp)
        departed = True
    elif is_monster(target) and target["subcategory"] != "守护者" and can_move_monster(tx, target_id):
        deck_zone = hall_zone.replace("hall:", "dungeon:").removesuffix(":rank0")
        tx.move(target_id, hall_zone, deck_zone)
        if context.get("retreat_position"):
            pile = tx.state["zones"][deck_zone]
            pile.remove(target_id)
            pile.insert(min(context["retreat_position"] - 1, len(pile)), target_id)
        tx.event("monster_returned_to_deck", target_instance_id=target_id,
                 deck_zone=deck_zone, position=context.get("retreat_position", "bottom"))
        departed = True
    else:
        tx.event("guardian_remained", target_instance_id=target_id)
    from tests.migration.reference.python_engine.turn.workflow import queue_steps
    if departed and rank == 1:
        tx.state.setdefault("hall_fronts", {})[hall_zone] = None
    tx.state["subphase"] = "BATTLE_AFTER_EFFECTS"
    steps = [{"op": "event", "event": "BATTLE_AFTER_OUTCOME", "context": {
        "source_instance_id": target_id, "won": won, "rank": rank}}]
    if won:
        steps.append({"op": "event", "event": "MONSTER_DEFEATED", "context": {
            "source_instance_id": target_id, "rank": rank, "hall_zone": hall_zone}})
    steps.append({"op": "return_borrowed", "timing": "after_battle"})
    from tests.migration.reference.python_engine.turn.scenarios import HEART_OF_DOOM
    if target["card_id"] == HEART_OF_DOOM:
        steps.append({"op": "heart_of_doom_outcome", "instance_id": target_id, "won": won})
    if departed and rank != 0:
        steps.append({"op": "refill_hall", "hall_zone": hall_zone, "acquire_stone":
                      won and rank == 1 and is_monster(target),
                      "defeated_instance_id": target_id if won and is_monster(target) else None})
    steps.append({"op": "finish_turn"})
    queue_steps(tx, steps)
