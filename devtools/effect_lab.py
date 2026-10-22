"""Reproducible, in-memory effect interpreter scenarios for the local preview."""

from __future__ import annotations

from copy import deepcopy
import csv
from functools import lru_cache
from typing import Callable

from backend.app.integrations.game_engine.catalog.repository import load_catalog
from backend.app.integrations.game_engine.effects.compiler import compile_ruleset, load_ruleset
from backend.app.integrations.game_engine.setup import start_game
from backend.app.integrations.game_engine.paths import PROJECT_ROOT
from backend.app.integrations.game_engine.turn import TurnError, apply_command, legal_commands


CASES = (
    {"id": "hero-copy", "title": "迪因惑法师：民兵复制能力", "kind": "真实卡牌",
     "focus": "保留民兵属性、替换原攻击；复制的主动效果暂停选择后继续"},
    {"id": "borrowed-weapon", "title": "托林角斗士：借用武器遭到摧毁", "kind": "真实卡牌",
     "focus": "对手弃武器、借用并装备；战后正常摧毁，不再归还"},
    {"id": "trap-immunity", "title": "拦路匪：只免疫自己承受的陷阱", "kind": "真实卡牌",
     "focus": "补牌触发龙之牙；对手展示拦路匪，保护自身牌堆，当前玩家仍受影响"},
    {"id": "spell-reuse", "title": "蓝火法杖：再次使用法术", "kind": "真实卡牌",
     "focus": "法师装备法杖，选择重用战斗狂暴；回合末摧毁法术"},
    {"id": "attached-disease", "title": "神圣教团：疾病附着与获得替代", "kind": "真实卡牌",
     "focus": "疾病放在怪物下；下次开战前接收同一实例，由疫病破除者摧毁"},
    {"id": "extra-turn", "title": "乌布里克的臂甲：额外回合", "kind": "真实卡牌",
     "focus": "击败低分怪物后牺牲宝藏，先进行额外回合，再轮到下位玩家"},
    {"id": "deferred-destruction", "title": "盛宴：战后摧毁改为弃牌", "kind": "真实卡牌",
     "focus": "英雄取得回合保护，仍贡献本次攻击；结算后弃牌，回合结束清除保护"},
    {"id": "destroy-cost-replacement", "title": "守护者之刃：替代后仍支付费用", "kind": "真实卡牌",
     "focus": "立即摧毁费用可改为弃牌；支付后可击败残酷幽影，英雄不再贡献攻击"},
    {"id": "doomheart-loss", "title": "末日之心：失败只淘汰攻击者", "kind": "真实卡牌",
     "focus": "放逐仪式允许地下城行动；失败淘汰当前玩家，其余玩家继续"},
    {"id": "doomheart-win", "title": "末日之心：雷霆之石 +6 与终局", "kind": "真实卡牌",
     "focus": "手中每张雷霆之石获得魔法攻击 +6；击败末日之心后立即计分"},
    {"id": "xp-choice", "title": "灵魂之火：选择消耗的经验值", "kind": "真实卡牌",
     "focus": "按当前经验提供 0～5 的合法选项；拒绝越界值，选择后恢复执行"},
    {"id": "deck-reorder", "title": "托利斯灵媒：查看并重排地下城牌顶", "kind": "真实卡牌",
     "focus": "揭示牌顶三张，选择一张放在最前；原牌堆其余顺序保留"},
    {"id": "trophy-versus-battle", "title": "无缚者：战斗效果与手牌战利品", "kind": "真实卡牌",
     "focus": "大厅怪物只触发战斗疾病；两张手牌战利品提供魔法攻击 +2"},
    {"id": "refill-trap-resume", "title": "驱逐：补牌陷阱中断后继续", "kind": "真实卡牌",
     "focus": "返回怪物 → 陷阱选英雄 → 原能力选费用 → 抽牌"},
    {"id": "disease-choice", "title": "先知：摧毁疾病后抽牌", "kind": "真实卡牌",
     "focus": "select → cost_gate → destroy → draw；多候选暂停与继续"},
    {"id": "monster-count", "title": "先知：按手牌怪物数抽牌", "kind": "真实卡牌",
     "focus": "count 查询、乘法表达式与动态抽牌"},
    {"id": "thornwood-tie", "title": "荆木：最高价格并列", "kind": "真实卡牌",
     "focus": "ACTION_EXITED 触发、max_by、选择后继续回合清理"},
    {"id": "thornwood-unique", "title": "荆木：唯一最高价格", "kind": "真实卡牌",
     "focus": "单候选自动选择并完成回合"},
    {"id": "condition-schedule", "title": "条件、循环与延迟效果", "kind": "合成 DSL",
     "focus": "all/not/exists/compare、if、for_each、repeat、schedule"},
    {"id": "condition-false", "title": "条件不满足与 else 分支", "kind": "合成 DSL",
     "focus": "any 为假时不可发动；if 进入 else；add 表达式"},
    {"id": "cost-rollback", "title": "费用不足时整条命令回滚", "kind": "合成 DSL",
     "focus": "spend_xp 失败、无收益、输入状态不变"},
    {"id": "cost-gain-discard", "title": "支付费用、获得牌并弃牌", "kind": "合成 DSL",
     "focus": "cost_gate、spend_xp、gain_card、select、discard"},
    {"id": "battle-modifiers", "title": "战斗临时修正", "kind": "合成 DSL",
     "focus": "mod_attack、mod_light 与战斗结算的计算轨迹"},
)


