# Dungeon and village areas

公共游戏区域的独立展示组件。复用 `game-card/` 的实体卡牌、牌堆纸张侧边和 Alt 检视；接收投影快照，不导入规则引擎、玩家牌组、网络客户端或页面代码。入口加载自身样式，页面先加载 `shared/styles/global.css`。

英雄等级弹窗使用全局 [browse-dialog.css](../../styles/browse-dialog.css) 的共用标题栏、遮罩和打开动画，本组件只保留等级对照的网格、库存与顶牌标记样式。

完整的地下城／村庄公共视窗使用上层 [PublicTableArea](../public-table-area/README.md) 挂载；它统一组合本模块、独立桌面、Tab、复位和玩家列表。只有需要单独展示某个区域时才直接使用以下两个组件。

## 挂载

```ts
import {DungeonArea, VillageArea} from './shared/components/table-areas/index.js';

const options = {
  overlayRoot: document.getElementById('game-overlays')!,
  background: [document.getElementById('game')!],
};
const dungeon = new DungeonArea(document.getElementById('dungeon')!, options);
const village = new VillageArea(document.getElementById('village')!, {
  ...options,
  onTakeTop: selection => {
    // selection: pileId, cardId, name, level?, infinite。
    // 调用方负责购买条件、实例创建及正式命令，并回传新快照。
    console.log(selection);
  },
});

dungeon.setState({
  environment: {id: 'ENV-1', cardId: 'TS-0193', name: '荆棘森林'},
  dungeons: [{id: 'main', name: '主地下城', deckCount: 27, hall: [
    {rank: 1, card: {id: 'CI-101', cardId: 'TS-0592', name: '刺脊魔狼'}},
    {rank: 2, card: null}, {rank: 3, card: null},
  ]}],
});
village.setState({piles: [
  {id: 'amazon', name: '亚马逊', kind: 'hero', cards: [
    {cardId: 'TS-0354', name: '亚马逊弓箭手', level: 1, count: 6},
    {cardId: 'TS-0355', name: '亚马逊女猎手', level: 2, count: 4},
    {cardId: 'TS-0356', name: '亚马逊女王', level: 3, count: 2},
  ]},
  {id: 'torch', name: '火把', kind: 'basic', cards: [{cardId: 'TS-0003', name: '火把', count: null}]},
]});

// 页面卸载时清理 DOM、监听和弹窗。
dungeon.dispose(); village.dispose();
```

`overlayRoot` 默认是 `document.body`，须放在 `background` 以外。`background` 默认是当前组件自身，完整牌桌应传入整个游戏区域，防止弹窗打开时仍操作其他区域。`idPrefix` 默认生成唯一前缀；`images.front` / `images.back` 可以覆盖图片来源。卡牌与供应快照会被复制，修改调用方对象不会改变显示。

两块区域均提供 `setVisible(boolean)`；隐藏时收起该区域的 Alt 检视，村庄同时关闭供应浏览，不清除库存或已加载卡图。`setInteractionSuspended(boolean)` 可在桌面平移等操作期间暂停悬停和检视。probe 在“公共视窗”内为两块区域分别使用独立的 [TableViewport](../table-viewport/README.md)，Tab 切换时保留各自位置，玩家牌组和右侧玩家列表固定在桌面外。

## 地下城模型

| 字段 | 含义 |
| --- | --- |
| `DungeonState.environment` | 可选的公开环境牌；`null` 或省略时隐藏整个环境面板及槽位。有牌时在地下城左侧的独立面板中展示，上方写“环境”；双地下城也共用一张，支持 Alt 检视。 |
| `DungeonState.dungeons` | 本局的地城列表。普通场景传一个地城；飞龙尖塔由调用方传入两个独立地城。 |
| `DungeonLane.id` / `name` | 地城标识和无障碍名称；桌面不再重复显示地下城或分区标题。 |
| `DungeonLane.deckCount` | 牌堆剩余张数。组件只显示统一牌背，不需要提供隐藏牌序、顶牌编号或牌堆内容。 |
| `DungeonLane.hall` | 大厅阶层及其正面公开卡牌。每项为 `rank` 和 `card`；`card: null` 表示空阶层。 |
| `TableCard.id` / `cardId` / `name` | 公开牌的实例标识、资产编号及名称。实例标识在当前环境牌和所有大厅之间唯一。 |

