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
| 疾病供应 | 不创建实体牌堆 | 疾病数量无限；取得时按本局权重生成新实例，被摧毁时移除实例，不进入普通摧毁区 |
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
  supply_rules: 基础牌与疾病的无限供应配置、疾病模式和抽取权重
  active_settings, continuous_effects, registered_triggers, scheduled_effects
  battle_context?, pending_choice?, resolution_frames[]
  rng_state, next_instance_sequence, next_event_sequence
  end_condition?
```

`PlayerState` 保存跨回合经验点和本回合的金币、额外购买次数等临时资源。金币的卡面值不直接累加到永久账户；村庄能力阶段之后才按仍在场的展示牌计算本次可用金币。`round_number` 只为需要“每轮”结算的变体保留，标准模式主要按 `turn_number` 和顺时针 `player_order` 运行。

已淘汰玩家保留在 `players` 和原始 `player_order` 中，以供存档与结算追溯；`eliminated`、`elimination_reason`、`eliminated_on_turn` 记录其状态。实际轮转与“其他玩家”效果只遍历仍在局中的玩家。淘汰者不再抽取新手牌、响应新选择或参与胜者比较；全员淘汰进入结算且无赢家。

`phase` 由[回合流程](04-turn-flow.md)和[地下城与战斗](05-dungeon-and-combat.md)定义；`timing_window` 标明回合/行动边界事件，不能只靠一个“当前回合”布尔值判断能力是否可发动。选择还没结束时，`pending_choice` 保存选择者、合法候选、数量约束、公开程度和继续执行的帧；`resolution_frames` 保存效果树运行位置。服务器恢复快照后不能需要重新猜测玩家此前的选择。

当前选择还包括数值／玩家／地下城选择、卡牌排序、效果升级和疾病替代。排序指令必须返回完整且无重复的候选排列。疾病替代帧保存同一实例的当前接收者、最终目的区及已使用来源，暂存疾病位于无所有者的 `pending:disease`；每次抽样只推进一次随机计数，不因重定向重新抽牌。

反应选择为 `effect_response`，保存受影响玩家、可用来源和转移阶段；法术重用为 `effect_reuse`，保存已使用法术及可选能力 ID。两者都可经 JSON 快照恢复，只有 `pending_choice.player_id` 能提交续接命令。

| 新增运行状态 | 用途与清理时点 |
| --- | --- |
| `copied_heroes[instance_id]` | 复制能力的模板和攻击替换策略；保留原卡定义，回合结束清除 |
| `borrowed_cards[instance_id]` | 原所有者和战后／回合末归还义务；已摧毁牌不归还 |
| `attachments[anchor_id]` | 囚笼、宝石和怪物下疾病的实例关联；实际卡牌仍各在唯一地区 |
| `registered_triggers[]` | 主动能力注册的本回合监听器及原绑定；命中一次性条件后或回合结束注销 |
| `continuous_effects[]` | 跨回合光照、强制地下城规则；记录创建回合和来源玩家下一回合的开始／结束期限 |
| `trap_responses[trap_id]` | 一张陷阱所有词条共用的免疫和转移结果；陷阱结算后清除 |
| `effect_collections` | 例如海德拉跨玩家展示后收集的候选；本次流程清理并在回合结束兜底清除 |
| `monster_reserve:*` 区域 | 虫群／兽潮逐张取用的实体怪物；地下城中的标记牌进入大厅时替换为下一张 |
| `used_supply_randomizers` | 风暴要塞补充供应时已使用的随机牌，防止重复选组 |

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
  battle_team?: {hero_instance_ids, support_instance_ids}
  excluded_participants
  equipped_weapon_by_hero, used_card_ids
  attack_components, magic_attack_components, light_components
  conditional_restrictions, pending_battle_destruction
  heroes_marked_for_turn_end_destruction, outcome?
```

这些是**结算上下文**，不是把最终攻击值永久写回卡牌。装备是否合法要随力量变化复核；武器脱落后失去加成，但某些“曾装备过”的条件仍可能成立，因此需要保留历史标记。地下城准备阶段摧毁的牌立即离场；战斗摧毁默认先标记、留在本次战斗中，结算后再执行，明确的立即摧毁和费用除外。英雄曾在战斗中力量到 0 的标记保留至回合末，即使力量恢复也不撤销。

`BattleDraft` 属于前端本地草稿，服务端只在 `SubmitBattleTeam` 完成装备事件和校验后写入 `battle_context.battle_team`。装备事件等待选择时，提交意图保存在可序列化工作流中；卡牌仍处于原手牌区。接口与作用域详见[战斗队伍接口](battle-team-api.md)。

实例的 `flags.turn_buffs` 保存回合状态，当前支持 `discard_instead_of_destroy`：包含 `buff`、`expires_after_turn`、`ability_id`、`source_instance_id`。状态跟随原英雄实例，离开手牌不清除，来源移除不撤销；它在回合末摧毁和补牌流程中仍有效，到移交回合前才移除。摧毁被替代为弃牌仍算支付了摧毁费用。实际执行或替代摧毁后，清除对应实例的待摧毁标记。

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

所有效果的目标检索从状态中的**实例与区域**出发，再结合 `CardDefinition` 的类型、标签和数值筛选。“手牌中的英雄”统一按“英雄”标签查找：所有英雄牌均显式带该标签，民兵和村庄英雄也适用；不根据大分类添加隐含标签。