@lru_cache(maxsize=1)
def _catalog():
    return load_catalog()


def card_coverage() -> dict:
    """Read generated coverage contracts, never report them as a live test run."""
    with (PROJECT_ROOT / "data/effects/card-coverage.csv").open(encoding="utf-8-sig", newline="") as source:
        rows = list(csv.DictReader(source))
    cards = [{**row, "ability_count": int(row["ability_count"]), "covered_count": int(row["covered_count"]),
              "test_name": "test_effect_" + row["card_id"].replace("-", "_")} for row in rows]
    return {"total": len(cards), "complete": sum(row["status"] == "COMPLETE" for row in cards), "cards": cards}


def _config(environment: str | None = None) -> dict:
    settings = {
        "mode": "classic",
        "counts": {"village_groups": 8, "hero_groups": 4, "monster_groups": 3},
        "selection": {
            "village": {"fixed_randomizer_ids": []},
            "hero": {"fixed_randomizer_ids": []},
            "monster": {"fixed_randomizer_ids": []},
            "dungeon_features": {"mode": "manual"},
            "guardian": {"random_count": 0, "fixed_card_ids": []},
            "environment": {"random_count": 0,
                            "fixed_card_ids": [environment] if environment else []},
            "trap": {"random_count": 0, "fixed_group_ids": []},
            "treasure": {"random_count": 0, "fixed_group_ids": []},
            "thunderstone": {"fixed_card_ids": []},
        },
        "instance_multipliers": {"village": 1, "hero": 1, "monster": 1},
    }
    if environment == "TS-0199":
        settings["selection"]["guardian"]["fixed_card_ids"] = ["TS-0683"]
        settings["selection"]["thunderstone"]["fixed_card_ids"] = [f"TS-{number:04d}" for number in range(707, 714)]
    return settings


def _synthetic(ability_id: str, body: dict, *, action: str = "village",
               conditions: list[dict] | None = None) -> dict:
    return {"schema_version": "thunderstone.effects/1", "abilities": [{
        "id": ability_id, "source_card_id": "TS-0001", "kind": "activated",
        "actions": [action], "source_zone": "active_hand",
        "usage": "once_per_turn", "conditions": conditions or [], "body": body,
    }]}


FLOW_RULE = _synthetic(
    "TS-0001-A99", {"op": "sequence", "children": [
        {"op": "if", "condition": {"compare": {
            "left": {"count": {"zone": "active_hand", "card_id": "TS-0001"}},
            "op": "ge", "right": 1}},
         "then": {"op": "gain_xp", "amount": 1},
         "else": {"op": "gain_xp", "amount": 9}},
        {"op": "for_each", "query": {"zone": "active_hand", "card_id": "TS-0001"},
         "bind": "militia", "body": {"op": "gain_xp", "amount": 1}},
        {"op": "repeat", "times": 2, "limit": 2,
         "body": {"op": "mod_gold", "amount": 1}},
        {"op": "schedule", "event": "TURN_WILL_END",
         "body": {"op": "gain_xp", "amount": 3}},
    ]}, conditions=[{"all": [
        {"exists": {"zone": "active_hand", "card_id": "TS-0001"}},
        {"not": {"setting_active": "TS-0199"}},
    ]}])

COST_RULE = _synthetic("TS-0001-A96", {"op": "sequence", "children": [
    {"op": "cost_gate", "cost": {"op": "spend_xp", "amount": 2},
     "then": {"op": "gain_card", "card_id": "TS-0003"}},
    {"op": "select", "query": {"zone": "active_hand", "card_id": "TS-0002"},
     "bind": "dagger", "then": {"op": "discard", "target": {"var": "dagger"}}},
]})

BATTLE_RULE = _synthetic("TS-0001-A97", {"op": "sequence", "children": [
    {"op": "mod_attack", "amount": 2},
    {"op": "mod_light", "amount": 1},
]}, action="dungeon")

FALSE_RULE = {"schema_version": "thunderstone.effects/1", "abilities": [
    _synthetic("TS-0001-A94", {"op": "gain_xp", "amount": 9}, conditions=[
        {"any": [
            {"exists": {"zone": "active_hand", "card_id": "TS-0714"}},
            {"exists": {"zone": "active_hand", "subcategory": "怪物"}},
        ]},
    ])["abilities"][0],
    _synthetic("TS-0001-A95", {"op": "if", "condition": {"any": [
        {"exists": {"zone": "active_hand", "card_id": "TS-0714"}},
        {"exists": {"zone": "active_hand", "subcategory": "怪物"}},
    ]}, "then": {"op": "gain_xp", "amount": 9},
        "else": {"op": "gain_xp", "amount": {"add": [1, 2]}}})["abilities"][0],
]}


def _label(state: dict, cards: dict, instance_id: str) -> dict:
    instance = state["instances"].get(instance_id)
    if instance is None:
        return {"instance_id": instance_id, "card_id": None, "name": "已移除"}
    card_id = instance["card_id"]
    card = cards[card_id]
    name = next((card[key] for key in ("name_zh", "card_name", "name", "title")
                 if card.get(key)), card_id)
    return {"instance_id": instance_id, "card_id": card_id, "name": name}


