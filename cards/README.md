# 卡牌内容

本目录保存纳入 Git 的卡牌定义、图片、规则和验证资料。前后端通过卡牌编号使用这些内容；规则解释和状态运算由独立的 `engine/` 执行。

## 目录

| 路径 | 内容与用途 |
| --- | --- |
| `cards.csv` | 722 条正式卡牌定义；字段见[数据字典](../docs/data-model.md)。`image_path` 使用项目根目录相对路径，例如 `cards/assets/TS-0001.png`。 |
| `setup_catalog.json` | 从 CSV 生成的组局索引，包含随机设置牌、卡组成员和地下城特征。内含 CSV 的 SHA-256，导入时校验一致性。 |
| `assets/` | 722 张按正式编号命名的卡图，包含可玩卡、参考卡和公共牌背。 |
| `effects/` | 正式效果 DSL：`classic-v1.json`、四份 `*-reviewed.json` 和 `mechanics.json`，合计 467 条可执行能力、206 条持续规则。 |
| `contracts/` | 8 份逐卡行为契约和词条归属清单，供测试、效果覆盖审计及怪物审核工具读取。 |
| `reviews/` | `monster-symbols.json` 保存怪物战利品符号判定、备注和已落实的绑定指纹。原始审核导出保留在 `archive/reviews/`。 |
| `reports/` | `coverage.csv` 为能力覆盖清单，`card-coverage.csv` 为卡牌覆盖清单；可重新生成，当前也被测试和审核页读取。 |

本地数据库和签名密钥位于 [data/](../data/README.md)。后端使用导入 SQLite 的卡牌目录快照，并加载本目录的正式效果 JSON。

村庄盗贼随机牌（`TS-0081`）对应一个按等级排列的村庄供应牌堆：上层 5 张村庄扒手（`TS-0301`），下层 3 张村庄强盗（`TS-0300`）。默认数量保存于 `initial_copy_count`；`tts_copy_count` 继续记录原 TTS 资产数量。供应位置、英雄身份和等级排序由引擎根据设置索引、标签及等级处理，升级规则见[回合流程](../docs/game-engine/04-turn-flow.md)。

## 更新卡牌目录

在项目根目录修改 `cards/cards.csv` 或替换对应卡图后，按需更新索引和数据库：

```powershell
.\.venv\Scripts\python.exe backend\scripts\catalog\build_setup_catalog.py
.\.venv\Scripts\python.exe backend\scripts\catalog\import_cards_to_sqlite.py --replace
```

单独替换图片且 CSV 没有变化时，不需要重新导入目录。卡牌编号变化需要同步迁移效果、契约、审核记录和所有引用。

## 验证效果与生成覆盖清单

`backend/scripts/effects/build_*_effects.py` 和同目录的 `build_mechanics.py` 维护已审核效果及契约；使用 `--check` 可检查生成结果与正式文件是否一致。

```powershell
.\.venv\Scripts\python.exe backend\scripts\effects\audit_effects.py --output cards\reports\coverage.csv --card-output cards\reports\card-coverage.csv --require-complete
```

完整验证命令见[项目 README](../README.md)和[引擎验证说明](../docs/game-engine/08-verification.md)。
