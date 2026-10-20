# 对局状态模型

房间成员、座位和玩家准备由联机层管理；引擎接收冻结请求并生成初始 `GameState`，交接见[引擎边界](00-engine-boundary.md)。进入对局后，引擎收到完整 `GameState` 和一条指令，返回下一状态与事件。状态必须足以在另一台服务器上继续同一局，包括洗牌顺序、待玩家选择和战斗中尚未完成的效果。静态卡牌定义与组局映射见[卡牌目录与规则包](01-catalog-and-rulesets.md)。

## 1. 定义与实例

`card_id` 指一种牌面定义。`instance_id` 指本局的一张实体牌，开局或效果获得时分配，不能用卡名或图片名代替。例如一名玩家初始牌库中的 6 张民兵都引用 `TS-0001`，但必须有 6 个不同 `instance_id`，才能各自记录位置、装备和待摧毁状态。

```text
CardInstance
  instance_id: 本局唯一
  card_id: CardCatalog 外键
  owner_player_id: 玩家或无归属
  origin: 初始供应 / 组局牌堆 / 效果生成
  flags: 临时状态，不保存可从卡面重建的印刷数值
```

所有已经物化的实例都必须恰好在一个区域中。区域按顺序存放 `instance_id`，查询时可建立实例到区域的索引；不要把两份独立可写的位置字段都当作权威值。

## 2. 区域与所有权

| 区域 | 顺序是否重要 | 主要规则 |
| --- | --- | --- |
| 玩家抽牌堆 | 是，记录堆顶 | 非拥有者不知道顺序；抽空且还需抽牌时洗混弃牌堆 |
| 玩家手牌 | 通常按抽入顺序保存 | 村庄/地下城行动时展示，休整时不自动公开；展示不需要移出手牌区域 |
| 玩家弃牌堆 | 是，至少保留堆顶 | 购买、击败怪物、升级后取得新牌都进入这里；通常不提前洗混 |
| 玩家控制区 | 视牌而定 | 例如展示后由当前玩家取得、以后可使用的宝藏 |
| 村庄供应堆 | 是，英雄等级分层 | 购买取堆顶；升级寻找下一等级，库存不足则非法 |
| 地下城抽牌堆 | 是 | 底部雷霆之石位置及洗牌结果必须可重放 |
| 地下城大厅 | 阶层 1、2、3；阶层 0 可多张守护者 | 阶层和进入时机决定光照、突破、全局效果与终局 |
| 疾病供应 | 可视为可再生成的逻辑供应 | 疾病数量无限；被摧毁的疾病返回该供应，不进入普通摧毁区 |
| 摧毁区 | 无 | 普通被摧毁牌本局不能再次使用，卡牌效果明确覆盖时例外 |
| 设置区 | 是或否，按设置效果 | 本局环境、场景和持续设置标记；随机设置牌完成设置后离开实际对局 |

`owner_player_id` 与区域分开：怪物在大厅时没有玩家所有者，击败后改归当前玩家并移动到其弃牌堆；玩家手牌中的怪物是玩家牌，不能再触发大厅中的战斗或突破效果。宝藏取得后在控制区而非弃牌堆。卡牌可以在原区域上改变可见性，例如手牌公开展示，而不改变“手牌中”的规则语义。

## 3. `GameState` 结构

```text
GameState
  match_id, game_version, catalog_version, ruleset_version, frozen_config_id
  player_order, first_player_id, active_player_id, turn_number, round_number
  phase, subphase, timing_window, chosen_action
  players: PlayerState[]
  zones: 各有序实例列表
  instances: instance_id -> CardInstance
  active_settings, continuous_effects, registered_triggers, scheduled_effects
  battle_context?, pending_choice?, resolution_frames[]
  rng_state, next_instance_sequence, next_event_sequence
  end_condition?
```

`PlayerState` 保存跨回合经验点和本回合的金币、额外购买次数等临时资源。金币的卡面值不直接累加到永久账户；村庄能力阶段之后才按仍在场的展示牌计算本次可用金币。`round_number` 只为需要“每轮”结算的变体保留，标准模式主要按 `turn_number` 和顺时针 `player_order` 运行。

