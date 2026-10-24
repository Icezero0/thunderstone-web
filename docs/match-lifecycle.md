# 正式对局：开局、回合、保存与恢复

## 本阶段范围

房间全员准备后，由房主开始对局。后端冻结规则配置、玩家列表及卡牌目录，调用共享 TypeScript 引擎进行 setup，并将结果保存到 SQLite。`/match?id=<match_id>` 展示每位参与者各自可见的开局状态。

页面支持飞龙尖塔分配、村庄购买和英雄升级、休息、能力发动、效果选择及地下城战斗。后端接收限定类型的操作，读取自己的权威状态后执行；客户端不提交完整状态。浏览器只在战斗准备中调用共享引擎进行无状态预览。

## 使用流程

1. 分别运行 `backend/run_backend.bat` 和 `frontend/run_frontend.bat`，打开 `/play`。
2. 两个账号加入同一房间；房主保存配置，所有玩家准备。
3. 房主选择随机先手或指定列表中的玩家，再点击“开始游戏”。玩家顺序沿用本次冻结的房间玩家列表。
4. 若飞龙尖塔需要分配，房主将两个怪物组分到地下城 A，其余进入 B；每组地下城特征也可分配到 A 或 B。其他玩家能查看候选内容及等待状态。
5. 完成后，双方看到同一公共牌桌，以及各自的手牌。点击卡牌可查看卡图、文字与数值。
6. 刷新、断线重连或重启后端后，从数据库恢复同一局。设置未完成时，恢复原来的分配候选。
7. 轮到自己时选择村庄、地下城或休息，操作区按当前阶段列出可执行动作。效果要求另一位玩家响应时，原回合暂停，指定玩家完成选择后继续。
8. 地下城准备中选择参战英雄、法术／支援牌、装备及目标。点击调整立即刷新本地预览；确认队伍才正式提交战斗。所有选中的牌仍在手牌里。
9. 自然结束后显示胜负和积分，房间恢复等待、清空准备状态。房主也可中途取消；两种情况都保留对局记录和玩家列表。

后端启动时自动执行数据库迁移：`0004` 创建对局记录，`0005` 增加 `finished` 状态。迁移保留已有账号、房间及玩家数据。

## 职责划分

| 层 | 职责 |
| --- | --- |
| `backend/app/api/v1/matches.py` | 解析认证请求、调用服务、提交后发送变化通知 |
| `backend/app/modules/matches/` | 权限、并发与幂等、持久化、按玩家生成视图 |
| `backend/app/integrations/game_engine/api.py` | 调用 setup／回合／预览入口，提供引擎与效果版本信息 |
| `engine/` | 组局、回合流程、卡牌效果、战斗计算、结束条件和计分 |
| `frontend/src/pages/match/` | 牌桌、设置分配、回合操作、效果选择、本地战斗预览和结算展示 |

前端通过已有 API 客户端和 WebSocket 连接获取更新。变化通知只携带 ID 与版本；页面重新读取经过鉴权的玩家视图。

## 持久化

### `matches`

保存房间关联、房主、冻结玩家列表、版本、创建及更新时间，以及：

- `status`：`setup_pending`（等待设置分配）、`active`（进行中）、`finished`（已结算）、`cancelled`（已取消）。
- `setup_request`：完整的引擎设置输入，包括服务端生成的私密随机种子和已确认分配。
- `setup_choice`：待完成的飞龙尖塔分配候选。
- `state`／`events`：完整权威状态及累积引擎事件，仅留在后端。
- `catalog_snapshot`：本局卡牌定义和设置索引，用于暂停后的确定性恢复。
- `engine_version`／`effects_version`：本局使用的计算实现和效果定义版本。实现发生变化后拒绝继续执行旧局；房主仍可取消并按新版重新开始。

`rooms` 新增 `active_match_id`，状态扩展为 `waiting / playing / closed`。开局及游戏期间锁定成员、配置及准备操作；取消或自然结算后恢复等待状态。

