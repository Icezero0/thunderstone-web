"""Checkpoint values and public operation labels, with no database access."""
from copy import deepcopy

SNAPSHOT_FIELDS = ("status", "state", "events", "setup_request", "setup_choice")
LABELS = {
    "ChooseAction": "选择行动", "FinishAbilities": "结束使用效果", "BuyCard": "购买卡牌",
    "FinishBuying": "结束购买", "UpgradeHero": "升级英雄", "FinishUpgrading": "结束升级",
    "RestDestroy": "休整摧毁手牌", "SkipRestDestroy": "跳过休整摧毁", "FinishTurn": "结束回合",
    "ActivateAbility": "发动卡牌效果", "ResolveChoice": "选择效果对象", "ResolveValueChoice": "选择效果选项",
    "ResolveCardOrder": "排列卡牌", "ResolveEffectPurchase": "选择供应牌", "ResolveEffectUpgrade": "升级英雄",
    "SubmitBattleTeam": "完成战斗队伍", "DeclareBattleTarget": "宣言战斗", "ReviseBattleTeam": "调整战斗队伍",
    "ResolveTrap": "触发陷阱", "ResolveDiseaseGain": "处理疾病获得", "ResolveOptional": "处理可选效果",
}


def snapshot(match):
    # Catalogue, participant identities and executable revisions are immutable
    # on Match; this captures all mutable rule state, RNG and continuations.
    return deepcopy({key: getattr(match, key) for key in SNAPSHOT_FIELDS})


def label(operation, payload):
    if operation != "command":
        return {"start": "开始冒险", "setup_choice": "分配地下城", "baseline": "现有对局起点"}.get(operation, operation)
    command = payload.command.model_dump(exclude_none=True)
    if command["type"] == "ChooseAction":
        return {"village": "访问村庄", "dungeon": "进入地下城", "rest": "休整"}.get(command.get("action"), "选择行动")
    return LABELS.get(command["type"], "处理效果响应")
