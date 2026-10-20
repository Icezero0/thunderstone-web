# 早期整理脚本

`card_order.py` 曾用于确定卡牌顺序和编号；当前顺序已固化在 `data/cards.csv` 的 `catalog_order` 中。

`normalize_effects.py` 曾用于合并卡面排版换行、拆分效果词条和规范数字空格。最终文字已写入 `data/cards.csv`；`test_normalize_effects.py` 仅保留当时的规则样例。

这些脚本不参与当前卡牌资产的读取。