### `match_commands`

以用户 ID 和 `command_id` 标识一次操作，保存操作类型、目标、请求摘要及该用户的成功响应。相同操作重试返回原响应，重复请求不会再次洗牌、购买或执行能力；复用同一个 ID 提交不同内容会返回冲突。

写入采用 `expected_version` 检查。对局、房间和幂等记录在同一事务内保存，通知在提交后发送。客户端收到版本冲突时重新读取当前视图。

## HTTP 接口

所有接口使用现有访问令牌认证，玩家身份由账号确定。

| 方法与路径 | 请求 | 响应 |
| --- | --- | --- |
| `POST /api/v1/rooms/{id}/start` | `{expected_version, command_id, first_player?}` | 当前用户的 `MatchView` |
| `GET /api/v1/matches/current` | 无 | `{match: MatchView \| null}` |
| `GET /api/v1/matches/{id}` | 无 | 参与者自己的 `MatchView` |
| `POST /api/v1/matches/{id}/setup-choice` | `{expected_version, command_id, group_a_ids, group_a_feature_ids}` | 完成设置后的 `MatchView` |
| `POST /api/v1/matches/{id}/commands` | `{expected_version, command_id, command}` | 操作后当前用户的 `MatchView` |
| `POST /api/v1/matches/{id}/cancel` | `{expected_version, command_id}` | 已取消的 `MatchView` |

开始操作中的 `expected_version` 是房间版本；设置选择和取消操作使用对局版本。`first_player` 默认为 `{"mode":"random"}`；指定时为 `{"mode":"fixed","user_id":123}`，该用户必须在当前房间中。

飞龙尖塔的 `group_a_ids` 恰好包含两个不同的候选怪物组；`group_a_feature_ids` 是分到 A 的特征子集，可以为空。B 自动取剩余候选。重试使用首次生成并保存的种子、配置和目录，不重新抽取候选。

### 局内命令

`commands` 使用 `MatchView.version`，与引擎内部的 `game_version` 分开。后端校验登录用户是否为当前行动者或效果指定的响应者，再注入引擎玩家 ID 和版本。客户端不能填写 `player_id`、引擎 `expected_version`、随机种子或状态。

```json
{
  "expected_version": 3,
  "command_id": "one-operation-unique-id",
  "command": {"type": "ChooseAction", "action": "village"}
}
```

| 操作 | 命令 |
| --- | --- |
| 选择行动 | `ChooseAction` |
| 村庄 | `FinishAbilities`、`BuyCard`、`FinishBuying`、`UpgradeHero`、`FinishUpgrading` |
| 休整第一阶段 | `RestDestroy`、`SkipRestDestroy` |
| 三种行动结束回合 | `FinishTurn`（仅 `ACTION_END`） |
| 地下城准备 | `ActivateAbility`、`UseSpell`、`EquipWeapon`、`AssignDiseasePenalty`、`AssignStrengthPenalty`、`SubmitBattleTeam` |
| 效果选择 | `ResolveChoice`、`ResolveValueChoice`、`ResolveCardOrder`、`ResolveEffectOrder`、`ResolveEffectPurchase`、`ResolveEffectUpgrade`、`ResolveReusedAbility` |
| 响应与疾病替代 | `ResolveResponse`、`ResolveDiseaseReplacement` |

`ActivateAbility` 也用于村庄能力阶段。选择窗口的候选项、数量限制和可跳过标记来自 `legal_commands`；前端不自行推断规则。数值选择保留原 JSON 类型，排序必须提交完整排列。

`SubmitBattleTeam` 的 `command.draft` 仅接受 `hero_instance_ids`、`support_instance_ids`、`equipment`、`target_instance_id` 四个可编辑字段。引擎版本、目录版本、玩家及当前状态版本由服务端补全。浏览器从当前视图的 `battle_preparation` 调用 `updateBattleDraft` / `previewBattleTeam`；新版本到达时重新生成准备上下文。预览不会执行随机效果、付费、抽牌或能力。正式提交后仍由服务器重算，并可能暂停等待战斗效果选择。

