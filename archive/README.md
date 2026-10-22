# 历史资料

这些文件记录已完成的卡牌整理和迁移过程，仅供溯源。正式数据以 `cards/cards.csv` 和 `cards/assets/` 为准。

- `card-audit/text_boxes.csv`：早期嵌字框、坐标和字体样式；其中的文字可能早于最终校对结果。
- `card-audit/hero_series_review.csv`：早期英雄系列核对清单。
- `wiki-research/`：Wiki 数值试验、名称对照和人工速查资料。
- `reviews/monster-review-2026-10-22T07-55-15-436Z.json`：用户的原始怪物符号审核和备注；正式落实记录见 `cards/reviews/monster-symbols.json`。
- `legacy-code/`：一次性排序、效果文字规范化脚本及其旧测试；正式卡牌数据不依赖它们。
- `migrations/2026-10-migration-records.zip`：原 `reports/` 中全部 27 个本地文件，包含英雄／怪物标签及效果筛选迁移快照、一次性脚本、TypeScript 迁移记录和当时的测试报告。压缩包内 `manifest.json` 保存每个文件的原路径、字节数与 SHA-256；归档后已逐文件验证。历史数据库仅含卡牌目录，用户表为空。脚本保留历史路径和前置条件，仅供阅读。
- `card-audit/warhammer-renumber-2026-10-20.csv`：战锤标签修正后的全目录旧编号、新编号和原始牌位对应表；战锤由 `TS-0215` 迁移为 `TS-0238`。同名前缀的 `-before.zip` 保存迁移前文本及原战锤卡图，`-manifest.json` 记录文件校验值和用户提供的新图替换记录。这些迁移记录保留当时的编号，不随后续目录重建改写。

当前项目不再使用覆盖表或从这些资料重建正式卡牌目录。

旧 Python 规则实现位于 `backend/tests/migration/reference/`，仍参与迁移对照和回归测试，因此保留在测试目录。后续生成的临时报告可写入 Git 忽略的 `reports/`，按需清理。