def _view(state: dict, cards: dict) -> dict:
    player = state["active_player_id"]
    zones = state["zones"]
    choice = state.get("pending_choice")
    supply = []
    for zone, pile in sorted(zones.items()):
        if zone.startswith("village_supply:") and pile:
            supply.append({"zone": zone, "count": len(pile),
                           "top": _label(state, cards, pile[0])})
    choice_view = None
    if choice:
        if choice["kind"] == "effect_purchase":
            candidates = [{"card_id": row["card_id"], "instance_id": "buy:" + row["card_id"],
                           "name": cards[row["card_id"]]["name"]} for row in choice["options"]]
        elif choice["kind"] == "effect_order":
            candidates = [{"card_id": None, "instance_id": row["effect_id"], "name": row["ability_id"]} for row in choice["effects"]]
        elif choice["kind"] == "effect_value":
            candidates = [{"card_id": None, "instance_id": str(value), "name": str(value)} for value in choice["options"]]
        elif choice["kind"] == "effect_upgrade":
            candidates = [{"card_id": row["target_card_id"], "instance_id": row["source_instance_id"],
                           "name": cards[row["target_card_id"]]["name"]} for row in choice["options"]]
        elif choice["kind"] in ("disease_replacement", "effect_response"):
            candidates = ([{"card_id": None, "instance_id": value, "name": value} for value in choice["options"]]
                          if choice["stage"] == "recipient" else [
                              _label(state, cards, value["source_instance_id"]) for value in choice["options"]])
        elif choice["kind"] == "effect_reuse":
            candidates = [{"card_id": value.split("-A")[0], "instance_id": value, "name": value}
                          for value in choice["options"]]
        else:
            candidates = [_label(state, cards, item) for item in choice["candidate_instance_ids"]]
        choice_view = {"kind": choice["kind"], "ability_id": choice.get("ability_id", choice.get("event")),
                       "player_id": choice["player_id"], "candidates": candidates}
    return {
        "version": state["game_version"], "turn": state["turn_number"],
        "player": player, "phase": state["phase"], "subphase": state["subphase"],
        "action": state["chosen_action"],
        "xp": state["players"][player]["xp"],
        "gold": state["players"][player]["temporary_gold"],
        "battle_modifiers": deepcopy((state.get("battle_context") or {}).get("modifiers", {})),
        "hand": [_label(state, cards, item) for item in zones[f"player:{player}:hand"]],
        "draw_count": len(zones[f"player:{player}:draw"]),
        "discard": [_label(state, cards, item) for item in zones[f"player:{player}:discard"]],
        "destroyed": [_label(state, cards, item) for item in zones.get("destroyed", [])],
        "supply": supply,
        "halls": [{"zone": zone, "cards": [_label(state, cards, item) for item in pile]}
                  for zone, pile in sorted(zones.items()) if zone.startswith("hall:")],
        "dungeons": [{"zone": zone, "count": len(pile), "top": [_label(state, cards, item) for item in pile[:5]]}
                     for zone, pile in sorted(zones.items()) if zone.startswith("dungeon:")],
        "players": [{"player_id": item, "eliminated": state["players"][item].get("eliminated", False),
                     "hand": [_label(state, cards, card) for card in zones[f"player:{item}:hand"]],
                     "discard": [_label(state, cards, card) for card in zones[f"player:{item}:discard"]],
                     "draw_count": len(zones[f"player:{item}:draw"])}
                    for item in state["player_order"]],
        "hero_statuses": [{**_label(state, cards, item),
                           "buffs": deepcopy(instance["flags"].get("turn_buffs", [])),
                           "after_battle": bool(instance["flags"].get("pending_after_battle_destruction")),
                           "turn_end": bool(instance["flags"].get("pending_turn_end_destruction"))}
                          for item, instance in state["instances"].items()
                          if any(instance["flags"].get(key) for key in (
                              "turn_buffs", "pending_after_battle_destruction", "pending_turn_end_destruction"))],
        "end_condition": deepcopy(state.get("end_condition")),
        "result": deepcopy(state.get("result")),
        "choice": choice_view,
        "scheduled": [{"ability_id": item["ability_id"], "event": item["event"]}
                      for item in state.get("scheduled_effects", [])],
        "ability_uses": deepcopy(state.get("ability_uses", {})),
        "copied_heroes": [{**_label(state, cards, item), **deepcopy(record)}
                          for item, record in state.get("copied_heroes", {}).items()],
        "borrowed_cards": [{**_label(state, cards, item), **deepcopy(record)}
                           for item, record in state.get("borrowed_cards", {}).items()],
        "attachments": [{"anchor": _label(state, cards, anchor),
                         "cards": [{**_label(state, cards, record["instance_id"]), "kind": record["kind"]}
                                   for record in records]}
                        for anchor, records in state.get("attachments", {}).items()],
        "continuous_effects": deepcopy(state.get("continuous_effects", [])),
        "listeners": deepcopy(state.get("registered_triggers", [])),
    }