## 玩家视图

`projection.py` 按明确字段构造响应，不复制完整状态后再删除私密字段。

- **公共信息**：参与者当前显示名与头像、当前玩家、淘汰状态、回合摘要、大厅及阶层、环境、供应数量、英雄所有等级（含售罄等级）的库存、疾病供应类型及权重、各玩家牌区数量和已控制卡牌。
- **牌堆清单**：各玩家的抽牌堆和弃牌堆提供按卡牌 ID 排序的清单；他人的清单使用无序展示 ID，不提供真实实例 ID。地下城隐藏牌堆仍仅提供张数。
- **手牌公开**：他人手牌逐实例提供 `revealed`。引擎的 `turn_hand_public` 使当前回合玩家的整手牌公开，从回合开始前的行动选择窗口起生效，回合内新增手牌也公开；回合末补牌开始前撤回整手公开，直到下一次自己的回合。`cards_shown`／`dungeon_hand_revealed` 提供单牌公开记录，即使处于回合外也保留至离开手牌或再次抽取。未公开牌只有不透明的展示 ID，无卡牌 ID，不加载正面图；刷新和重连直接恢复权威公开状态。
- **本人信息**：自己的手牌、弃牌、旁置牌实例，以及按卡牌 ID 排序的抽牌堆清单；本人弃牌堆保留真实顺序，以便自顶向下浏览。
- **设置选择**：已公开、需要分配的怪物组和特征；仅房主可以提交。
- **局内选择**：所有人知道正在等待哪位玩家；具体合法命令、选择候选及能力说明只提供给该玩家。
- **战斗准备**：只给当前行动者本人手牌、公开大厅和相关计算规则，不包含他人的隐藏手牌或任何牌堆顺序。
- **事件与结算**：按字段白名单展示操作摘要、明确展示的卡牌以及最终分数；原始事件和结算逐卡实例表留在后端。
- **卡牌目录**：仅带出上述视图引用的卡牌定义，图片通过 `/cards/<card_id>.png` 加载。

响应不包含他人未公开手牌身份、任何抽牌堆顺序、地下城隐藏牌序、随机种子、完整实例表、解释器续帧或原始开局事件。开局事件含洗牌顺序及初始手牌，不能直接作为公共日志发送。`player_deck_shuffled` 的公共摘要仅提供事件序号和玩家 ID，供展示洗牌动画，不含洗牌结果。

## 正式牌桌

`/match` 使用与 `/game-probe` 相同的 `PublicTableArea` 和 `PlayerDeckArea`。`table-state.ts` 将参与者视图适配为展示快照，`table.ts` 负责组件组合与操作回调，不实现游戏规则。

