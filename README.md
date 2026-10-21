# 雷霆之石网页版：卡牌资产

本阶段的正式资产是 [data/cards.csv](data/cards.csv) 和 [assets/cards/](assets/cards/) 中按 `card_id` 命名的卡图。分类、中文文字、数值、初始化实例数量、审核状态、排序和新旧编号都已写入 CSV。后端将 CSV 和生成的设置索引显式导入 SQLite，在运行时读取数据库中的目录快照。

## 资产

- `data/cards.csv`：722 条记录，其中 720 张可玩卡正面、1 张回合顺序参考卡、1 张公共牌背。`card_id` 是正式编号，`source_card_id` 保存原图集牌位名，`catalog_order` 保存当前目录顺序，`initial_copy_count` 保存一次性从 TTS 初始牌堆导入的默认实例数量。
- `assets/cards/`：720 张 `TS-0001.png` 至 `TS-0720.png`，以及 `TS-REFERENCE-001.png`、`TS-BACK-001.jpg`。每条记录的 `image_path` 指向相同编号的图片。
- `archive/`：早期文字框、英雄系列核对结果和 Wiki 研究资料，仅供溯源，不参与当前目录编辑。

初期输入 `game/` 与 `black_edges/` 保留在本地，仍被 Git 忽略。人工修订的卡图已并入正式图片 `TS-0148.png`、`TS-0120.png`、`TS-0679.png`。当前不再使用图集切割、数据重建或覆盖表。

历史编号映射、牌组分类和 Wiki 候选值均已并入 `cards.csv`；旧构建输入与命令已清理。

## 使用数据

`cards.csv` 使用带 BOM 的 UTF-8 编码，空白数值表示未知或不适用，不等于 0。卡牌图片的路径由 `image_path` 字段给出。旧审核页面已移除；下方的规则配置面板是新的独立原型。

分类、标签、英雄系列、经验值字段与审核状态见 [数据模型](docs/data-model.md)。

## 游戏引擎设计

Python 规则引擎的设计见[总览](docs/game-engine-design.md)和[详细文档目录](docs/game-engine/README.md)。详细文档依次说明卡牌目录与规则包、状态、组局、回合、战斗、能力结算、联机和验证。

代码分为独立的 [规则引擎](engine/README.md) 和 [网络后端](backend/README.md)。引擎只计算规则和状态；后端负责用户、SQLite、HTTP 与 WebSocket，并通过接口调用引擎。卡牌目录的表结构、导入和版本策略见 [SQLite 设计文档](docs/card-catalog-database-design.md)。

## 规则配置面板（本地原型）

从仓库根目录运行：

```powershell
cd D:\project\thunderstone-web
uv pip install --python .\.venv\Scripts\python.exe -r backend\requirements.txt
.\.venv\Scripts\python.exe scripts\import_cards_to_sqlite.py
.\.venv\Scripts\python.exe scripts\run_config_panel.py --host 127.0.0.1 --port 8765
```

随后打开 `http://127.0.0.1:8765/`。现在由 [Python 后端](backend/README.md)提供面板和 `/api/v1` 接口。面板通过后端读取已导入 SQLite 的卡牌目录，可设置经典模式的组数、固定组、雷霆之石，以及地下城特征的经典随机或手动选择。手动模式中，守护者/环境按实际卡牌选，陷阱/宝藏按整组选；未固定的名额可随机补足。末日之门、绝境庇护所、飞龙尖塔会调整实际组数；飞龙尖塔允许最多固定 2 张雷霆之石，放逐仪式强制选入全部 7 张与末日之心。村庄/英雄/怪物三类牌各有实例倍率（×1～×5）。

第 05 部分可填入临时玩家 ID 和随机种子，点击“生成本局”，直接查看实际抽中的卡组、地下城特征、雷霆之石、初始大厅与玩家起始牌数，并下载完整设置状态与事件。若抽到飞龙尖塔，页面会先展示四个怪物组和已抽中的特征，让你分配到两座地下城，完成后再显示结果。正式联机时，玩家与座位、先手策略和种子仍由联机层提交。

## 运行一次 setup

不使用页面时，也可把面板导出的 JSON 保存为 `config.json`，从仓库根目录运行：

```powershell
.\.venv\Scripts\python.exe scripts\run_setup.py --config config.json --players alice bob --seed game-1 --match-id game-1 --output setup-result.json
```

输出包含初始 `state` 和仅供服务器保存的完整设置 `events`。相同输入和随机种子会得到相同结果。飞龙尖塔需要玩家决定两座地下城的怪物组与特征分配；命令会先输出所需选择，再用相同参数加 `--choices choices.json` 重新执行。`choices.json` 的结构为 `{"two_dungeons":{"group_a_ids":["组ID1","组ID2"],"group_a_feature_ids":["特征ID"]}}`，未列出的组和特征进入另一座地下城。

基础回合指令已在独立的 [`engine.turn`](engine/README.md) 中实现，可以从 setup 状态推进村庄、休整和地下城行动。用 `.\.venv\Scripts\python.exe scripts\run_turns.py --state setup-result.json --commands commands.json --output turn-result.json` 可在本地重放指令。[JSON 效果处理器](docs/game-engine/ability-runtime-implementation.md)包含 446 条可执行能力及 222 条持续规则绑定，另有卡面基础数值、开局和共用规则；逐条和逐卡状态分别见 [能力覆盖清单](data/effects/coverage.csv) 与 [卡牌覆盖清单](data/effects/card-coverage.csv)。520 张有效果的卡牌已全部具有完整绑定及逐卡行为测试，未完成卡牌会使测试与审计门禁失败。已实现替代与反应窗口、借用与复制、附着、跨回合规则、额外回合、供应补充和特殊场景。临时 [效果实验台](docs/game-engine/effect-lab.md)展示 23 个执行案例，以及可检索的全卡覆盖清单。此覆盖范围是当前经典规则与已确认裁定；联机层、正式客户端及合作／单人变体另行开发。

[怪物能力审核页](docs/game-engine/monster-audit.md)位于 `/monster-audit`，将全部 214 种怪物的 345 条能力与卡图并排展示，解释当前 DSL 的生效区域与执行流程，便于人工核对战利品符号。审核意见保存在浏览器，可导出 JSON 后统一修正规则。

效果处理器的[临时测试页面](web/effect_lab.html)位于 `http://127.0.0.1:8765/effect-lab`，沿用上面的启动命令。页面可逐步查看 11 个可复现案例的命令、状态、事件、选择分支和断言，包括战斗与手牌战利品的区别、补牌陷阱中断后恢复原能力；[案例说明](docs/game-engine/effect-lab.md)列出真实卡牌与合成 DSL 的边界。此页面每次请求都在内存中重新组局，不修改数据库。

修改卡牌目录后，先用 `.\.venv\Scripts\python.exe scripts\build_setup_catalog.py` 更新组映射，再用 `.\.venv\Scripts\python.exe scripts\import_cards_to_sqlite.py --replace` 更新数据库，随后启动或重启面板。原始 TTS 存档不会参与面板或组局的读取。
