"""Behavior fixtures shared by per-card tests for dedicated rule hooks."""

from copy import deepcopy
from dataclasses import replace

from engine.effects.combat import combat_values, monster_health, stat
from engine.effects.economy import printed_gold, purchase_price, purchase_allowed
from engine.scoring import score_game
from engine.turn.dungeon import equip_weapon, declare_battle_target
from engine.turn.operations import Transition, TurnError


def hero(card):
    return "英雄" in card["tags"].split("|")


def qualifies(card, spec):
    tags = card["tags"].split("|")
    return (all(card[key] == spec[key] for key in ("card_id", "card_type", "subcategory", "name") if key in spec)
            and ("tag" not in spec or spec["tag"] in tags)
            and ("tags_any" not in spec or any(tag in tags for tag in spec["tags_any"]))
            and not any(tag in tags for tag in spec.get("tags_none", []))
            and ("gold_present" not in spec or (card["wiki_金币值"] != "") == spec["gold_present"])
            and ("gold_min" not in spec or int(card["wiki_金币值"] or 0) >= spec["gold_min"])
            and ("light_min" not in spec or int(card["wiki_光照"] or 0) >= spec["light_min"])
            and ("magic_min" not in spec or int(card["正文_基础魔法攻击"] or 0) >= spec["magic_min"])
            and ("level_min" not in spec or int(card["wiki_英雄等级"] or 0) >= spec["level_min"])
            and ("level_max" not in spec or int(card["wiki_英雄等级"] or 0) <= spec["level_max"]))


class Fixture:
    def __init__(self, base, cards, ruleset, rule):
        self.cards = cards
        self.state = deepcopy(base)
        self.player = self.state["active_player_id"]
        for player in self.state["player_order"]:
            for part in ("draw", "hand", "discard", "control"):
                zone = f"player:{player}:{part}"
                for item in self.state["zones"][zone]:
                    self.state["instances"][item]["owner_player_id"] = None
                self.state["zones"].setdefault("destroyed", []).extend(self.state["zones"][zone])
                self.state["zones"][zone] = []
        self.state["chosen_action"] = "dungeon"
        self.state["subphase"] = "DUNGEON_PREPARE"
        self.state["battle_context"] = {"equipped_weapon_by_hero": {}}
        self.ruleset = replace(ruleset, abilities=(), mechanics=(rule,))
        self.tx = Transition(self.state, cards, self.ruleset)

    def add(self, card_id, zone=None, player=None):
        zone = zone or f"player:{player or self.player}:hand"
        instance = f"CI-{self.tx.state['next_instance_sequence']:06d}"
        self.tx.state["next_instance_sequence"] += 1
        self.tx.state["instances"][instance] = {
            "card_id": card_id, "owner_player_id": zone.split(":")[1] if zone.startswith("player:") else None,
            "origin": "unit_test", "flags": {}}
        self.tx.state["zones"].setdefault(zone, []).append(instance)
        return instance

    def find(self, predicate):
        return next(card_id for card_id, card in self.cards.items()
                    if card["slot_kind"] == "front" and card["card_type"] != "游戏设置牌"
                    and predicate(card))

    def source(self, rule):
        source = self.add(rule.source_card_id)
        if "武器" in self.cards[rule.source_card_id]["tags"].split("|"):
            equipper = self.add("TS-0302")
            self.tx.state["battle_context"]["card_modifiers"] = {equipper: {"strength": 100}}
            self.tx.state["battle_context"]["equipped_weapon_by_hero"][equipper] = source
        return source

    def calc(self, rank=1, target=None, *, baseline=False):
        tx = self.tx
        if baseline:
            tx = Transition(tx.state, self.cards, replace(self.ruleset, mechanics=()))
        return combat_values(tx, rank, target)

    def value(self, trace, instance, field):
        if field == "strength":
            return trace["hero_strength"].get(instance, 0)
        return next((row[field] for row in trace["components"] if row["instance_id"] == instance), 0)