`DungeonArea.root` 是无边框的布局层，环境面板与地下城面板是两个独立容器。飞龙尖塔的两组牌堆与大厅在地下城面板中上下排列，环境面板位于左侧。牌堆上方标为“地下城”，每组大厅按阶层降序排列，越靠近牌堆阶层越高。模型仍按数值升序规范化，始终补出 `1`、`2`、`3` 的位置；`0`、`4` 等额外阶层由调用方提供，可随效果出现或移除。组件不推断环境或卡牌效果，不自行补怪、移动守护者或生成地城。当前不展示虫群／兽潮的备用位置，标记抽出后的替换由规则引擎处理。

## 村庄模型

| 字段 | 含义 |
| --- | --- |
| `VillageState.piles` | 英雄、村庄、基础供应列表。 |
| `SupplyPile.id` / `name` | 供应标识和显示名称。 |
| `SupplyPile.kind` | `hero`、`village` 或 `basic`，决定供应分区与展示方式。 |
| `SupplyPile.cards` | 同一个牌堆按卡牌定义聚合的库存。英雄和拥有“英雄”标签的村庄牌可有多个等级；普通村庄和基础供应各有一种卡牌。 |
| `SupplyCard.cardId` / `name` | 该库存的资产编号与名称。 |
| `SupplyCard.count` | 该等级／卡牌的剩余张数。有限供应是非负整数；基础供应必须为 `null`，表示无限。 |
| `SupplyCard.level` | 普通英雄供应的等级是正整数；村庄英雄允许 0 级（如精锐民兵）。不限定三级，支持二级或四级等系列。 |
| `SupplyCard.tags` | 可选的卡牌标签。村庄供应含“英雄”标签时，也启用英雄等级预览并要求提供有效等级。基础供应不启用等级预览。 |

供应从上到下按英雄、村庄、基础分区，每行最多四堆，多出的自动换行。每堆上方左侧显示供应名称（英雄为系列名），右侧显示总数量，不显示分类标题或顶牌等级。

英雄供应按等级从低到高形成一堆。当前顶牌是最低且仍有库存的等级；该等级用尽后，新快照使下一等级成为顶牌。供应总量是所有等级剩余数量之和。

英雄供应及带“英雄”标签的村庄供应响应点击：点击顶牌或空牌位打开等级对照视窗，按等级并排放大展示卡面上的数值与能力；每列标出等级、名称、剩余张数，当前点击供应的顶牌突出显示。已用尽的等级仍可检视，二级或四级系列按实际等级展示，窄屏自动换行。预览高等级牌不会使其成为可购买对象。只有传入 `onTakeTop` 才显示选择按钮，按钮始终请求当前点击供应的顶牌；`takeLabel` 可以定制按钮文字。普通村庄和基础供应点击无操作，也不声明弹窗入口，但保留悬停和 Alt 原图检视。

村庄扒手（`TS-0301`，1 级，5 张）和村庄强盗（`TS-0300`，2 级，3 张）在村庄区组成同一个“村庄盗贼”供应牌堆，共 8 张。该供应使用 `kind: 'village'`，两个等级放在同一 `cards` 数组，均带 `tags: ['盗贼', '英雄', '村庄']` 及实际 `level`。扒手在上层，强盗在下层；扒手用尽后才露出强盗。点击牌堆可并排对照两级，库存与当前顶牌随快照更新。组件通过标签识别村庄英雄，复用普通英雄的排序、预览和取顶牌逻辑，不硬编码卡牌编号。

基础供应显示 `∞`，按 16 张模拟纸张厚度，数据中的 `count` 仍为 `null`；获得基础牌不减少库存或改变厚度，正式的新实例由调用方创建。有限库存同样不由组件扣减，调用方收到规则结果后调用 `setState()`。

