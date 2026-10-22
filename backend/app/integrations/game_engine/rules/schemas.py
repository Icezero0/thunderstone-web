"""The frozen classic setup request shape."""

from typing import TypedDict


class GroupCounts(TypedDict):
    village_groups: int
    hero_groups: int
    monster_groups: int


class GroupSelection(TypedDict):
    fixed_randomizer_ids: list[str]


class ExtraCardSelection(TypedDict):
    random_count: int
    fixed_card_ids: list[str]


class ExtraGroupSelection(TypedDict):
    random_count: int
    fixed_group_ids: list[str]


class ThunderstoneSelection(TypedDict):
    fixed_card_ids: list[str]


class DungeonFeatureSelection(TypedDict):
    mode: str


class InstanceMultipliers(TypedDict):
    village: int
    hero: int
    monster: int


class SetupSelection(TypedDict):
    village: GroupSelection
    hero: GroupSelection
    monster: GroupSelection
    dungeon_features: DungeonFeatureSelection
    guardian: ExtraCardSelection
    environment: ExtraCardSelection
    trap: ExtraGroupSelection
    treasure: ExtraGroupSelection
    thunderstone: ThunderstoneSelection


class RulesConfig(TypedDict):
    mode: str
    counts: GroupCounts
    selection: SetupSelection
    instance_multipliers: InstanceMultipliers