def verify_rule(test, base, cards, ruleset, rule):
    f = Fixture(base, cards, ruleset, rule)
    p, op = rule.params, rule.op
    source = None
    if op == "response":
        from tests.response_cases import verify_response
        verify_response(test, base, cards, ruleset, rule)
        return
    elif op == "return_destroyed_to_supply":
        f.tx.state["active_settings"] = [rule.source_card_id]
        source = f.add("TS-0302")
        f.add("TS-0304", "hero_supply:returned")
        f.add("TS-0303", "hero_supply:returned")
        result = f.tx.destroy_card(source)
        test.assertTrue(result["destination"].startswith("hero_supply:"))
        levels = [int(f.tx.card(item)["wiki_英雄等级"]) for item in f.tx.state["zones"][result["destination"]]]
        test.assertEqual(levels, sorted(levels))
        village = f.add("TS-0226")
        test.assertTrue(f.tx.destroy_card(village)["destination"].startswith("village_supply:"))
        monster = f.add("TS-0476")
        test.assertEqual(f.tx.destroy_card(monster)["destination"], "destroyed")
        disease = f.add("TS-0714")
        test.assertEqual(f.tx.destroy_card(disease)["destination"], "disease_supply")
        return
    elif op == "refill_empty_supply":
        from engine.catalog.repository import load_catalog
        f.tx.setup_index = load_catalog().setup_index
        f.tx.state["active_settings"] = [rule.source_card_id]
        zone = next(zone for zone in f.tx.state["zones"] if zone.startswith("village_supply:"))
        for item in list(f.tx.state["zones"][zone]):
            f.tx.destroy_card(item)
        f.tx.finish()
        event = next(event for event in f.tx.events if event["kind"] == "empty_supply_replenished")
        test.assertEqual(event["exhausted_zone"], zone)
        test.assertNotIn(event["randomizer_id"], f.tx.state["selected_groups"]["village"])
        test.assertTrue(f.tx.state["zones"][event["zone"]])
        test.assertTrue(all(f.tx.state["instances"][item]["owner_player_id"] is None for item in event["instance_ids"]))
        return
    elif op == "replace_monster":
        from engine.turn.workflow import queue_steps
        for zone in list(f.tx.state["zones"]):
            if zone.startswith(("hall:", "dungeon:")):
                f.tx.state["zones"]["destroyed"].extend(f.tx.state["zones"][zone])
                f.tx.state["zones"][zone] = []
        f.tx.state["active_settings"] = []
        source = f.add(rule.source_card_id, "dungeon:main")
        marker2 = f.add(rule.source_card_id, "dungeon:main")
        f.add("TS-0476", "dungeon:main")
        ids = ("TS-0540", "TS-0541") if rule.source_card_id == "TS-0550" else ("TS-0616", "TS-0617")
        reserved = [f.add(card, "monster_reserve:" + rule.source_card_id) for card in ids]
        queue_steps(f.tx, [{"op": "refill_hall", "hall_zone": "hall:main"}])
        test.assertEqual(f.tx.state["zones"]["hall:main"][:2], reserved)
        test.assertEqual(f.tx.state["zones"]["monster_markers"], [source, marker2])
        return
    elif op == "draw_attack":
        source = f.source(rule)
        before = f.value(f.calc(), source, "attack")
        f.add("TS-0003", f"player:{f.player}:draw")
        f.add("TS-0003", f"player:{f.player}:draw")
        f.tx.draw(5)
        test.assertEqual(f.value(f.calc(), source, "attack"), before + 2)
        f.tx.state["battle_context"]["equipped_weapon_by_hero"] = {}
        f.tx.draw(1)
        test.assertEqual(f.tx.state["battle_context"]["equipment_draw_counts"][source], 2)
        return
    elif op == "dungeon_deck_lock":
        from engine.effects.runtime import available_activations
        f.tx.ruleset = ruleset
        source = f.add(rule.source_card_id, "hall:main")
        medium = f.add("TS-0453")
        option = {"ability_id": "TS-0453-A02", "source_instance_id": medium}
        test.assertNotIn(option, available_activations(f.tx, ruleset))
        f.tx.destroy_card(source)
        test.assertIn(option, available_activations(f.tx, ruleset))
        return
    elif op == "repeat_battle":
        from engine.turn import apply_command
        source = f.add(rule.source_card_id, "hall:main:rank0")
        target = f.add("TS-0476", "hall:main")
        f.tx.ruleset = ruleset
        result = apply_command(f.tx.state, {"type": "DeclareBattleTarget", "player_id": f.player,
            "target_instance_id": target}, effects=ruleset)
        test.assertEqual(sum(e["kind"] == "disease_taken_from_supply" for e in result["events"]), 2)
        return
    elif op == "replace_disease":
        source = f.add(rule.source_card_id)
        before_rng = f.tx.rng.counter
        disease = f.tx.take_disease()
        test.assertEqual(f.tx.rng.counter, before_rng + 1)
        if p["action"] == "destroy":
            test.assertNotIn(disease, f.tx.state["instances"])
            test.assertNotIn(disease, f.tx.state["zones"]["destroyed"])
        else:
            other = next(player for player in f.tx.state["player_order"] if player != f.player)
            test.assertIn(disease, f.tx.zone("discard", other))
            test.assertEqual(f.tx.state["instances"][disease]["owner_player_id"], other)
        f.tx.move(source, f"player:{f.player}:hand", f"player:{f.player}:discard")
        ordinary = f.tx.take_disease()
        test.assertIn(ordinary, f.tx.zone("discard"))
        test.assertEqual(f.tx.state["instances"][ordinary]["owner_player_id"], f.player)
        return
    if op in {"rank_bonus", "hand_bonus", "target_bonus", "ignore_darkness", "double_magic",
              "hero_aura", "weapon_aura", "rank_restriction", "disease_strength", "excess_light_magic", "card_aura"}:
        source = f.source(rule)
    if op == "rank_bonus":
        for rank in (1, 2, 3, 4):
            before, after = f.calc(rank, baseline=True), f.calc(rank)
            factor = ((rank if p.get("scale") else 1)
                      if p.get("minimum", 0) <= rank <= p.get("maximum", 100) else 0)
            for field in ("attack", "magic_attack", "light"):
                test.assertEqual(f.value(after, source, field) - f.value(before, source, field),
                                 p.get(field, 0) * factor)
    elif op == "hand_bonus":
        pool = ("TS-0001", "TS-0003", "TS-0004", "TS-0226", "TS-0267", "TS-0328", "TS-0329", "TS-0401", "TS-0511")
        for card_id in pool:
            f.add(card_id)
        f.tx.player["xp"] = 7
        selected = [item for item in f.tx.zone("hand") if qualifies(f.tx.card(item), p.get("filter", {}))
                    and (not p.get("exclude_source") or item != source)]
        metric = p.get("metric", "count")
        count = (sum(int(f.tx.card(item)["wiki_金币值"] or 0) for item in selected) if metric == "gold"
                 else len(selected))
        multiplier = (int(count == 0) if p.get("absent") else 0 if count < p.get("minimum", 0)
                      else 1 if p.get("flat") else count // p.get("divisor", 1))
        before, after = f.calc(baseline=True), f.calc()
        for field in ("attack", "magic_attack", "light", "strength"):
            test.assertEqual(f.value(after, source, field) - f.value(before, source, field),
                             p.get(field, 0) * multiplier, rule.id)
        # Removing every matching companion exercises absence and thresholds.
        for item in list(selected):
            if item != source:
                f.tx.zone("hand").remove(item)
                f.tx.zone("discard").append(item)
        before, after = f.calc(baseline=True), f.calc()
        if p.get("minimum", 0) > 1:
            for field in ("attack", "magic_attack", "light", "strength"):
                test.assertEqual(f.value(after, source, field), f.value(before, source, field))
        if p.get("absent"):
            for field in ("attack", "magic_attack", "light", "strength"):
                test.assertEqual(f.value(after, source, field) - f.value(before, source, field), p.get(field, 0))
    elif op == "equipment_bonus":
        source = f.add(rule.source_card_id)
        weapon_source = "武器" in cards[rule.source_card_id]["tags"].split("|")
        if weapon_source:
            hero_id = p.get("hero_card_id") or f.find(lambda c: hero(c) and (
                not p.get("hero_tag") or any(t in c["tags"].split("|") for t in p["hero_tag"].split("|"))))
            owner, weapon = f.add(hero_id), source
        else:
            owner = source
            weapon = f.add(f.find(lambda c: "武器" in c["tags"].split("|")
                                 and (not p.get("weapon_tag") or p["weapon_tag"] in c["tags"].split("|"))
                                 and int(c["wiki_重量"] or 100) <= p.get("weight_max", 100)))
        f.tx.state["battle_context"]["equipped_weapon_by_hero"][owner] = weapon
        f.tx.state["battle_context"]["card_modifiers"] = {owner: {"strength": 100}}
        rank = max(1, p.get("minimum_rank", 0))
        target = {**cards["TS-0476"], "tags": p["target_tags_any"][0]} if p.get("target_tags_any") else None
        before, after = f.calc(rank, target, baseline=True), f.calc(rank, target)
        for field in ("attack", "magic_attack", "light"):
            expected = p.get(field, 0) * (int(cards[hero_id]["wiki_英雄等级"] or 0) if p.get("level_scale") and weapon_source else
                                         int(cards[rule.source_card_id]["wiki_英雄等级"] or 0) if p.get("level_scale") else 1)
            test.assertEqual(f.value(after, source, field) - f.value(before, source, field), expected, rule.id)
        if p.get("strength"):
            test.assertEqual(after["hero_strength"][owner] - before["hero_strength"][owner], p["strength"])
        f.tx.state["battle_context"]["equipped_weapon_by_hero"] = {}
        before, after = f.calc(rank, target, baseline=True), f.calc(rank, target)
        for field in ("attack", "magic_attack", "light"):
            test.assertEqual(f.value(after, source, field), f.value(before, source, field))
    elif op in ("hero_aura", "weapon_aura"):
        other = f.add("TS-0001")
        weapon = f.add("TS-0002")
        f.tx.state["battle_context"]["equipped_weapon_by_hero"][other] = weapon
        f.tx.state["battle_context"]["card_modifiers"] = {other: {"strength": 100}}
        before, after = f.calc(baseline=True), f.calc()
        recipient = weapon if op == "weapon_aura" else other
        for field in ("attack", "magic_attack", "light", "strength"):
            test.assertEqual(f.value(after, recipient, field) - f.value(before, recipient, field), p.get(field, 0))
    elif op in ("target_bonus", "ignore_darkness"):
        target = dict(cards["TS-0476"])
        if p.get("same_family"):
            f.add("TS-0663")
            target = dict(cards["TS-0664"])
        if p.get("tag"):
            target["tags"] = p["tag"]
        before, after = f.calc(3, target, baseline=True), f.calc(3, target)
        if op == "ignore_darkness":
            test.assertGreater(before["darkness_penalty"], 0)
            test.assertEqual(after["darkness_penalty"], 0)
        else:
            for field in ("attack", "magic_attack", "light"):
                test.assertEqual(f.value(after, source, field) - f.value(before, source, field), p.get(field, 0))
            target["tags"], target["effect_text"] = "动物", ""
            before, after = f.calc(3, target, baseline=True), f.calc(3, target)
            for field in ("attack", "magic_attack", "light"):
                test.assertEqual(f.value(after, source, field), f.value(before, source, field))
            if p.get("same_family"):
                target = cards["TS-0668"]
                before, after = f.calc(3, target, baseline=True), f.calc(3, target)
                test.assertEqual(f.value(after, source, "attack"), f.value(before, source, "attack"))
    elif op == "excess_light_magic":
        for _ in range(3):
            f.add("TS-0003")
        for rank in (0, 1, 2, 3, 4):
            before, after = f.calc(rank, baseline=True), f.calc(rank)
            test.assertEqual(after["magic_attack"] - before["magic_attack"], p["amount"] * max(0, before["light"] - rank))
    elif op == "card_aura":
        item = f.add("TS-0003")
        spell = f.add(f.find(lambda c: "法术" in c["tags"].split("|") and stat(c, "magic_attack") >= 1))
        blank_spell = f.add("TS-0267")
        before, after = f.calc(baseline=True), f.calc()
        for target in (item, spell):
            test.assertEqual(f.value(after, target, "magic_attack") - f.value(before, target, "magic_attack"), 1)
        test.assertEqual(f.value(after, blank_spell, "magic_attack"), f.value(before, blank_spell, "magic_attack"))
    elif op == "double_magic":
        f.tx.state["battle_context"]["modifiers"] = {"magic_attack": 5}
        before, after = f.calc(baseline=True), f.calc()
        test.assertEqual(after["magic_attack"], 2 * before["magic_attack"])
    elif op == "rank_restriction":
        for rank in (0, 1, 2, 3, 4):
            excluded = rank in p.get("forbidden", []) or ("allowed" in p and rank not in p["allowed"])
            test.assertEqual(source in f.calc(rank)["excluded_instance_ids"], excluded)
    elif op == "disease_strength":
        owner = f.add("TS-0302")
        before, after = f.calc(baseline=True), f.calc()
        test.assertEqual(after["hero_strength"][owner] - before["hero_strength"][owner], p["amount"])
        if p.get("single"):
            other = f.add("TS-0303")
            f.tx.state["battle_context"]["strength_penalty_assignments"] = {source: other}
            before, after = f.calc(baseline=True), f.calc()
            test.assertEqual(after["hero_strength"][owner], before["hero_strength"][owner])
            test.assertEqual(after["hero_strength"][other], before["hero_strength"][other] + p["amount"])
    elif op == "extra_equipment":
        is_weapon = "武器" in cards[rule.source_card_id]["tags"].split("|")
        owner = f.add("TS-0302" if is_weapon else rule.source_card_id)
        f.tx.state["battle_context"]["card_modifiers"] = {owner: {"strength": 100}}
        if is_weapon:
            equip_weapon(f.tx, owner, f.add(rule.source_card_id))
        for _ in range(min(3, p["capacity"]) - int(is_weapon)):
            equip_weapon(f.tx, owner, f.add("TS-0002"))
        if p["capacity"] == 2:
            with test.assertRaises(TurnError):
                equip_weapon(f.tx, owner, f.add("TS-0002"))
        test.assertEqual(len(f.calc()["equipped_pairs"]), min(3, p["capacity"]))
    elif op == "equipment_discount":
        weapon = f.add(rule.source_card_id)
        owner = f.add(f.find(lambda c: hero(c) and p["hero_tag"] in c["tags"].split("|")))
        desired = stat(cards[rule.source_card_id], "weight") - p["amount"]
        f.tx.state["battle_context"]["card_modifiers"] = {owner: {"strength": desired - stat(f.tx.card(owner), "strength")}}
        equip_weapon(f.tx, owner, weapon)
        test.assertIn([owner, weapon], f.calc()["equipped_pairs"])
    elif op == "target_restriction":
        target = cards[rule.source_card_id]
        context = f.tx.state["battle_context"]
        if "exclude_tags" in p or "strength_min" in p or p.get("equipped_only"):
            owner = f.add(f.find(lambda c: hero(c) and (not p.get("exclude_tags") or
                                any(tag in c["tags"].split("|") for tag in p["exclude_tags"]))))
            if "strength_min" in p:
                context["card_modifiers"] = {owner: {"strength": p["strength_min"] - 1 - stat(f.tx.card(owner), "strength")}}
            test.assertIn(owner, f.calc(target=target)["excluded_instance_ids"])
            if "strength_min" in p:
                context["card_modifiers"][owner]["strength"] += 1
                test.assertNotIn(owner, f.calc(target=target)["excluded_instance_ids"])
            if p.get("equipped_only"):
                weapon = f.add("TS-0002")
                context["card_modifiers"] = {owner: {"strength": 100}}
                context["equipped_weapon_by_hero"][owner] = weapon
                test.assertNotIn(owner, f.calc(target=target)["excluded_instance_ids"])
        elif p.get("immune_spells"):
            spell = f.add(f.find(lambda c: "法术" in c["tags"].split("|") and stat(c, "magic_attack") > 0))
            context["card_modifiers"] = {spell: {"light": 1}}
            trace = f.calc(target=target)
            test.assertEqual(f.value(trace, spell, "magic_attack"), 0)
            test.assertEqual(f.value(trace, spell, "light"), stat(f.tx.card(spell), "light") + 1)
        elif p.get("immune_unarmed"):
            owner = f.add("TS-0302")
            context["card_modifiers"] = {owner: {"light": 1}}
            trace = f.calc(target=target)
            test.assertEqual(f.value(trace, owner, "attack"), 0)
            test.assertEqual(f.value(trace, owner, "light"), 1)
        elif p.get("immune_weapon_tag"):
            owner = f.add("TS-0001")
            weapon = f.add(f.find(lambda c: p["immune_weapon_tag"] in c["tags"].split("|")))
            context["card_modifiers"] = {owner: {"strength": 100}}
            context["card_modifiers"][weapon] = {"light": 1}
            context["equipped_weapon_by_hero"][owner] = weapon
            trace = f.calc(target=target)
            test.assertEqual(f.value(trace, weapon, "attack"), 0)
            test.assertEqual(f.value(trace, weapon, "light"), stat(f.tx.card(weapon), "light") + 1)
        elif p.get("magic_required"):
            test.assertFalse(f.calc(target=target)["can_defeat"])
            context["modifiers"] = {"magic_attack": 1}
            test.assertTrue(f.calc(target=target)["can_defeat"])
        elif p.get("half_magic"):
            context["modifiers"] = {"magic_attack": 5}
            test.assertEqual(f.calc(target=target)["magic_attack"], 2)
        elif p.get("half_attack_no_magic") or p.get("half_attack_no_weapon"):
            context["modifiers"] = {"attack": 9}
            test.assertEqual(f.calc(target=target)["attack"], 4)
            if p.get("half_attack_no_magic"):
                context["modifiers"]["magic_attack"] = 1
                test.assertEqual(f.calc(target=target)["attack"], 9)
        elif "min_heroes" in p:
            for _ in range(p["min_heroes"] - 1):
                f.add("TS-0001")
            test.assertFalse(f.calc(target=target)["can_defeat"])
            f.add("TS-0001")
            test.assertTrue(f.calc(target=target)["can_defeat"])
        elif p.get("no_darkness"):
            test.assertFalse(f.calc(3, target)["can_attack"])
            context["modifiers"] = {"light": 100}
            test.assertTrue(f.calc(3, target)["can_attack"])
        elif p.get("forbid_used_spell"):
            test.assertTrue(f.calc(target=target)["can_attack"])
            context["used_card_tags"] = ["法术"]
            test.assertFalse(f.calc(target=target)["can_attack"])
        elif p.get("requires_used_spell_or_item"):
            test.assertFalse(f.calc(target=target)["can_defeat"])
            context["used_card_tags"] = ["物品"]
            test.assertTrue(f.calc(target=target)["can_defeat"])
        elif p.get("half_no_element"):
            context["modifiers"] = {"attack": 8, "magic_attack": 2}
            trace = f.calc(target=target)
            test.assertEqual(trace["attack"] + trace["magic_attack"], 5)
        else:
            test.fail(f"no fixture for restriction {rule.id}")
    elif op == "target_health":
        target = cards[rule.source_card_id]
        target_id = f.add(rule.source_card_id, "hall:main")
        if "hall_filter" in p:
            test.assertEqual(monster_health(f.tx, target, target_id=target_id), stat(target, "health"))
            same_family = f.find(lambda c: qualifies(c, p["hall_filter"]) and c["card_id"] != rule.source_card_id)
            f.add(same_family, "hall:main")
            f.add(same_family, "hall:second")
            f.add("TS-0476", "hall:second")
            test.assertEqual(monster_health(f.tx, target, target_id=target_id), stat(target, "health") + 4)
        elif p.get("metric") == "xp":
            for value in (0, 1, 9):
                f.tx.player["xp"] = value
                test.assertEqual(monster_health(f.tx, target), stat(target, "health") + value)
        elif "gold_below_double" in p:
            test.assertEqual(monster_health(f.tx, target), stat(target, "health") * 2)
            for _ in range(5):
                f.add("TS-0003")
            test.assertEqual(monster_health(f.tx, target), stat(target, "health"))
        elif "other_tag" in p:
            other = f.find(lambda c: p["other_tag"] in c["tags"].split("|") and c["card_id"] != rule.source_card_id)
            f.add(other)
            test.assertEqual(monster_health(f.tx, target), stat(target, "health") + p["multiplier"])
        else:
            pool = ("TS-0001", "TS-0003", "TS-0004", "TS-0226", "TS-0302", "TS-0303", "TS-0304", "TS-0714", "TS-0714")
            for card_id in pool:
                f.add(card_id)
            selected = [f.tx.card(item) for item in f.tx.zone("hand") if qualifies(f.tx.card(item), p.get("filter", {}))]
            metric = p.get("metric", "count")
            value = (sum(int(c["wiki_金币值"] or 0) for c in selected) if metric == "gold" else
                     sum(int(c["wiki_英雄等级"] or 0) for c in selected) if metric == "level_sum" else len(selected))
            if p.get("flat"):
                value = int(value >= p["minimum"])
            test.assertEqual(monster_health(f.tx, target), stat(target, "health") + value * p.get("multiplier", 1))
    elif op == "hall_movement_lock":
        from engine.effects.hall import can_move_monster, relocate
        blocker = f.add(rule.source_card_id, "hall:main")
        other = f.add("TS-0476", "hall:main")
        test.assertFalse(can_move_monster(f.tx, blocker))
        test.assertFalse(can_move_monster(f.tx, other))
        with test.assertRaises(TurnError):
            relocate(f.tx, other, "discard")
        f.tx.destroy_card(blocker)
        test.assertTrue(can_move_monster(f.tx, other))
    elif op == "hall_target_restriction":
        blocker = f.add(rule.source_card_id, "hall:main")
        other_id = f.find(lambda c: p["protected_tag"] in c["tags"].split("|") and c["card_id"] != rule.source_card_id)
        test.assertFalse(f.calc(target=cards[other_id])["can_attack"])
        test.assertTrue(f.calc(target=cards[rule.source_card_id])["can_attack"])
        test.assertTrue(f.calc(target=cards["TS-0476"])["can_attack"])
        f.tx.destroy_card(blocker)
        test.assertTrue(f.calc(target=cards[other_id])["can_attack"])
    elif op == "hall_aura":
        zone = "hall:main:rank0" if p.get("rank0_only") else "hall:main"
        f.add(rule.source_card_id, zone)
        owner = f.add("TS-0302")
        f.add("TS-0714")
        f.add("TS-0267")
        f.tx.state["battle_context"]["modifiers"] = {"attack": 3}
        before, after = f.calc(3, baseline=True), f.calc(3)
        test.assertEqual(after["light"] - before["light"], p.get("light", 0))
        test.assertEqual(after["attack"] - before["attack"], p.get("disease_attack", 0))
        test.assertEqual(after["hero_strength"][owner] - before["hero_strength"][owner],
                         p.get("strength", 0) - int(bool(p.get("strength_per_spell"))))
        if p.get("health"):
            target = cards["TS-0476"]
            test.assertEqual(monster_health(f.tx, target), stat(target, "health") + p["health"])
        if p.get("double_darkness"):
            test.assertEqual(after["light_requirement"], 6)
    elif op == "light_requirement":
        target = cards[rule.source_card_id]
        f.add("TS-0003")
        for rank in (0, 1, 2, 3):
            trace = f.calc(rank, target)
            required = p.get("ranks", {}).get(str(rank), rank)
            test.assertEqual(trace["darkness"], (required if p.get("irreducible") else max(0, required - 1)) if rank else 0)
    elif op == "immovable":
        target = f.add(rule.source_card_id, "hall:main")
        declare_battle_target(f.tx, target)
        test.assertTrue(any(target in pile for zone, pile in f.tx.state["zones"].items() if zone.startswith("hall:")))
    elif op == "economy":
        if p.get("monster_gold_zero"):
            f.tx.state["active_settings"] = [rule.source_card_id]
        elif p.get("hero_surcharge") or p.get("one_purchase"):
            f.add(rule.source_card_id, "hall:main")
        else:
            f.add(rule.source_card_id)
        if p.get("one_purchase"):
            test.assertTrue(purchase_allowed(f.tx))
            f.tx.state["turn_purchases"] = {f.player: 1}
            test.assertFalse(purchase_allowed(f.tx))
        elif p.get("monster_gold_zero"):
            card = cards[f.find(lambda c: c["subcategory"] == "怪物" and int(c["wiki_金币值"] or 0) > 0)]
            test.assertEqual(printed_gold(f.tx, card), 0)
        else:
            card = cards["TS-0302"]
            test.assertEqual(purchase_price(f.tx, card), int(card["wiki_购买价格"]) + p.get("all_surcharge", 0)
                             + p.get("hero_surcharge", 0) - p.get("hero_discount", 0))
    elif op == "scoring":
        source = f.add(rule.source_card_id)
        if "group" in p:
            for index in range(5):
                f.add(rule.source_card_id, f"player:{f.player}:{'draw' if index % 2 else 'discard'}")
            expected = min(6, p.get("maximum", 6))
        elif p.get("other_stones"):
            f.add("TS-0709")
            f.add("TS-0710", f"player:{f.player}:discard")
            expected = stat(cards[rule.source_card_id], "vp") + 4
        else:
            for opponent in f.tx.state["player_order"]:
                if opponent != f.player:
                    f.add("TS-0476", player=opponent)
            expected = stat(cards[rule.source_card_id], "vp") + 4
        result = score_game(f.tx.state, cards, f.ruleset)
        row = next(row for row in result["players"][f.player]["cards"] if row["instance_id"] == source)
        test.assertEqual(row["victory_points"], expected)
    else:
        test.fail(f"no behavior fixture for {rule.id}: {op}")


def verify_card(test, base, cards, ruleset, card_id):
    rules = [rule for rule in ruleset.mechanics if rule.source_card_id == card_id]
    test.assertTrue(rules)
    for rule in rules:
        with test.subTest(ability=rule.id, op=rule.op):
            verify_rule(test, base, cards, ruleset, rule)