- 公共区以地下城／村庄 Tab 切换，可拖动平移、滚轮缩放与复位；环境、双地下城和阶层 0／4 跟随实际状态。
- 玩家列表显示真实名称与头像，点击其他玩家浏览其牌区。自己的抽牌／弃牌浏览、手牌排序、Alt 检视、宝藏／旁置 Tab 复用现有组件；打开的窗口随权威快照更新。
- 手牌响应栏显示当前阶段、回合行动与阶段结束操作。“行动与战斗”栏及打开入口目前暂时隐藏，内部能力、购买、升级、装备、效果选择和结算逻辑保留，等待逐项审核后接入新的效果交互；疾病供应、公开控制区与事件记录放在下方折叠区。
- 自己的回合以响应区左侧小旗帜标记，其右显示行动名及当前步骤（例如“访问村庄 · 4/6 购买卡牌”）。村庄的六步为展示手牌、使用村庄效果、生产金币、购买卡牌、升级英雄、结束回合；地下城的五步为展示手牌、构建战斗队伍、宣言战斗、结算战斗、结束回合；休整的两步为摧毁手牌、结束回合。展示、金币生产和无需选择的结算仍自动执行，不额外要求点击；暂停的入口事件由 `turn.resolving_event` 识别，其他步骤由 `chosen_action`、`subphase` 和 `timing_window` 映射。
- 行动按钮分为铜金（访问村庄）、淡紫（进入地下城）、浅蓝（休整）。休整第一阶段显示“摧毁手牌／跳过”；选择摧毁后仅合法候选手牌发光，点击一张提交 `RestDestroy`，播放中央放大消散动画。摧毁或跳过都进入第二阶段，仅显示红色“结束回合”。每回合至多摧毁一次；再次点“摧毁手牌”可取消选牌。三种行动都等待 `FinishTurn`，再复用同一条弃手牌、按需洗牌和补抽六张的动画序列。候选来自服务端，普通点击和理牌不会隐式摧毁卡牌。
- 休整第一阶段不显示常驻的“可摧毁一张手牌或跳过”提示，点击摧毁后才提示选择手牌。规则中的展示手牌阶段与原编号保留，自动完成。其他玩家看到当前回合玩家条目旁向左展开的气泡：“展示了手牌”；休整摧毁则显示“摧毁了 卡牌名称”。消息默认 4.5 秒消失，新行动／阶段消息覆盖旧气泡；自身操作不显示自身气泡，同版本刷新不重播，首次载入不会回放旧操作。消息来自公开视图与增量事件，组件不决定规则。probe 外部测试面板提供展示、摧毁气泡演示。
- 地下城准备时点击手牌调整英雄和支援的参战标记，点击大厅怪物选择目标；装备在操作栏分配。本地共享引擎逐次预览，提交后服务器重新校验，卡牌始终保留在手牌中。
- 抽牌、弃牌和洗回动画只展示服务器已经确定的结果；回合结束依次播放全部手牌弃牌、抽取剩余牌、必要时洗回、继续补牌。连续快照、窗口切换和重连以最新状态为准。桌面相机、手牌排列和弹窗属于本地展示状态。

摧毁事件公开：`card_destroyed` 的参与者日志包含卡牌 ID 及能从原区域确定的所属玩家，卡名可从公开目录解析；不发送私有实例记录或区域数据。动画从已知的本人手牌实例与权威结果中定位被摧毁的牌；完全相同卡面的移除无法唯一辨识时直接使用最新快照。

## 验证

使用临时 SQLite 数据库和进程内 HTTP 客户端验证，不启动监听服务。测试覆盖权限、准备状态、并发写入、重试幂等、飞龙尖塔暂停／续接、效果选择、取消后重新配置、进程重建后恢复、成员视图隔离及已有数据库迁移。`test_match_playthrough.py` 从真实账号和房间开始，完成购买、休息、战斗、自然结算和再次开局，不注入或修改引擎状态。

```powershell
.\.venv\Scripts\python.exe -B -X utf8 -m unittest discover -s backend/tests/modules -t .
npm run typecheck --workspace @thunderstone/frontend
npm run build --workspace @thunderstone/frontend
npm test --workspace @thunderstone/frontend
```

2026-10-24 验证结果：完整后端 **1,668 项**、共享引擎 **123 项**、前端 **57 项**测试通过；两个 TypeScript 包的类型检查和前端生产构建通过。构建后的 `/match`、`/play` 及其 JS／CSS 经进程内 HTTP 请求验证。前端测试直接执行页面 bundle，覆盖全部选择类型、参战预览、请求重试、响应顺序及同版本恢复。浏览器连接工具未能启动，本轮没有完成实际浏览器视觉验收。

更新后由用户重启前后端，后端启动自动迁移到 `0005`。本轮共享引擎实现版本已变化；旧局会保留可查看的状态，但无法继续执行命令，可由房主取消并重新开局。

