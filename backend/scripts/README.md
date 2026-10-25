# 开发与维护命令

从仓库根目录使用 `.\.venv\Scripts\python.exe backend\scripts\<功能目录>\<脚本名>` 运行。后端服务的启动入口是 `backend/run_backend.bat`（或 `.sh`），前端入口是 `frontend/run_frontend.bat`（或 `.sh`）。

卡牌源文件和图片统一位于 `cards/`；效果、测试契约、审核记录和覆盖清单分别位于其中的 `effects/`、`contracts/`、`reviews/`、`reports/`。SQLite 默认位于 `data/thunderstone.db`。详见[卡牌内容说明](../../cards/README.md)。

| 用途 | 脚本 |
| --- | --- |
| 离线组局、重放回合命令 | `sandbox/run_setup.py`、`sandbox/run_turns.py` |
| 根据 CSV 更新设置索引 | `catalog/build_setup_catalog.py` |
| 将正式目录导入 SQLite | `catalog/import_cards_to_sqlite.py`；更新目录时加 `--replace` |
| 维护已审核效果 JSON 与行为契约 | `effects/build_simple_effects.py`、`effects/build_action_effects.py`、`effects/build_battle_effects.py`、`effects/build_event_effects.py`、`effects/build_mechanics.py`；使用 `--check` 可只验证 |
| 审计效果覆盖及分类／标签判断 | `effects/audit_effects.py`、`effects/audit_effect_identity.py` |

效果生成脚本仍是规则维护工具，测试和覆盖审计依赖它们的产物。一次性的资产清洗、排序和 TTS 数量导入脚本位于 `archive/legacy-code/`。

`effects/audit_effect_identity.py` 默认只读输出 JSON 汇总，扫描分类、具体卡牌编号、装备者身份、同名及系列谓词。可用 `--output cards/reports/effect-identity-inventory.md` 导出原始清单；人工审核结论保存在 `docs/game-engine/effect-identity-audit.md`，不由生成器覆盖。
