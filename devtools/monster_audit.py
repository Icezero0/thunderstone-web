"""Read-only monster review projection from actual executable rules and hooks."""

import csv
from dataclasses import asdict
import hashlib
import json
import re

from devtools.effect_explanation import ACTIONS, EVENTS, STATS, Explainer
from engine.catalog.repository import load_catalog
from engine.effects.combat import stat
from engine.effects.compiler import load_ruleset
from engine.paths import PROJECT_ROOT

SCOPES = {"hand_passive": "手牌 · 自动生效", "hand_active": "手牌 · 主动发动", "battle": "与此怪物战斗时",
          "hall": "此牌位于大厅时", "breach": "突破 · 进入阶层 1", "on_defeat": "此怪物被击败后",
          "scoring": "游戏结束计分", "on_enter": "进入大厅时", "setup": "组局及大厅结构", "unknown": "尚无运行绑定"}


def _csv(name):
    with (PROJECT_ROOT / "data/effects" / name).open(encoding="utf-8-sig", newline="") as source:
        return {row["ability_id"]: row for row in csv.DictReader(source)}


def _leaf(text):
    return {"text": text, "children": []}


def _compiled_scope(ability):
    if ability.source_zone in ("active_hand", "active_control"):
        if ability.kind == "activated":
            actions = "／".join(ACTIONS[action] for action in ability.actions)
            return ["hand_active"], f"此牌在当前玩家手牌中，选择{actions}行动时，可主动发动。"
        return ["hand_passive"], "此牌在当前玩家手牌中，" + EVENTS[ability.event] + "触发。"
    if ability.source_zone == "battle_target":
        return ["battle"], "此牌是当前战斗目标时，" + EVENTS[ability.event] + "触发。"
    if ability.source_zone == "hall":
        return ["hall"], "此牌在地下城大厅中，" + EVENTS[ability.event] + "触发。"
    if ability.source_zone == "event_source":
        scope = {"BREACH": "breach", "HALL_REVEALED": "on_enter", "MONSTER_DEFEATED": "on_defeat"}.get(ability.event, "unknown")
        return [scope], EVENTS.get(ability.event, ability.event) + "触发，来源为本次事件对应的这张怪物牌。"
    return ["unknown"], f"来源区域 {ability.source_zone}；事件 {ability.event}。"


def _mechanic_scope(mechanic):
    op = mechanic.op
    if op in ("response", "hero_aura", "target_bonus"):
        return ["hand_passive"], "此怪物牌在玩家手牌中时提供此规则。"
    if op == "scoring":
        return ["scoring"], "游戏结束时，按此牌的所有者拥有的相关卡牌计算。"
    if op == "replace_monster":
        return ["on_enter"], "此标记进入大厅时，用对应储备牌堆的下一张怪物替换。"
    if op == "economy":
        # economy_rules combines both hand_rules and hall_rules. Surface that
        # behavior rather than inferring a hall-only rule from the printed text.
        return ["hall", "hand_passive"], "当前实现同时检查大厅和当前玩家手牌中的此牌，再约束村庄购买。"
    if op in ("hall_aura", "dungeon_deck_lock", "hall_movement_lock", "hall_target_restriction", "immovable"):
        return ["hall"], "此怪物位于地下城大厅时，此持续规则生效。"
    return ["battle"], "此怪物是当前战斗目标时，在战斗计算中应用此持续规则。"


