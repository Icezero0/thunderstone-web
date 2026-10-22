# 早期整理脚本

`card_order.py` 曾用于确定卡牌顺序和编号；当前顺序已固化在 `data/cards.csv` 的 `catalog_order` 中。

`normalize_effects.py` 曾用于合并卡面排版换行、拆分效果词条和规范数字空格。最终文字已写入 `data/cards.csv`；`test_normalize_effects.py` 仅保留当时的规则样例。

`import_tts_initial_counts.py` 曾从 `game_TTS/TDS_CN.json` 一次性导入默认实例数到 `cards.csv.initial_copy_count`。数量已固化，日常组局和数据库导入不再运行它。

`renumber_warhammer.py` 是战锤标签修正后的编号迁移脚本，对应记录位于 `archive/card-audit/warhammer-renumber-2026-10-20*`。

这些脚本不参与当前卡牌资产的读取。
