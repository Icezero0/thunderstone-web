# 游戏引擎设计文档

现有规则已完成 [TypeScript 迁移](typescript-migration.md)。战斗数值、怪物生命、金币／价格、计分、[DSL 编译与纯计算](typescript-dsl.md)、[规则配置与 setup](typescript-setup.md)、回合和有状态效果处理器均由共享 TS 包执行。前端复用只读计算，正式状态由后端维护。

本目录把 [总览](../game-engine-design.md) 展开为可直接指导 TypeScript 实现的规则与接口约定。正文中的“规则书要求”来自 [`TS4_rules_CN.pdf`](../../game_TTS/TS4_rules_CN.pdf) 的标准竞争对局；“设计约定”是网页版的实现选择；“待裁定”表示资料尚不足以写成确定行为。目前已实现[规则配置校验](../../packages/engine/src/setup/validation.ts)、[确定性组局](../../packages/engine/src/setup/builder.ts)、[疾病供应及回合转换](../../packages/engine/src/turn/commands.ts)、[全量效果绑定与逐卡测试](ability-runtime-implementation.md)、特殊场景战斗、计分和[本地面板 API](../../backend/app/api/v1/setup.py)。520 张有效果的卡牌均已完整覆盖；联机层与正式客户端仍待开发。

## 文档树与阅读顺序

```text
docs/
├── data-model.md                   现有卡牌 CSV 字段
├── game-engine-design.md           引擎总览
└── game-engine/
    ├── README.md                   本索引、范围和来源优先级
    ├── 00-engine-boundary.md       联机层与引擎的交接、启动和结果
    ├── 01-catalog-and-rulesets.md  数据导入、组局映射、规则包版本
    ├── 02-state-model.md           对局对象、卡牌区域、状态不变量
    ├── 03-setup.md                 标准对局设置与特殊设置分支
    ├── 04-turn-flow.md             三种行动、村庄、休整、升级、抽牌
    ├── 05-dungeon-and-combat.md    战斗、大厅、地下城特征、终局
    ├── 06-ability-runtime.md       能力编译、事件与效果结算
    ├── 07-multiplayer.md           联机请求、状态持久化、可见性
    └── 08-verification.md          测试矩阵、变体边界、实施次序
```

| 顺序 | 文档 | 核心问题 |
| --- | --- | --- |
| 0 | [联机层与引擎边界](00-engine-boundary.md) | 联机层交给引擎什么，引擎返回什么？ |
| 1 | [卡牌目录与规则包](01-catalog-and-rulesets.md) | 如何按标签生成卡组映射、从 CSV 读取默认张数并应用例外？ |
| 2 | [状态模型](02-state-model.md) | 一张实体牌在哪里，什么状态需要在服务器保存？ |
| 3 | [对局设置](03-setup.md) | 如何结合指定牌组和随机设置牌构建本局？ |
| 4 | [回合流程](04-turn-flow.md) | 回合开始/结束时点和三种行动如何衔接？ |
| 5 | [地下城与战斗](05-dungeon-and-combat.md) | 如何计算战斗、补位、陷阱和终局？ |
| 6 | [能力运行时](06-ability-runtime.md) | 如何把规则草案变成可验证、可暂停的效果？ |
| 7 | [联机与持久化](07-multiplayer.md) | 如何按顺序处理异地玩家的指令并保护隐藏信息？ |
| 8 | [验证与实施](08-verification.md) | 哪些行为必须测试，什么条件下允许一张牌进入牌池？ |

临时工具：[效果实验台](effect-lab.md)展示命令执行轨迹；[怪物能力审核](monster-audit.md)用于逐卡对照卡面符号与当前 DSL 的中文解释，并记录审核意见。

[怪物审核处理清单](monster-review-resolution.md)记录 2026-10-22 已落实的符号判定、全部备注及相关规则修正。

[战斗队伍接口](battle-team-api.md)说明英雄／法术／装备的本地选择、共享数值预览、`SubmitBattleTeam` 和后端适配契约。

[效果身份判断审计](effect-identity-audit.md)列出已经改为英雄、怪物、疾病、雷霆之石、村庄标签的通用判断，以及仍按分类处理的宝藏和英雄系列效果；另附全部涉及村庄牌的卡文与处理方式。

## 来源优先级

1. **卡牌身份、中文显示和已整理静态数值**：[`data/cards.csv`](../../data/cards.csv)，字段解释见 [数据字典](../data-model.md)。图片使用 CSV 的 `image_path`。卡牌定义与实体牌实例分开。
2. **标准游戏通则**：[`TS4_rules_CN.pdf`](../../game_TTS/TS4_rules_CN.pdf)。规则书明确卡牌可以覆盖通则。非标准变体和其他扩展不能未经选择就混入标准模式。
3. **卡牌能力设计输入与人工裁定**：[`thunderstone_card_rules_v0.3.2_engine.json`](../游戏引擎设计参考/thunderstone_card_rules_v0.3.2_engine.json) 和 [人工审阅工作簿](../游戏引擎设计参考/thunderstone_card_atoms_v0.3.2_author_reviewed.xlsx)。它们保留触发、条件、原子、AST 草案及裁定，但尚不是可直接执行的规则包。
4. **TTS 初始设置**：已从 [`TDS_CN.json`](../../game_TTS/TDS_CN.json) 的具体供应袋/牌堆一次性导入每张卡的**默认实例数**到 `cards.csv.initial_copy_count`；Lua 脚本用于核对组局操作和特殊分支。本局仅对村庄、英雄、怪物牌应用各自的实例倍率；坐标、GUID、等待帧和手工步骤不进入 TypeScript 规则内核。

若同一行为在资料间冲突，先记录差异和适用的游戏模式；不要让导入器静默覆盖 CSV 或执行未经校验的 AST。联机层提交的用户选择（例如指定牌组、调整默认组数或指定首位玩家）作为明确的产品规则记录，不冒充 PDF 的原始设置。默认首位玩家随机决定。每局固定 `catalog_version`、`ruleset_version`、玩家顺序与组局配置快照，从开局到终局保持不变。

## 第一阶段范围

当前阶段覆盖**标准竞争对局**与现有目录的全部效果卡，采用已确认的逐卡裁定。合作、单人变体另行设计。规则内核负责冻结配置的规则校验、组局、状态转换和计分；不管理房间、玩家座位、准备状态、HTTP、数据库连接、图像渲染或 TTS 操作。
