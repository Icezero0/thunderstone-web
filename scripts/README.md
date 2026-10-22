# 开发与维护命令

从仓库根目录使用 `.\.venv\Scripts\python.exe scripts\<脚本名>` 运行。

| 用途 | 脚本 |
| --- | --- |
| 启动本地配置面板与 API | `run_config_panel.py` |
| 离线组局、重放回合命令 | `run_setup.py`、`run_turns.py` |
| 根据 CSV 更新设置索引 | `build_setup_catalog.py` |
| 将正式目录导入 SQLite | `import_cards_to_sqlite.py`；更新目录时加 `--replace` |
| 维护已审核效果 JSON 与行为契约 | `build_simple_effects.py`、`build_action_effects.py`、`build_battle_effects.py`、`build_event_effects.py`、`build_mechanics.py`；使用 `--check` 可只验证 |
| 审计效果覆盖及分类／标签判断 | `audit_effects.py`、`audit_effect_identity.py` |

效果生成脚本仍是规则维护工具，测试和覆盖审计依赖它们的产物。一次性的资产清洗、排序和 TTS 数量导入脚本位于 `archive/legacy-code/`。
