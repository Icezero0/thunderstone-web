# TypeScript 迁移回归

`test_shared_*.py` 和 `test_full_turn_parity.py` 验证共享 TypeScript 引擎与历史实现的兼容行为。`transition_parity_runner.py` 可将现有命令案例交给两套实现，逐次比较完整状态、事件和可用指令。

```powershell
.\.venv\Scripts\python.exe -X utf8 -m tests.migration.transition_parity_runner tests.test_card_effects
```

`reference/` 保存历史 Python 执行器、公式及测试辅助函数。普通逐卡回归仍引用其中的辅助函数，因此这些文件是有效测试依赖，不能作为迁移垃圾删除。后端、引擎适配层和调试页面都不依赖它们。

运行中的唯一规则实现位于 `packages/engine/src/`。Python 数据和进程调用适配层位于 `backend/app/integrations/game_engine/`。