class _Run:
    def __init__(self, case_id: str, seed: str, *, environment: str | None = None,
                 custom_rule: dict | None = None):
        self.meta = next(item for item in CASES if item["id"] == case_id)
        self.snapshot = _catalog()
        self.cards = self.snapshot.cards
        self.rule_json = custom_rule
        self.effects = (compile_ruleset(custom_rule, self.cards) if custom_rule
                        else load_ruleset(self.cards))
        request = {"match_id": f"effect-lab-{case_id}",
                   "player_ids": ["alice", "bob"], "rng_seed": seed,
                   "config": _config(environment)}
        self.state = start_game(request, snapshot=self.snapshot)["state"]
        self.state["effects_version"] = self.effects.version
        self.steps: list[dict] = []
        self.checks: list[dict] = []
        self.seed = seed
        self.setup_config = request["config"]

    @property
    def player(self) -> str:
        return self.state["active_player_id"]

    def fixture(self, description: str, change: Callable[[dict], None]) -> None:
        before = _view(self.state, self.cards)
        change(self.state)
        self.steps.append({"type": "fixture", "title": description,
                           "before": before, "after": _view(self.state, self.cards),
                           "events": []})

    def add_hand(self, card_id: str) -> str:
        instance_id = f"CI-{self.state['next_instance_sequence']:06d}"
        self.state["next_instance_sequence"] += 1
        self.state["instances"][instance_id] = {
            "card_id": card_id, "owner_player_id": self.player,
            "origin": "effect_lab_fixture", "flags": {},
        }
        self.state["zones"][f"player:{self.player}:hand"].append(instance_id)
        return instance_id

    def first_hand(self, card_id: str) -> str:
        return next(item for item in self.state["zones"][f"player:{self.player}:hand"]
                    if self.state["instances"][item]["card_id"] == card_id)

    def clear_zone(self, zone: str) -> None:
        pile = self.state["zones"][zone]
        for item in pile:
            self.state["instances"][item]["owner_player_id"] = None
        self.state["zones"].setdefault("destroyed", []).extend(pile)
        pile.clear()

    def add_to_zone(self, card_id: str, zone: str) -> str:
        item = self.add_hand(card_id)
        self.state["zones"][f"player:{self.player}:hand"].remove(item)
        self.state["zones"].setdefault(zone, []).append(item)
        self.state["instances"][item]["owner_player_id"] = zone.split(":")[1] if zone.startswith("player:") else None
        return item

    def do(self, kind: str, **arguments: object) -> dict:
        before = _view(self.state, self.cards)
        actor = self.state["pending_choice"]["player_id"] if self.state["pending_choice"] else self.player
        command = {"type": kind, "player_id": actor,
                   "expected_version": self.state["game_version"], **arguments}
        result = apply_command(self.state, command, snapshot=self.snapshot,
                               effects=self.effects, trace_effects=True)
        self.state = result["state"]
        self.steps.append({"type": "command", "title": kind,
                           "command": command, "before": before,
                           "after": _view(self.state, self.cards),
                           "events": result["events"],
                           "effect_trace": result["effect_trace"],
                           "legal_commands": result["legal_commands"]})
        return result

    def reject(self, kind: str, **arguments: object) -> str:
        before = deepcopy(self.state)
        command = {"type": kind, "player_id": self.player,
                   "expected_version": self.state["game_version"], **arguments}
        try:
            apply_command(self.state, command, snapshot=self.snapshot,
                          effects=self.effects)
        except TurnError as error:
            self.steps.append({"type": "rejected", "title": kind,
                               "command": command, "before": _view(before, self.cards),
                               "after": _view(self.state, self.cards),
                               "events": [], "error": str(error)})
            self.check("被拒绝的命令未改变输入状态", self.state == before)
            return str(error)
        self.check("预期被拒绝的命令被接受", False)
        raise AssertionError(f"{kind} unexpectedly succeeded")

    def check(self, title: str, passed: bool, detail: str = "") -> None:
        self.checks.append({"title": title, "passed": bool(passed), "detail": detail})

    def output(self) -> dict:
        return {"case": self.meta, "seed": self.seed, "config": self.setup_config,
                "ruleset_version": self.effects.version,
                "abilities": ([item for item in self.rule_json["abilities"]]
                              if self.rule_json else [
                                  {"id": item.id, "source_card_id": item.source_card_id,
                                   "kind": item.kind, "conditions": item.conditions,
                                   "body": item.body}
                                  for item in self.effects.abilities
                                  if item.id in {event.get("ability_id")
                                                 for step in self.steps
                                                 for event in step["events"]}]),
                "initial": self.steps[0]["before"] if self.steps else _view(self.state, self.cards),
                "steps": self.steps, "checks": self.checks,
                "passed": bool(self.checks) and all(item["passed"] for item in self.checks)}


def _choice(run: _Run, choice_index: int) -> str:
    candidates = run.state["pending_choice"]["candidate_instance_ids"]
    if not 0 <= choice_index < len(candidates):
        raise ValueError(f"choice_index must be in 0..{len(candidates) - 1}")
    selected = candidates[choice_index]
    run.steps[-1]["replay_choice_count"] = len(candidates)
    run.do("ResolveChoice", instance_id=selected)
    return selected


