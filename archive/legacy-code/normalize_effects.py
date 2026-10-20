"""Normalize card effect typography and remove card-art line wrapping."""

from __future__ import annotations

import re


EFFECT_PREFIXES = (
    "村庄 / 地下城",
    "重复地下城",
    "地下城",
    "战斗",
    "突破",
    "村庄",
    "全局",
    "凯旋",
    "掠袭",
    "追猎",
)
SENTENCE_END = ("。", "！", "？", "!", "?", "；", ";", "）", ")")
TERMINAL_PUNCTUATION = ("。", "！", "？", "!", "?", "）", ")")
HAN = r"[\u3400-\u9fff]"
CONTINUATION_STARTS = (
    "效果持续", "重复此流程", "若有多个并列牌堆", "若展示的英雄不是盗贼",
    "若本局游戏已经存在环境",
    "英雄牌返回牌堆的正确位置",
)


def effect_prefix(line: str) -> str:
    return next((prefix for prefix in EFFECT_PREFIXES if line.startswith(prefix + "：")), "")


def normalize_number_spacing(text: str) -> str:
    """Use one space at Han/number boundaries and keep signs with digits."""
    text = re.sub(r"([+-])[ \t]+(?=\d)", r"\1", text)
    text = re.sub(rf"({HAN})[ \t]*(?=[+-]?\d)", r"\1 ", text)
    text = re.sub(rf"(?<=\d)[ \t]*(?={HAN})", " ", text)
    return re.sub(r"(?<=\d)[ \t]+(?=[，。！？；：、）])", "", text)


def starts_separate_effect(previous: str, current: str) -> bool:
    """Separate a new ability while retaining sentences within one activated ability."""
    if effect_prefix(current):
        return True
    if not previous.endswith(SENTENCE_END):
        return False
    if current.startswith(("（", "(") + CONTINUATION_STARTS):
        return False
    prefix = effect_prefix(previous)
    if not prefix:
        return True
    if current.startswith(("攻击 +", "攻击 -", "魔法攻击 +", "魔法攻击 -", "免疫", "除非")):
        return True
    if prefix == "突破" and current.startswith(("当", "若")):
        return True
    if prefix == "全局" and current.startswith("所有英雄承受"):
        return True
    if prefix == "战斗" and current.startswith("所有玩家摧毁"):
        return True
    return False


def normalize_effect_text(
    text: str, other_text: str, *, card_type: str, subcategory: str
) -> tuple[str, str]:
    """Keep sentence and prefix boundaries; join only clear visual wraps."""
    lines: list[str] = []
    additional_other_lines: list[str] = []
    blank_before = False
    for raw_line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw_line.strip()
        if not line:
            blank_before = True
            continue
        if card_type == "地下城牌" and subcategory == "宝藏" and line == "宝藏":
            continue
        if line == "解释：":
            additional_other_lines.append(line)
            blank_before = True
            continue
        if card_type == "地下城牌" and subcategory == "雷霆之石" and "…" in line:
            additional_other_lines.append(line)
            blank_before = True
            continue
        line = normalize_number_spacing(line)
        if not lines or blank_before or starts_separate_effect(lines[-1], line):
            lines.append(line)
        else:
            lines[-1] = normalize_number_spacing(lines[-1] + line)
        blank_before = False
    preserved_other = other_text.rstrip("\r\n")
    if additional_other_lines:
        preserved_other += ("\n" if preserved_other else "") + "\n".join(additional_other_lines)
    return "\n".join(
        line if line.endswith(TERMINAL_PUNCTUATION) else line + "。" for line in lines
    ), preserved_other