正式购买交互可通过 `onSupplyClick(selection)` 接管非空供应顶牌的单击：返回 `true` 阻止默认英雄预览，其他返回值保留默认行为。`setPurchaseOptions([{cardId, price}])` 接收宿主提供的可购顶牌及结算价格，只显示发光提示，不在卡面叠加价格标签；传空数组清除。高等级卡在下层时不会因编号匹配而发光，顶牌与库存变化后提示跟随快照更新。组件不计算金币、购买次数或卡牌效果；`PublicTableArea` 转发这两个接口，公共桌面的拖动结束仍拦截点击。

`topCardRect(cardId)` 返回当前可见供应顶牌的屏幕边界，供调用方在快照更新前记录飞牌起点；隐藏区域、已移除区域、空供应或非顶牌返回 `null`。`inert` 仅锁定交互，不影响获取动画起点；事件时间线在锁定公共区域后仍需调用 `focusSupply()` 定位供应。上层 `PublicTableArea.supplyCardRect()` 同时检查当前 Tab。坐标来自实际卡面，包含桌面平移、缩放和悬停浮起，不传递供应的隐藏牌序。

`openSupply(pileId)` 可由调用方打开英雄或村庄英雄供应浏览，其余供应不响应；`isBrowsing` 可查询浏览状态。外部 `setState()` 会同步打开的浏览视窗，包括数量、顶牌、等级卡图和售罄状态；供应被移除或失去英雄身份时关闭。Esc、关闭和点击遮罩可退出；窗口内支持 Tab 焦点循环、Alt 原图检视，关闭后聚焦当前顶牌／空牌位。

## 大厅动画

`DungeonArea.animateTo(state, afterLayout?)` 对现有卡牌、阶层标题及地下城牌堆执行补位动画。新增阶层淡入；移除的阶层使用临时空槽淡出，不复制已经离场的怪物卡面。`finish()` 清理飞牌、补位和临时槽位。公共视窗在 `afterLayout` 中刷新镜头边界，再测量新位置；惯性输入锁定不阻止布局更新。屏幕坐标换算成桌面局部坐标后再执行补位，避免缩放时位移放大。

正式对局的事件编排由 `pages/match/event-timeline.ts` 负责：判定胜负后先处理延后摧毁，再让怪物离场；击败的怪物飞到获得者牌区，`monster_returned_to_deck` 或返回牌堆底部的移动效果播放大厅到地下城的飞牌，然后调整阶层和补位。`hall_rank_count` 是引擎在该事件时点给出的普通阶层数量，前端不根据怪物卡文推断容量。阶层 0 单独增减。连续版本才重放事件，同版本不重播，中断直接恢复权威快照。

## 演示与验证

`pages/game-probe/public-demo-state.ts` 保存固定示例，普通英雄张数来自卡牌目录，村庄盗贼使用已确认的 5 张扒手、3 张强盗。`public-demo-controller.ts` 组合两块区域，场景选择包含无环境的普通地下城、荆棘森林及飞龙尖塔（含对应环境卡），另有阶层 0／4 开关；未修改目录或规则。

probe 的“演示与测试”面板位于牌桌外，提供供应下拉选择和“演示取顶牌”按钮，把所选供应顶牌的新演示实例放进玩家弃牌堆，不计算金币、升级条件或其他效果。有限库存扣减后立即回传给供应组件，基础供应保持无限。“重置供应”恢复示例库存。probe 内的供应浏览仅展示各级卡面与数量，不放置演示按钮；通用组件仍保留 `onTakeTop` 接口。所有演示均为本地数据，不写入正式对局。

测试：`tests/table-areas.test.mjs` 覆盖最小／额外阶层、双地城、环境面板、隐藏牌背、Alt、英雄等级排序及售罄切换、无限供应、弹窗同步与清理。使用现有前端测试和构建命令，无新增依赖。
