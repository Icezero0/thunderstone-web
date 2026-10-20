import unittest

from normalize_effects import normalize_effect_text, normalize_number_spacing


class NormalizeEffectsTests(unittest.TestCase):
    def test_number_spacing_keeps_sign_with_number(self):
        self.assertEqual(
            normalize_number_spacing("力量-1。光照 + 2 。大于6点时，抽1张牌。"),
            "力量 -1。光照 +2。大于 6 点时，抽 1 张牌。",
        )

    def test_wraps_and_effect_boundaries(self):
        raw = (
            "魔法攻击 +2。\n若对手的效果将以你为目标，你可以展示此英雄，改为以\n"
            "当前回合玩家为目标。\n地下城：抽 1 张牌。"
        )
        result, other = normalize_effect_text(raw, "", card_type="英雄牌", subcategory="贝尔祖")
        self.assertEqual(result.splitlines(), [
            "魔法攻击 +2。",
            "若对手的效果将以你为目标，你可以展示此英雄，改为以当前回合玩家为目标。",
            "地下城：抽 1 张牌。",
        ])
        self.assertEqual(other, "")

    def test_multiple_sentences_in_one_activated_effect(self):
        result, _ = normalize_effect_text(
            "地下城：抽 1 张牌。\n若该牌是英雄，获得攻击+2。",
            "", card_type="村庄牌", subcategory="",
        )
        self.assertEqual(result, "地下城：抽 1 张牌。若该牌是英雄，获得攻击 +2。")

    def test_treasure_label_and_non_effect_text(self):
        treasure, other = normalize_effect_text(
            "宝藏\n村庄：摧毁该牌以\n获取4金币。", "", card_type="地下城牌", subcategory="宝藏"
        )
        self.assertEqual(treasure, "村庄：摧毁该牌以获取 4 金币。")
        self.assertEqual(other, "")
        stone, other = normalize_effect_text(
            "魔法攻击+1\n心腐肉枯，肢体凋零…", "", card_type="地下城牌", subcategory="雷霆之石"
        )
        self.assertEqual(stone, "魔法攻击 +1。")
        self.assertEqual(other, "心腐肉枯，肢体凋零…")

    def test_missing_periods_are_added_after_effects_are_split(self):
        result, other = normalize_effect_text(
            "攻击+2\n地下城：抽1张牌",
            "", card_type="英雄牌", subcategory="",
        )
        self.assertEqual(result, "攻击 +2。\n地下城：抽 1 张牌。")
        self.assertEqual(other, "")
        self.assertEqual(
            normalize_effect_text(result, other, card_type="英雄牌", subcategory=""),
            (result, other),
        )
        parenthetical, _ = normalize_effect_text(
            "游戏结束时，获得胜利点。（包括此牌，最高5胜利点）\n攻击+1",
            "", card_type="地下城牌", subcategory="怪物",
        )
        self.assertEqual(
            parenthetical,
            "游戏结束时，获得胜利点。（包括此牌，最高 5 胜利点）\n攻击 +1。",
        )
        self.assertEqual(
            normalize_effect_text(parenthetical, "", card_type="地下城牌", subcategory="怪物"),
            (parenthetical, ""),
        )

    def test_dependent_followup_stays_in_one_entry(self):
        result, other = normalize_effect_text(
            "光照+1。\n效果持续到你的下个回合结束。",
            "备注", card_type="村庄牌", subcategory="",
        )
        self.assertEqual(result, "光照 +1。效果持续到你的下个回合结束。")
        self.assertEqual(other, "备注")
        self.assertEqual(
            normalize_effect_text(result, other, card_type="村庄牌", subcategory=""),
            (result, other),
        )


if __name__ == "__main__":
    unittest.main()
