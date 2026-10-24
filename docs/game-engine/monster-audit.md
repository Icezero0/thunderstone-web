# Monster review record

怪物审核已完成，临时页面及 `/monster-audit`、`/monster-audit/data` 接口于 2026-10-23 移除。前端审核脚本、中文 DSL 展示器和页面专用测试一并删除，Git 历史可追溯其实现。

正式审核成果继续保留：

- [符号结论](../../cards/reviews/monster-symbols.json)：345 条能力的符号判定、原文、处理说明与已应用绑定指纹。
- [原始导出](../../archive/reviews/)：最初提交的浏览器审核记录。
- [处理清单](monster-review-resolution.md)：战利品符号和卡牌备注的落实说明。
- [规则回归](../../backend/tests/effects/test_monster_review.py)：直接检查正式效果的符号范围、绑定指纹与实际行为，不依赖审核页面。

后续规则维护直接修改 `cards/effects/` 和对应构建脚本、测试契约；执行过程仍可通过[效果实验台](effect-lab.md)查看。
