"""Validate and evaluate classic rule configuration."""

from __future__ import annotations

from typing import Mapping

from backend.app.integrations.game_engine.rules.constants import ENVIRONMENT_SETUP_RULES
from backend.app.integrations.game_engine.rules.schemas import RulesConfig


def effective_group_counts(counts: Mapping[str, int], environment_id: str | None) -> dict[str, int]:
    """Apply a fixed environment's printed setup changes to group targets."""
    result = {kind: counts[f"{kind}_groups"] for kind in ("village", "hero", "monster")}
    rule = ENVIRONMENT_SETUP_RULES.get(environment_id or "", {})
    for kind, delta in rule.get("count_delta", {}).items():
        result[kind] += delta
    result.update(rule.get("count_override", {}))
    return result


def effective_copy_count(card: Mapping[str, str], config: RulesConfig) -> int:
    """Apply the rule draft's category/hero-level multiplier to a CSV card row."""
    base = int(card["initial_copy_count"])
    multipliers = config["instance_multipliers"]
    if card["card_type"] == "村庄牌":
        return base * multipliers["village"]
    if card["card_type"] == "英雄牌":
        return base * multipliers["hero"]
    if card["subcategory"] == "怪物":
        return base * multipliers["monster"]
    return base


def validate_rules_config(payload: object, catalog: dict) -> list[dict[str, str]]:
    """Validate the input shape and simple catalog constraints only.

    Full game setup, feature interactions and card-ability checks come later.
    """
    errors: list[dict[str, str]] = []

    def add(path: str, message: str) -> None:
        errors.append({"path": path, "message": message})

    if not isinstance(payload, dict):
        return [{"path": "$", "message": "配置必须是 JSON 对象"}]
    if payload.get("mode") != "classic":
        add("mode", "目前只支持 classic 模式")
    counts = payload.get("counts")
    counts = counts if isinstance(counts, dict) else {}
    selection = payload.get("selection")
    selection = selection if isinstance(selection, dict) else {}
    feature_selection = selection.get("dungeon_features")
    feature_selection = feature_selection if isinstance(feature_selection, dict) else {}
    feature_mode = feature_selection.get("mode")
    if feature_mode not in ("classic_random", "manual"):
        add("selection.dungeon_features.mode", "请选择经典随机或手动地下城特征")
    base_counts = {}
    fixed_group_counts = {}
    for kind in ("village", "hero", "monster"):
        count_path = f"counts.{kind}_groups"
        target = counts.get(f"{kind}_groups")
        if type(target) is not int or target < 0:
            add(count_path, "组数必须是非负整数")
            target = None
        elif target > len(catalog["groups"][kind]):
            add(count_path, "目标组数超过卡牌目录中的可选组数")
        if target is not None:
            base_counts[f"{kind}_groups"] = target
        group_data = selection.get(kind)
        group_data = group_data if isinstance(group_data, dict) else {}
        fixed = group_data.get("fixed_randomizer_ids")
        available = {item["id"] for item in catalog["groups"][kind]}
        if not isinstance(fixed, list) or any(not isinstance(item, str) for item in fixed):
            add(f"selection.{kind}.fixed_randomizer_ids", "固定组必须是卡牌 ID 列表")
            fixed = []
        elif len(fixed) != len(set(fixed)):
            add(f"selection.{kind}.fixed_randomizer_ids", "固定组不能重复")
        for card_id in fixed:
            if card_id not in available:
                add(f"selection.{kind}.fixed_randomizer_ids", f"{card_id} 不是有效的{kind}设置牌")
        fixed_group_counts[kind] = len(fixed)

    for field in ("guardian", "environment"):
        item = selection.get(field)
        item = item if isinstance(item, dict) else {}
        available = {card["id"] for card in catalog["dungeon_cards"][field]}
        fixed = item.get("fixed_card_ids")
        if (not isinstance(fixed, list)
                or any(not isinstance(card_id, str) or card_id not in available
                       for card_id in fixed)
                or len(fixed) != len(set(map(str, fixed)))):
            add(f"selection.{field}.fixed_card_ids", "请选择有效且不重复的实际卡牌")
            fixed = []
        random_count = item.get("random_count")
        if type(random_count) is not int or random_count < 0:
            add(f"selection.{field}.random_count", "随机种数必须是非负整数")
        elif random_count + len(fixed) > len(available):
            add(f"selection.{field}.random_count", "随机种数超过未固定的候选卡牌数量")
        if field == "environment" and type(random_count) is int:
            if random_count + len(fixed) > 1:
                add("selection.environment", "环境牌最多选择一种")
    for field in ("trap", "treasure"):
        item = selection.get(field)
        item = item if isinstance(item, dict) else {}
        available = {group["id"] for group in catalog["dungeon_groups"][field]}
        fixed = item.get("fixed_group_ids")
        if (not isinstance(fixed, list)
                or any(not isinstance(group_id, str) or group_id not in available
                       for group_id in fixed)
                or len(fixed) != len(set(map(str, fixed)))):
            add(f"selection.{field}.fixed_group_ids", "请选择有效且不重复的牌组")
            fixed = []
        random_count = item.get("random_count")
        if type(random_count) is not int or random_count < 0:
            add(f"selection.{field}.random_count", "随机组数必须是非负整数")
        elif random_count + len(fixed) > len(available):
            add(f"selection.{field}.random_count", "随机组数超过未固定的候选牌组数量")
    stone = selection.get("thunderstone")
    stone = stone if isinstance(stone, dict) else {}
    fixed_stones = stone.get("fixed_card_ids")
    all_stones = {item["id"] for item in catalog["thunderstones"]}
    if (not isinstance(fixed_stones, list)
            or any(not isinstance(card_id, str) or card_id not in all_stones
                   for card_id in fixed_stones)
            or len(fixed_stones) != len(set(map(str, fixed_stones)))):
        add("selection.thunderstone.fixed_card_ids", "请选择有效且不重复的雷霆之石")
        fixed_stones = []
    if feature_mode == "classic_random":
        for field, key in (("guardian", "fixed_card_ids"),
                           ("environment", "fixed_card_ids"),
                           ("trap", "fixed_group_ids"),
                           ("treasure", "fixed_group_ids")):
            choice = selection.get(field)
            if isinstance(choice, dict) and (choice.get("random_count") != 0
                                             or choice.get(key) != []):
                add(f"selection.{field}", "经典随机模式下不能同时指定手动特征")
    if len(base_counts) == 3:
        environment = selection.get("environment")
        fixed_environments = environment.get("fixed_card_ids") if isinstance(environment, dict) else None
        environment_id = (fixed_environments[0] if feature_mode == "manual"
                          and isinstance(fixed_environments, list)
                          and len(fixed_environments) == 1
                          and isinstance(fixed_environments[0], str) else None)
        environment_rule = ENVIRONMENT_SETUP_RULES.get(environment_id or "", {})
        effective = effective_group_counts(base_counts, environment_id)
        for kind, target in effective.items():
            if not 0 <= target <= len(catalog["groups"][kind]):
                add(f"counts.{kind}_groups", "环境调整后的组数超出可用范围")
            if fixed_group_counts[kind] > target:
                add(f"counts.{kind}_groups", "固定组数超过环境调整后的目标组数")
        random_environment_possible = feature_mode == "classic_random" or (
            feature_mode == "manual" and isinstance(environment, dict)
            and environment.get("random_count") == 1)
        if random_environment_possible:
            for kind in ("village", "hero", "monster"):
                for card in catalog["dungeon_cards"]["environment"]:
                    random_target = effective_group_counts(base_counts, card["id"])[kind]
                    if not 0 <= random_target <= len(catalog["groups"][kind]):
                        add(f"counts.{kind}_groups", f"随机抽到{card['name']}时，组数超出可用范围")
                        break
        stone_target = environment_rule.get("thunderstone_target", 1)
        if len(fixed_stones) > stone_target:
            add("selection.thunderstone.fixed_card_ids", "固定雷霆之石超过本场景允许数量")
        if environment_id == "TS-0199":
            if set(fixed_stones) != all_stones:
                add("selection.thunderstone.fixed_card_ids", "放逐仪式必须选入全部 7 张雷霆之石")
            guardian = selection.get("guardian")
            if isinstance(guardian, dict):
                fixed_guardians = guardian.get("fixed_card_ids")
                if isinstance(fixed_guardians, list) and "TS-0683" not in fixed_guardians:
                    add("selection.guardian.fixed_card_ids", "放逐仪式必须加入末日之心")
    multipliers = payload.get("instance_multipliers")
    multipliers = multipliers if isinstance(multipliers, dict) else {}
    for category in ("village", "hero", "monster"):
        value = multipliers.get(category)
        if type(value) is not int or not 1 <= value <= 5:
            add(f"instance_multipliers.{category}", "倍率必须是 1～5 的整数")
    return errors