`phase` 由[回合流程](04-turn-flow.md)和[地下城与战斗](05-dungeon-and-combat.md)定义；`timing_window` 标明回合/行动边界事件，不能只靠一个“当前回合”布尔值判断能力是否可发动。选择还没结束时，`pending_choice` 保存选择者、合法候选、数量约束、公开程度和继续执行的帧；`resolution_frames` 保存效果树运行位置。服务器恢复快照后不能需要重新猜测玩家此前的选择。

`end_condition` 保存终局事件、原因与发生时的状态版本。最终胜利点和赢家在**引擎的** `SETTLING` 阶段由终局快照求出，属于独立 `MatchResult`；不能在 `PLAYING` 中边修改牌区边保存半成品分数。房间何时重新开放由联机层决定。

## 4. 当前回合与战斗上下文

```text
TurnContext
  active_player_id, action, subphase
  revealed_instance_ids
  activation_count[(instance_id, ability_id)]
  temporary_gold, purchases_remaining, temporary_modifiers

BattleContext
  target_instance_id, target_rank_at_declaration
  participant_hero_ids, blocked_hero_ids
  equipped_weapon_by_hero, used_card_ids
  attack_components, magic_attack_components, light_components
  conditional_restrictions, pending_battle_destruction
  heroes_marked_for_turn_end_destruction, outcome?
```

这些是**结算上下文**，不是把最终攻击值永久写回卡牌。装备是否合法要随力量变化复核；武器脱落后失去加成，但某些“曾装备过”的条件仍可能成立，因此需要保留历史标记。地下城准备阶段摧毁的牌立即离场；战斗效果要求摧毁的牌可以先标记、留在本次战斗中，结束后再离场。英雄曾在战斗中力量到 0 的标记保留至回合末，即使力量恢复也不撤销。

`activation_count` 按实体牌与能力 ID 记录，防止同一回合重复使用普通能力；标为“重复”的能力可以多次发动，但每次重新校验费用和目标。牌离开手牌不应抹掉本回合已经使用过能力的事实。

## 5. 状态不变量

每次指令提交前检查至少以下条件：

1. 每个物化 `instance_id` 恰好出现于一个区域，区域内无重复 ID，实例引用的 `card_id` 在当前目录版本中存在。
2. 玩家抽牌堆、弃牌堆、手牌中的牌有正确所有者；大厅、地下城抽牌堆与未售出供应不被误记为玩家已拥有。
3. `pending_choice` 的选择者、候选和继续帧都存在；有待选择时不接受无关行动。对局结束后不再接受普通游戏指令。
4. 经验点不能在支付升级费用后变成负数；购买费用不超过本次可用金币；升级目标等级与供应库存有效。
5. 装备的武器和英雄实例存在、仍在有效作用范围；每件武器不同时装备给两名英雄。装备失效时移除收益，不凭空销毁武器。
6. 大厅阶段结束时阶层有序；补牌过程中允许短暂空缺，但必须有明确的继续帧或牌堆耗尽结果。
7. 阶层 0 只容纳规则允许的守护者。`end_condition` 一旦确认，不再接受普通行动或继续回合抽牌；最终结果只能从对应的终局快照计算。
8. 随机数状态、实例序列与事件序列随状态一起前进，重放时不依赖系统时间或 Python 全局随机数。

这些约束属于引擎正确性检查。允许具体卡牌或变体临时改变供应、区域去向、行动次数时，应通过显式规则修改和对应测试维护约束，而不是关掉检查。

## 6. 可见性与查询

状态本体保存完整信息，返回客户端时生成按玩家权限裁剪的视图。手牌在村庄或地下城行动开始后按规则公开；在此之前及休整时维持隐藏。牌库顺序始终隐藏，除非效果明确展示指定牌。事件也要分别生成公开版本和仅有关玩家可见的内容，见 [联机设计](07-multiplayer.md)。

所有效果的目标检索从状态中的**实例与区域**出发，再结合 `CardDefinition` 的类型、标签和数值筛选。例如“手牌中的英雄”包括带英雄标签的基础牌或村庄牌是否适用，应由该效果与规则约定判定，不简单地只查 `card_type=英雄牌`。