def run_case(case_id: str, *, choice_index: int = 0) -> dict:
    """Run one fresh fixture through public setup/turn APIs; never persist state."""
    if case_id not in {item["id"] for item in CASES}:
        raise KeyError(case_id)
    if not isinstance(choice_index, int) or choice_index < 0:
        raise ValueError("choice_index must be nonnegative")

    from devtools.advanced_effect_cases import ADVANCED_IDS, run_advanced
    if case_id in ADVANCED_IDS:
        return run_advanced(case_id, _Run, _choice, choice_index).output()

    if case_id in ("deferred-destruction", "destroy-cost-replacement"):
        run = _Run(case_id, "lab-destruction-replacement")
        ids = {}
        actor = run.player
        def arrange(state):
            for zone in list(state["zones"]):
                if zone.startswith(("hall:", "dungeon:")) or zone.startswith(f"player:{actor}:"):
                    run.clear_zone(zone)
            for _ in range(8):
                run.add_to_zone("TS-0003", f"player:{actor}:draw")
            ids["hero"] = run.add_hand("TS-0001" if case_id == "deferred-destruction" else "TS-0302")
            ids["source"] = run.add_hand("TS-0295" if case_id == "deferred-destruction" else "TS-0247")
            if case_id == "deferred-destruction":
                ids["other_hero"] = run.add_hand("TS-0001")
            ids["target"] = run.add_to_zone("TS-0486" if case_id == "deferred-destruction" else "TS-0471", "hall:main")
            if case_id == "destroy-cost-replacement":
                # Leave real refill cards ahead of a retreating monster. An
                # empty dungeon would draw that same monster straight back.
                for _ in range(3):
                    run.add_to_zone("TS-0510", "dungeon:main")
        run.fixture("放入测试英雄、保护来源和目标怪物，准备后续手牌；费用案例另准备三张补厅怪物", arrange)
        run.do("ChooseAction", action="dungeon")
        if case_id == "deferred-destruction":
            run.do("ActivateAbility", ability_id="TS-0295-A01", source_instance_id=ids["source"])
            run.check("盛宴给两名英雄添加回合保护", all(
                run.state["instances"][ids[key]]["flags"].get("turn_buffs") for key in ("hero", "other_hero")))
            run.do("DeclareBattleTarget", target_instance_id=ids["target"])
            selected = _choice(run, choice_index)
            result = run.steps[-1]
            battle = next(e for e in result["events"] if e["kind"] == "battle_resolved")
            replacement = next(e for e in result["events"] if e["kind"] == "card_destruction_replaced")
            run.check("先计算战斗，再用弃牌替代摧毁", replacement["sequence"] > battle["sequence"]
                      and selected in [row["instance_id"] for row in battle["calculation"]["components"]])
            run.check("被选择英雄保留所有权并进入弃牌堆", selected in run.state["zones"][f"player:{actor}:discard"]
                      and run.state["instances"][selected]["owner_player_id"] == actor)
        else:
            def strength_fixture(state):
                state["battle_context"]["card_modifiers"] = {ids["hero"]: {"strength": 100}}
                state["battle_context"]["modifiers"] = {"attack": 100}
            run.fixture("测试夹具提供足够力量和攻击，用于单独验证支付费用", strength_fixture)
            run.do("EquipWeapon", hero_instance_id=ids["hero"], weapon_instance_id=ids["source"])
            run.do("DeclareBattleTarget", target_instance_id=ids["target"])
            options = run.state["pending_choice"]["options"]
            if choice_index >= len(options):
                raise ValueError("choice_index must be in 0..1")
            run.steps[-1]["replay_choice_count"] = len(options)
            value = options[choice_index]
            xp_before = run.state["players"][actor]["xp"]
            result = run.do("ResolveValueChoice", value=value)
            battle = next(e for e in result["events"] if e["kind"] == "battle_resolved")
            if value == "pay":
                replacement = next(e for e in result["events"] if e["kind"] == "card_destruction_replaced")
                run.check("弃牌仍算付费，发生在战斗计算之前", replacement["sequence"] < battle["sequence"]
                          and battle["outcome"] == "win")
                run.check("付费英雄不再贡献攻击", ids["hero"] not in [row["instance_id"] for row in battle["calculation"]["components"]])
            else:
                run.check("已宣告战斗后拒绝支付，战斗判负", battle["outcome"] == "loss")
                run.check("战败怪物离开大厅，放回地下城牌堆底", run.state["zones"]["dungeon:main"][-1] == ids["target"]
                          and all(ids["target"] not in pile for zone, pile in run.state["zones"].items() if zone.startswith("hall:")))
                run.check("怪物不归玩家所有，也不进入玩家弃牌堆", run.state["instances"][ids["target"]]["owner_player_id"] is None
                          and all(ids["target"] not in pile for zone, pile in run.state["zones"].items() if zone.startswith("player:")))
                run.check("战败不获得经验或击败奖励", run.state["players"][actor]["xp"] == xp_before
                          and not any(e["kind"] == "monster_defeated" for e in result["events"]))
        run.check("回合结束后保护不残留", all(not instance["flags"].get("turn_buffs")
                  for instance in run.state["instances"].values()))
    elif case_id in ("doomheart-loss", "doomheart-win"):
        run = _Run(case_id, "lab-doomheart", environment="TS-0199")
        ids = {}
        actor = run.player
        def arrange(state):
            for zone in list(state["zones"]):
                if zone.startswith(("hall:", "dungeon:")) or zone == f"player:{actor}:hand":
                    run.clear_zone(zone)
            run.add_to_zone("TS-0476", "hall:main")
            ids["heart"] = run.add_to_zone("TS-0683", "hall:main")
            run.add_to_zone("TS-0476", "hall:main")
            run.add_hand("TS-0003")
            if case_id == "doomheart-win":
                for number in range(707, 712):
                    run.add_hand(f"TS-{number:04d}")
        run.fixture("末日之心位于阶层 2；胜利案例额外在手牌放入五张雷霆之石", arrange)
        run.do("ChooseAction", action="dungeon")
        result = run.do("DeclareBattleTarget", target_instance_id=ids["heart"])
        if case_id == "doomheart-loss":
            run.check("只淘汰攻击者", run.state["players"][actor].get("eliminated") is True
                      and sum(player.get("eliminated", False) for player in run.state["players"].values()) == 1)
            run.check("其余玩家继续，尚未计分", run.state["phase"] == "PLAYING" and "result" not in run.state)
            survivor = run.player
            run.do("ChooseAction", action="rest")
            run.do("FinishRest")
            run.check("回合顺序跳过已淘汰者", run.player == survivor and run.player != actor)
        else:
            battle = next(event for event in result["events"] if event["kind"] == "battle_resolved")
            run.check("五张雷霆之石各获得魔法攻击 +6", sum(event["amount"] == 6 for event in result["events"]
                      if event["kind"] == "effect_card_modified" and event["stat"] == "magic_attack") == 5)
            run.check("击败末日之心立即结束", battle["outcome"] == "win" and run.state["phase"] == "SETTLING")
            run.check("末日之心归攻击者所有并计入得分", run.state["instances"][ids["heart"]]["owner_player_id"] == actor
                      and any(row["card_id"] == "TS-0683" and row["victory_points"] == 15
                              for row in run.state["result"]["players"][actor]["cards"]))
    elif case_id == "xp-choice":
        run = _Run(case_id, "lab-xp-choice")
        source = []
        def arrange(state):
            run.clear_zone(f"player:{run.player}:hand")
            source.append(run.add_hand("TS-0273"))
            state["players"][run.player]["xp"] = 5
        run.fixture("手牌放入灵魂之火，当前玩家持有 5 经验", arrange)
        run.do("ChooseAction", action="dungeon")
        run.do("ActivateAbility", ability_id="TS-0273-A02", source_instance_id=source[0])
        options = run.state["pending_choice"]["options"]
        if choice_index >= len(options):
            raise ValueError("choice_index must be in 0..5")
        run.check("可选消耗值为 0～5", options == list(range(6)))
        run.reject("ResolveValueChoice", value=6)
        run.steps[-1]["replay_choice_count"] = len(options)
        value = options[choice_index]
        run.do("ResolveValueChoice", value=value)
        run.check("支付的经验与魔法攻击增量相等", run.state["players"][run.player]["xp"] == 5 - value
                  and run.state["battle_context"]["modifiers"]["magic_attack"] == value)
    elif case_id == "deck-reorder":
        run = _Run(case_id, "lab-deck-reorder")
        ids = {}
        def arrange(state):
            for zone in list(state["zones"]):
                if zone.startswith(("hall:", "dungeon:")) or zone == f"player:{run.player}:hand":
                    run.clear_zone(zone)
            ids["source"] = run.add_hand("TS-0453")
            for _ in range(3):
                run.add_to_zone("TS-0476", "hall:main")
            ids["deck"] = [run.add_to_zone(card, "dungeon:main") for card in ("TS-0476", "TS-0477", "TS-0478", "TS-0479")]
        run.fixture("地下城牌堆顶放置四张可识别的怪物牌", arrange)
        run.do("ChooseAction", action="dungeon")
        run.do("ActivateAbility", ability_id="TS-0453-A02", source_instance_id=ids["source"])
        candidates = run.state["pending_choice"]["candidate_instance_ids"]
        if choice_index >= len(candidates):
            raise ValueError("choice_index must be in 0..2")
        run.reject("ResolveCardOrder", instance_ids=[candidates[0]] * 3)
        run.steps[-1]["replay_choice_count"] = len(candidates)
        first = candidates[choice_index]
        ordered = [first, *(item for item in candidates if item != first)]
        run.do("ResolveCardOrder", instance_ids=ordered)
        run.check("三张牌按选择顺序返回牌顶，第四张保持原位", run.state["zones"]["dungeon:main"] == [*ordered, ids["deck"][3]])
        run.check("揭示区域与待选状态均已清理", run.state["pending_choice"] is None
                  and not any(zone.startswith("revealed:") for zone in run.state["zones"]))
    elif case_id == "trophy-versus-battle":
        run = _Run(case_id, "lab-trophy-versus-battle")
        ids = {}
        def arrange(state):
            for zone in list(state["zones"]):
                if zone.startswith(("hall:", "dungeon:")) or zone == f"player:{run.player}:hand":
                    run.clear_zone(zone)
            ids["hand"] = [run.add_hand("TS-0582") for _ in range(2)]
            ids["target"] = run.add_to_zone("TS-0582", "hall:main")
        run.fixture("手牌放两张无缚者，大厅放另一张无缚者", arrange)
        run.do("ChooseAction", action="dungeon")
        result = run.do("DeclareBattleTarget", target_instance_id=ids["target"])
        battle = next(e for e in result["events"] if e["kind"] == "battle_resolved")
        run.check("两张手牌战利品提供魔法攻击 +2", battle["calculation"]["magic_attack"] == 2)
        run.check("大厅怪物不提供魔法攻击", ids["target"] not in {c["instance_id"] for c in battle["calculation"]["components"]})
        run.check("只有被攻击的怪物触发一次疾病", sum(e["kind"] == "disease_taken_from_supply" for e in result["events"]) == 1)
    elif case_id == "refill-trap-resume":
        run = _Run(case_id, "lab-refill-trap")
        ids = {}
        def arrange(state):
            for zone in list(state["zones"]):
                if zone.startswith(("hall:", "dungeon:")) or zone.startswith("player:"):
                    run.clear_zone(zone)
            ids["source"] = run.add_hand("TS-0268")
            ids["hero"] = run.add_hand("TS-0001")
            run.add_hand("TS-0302")
            ids["cost"] = run.add_hand("TS-0003")
            for _ in range(3):
                run.add_to_zone("TS-0476", "hall:main")
                run.add_to_zone("TS-0001", f"player:{run.player}:draw")
            ids["trap"] = run.add_to_zone("TS-0688", "dungeon:main")
            for _ in range(4):
                run.add_to_zone("TS-0476", "dungeon:main")
        run.fixture("大厅三只怪物，牌堆顶为斩首陷阱，手牌含驱逐与两名英雄", arrange)
        run.do("ChooseAction", action="dungeon")
        run.do("ActivateAbility", ability_id="TS-0268-A01", source_instance_id=ids["source"])
        _choice(run, choice_index)
        run.check("补牌时先暂停到陷阱的选择", run.state["pending_choice"]["ability_id"] == "TS-0688-A01")
        run.do("ResolveChoice", instance_id=ids["hero"])
        run.check("陷阱完成后恢复原能力的费用选择", run.state["pending_choice"]["ability_id"] == "TS-0268-A01")
        result = run.do("ResolveChoice", instance_id=ids["cost"])
        run.check("原能力继续抽牌", any(e["kind"] == "effect_draw" and e["ability_id"] == "TS-0268-A01" for e in result["events"]))
        run.check("陷阱和费用牌都已正确处理", {ids["trap"], ids["cost"]} <= set(run.state["zones"]["destroyed"]))
        run.check("可继续地下城准备，没有残留选择", run.state["pending_choice"] is None and run.state["subphase"] == "DUNGEON_PREPARE")
    elif case_id == "disease-choice":
        run = _Run(case_id, "effect-lab-disease")
        added = []
        def arrange(state: dict) -> None:
            added.append(run.add_hand("TS-0428"))
            added.extend((run.add_hand("TS-0714"), run.add_hand("TS-0714")))
        run.fixture("在手牌加入先知和两张普通疾病", arrange)
        run.do("ChooseAction", action="village")
        run.do("ActivateAbility", ability_id="TS-0428-A02",
               source_instance_id=added[0])
        pending = run.state["pending_choice"]
        run.check("两张疾病均为可选目标", set(pending["candidate_instance_ids"]) == set(added[1:]))
        hand_before = len(run.state["zones"][f"player:{run.player}:hand"])
        selected = _choice(run, choice_index)
        run.check("所选疾病被移除", selected not in run.state["instances"])
        run.check("另一张疾病仍在手牌", any(item in run.state["zones"][f"player:{run.player}:hand"]
                                            for item in added[1:] if item != selected))
        run.check("抽两张牌，手牌净增一张",
                  len(run.state["zones"][f"player:{run.player}:hand"]) == hand_before + 1)
        run.check("效果只能使用一次", not any(
            option.get("ability_id") == "TS-0428-A02"
            for command in legal_commands(run.state, snapshot=run.snapshot, effects=run.effects)
            for option in command.get("options", [])))
    elif case_id == "monster-count":
        run = _Run(case_id, "effect-lab-count")
        added = []
        def arrange(state: dict) -> None:
            added.append(run.add_hand("TS-0428"))
            monster = state["instances"][state["zones"]["hall:main"][0]]["card_id"]
            added.extend((run.add_hand(monster), run.add_hand(monster)))
        run.fixture("在手牌加入先知和两张怪物", arrange)
        run.do("ChooseAction", action="village")
        result = run.do("ActivateAbility", ability_id="TS-0428-A03",
                        source_instance_id=added[0])
        draw = next(item for item in result["events"] if item["kind"] == "effect_draw")
        run.check("两张怪物使表达式 2 × count 求值为 4", draw["requested"] == 4)
        run.check("实际抽到四张牌", len(draw["instance_ids"]) == 4)
    elif case_id in ("thornwood-tie", "thornwood-unique"):
        tie = case_id == "thornwood-tie"
        run = _Run(case_id, "8" if tie else "0", environment="TS-0193")
        actor = run.player
        supply = [pile[0] for zone, pile in run.state["zones"].items()
                  if zone.startswith("village_supply:") and pile]
        price = lambda item: int(run.cards[run.state["instances"][item]["card_id"]][
            "wiki_购买价格"])
        highest = max(map(price, supply))
        candidates = {item for item in supply if price(item) == highest}
        run.check("场景具备预期最高价候选数", len(candidates) > 1 if tie else len(candidates) == 1)
        run.do("ChooseAction", action="rest")
        result = run.do("FinishRest")
        if tie:
            run.check("并列候选在行动退出时暂停回合",
                      run.state["subphase"] == "ACTION_EXIT_EFFECTS"
                      and run.state["turn_number"] == 1)
            run.check("只提供最高价格的候选",
                      set(run.state["pending_choice"]["candidate_instance_ids"]) == candidates)
            selected = _choice(run, choice_index)
        else:
            run.check("唯一候选无需交互", run.state["pending_choice"] is None)
            selected = next(iter(candidates))
        run.check("选中的村庄供应牌顶被摧毁", selected in run.state["zones"]["destroyed"])
        run.check("效果完成后才交给下位玩家", run.state["turn_number"] == 2
                  and run.state["active_player_id"] != actor)
    elif case_id == "condition-schedule":
        run = _Run(case_id, "effect-lab-flow", custom_rule=FLOW_RULE)
        actor = run.player
        militia = [item for item in run.state["zones"][f"player:{run.player}:hand"]
                   if run.state["instances"][item]["card_id"] == "TS-0001"]
        if not militia:
            run.fixture("加入民兵，以满足条件和循环查询", lambda state: run.add_hand("TS-0001"))
            militia = [run.first_hand("TS-0001")]
        run.do("ChooseAction", action="village")
        activation = run.do("ActivateAbility", ability_id="TS-0001-A99",
                            source_instance_id=militia[0])
        run.check("条件分支和逐张循环累计经验", run.state["players"][run.player]["xp"] == 1 + len(militia))
        run.check("结束回合效果已排程", len(run.state["scheduled_effects"]) == 1)
        gold_events = [event for event in activation["events"]
                       if event["kind"] == "effect_resource_changed"
                       and event.get("op") == "mod_gold"]
        run.check("重复两次，各增加 1 金币", len(gold_events) == 2
                  and sum(event["amount"] for event in gold_events) == 2
                  and run.state["players"][actor]["temporary_gold"] == 2)
        run.do("FinishAbilities")
        run.do("FinishBuying")
        run.do("FinishUpgrading")
        run.check("TURN_WILL_END 时额外获得 3 经验", run.state["players"][actor]["xp"]
                  == 4 + len(militia))
        run.check("排程已消费", run.state["scheduled_effects"] == [])
    elif case_id == "condition-false":
        run = _Run(case_id, "effect-lab-false", custom_rule=FALSE_RULE)
        run.fixture("加入民兵；手牌中没有疾病或怪物",
                    lambda state: run.add_hand("TS-0001"))
        source = run.first_hand("TS-0001")
        run.do("ChooseAction", action="village")
        options = [option for command in legal_commands(
            run.state, snapshot=run.snapshot, effects=run.effects)
            for option in command.get("options", [])]
        run.check("any 两支均为假，第一条能力不在可发动列表",
                  not any(option["ability_id"] == "TS-0001-A94" for option in options))
        run.reject("ActivateAbility", ability_id="TS-0001-A94",
                   source_instance_id=source)
        run.do("ActivateAbility", ability_id="TS-0001-A95",
               source_instance_id=source)
        run.check("进入 else，并计算 1 + 2 经验", run.state["players"][run.player]["xp"] == 3)
    elif case_id in ("cost-rollback", "cost-gain-discard"):
        run = _Run(case_id, "effect-lab-cost", custom_rule=COST_RULE)
        def arrange(state: dict) -> None:
            run.add_hand("TS-0001")
            run.add_hand("TS-0002")
            run.add_hand("TS-0002")
            if case_id == "cost-gain-discard":
                state["players"][run.player]["xp"] = 3
        run.fixture("加入民兵和两把匕首；成功案例另给 3 经验", arrange)
        source = run.first_hand("TS-0001")
        run.do("ChooseAction", action="village")
        if case_id == "cost-rollback":
            error = run.reject("ActivateAbility", ability_id="TS-0001-A96",
                               source_instance_id=source)
            run.check("错误明确指出费用不足", "cost" in error or "XP" in error)
        else:
            run.do("ActivateAbility", ability_id="TS-0001-A96",
                   source_instance_id=source)
            run.check("支付 2 点经验后剩余 1 点", run.state["players"][run.player]["xp"] == 1)
            run.check("获得应急干粮到弃牌堆", any(
                run.state["instances"][item]["card_id"] == "TS-0003"
                for item in run.state["zones"][f"player:{run.player}:discard"]))
            run.check("两把匕首进入选择候选", len(run.state["pending_choice"]["candidate_instance_ids"]) >= 2)
            chosen = _choice(run, choice_index)
            run.check("所选匕首进入弃牌堆", chosen in run.state["zones"][f"player:{run.player}:discard"])
    else:
        run = _Run(case_id, "effect-lab-battle", custom_rule=BATTLE_RULE)
        run.fixture("在手牌加入民兵，作为合成效果的来源",
                    lambda state: run.add_hand("TS-0001"))
        source = run.first_hand("TS-0001")
        run.do("ChooseAction", action="dungeon")
        run.do("ActivateAbility", ability_id="TS-0001-A97",
               source_instance_id=source)
        run.check("战斗上下文保存攻击 +2 和光照 +1",
                  run.state["battle_context"]["modifiers"] == {"attack": 2, "light": 1})
        targets = next(item["instance_ids"] for item in legal_commands(
            run.state, snapshot=run.snapshot, effects=run.effects)
            if item["type"] == "DeclareBattleTarget")
        result = run.do("DeclareBattleTarget", target_instance_id=targets[0])
        battle = next(item for item in result["events"] if item["kind"] == "battle_resolved")
        run.check("战斗计算轨迹包含两项修正",
                  battle["calculation"]["modifiers"] == {"attack": 2, "light": 1})
    return run.output()