def monster_audit_data():
    snapshot = load_catalog()
    cards = snapshot.cards
    ruleset = load_ruleset(cards)
    draft_path = PROJECT_ROOT / "docs/游戏引擎设计参考/thunderstone_card_rules_v0.3.2_engine.json"
    # Only identity/source_line comes from the draft. Its trigger/AST is not
    # evidence for how the current engine actually executes an effect.
    draft = {card["id"]: card for card in json.loads(draft_path.read_text(encoding="utf-8-sig"))["cards"]}
    compiled = {ability.id: ability for ability in ruleset.abilities}
    mechanics = {rule.id: rule for rule in ruleset.mechanics}
    printed = _csv("printed-contracts.csv")
    targets = _csv("target-contracts.csv")
    system = json.loads((PROJECT_ROOT / "data/effects/system-contracts.json").read_text(encoding="utf-8"))
    coverage = _csv("coverage.csv")
    result = []
    for card_id, card in sorted(cards.items(), key=lambda pair: int(pair[1].get("catalog_order") or 0)):
        if card["slot_kind"] != "front" or card["subcategory"] != "怪物":
            continue
        entries = []
        known_lines = set()
        definitions = {a["id"]: a["source_line"] for a in draft.get(card_id, {}).get("abilities", [])}
        for source in (*ruleset.abilities, *ruleset.mechanics):
            if source.source_card_id == card_id:
                definitions.setdefault(source.id, getattr(source, "source_line", ""))
        for ability_id, line in definitions.items():
            known_lines.add(line)
            explain = Explainer(cards)
            warnings = []
            if ability_id in compiled:
                ability = compiled[ability_id]
                binding = asdict(ability)
                scopes, timing = _compiled_scope(ability)
                usage = {"once_per_turn": "每个来源实例每回合限一次", "repeatable": "满足条件时可重复发动",
                         "once_per_event": "每次对应事件触发一次"}.get(ability.usage, ability.usage)
                steps = [_leaf("发动条件：" + explain.condition(c)) for c in ability.conditions]
                steps.append(explain.node(ability.body))
                implementation = "可执行 DSL"
            elif ability_id in mechanics:
                mechanic = mechanics[ability_id]
                binding = asdict(mechanic)
                scopes, timing = _mechanic_scope(mechanic)
                usage = "持续检查／专用规则入口"
                steps = explain.mechanic(mechanic)
                implementation = "持续机制绑定"
                if mechanic.op == "economy":
                    warnings.append("当前商店规则同时读取大厅和手牌中的此牌；请重点核对其是否应仅在大厅生效。")
            elif ability_id in printed:
                p = printed[ability_id]
                binding = {"hook": "printed_hand_baseline", "stat": p["stat"], "line_amount": int(p["amount"]),
                           "runtime_card_total": stat(card, p["stat"]), "source_zone": "active_hand"}
                scopes, timing, usage = ["hand_passive"], "此怪物在当前玩家手牌中，进行战斗数值计算时自动计入。", "自动持续生效"
                steps = [_leaf(f"此手牌的{STATS[p['stat']]}词条数值为 {int(p['amount']):+d}；当前卡牌该项基础合计为 {stat(card, p['stat']):+d}。")]
                implementation = "手牌基础数值入口"
            elif ability_id in targets:
                rule = targets[ability_id]["rule"]
                binding = {"hook": "combat_target_text_rule", "rule": rule, "source_zone": "battle_target"}
                scopes, timing, usage = ["battle"], "此怪物是当前战斗目标时应用。", "战斗计算时持续检查"
                text = {"immune_magic_attack": "对抗此怪物时，队伍魔法攻击按 0 计算。",
                        "magic_attack_only": "对抗此怪物时，队伍普通攻击按 0 计算，只保留魔法攻击。"}.get(rule)
                steps = [_leaf(text or explain.unknown("目标规则", rule))]
                implementation = "共用战斗规则入口"
            elif ability_id in system:
                hook = system[ability_id]
                binding = {"hook": hook}
                scopes, timing, usage = ["setup", "hall"], "组局和游戏期间由共享大厅容量规则处理。", "结构规则，按当前大厅状态重算"
                steps = [_leaf("此树精在大厅时增加一个临时阶层并补牌，开局也适用；树精离开时撤去对应临时阶层。")
                         if hook == "extra_hall_rank" else _leaf(explain.unknown("系统规则", hook))]
                implementation = "共用系统规则入口"
            else:
                binding = None
                scopes, timing, usage = ["unknown"], "未找到可执行绑定。", "待补充"
                steps = [_leaf("此词条没有找到当前运行规则，不能根据原始草案假定其生效范围。")]
                implementation = "缺少绑定"
                warnings.append("没有当前运行绑定。")
            explicit = bool(re.match(r"^(?:战斗|突破|全局|地下城|村庄|凯旋|战利品)(?:\s*[/／]\s*(?:村庄|地下城))?[：:]", line)) or line.startswith("游戏结束")
            if not explicit:
                warnings.append("原文没有明确的时点前缀，请对照卡面左侧符号核对当前生效范围。")
            if explain.unsupported:
                warnings.append("部分运行节点尚未翻译，请展开原始定义。")
            fingerprint = hashlib.sha256(json.dumps({"line": line, "binding": binding, "scopes": scopes},
                                                     ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
            entries.append({"ability_id": ability_id, "source_line": line, "scope_ids": scopes,
                            "scope_labels": [SCOPES[scope] for scope in scopes], "timing": timing, "usage": usage,
                            "implementation": implementation, "steps": steps, "binding": binding,
                            "binding_status": coverage.get(ability_id, {}).get("status", "MISSING"),
                            "needs_symbol_check": not explicit, "warnings": warnings,
                            "untranslated": sorted(explain.unsupported), "fingerprint": fingerprint})
        unmapped = [line for line in card["effect_text"].splitlines() if line.strip() and line not in known_lines]
        result.append({"card_id": card_id, "name": card["name"], "english_name": card["wiki_英文卡名"],
                       "fingerprint": hashlib.sha256((card_id + card["effect_text"] + "".join(a["fingerprint"] for a in entries)).encode("utf-8")).hexdigest(),
                       "source_card_id": card["source_card_id"], "tags": list(filter(None, card["tags"].split("|"))),
                       "image_url": "/cards/" + card_id + ".png", "effect_text": card["effect_text"],
                       "stats": {label: card[field] for label, field in (
                           ("生命值", "wiki_生命值"), ("金币值", "wiki_金币值"), ("光照", "wiki_光照"),
                           ("击败经验", "defeat_xp_reward"), ("胜利点", "wiki_胜利点"))},
                       "abilities": entries, "unmapped_lines": unmapped})
    return {"schema_version": "thunderstone.monster-audit/1", "catalog_version": snapshot.setup_index["cards_csv_sha256"],
            "effects_version": ruleset.version, "scope_options": SCOPES, "cards": result,
            "summary": {"monsters": len(result), "with_effects": sum(bool(c["abilities"]) for c in result),
                        "abilities": sum(len(c["abilities"]) for c in result),
                        "symbol_checks": sum(a["needs_symbol_check"] for c in result for a in c["abilities"])}}
