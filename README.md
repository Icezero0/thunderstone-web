# 雷霆之石网页版：卡牌资产

本阶段的正式资产是 [data/cards.csv](data/cards.csv) 和 [assets/cards/](assets/cards/) 中按 `card_id` 命名的卡图。分类、中文文字、数值、初始化实例数量、审核状态、排序和新旧编号都已写入 CSV。后端将 CSV 和生成的设置索引显式导入 SQLite，在运行时读取数据库中的目录快照。

## 目录

| 目录 | 内容 |
| --- | --- |
| `assets/cards/` | 按正式编号命名的卡图 |
| `data/` | 正式卡牌 CSV、设置索引及已审核效果数据 |
| `packages/engine/` | 共享 TypeScript 规则引擎及其测试 |
| `backend/` | 账户、SQLite、HTTP、WebSocket、Python 引擎适配层和 Node worker 入口 |
| `web/`、`devtools/` | 本地配置面板、效果实验台和怪物审核工具 |
| `scripts/` | 当前维护与运行命令，见[脚本说明](scripts/README.md) |
| `tests/` | 回归测试；`migration/reference/` 保留测试仍使用的历史 Python 实现 |
| `docs/` | 数据字典、规则设计与实现说明 |
| `archive/` | 已完成的资产整理、一次性脚本与迁移记录，见[归档说明](archive/README.md) |
| `game_TTS/` | 本地原始 TTS 存档、图集和规则书，Git 忽略 |

`.venv/`、`node_modules/`、`backend/instance/` 和引擎 `dist/` 是本地环境及运行产物。临时审计输出可写入 Git 忽略的 `reports/`，无需预先创建该目录。

## 资产

- `data/cards.csv`：722 条记录，其中 720 张可玩卡正面、1 张回合顺序参考卡、1 张公共牌背。`card_id` 是正式编号，`source_card_id` 保存原图集牌位名，`catalog_order` 保存当前目录顺序，`initial_copy_count` 保存一次性从 TTS 初始牌堆导入的默认实例数量。
- `assets/cards/`：720 张 `TS-0001.png` 至 `TS-0720.png`，以及 `TS-REFERENCE-001.png`、`TS-BACK-001.jpg`。每条记录的 `image_path` 指向相同编号的图片。
- `archive/`：历史卡牌审核、Wiki 研究、一次性脚本与已完成迁移记录，详见[归档说明](archive/README.md)。

原始输入位于 Git 忽略的 `game_TTS/`；早期目录 `game/` 与 `black_edges/` 也列入忽略规则。人工修订的卡图已并入正式图片，当前不再使用图集切割、数据重建或覆盖表。

历史编号映射、牌组分类和 Wiki 候选值均已并入 `cards.csv`；旧构建输入与命令已清理。

## 使用数据

`cards.csv` 使用带 BOM 的 UTF-8 编码，空白数值表示未知或不适用，不等于 0。卡牌图片的路径由 `image_path` 字段给出。旧审核页面已移除；下方的规则配置面板是新的独立原型。

分类、标签、英雄系列、经验值字段与审核状态见 [数据模型](docs/data-model.md)。

## 游戏引擎设计

当前成果、未完成范围和建议推进顺序见[项目阶段状态](docs/project-status.md)。

规则引擎的设计见[总览](docs/game-engine-design.md)和[详细文档目录](docs/game-engine/README.md)。经典规则的 setup、回合命令、卡牌效果、地下城流程、疾病获得与计分已迁移到[共享 TypeScript 引擎](docs/game-engine/typescript-migration.md)，实现位于 [packages/engine](packages/engine/README.md)。Python 保留目录读取和后端适配层，旧规则实现归档用于迁移对照测试。

代码分为独立的 [TypeScript 规则引擎](packages/engine/README.md) 和 [Python 网络后端](backend/README.md)。引擎只计算规则和状态；后端负责用户、SQLite、HTTP 与 WebSocket，通过 [Python 适配层](backend/app/integrations/game_engine/README.md)调用引擎。根目录的旧 `engine/` 已撤除。卡牌目录的表结构、导入和版本策略见 [SQLite 设计文档](docs/card-catalog-database-design.md)。

[战斗队伍接口](docs/game-engine/battle-team-api.md)支持在地下城准备结束时提交参战英雄、法术／支援、装备和目标。前端逐次操作使用共享引擎即时预览，后端通过 `SubmitBattleTeam` 重新验证并结算。

## 规则配置面板（本地原型）

从仓库根目录运行：

```powershell
cd D:\project\thunderstone-web
npm ci
npm run build
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

基础回合指令由 [TypeScript 回合内核](packages/engine/src/turn/commands.ts)执行，可以从 setup 状态推进村庄、休整和地下城行动。用 `.\.venv\Scripts\python.exe scripts\run_turns.py --state setup-result.json --commands commands.json --output turn-result.json` 可在本地重放指令。[JSON 效果处理器](docs/game-engine/ability-runtime-implementation.md)包含 446 条可执行能力及 227 条持续规则绑定，另有卡面基础数值、开局和共用规则；逐条和逐卡状态分别见 [能力覆盖清单](data/effects/coverage.csv) 与 [卡牌覆盖清单](data/effects/card-coverage.csv)。520 张有效果的卡牌已全部具有完整绑定及逐卡行为测试，未完成卡牌会使测试与审计门禁失败。已实现替代与反应窗口、借用与复制、附着、跨回合规则、额外回合、供应补充和特殊场景。临时 [效果实验台](docs/game-engine/effect-lab.md)展示 23 个执行案例，以及可检索的全卡覆盖清单。此覆盖范围是当前经典规则与已确认裁定；联机层、正式客户端及合作／单人变体另行开发。

[怪物能力审核页](docs/game-engine/monster-audit.md)位于 `/monster-audit`，将全部 214 种怪物的 345 条能力与卡图并排展示，解释当前 DSL 的生效区域与执行流程。本轮战利品符号与 7 条备注已落实，见[审核处理清单](docs/game-engine/monster-review-resolution.md)；页面保留原备注并显示处理说明。后续审核意见仍保存在浏览器，可导出 JSON。

效果实验台位于 `http://127.0.0.1:8765/effect-lab`，沿用上面的启动命令。每个案例展示命令、状态、事件、选择分支和断言；请求在内存中重新组局，不修改数据库。

修改卡牌目录后，先用 `.\.venv\Scripts\python.exe scripts\build_setup_catalog.py` 更新组映射，再用 `.\.venv\Scripts\python.exe scripts\import_cards_to_sqlite.py --replace` 更新数据库，随后启动或重启面板。原始 TTS 存档不会参与面板或组局的读取。
