"""Materialize a validated setup request into a game state."""

from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from typing import Any

from backend.tests.migration.reference.setup.rules import effective_copy_count, effective_group_counts
from backend.app.integrations.game_engine.setup.constants import (RULESET_VERSION, SPECIAL_DISEASE_RANDOMIZERS,
                                                 STARTER_CARDS)
from backend.app.integrations.game_engine.setup.exceptions import SetupChoiceRequired, SetupError
from backend.tests.migration.reference.setup.random import RNG_VERSION, SetupRng
from backend.tests.migration.reference.setup.state import validate_setup_state
from backend.tests.migration.reference.setup.hall import base_hall_capacity, hall_capacity


class _Builder:
    def __init__(self, request: dict, cards: dict, index: dict, panel: dict):
        self.request = request
        self.config = deepcopy(request["config"])
        self.cards = cards
        self.index = index
        self.panel = panel
        self.rng = SetupRng(request["rng_seed"])
        self.zones: dict[str, list[str]] = {}
        self.instances: dict[str, dict[str, Any]] = {}
        self.events: list[dict[str, Any]] = []
        self.selected = {kind: [] for kind in ("monster", "hero", "village")}
        self.features = {kind: [] for kind in ("guardian", "environment", "trap", "treasure")}
        self.group_by_id = {group["randomizer_id"]: group for group in index["groups"]}
        self.feature_by_id = {item["feature_id"]: item for item in index["dungeon_features"]}
        self.next_instance = 1

    def event(self, kind: str, **details: Any) -> None:
        self.events.append({"sequence": len(self.events) + 1, "kind": kind, **details})

    def pick(self, purpose: str, candidates: list[str]) -> str:
        if not candidates:
            raise SetupError(f"{purpose}: candidate pool exhausted")
        choice = candidates[self.rng.randbelow(len(candidates))]
        self.event("random_pick", purpose=purpose, candidates=list(candidates), chosen=choice)
        return choice

    def shuffle(self, purpose: str, items: list[str]) -> None:
        self.rng.shuffle(items)
        self.event("shuffle", purpose=purpose, order=list(items))

    def trim_for_random_environment(self, kind: str, selected: list[str],
                                    target: int) -> None:
        environment = self.features["environment"][0] if self.features["environment"] else None
        fixed = self.config["selection"]["environment"]["fixed_card_ids"]
        if len(selected) > target and (environment is None or environment in fixed):
            raise SetupError(f"{kind}: fixed groups exceed target")
        while len(selected) > target:
            removed = self.pick(f"{kind}_group_removed_by_environment", selected)
            selected.remove(removed)
            self.event("group_removed_by_environment", category=kind,
                       environment_id=environment, removed=removed, target=target)

    def create(self, card_id: str, zone: str, *, owner: str | None = None,
               origin: str, count: int | None = None) -> None:
        copies = int(self.cards[card_id]["initial_copy_count"]) if count is None else count
        if copies < 1:
            raise SetupError(f"{card_id}: initial_copy_count must be positive")
        pile = self.zones.setdefault(zone, [])
        for _ in range(copies):
            instance_id = f"CI-{self.next_instance:06d}"
            self.next_instance += 1
            self.instances[instance_id] = {
                "card_id": card_id, "owner_player_id": owner, "origin": origin, "flags": {},
            }
            pile.append(instance_id)

    def choose_feature(self, feature_id: str) -> None:
        feature = self.feature_by_id[feature_id]
        kind = feature["kind"]
        self.event("feature", feature_id=feature_id, action=kind)
        if kind in ("trap_group", "treasure_group"):
            destination = kind.removesuffix("_group")
            if feature_id not in self.features[destination]:
                self.features[destination].append(feature_id)
        elif kind == "draw_guardian":
            available = [card_id for card_id in self.index["other_pools"]["guardian"]
                         if card_id not in self.features["guardian"]]
            self.features["guardian"].append(self.pick("guardian", available))
        elif kind == "draw_environment":
            if self.features["environment"]:
                self.pending_feature_draws += 1
                self.event("feature_redirect", reason="environment_already_exists")
            else:
                self.features["environment"].append(self.pick(
                    "environment", self.index["other_pools"]["environment"]))
        elif kind == "draw_features":
            self.pending_feature_draws += feature["count"]
        else:
            raise SetupError(f"unhandled dungeon feature {feature_id}: {kind}")

    def draw_features(self, count: int = 1) -> None:
        self.pending_feature_draws = count
        while self.pending_feature_draws:
            self.pending_feature_draws -= 1
            feature_id = self.pick("dungeon_feature", self.feature_pool)
            self.feature_pool.remove(feature_id)
            self.choose_feature(feature_id)

    def choose_manual_features(self) -> None:
        selection = self.config["selection"]
        for kind in self.features:
            key = "fixed_group_ids" if kind in ("trap", "treasure") else "fixed_card_ids"
            chosen = list(selection[kind][key])
            for item in chosen:
                self.event("fixed_feature", category=kind, chosen=item)
            available = ([item["id"] for item in self.panel["dungeon_groups"][kind]]
                         if kind in ("trap", "treasure")
                         else self.index["other_pools"][kind])
            remaining = [item for item in available if item not in chosen]
            for _ in range(selection[kind]["random_count"]):
                item = self.pick(f"manual_{kind}", remaining)
                remaining.remove(item)
                chosen.append(item)
            self.features[kind] = chosen

    def choose_monsters(self) -> None:
        selection = self.config["selection"]
        self.selected["monster"] = list(selection["monster"]["fixed_randomizer_ids"])
        for item in self.selected["monster"]:
            self.event("fixed_group", category="monster", chosen=item)
        if selection["dungeon_features"]["mode"] == "manual":
            self.choose_manual_features()
        entry = self.index["dungeon_feature_entry"]["randomizer_id"]
        pool = [item for item in self.index["randomizer_pools"]["monster_or_feature"]
                if item != entry and item not in self.selected["monster"]]
        if selection["dungeon_features"]["mode"] == "classic_random":
            pool.extend([entry] * int(self.cards[entry]["initial_copy_count"]))
            self.feature_pool = [feature_id for feature_id in self.feature_by_id
                                 for _ in range(int(self.cards[feature_id]["initial_copy_count"]))]
        while True:
            environment = self.features["environment"][0] if self.features["environment"] else None
            target = effective_group_counts(self.config["counts"], environment)["monster"]
            self.trim_for_random_environment("monster", self.selected["monster"], target)
            if len(self.selected["monster"]) >= target:
                break
            drawn = self.pick("monster_or_feature", pool)
            pool.remove(drawn)
            if drawn == entry:
                self.draw_features(self.index["dungeon_feature_entry"]["draw_feature_count"])
            else:
                self.selected["monster"].append(drawn)
                self.event("group_selected", category="monster", chosen=drawn)
        self.event("monster_target", target=target, environment_id=environment)

    def choose_groups(self, kind: str) -> None:
        target = effective_group_counts(
            self.config["counts"], self.features["environment"][0]
            if self.features["environment"] else None)[kind]
        selected = list(self.config["selection"][kind]["fixed_randomizer_ids"])
        for item in selected:
            self.event("fixed_group", category=kind, chosen=item)
        self.trim_for_random_environment(kind, selected, target)
        available = [item for item in self.index["randomizer_pools"][kind]
                     if item not in selected]
        while len(selected) < target:
            item = self.pick(f"{kind}_group", available)
            available.remove(item)
            selected.append(item)
            self.event("group_selected", category=kind, chosen=item)
        self.selected[kind] = selected

    def choose_stones(self) -> list[str]:
        environment = self.features["environment"][0] if self.features["environment"] else None
        all_stones = self.index["other_pools"]["thunderstone"]
        if environment == "TS-0199":
            chosen = list(all_stones)
            self.event("scenario_stones", scenario="banishing_ritual", chosen=chosen)
            return chosen
        target = 2 if environment == "TS-0198" else 1
        chosen = list(self.config["selection"]["thunderstone"]["fixed_card_ids"])
        remaining = [item for item in all_stones if item not in chosen]
        for _ in range(target - len(chosen)):
            item = self.pick("thunderstone", remaining)
            remaining.remove(item)
            chosen.append(item)
        self.event("stones_selected", chosen=list(chosen))
        return chosen

    def check_targets(self) -> None:
        environment = self.features["environment"][0] if self.features["environment"] else None
        targets = effective_group_counts(self.config["counts"], environment)
        for kind, target in targets.items():
            if len(self.selected[kind]) != target:
                raise SetupError(f"{kind}: selected {len(self.selected[kind])}, expected {target}")

    def materialize_supplies(self) -> None:
        for randomizer_id in self.selected["village"]:
            for card_id in self.group_by_id[randomizer_id]["members"]:
                card = self.cards[card_id]
                self.create(card_id, f"village_supply:{card_id}", origin=randomizer_id,
                            count=effective_copy_count(card, self.config))
        for randomizer_id in self.selected["hero"]:
            members = self.group_by_id[randomizer_id]["members"]
            ordered = sorted(members, key=lambda card_id: (
                int(self.cards[card_id]["wiki_英雄等级"]), card_id))
            for card_id in ordered:
                card = self.cards[card_id]
                self.create(card_id, f"hero_supply:{randomizer_id}", origin=randomizer_id,
                            count=effective_copy_count(card, self.config))
        if "TS-0197" in self.features["environment"]:
            destroyed = self.zones.setdefault("destroyed", [])
            for zone in list(self.zones):
                if zone.startswith("village_supply:"):
                    removed = self.zones[zone][:2]
                    del self.zones[zone][:2]
                    destroyed.extend(removed)
                    self.event("stormhold_supply_destroyed", zone=zone,
                               instance_ids=removed)

    def dungeon_allocation(self) -> dict[str, str]:
        group_ids = self.selected["monster"]
        feature_ids = (self.features["guardian"] + self.features["trap"]
                       + self.features["treasure"])
        choices = self.request.get("scenario_choices", {})
        if not isinstance(choices, dict):
            raise SetupError("scenario_choices must be an object")
        choice = choices.get("two_dungeons")
        prompt = {"kind": "two_dungeons", "group_ids": group_ids,
                  "feature_ids": feature_ids, "group_a_count": 2}
        if not isinstance(choice, dict) or "group_a_ids" not in choice or (
                feature_ids and "group_a_feature_ids" not in choice):
            raise SetupChoiceRequired(prompt)
        first = choice["group_a_ids"]
        first_features = choice.get("group_a_feature_ids", [])
        if (not isinstance(first, list) or len(first) != 2 or len(set(first)) != 2
                or any(item not in group_ids for item in first)
                or not isinstance(first_features, list)
                or len(set(first_features)) != len(first_features)
                or any(item not in feature_ids for item in first_features)):
            raise SetupError("invalid two_dungeons allocation")
        self.event("scenario_allocation", group_a_ids=first,
                   group_a_feature_ids=first_features)
        return {item: "a" if item in first else "b" for item in group_ids} | {
            item: "a" if item in first_features else "b" for item in feature_ids}

    def add_dungeon_members(self, zone: str, group_id: str, *, monster: bool) -> None:
        members = (self.group_by_id[group_id]["members"] if monster
                   else self.feature_by_id[group_id]["members"])
        for card_id in members:
            card = self.cards[card_id]
            from backend.tests.migration.reference.setup.reserves import MARKERS
            marker = next((item for item in members if item in MARKERS), None)
            destination = "monster_reserve:" + marker if monster and marker and card_id != marker else zone
            self.create(card_id, destination, origin=group_id,
                        count=effective_copy_count(card, self.config) if monster else None)

    def bury_guardians(self, zone: str, guardian_ids: list[str]) -> None:
        if not guardian_ids:
            return
        pile = self.zones[zone]
        if len(pile) < 10:
            raise SetupError(f"{zone}: fewer than 10 cards before guardian placement")
        bottom = pile[-10:]
        del pile[-10:]
        for guardian_id in guardian_ids:
            self.create(guardian_id, zone, origin="guardian_feature")
        guardians = pile[len(pile) - sum(int(self.cards[item]["initial_copy_count"])
                                        for item in guardian_ids):]
        del pile[-len(guardians):]
        bottom.extend(guardians)
        self.shuffle(f"{zone}_guardians", bottom)
        pile.extend(bottom)

    def insert_stone_near_bottom(self, zone: str, stone_id: str, depth: int) -> None:
        pile = self.zones[zone]
        if len(pile) < depth:
            raise SetupError(f"{zone}: fewer than {depth} cards before stone placement")
        bottom = pile[-depth:]
        del pile[-depth:]
        self.create(stone_id, zone, origin="thunderstone", count=1)
        bottom.append(pile.pop())
        self.shuffle(f"{zone}_stone_bottom", bottom)
        pile.extend(bottom)

    def materialize_dungeon(self, stones: list[str]) -> list[str]:
        environment = self.features["environment"][0] if self.features["environment"] else None
        allocation = self.dungeon_allocation() if environment == "TS-0198" else None
        deck_names = ["dungeon:a", "dungeon:b"] if allocation else ["dungeon:main"]
        for zone in deck_names:
            self.zones[zone] = []
        for group_id in self.selected["monster"]:
            zone = f"dungeon:{allocation[group_id]}" if allocation else "dungeon:main"
            self.add_dungeon_members(zone, group_id, monster=True)
        for kind in ("trap", "treasure"):
            for group_id in self.features[kind]:
                zone = f"dungeon:{allocation[group_id]}" if allocation else "dungeon:main"
                self.add_dungeon_members(zone, group_id, monster=False)
        for zone in deck_names:
            self.shuffle(f"{zone}_base", self.zones[zone])
            if environment == "TS-0199":
                for stone in stones:
                    self.create(stone, zone, origin="banishing_ritual", count=1)
                self.shuffle("banishing_ritual_stones", self.zones[zone])
            guardians = [item for item in self.features["guardian"]
                         if not allocation or f"dungeon:{allocation[item]}" == zone]
            if environment == "TS-0199":
                guardians = [item for item in guardians if item != "TS-0683"]
            self.bury_guardians(zone, guardians)
        if environment == "TS-0198":
            for zone, stone in zip(deck_names, stones, strict=True):
                self.insert_stone_near_bottom(zone, stone, 5)
        elif environment == "TS-0199":
            zone = deck_names[0]
            self.create("TS-0683", zone, origin="banishing_ritual", count=1)
        else:
            self.insert_stone_near_bottom(deck_names[0], stones[0], 10)
        return deck_names

    def fill_hall(self, deck_zone: str) -> None:
        hall_zone = deck_zone.replace("dungeon:", "hall:")
        hall = self.zones.setdefault(hall_zone, [])
        deck = self.zones[deck_zone]
        base = base_hall_capacity(self.features["environment"])
        target = base
        postponed = 0
        skipped_stones: list[str] = []
        while len(hall) < target:
            if not deck or postponed >= len(deck):
                if target > base and len(hall) >= base:
                    self.event("setup_hall_deck_exhausted", hall_zone=hall_zone, missing=target - len(hall))
                    break
                raise SetupError(f"{deck_zone}: cannot fill initial hall with {target} cards")
            instance_id = deck.pop(0)
            from backend.tests.migration.reference.setup.reserves import replace_marker
            replacement = replace_marker(self.zones, self.instances, instance_id, hall_zone)
            if replacement != instance_id:
                self.event("monster_marker_replaced", marker_instance_id=instance_id, instance_id=replacement, at_setup=True)
            instance_id = replacement
            if instance_id is None:
                continue
            category = self.cards[self.instances[instance_id]["card_id"]]["subcategory"]
            if category in ("陷阱", "宝藏"):
                deck.append(instance_id)
                postponed += 1
                self.event("setup_hall_postponed", instance_id=instance_id)
                continue
            if category in ("雷霆之石", "守护者"):
                skipped_stones.append(instance_id)
                self.event("setup_hall_stone_skipped" if category == "雷霆之石" else "setup_hall_guardian_skipped", deck_zone=deck_zone,
                           instance_id=instance_id)
                continue
            if category != "怪物":
                raise SetupError(f"{deck_zone}: invalid initial hall card {instance_id}")
            hall.append(instance_id)
            target = hall_capacity((self.instances[item]["card_id"] for item in hall), self.features["environment"])
            postponed = 0
        # Only hall monsters were removed; skipped stones precede unvisited cards.
        deck[:0] = skipped_stones
        self.event("hall_filled_at_setup", hall_zone=hall_zone, instance_ids=list(hall))

    def materialize_players(self) -> None:
        for player_id in self.request["player_ids"]:
            draw = f"player:{player_id}:draw"
            hand = f"player:{player_id}:hand"
            self.zones[draw] = []
            self.zones[hand] = []
            self.zones[f"player:{player_id}:discard"] = []
            self.zones[f"player:{player_id}:control"] = []
            for card_id, count in STARTER_CARDS.items():
                self.create(card_id, draw, owner=player_id, origin="starter_deck", count=count)
            self.shuffle(f"{player_id}_starter", self.zones[draw])
            self.zones[hand].extend(self.zones[draw][:6])
            del self.zones[draw][:6]
            self.event("initial_hand_drawn", player_id=player_id,
                       instance_ids=list(self.zones[hand]))

    def build(self) -> dict:
        self.choose_monsters()
        self.choose_groups("hero")
        self.choose_groups("village")
        self.check_targets()
        stones = self.choose_stones()
        self.materialize_supplies()
        decks = self.materialize_dungeon(stones)
        for deck in decks:
            self.fill_hall(deck)
        for environment in self.features["environment"]:
            self.create(environment, "settings", origin="environment", count=1)
        self.materialize_players()
        first = self.request.get("first_player", {"mode": "random"})
        first_id = (self.pick("first_player", self.request["player_ids"])
                    if first["mode"] == "random" else first["player_id"])
        disease_mode = ("special" if SPECIAL_DISEASE_RANDOMIZERS.intersection(
            self.selected["monster"] + self.selected["hero"]) else "normal")
        disease_ids = [item for item in self.index["other_pools"]["disease"]
                       if ("特殊" in self.cards[item]["tags"].split("|"))
                       == (disease_mode == "special")]
        if not disease_ids:
            raise SetupError(f"no disease cards for {disease_mode} mode")
        disease_weights = {item: int(self.cards[item]["initial_copy_count"])
                           for item in disease_ids}
        if any(weight < 1 for weight in disease_weights.values()):
            raise SetupError(f"invalid disease weights for {disease_mode} mode")
        self.event("disease_mode", mode=disease_mode, card_ids=disease_ids,
                   weights=disease_weights)
        self.event("setup_complete", first_player_id=first_id)
        config_json = json.dumps(self.config, ensure_ascii=False, sort_keys=True,
                                 separators=(",", ":"))
        state = {
            "match_id": self.request["match_id"], "game_version": 1,
            "catalog_version": self.panel["catalog_hash"], "ruleset_version": RULESET_VERSION,
            "frozen_config_id": hashlib.sha256(config_json.encode("utf-8")).hexdigest(),
            "frozen_config": self.config, "player_order": list(self.request["player_ids"]),
            "first_player_id": first_id, "active_player_id": first_id,
            "turn_number": 1, "round_number": 1, "phase": "PLAYING",
            "subphase": "TURN_START", "timing_window": "TURN_START_BEFORE",
            "chosen_action": None,
            "players": {player_id: {"xp": 0, "temporary_gold": 0, "purchases_remaining": 1}
                        for player_id in self.request["player_ids"]},
            "zones": self.zones, "instances": self.instances,
            "selected_groups": self.selected, "selected_features": self.features,
            "selected_thunderstones": stones,
            "supply_rules": {"basic_card_ids": list(STARTER_CARDS),
                             "basic_infinite": True, "disease_mode": disease_mode,
                             "disease_card_ids": disease_ids,
                             "disease_weights": disease_weights,
                             "disease_infinite": True},
            "active_settings": list(self.features["environment"]),
            "continuous_effects": [], "registered_triggers": [], "scheduled_effects": [],
            "battle_context": None, "pending_choice": None, "resolution_frames": [],
            "end_condition": None,
            "rng_state": {"algorithm": RNG_VERSION, "seed": self.rng.seed,
                          "counter": self.rng.counter},
            "next_instance_sequence": self.next_instance,
            "next_event_sequence": len(self.events) + 1,
        }
        validate_setup_state(state, self.cards)
        return {"state": state, "events": self.events}


