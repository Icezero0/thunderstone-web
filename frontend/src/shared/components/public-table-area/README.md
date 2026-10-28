# PublicTableArea

公共游戏区域组件，组合地下城、村庄、两个独立可平移桌面、Tab、复位按钮及右侧 [PlayerList](../player-list/README.md)。本组件负责公共桌面布局和子区域协调；玩家列表与牌区弹窗由独立的 PlayerList 管理。不依赖页面结构，不调用网络、数据库或游戏引擎。

玩家牌区及英雄等级弹窗共用全局 [browse-dialog.css](../../styles/browse-dialog.css) 的外观与打开动画，也与玩家自己的抽牌堆／弃牌堆浏览一致。窗口内切换牌区或同步卡牌不重播动画。

村庄内可从空白处或任意供应牌堆按住左键平移视窗；移动达到 5 像素才开始平移并切换抓握光标。默认情况下，英雄供应（包括村庄盗贼）在阈值内点击松开时打开等级预览，其他供应单击不响应。宿主可用 `onSupplyClick` 接管单击用于购买；拖拽结束会拦截该次点击，不购买也不打开预览。平移期间暂停悬停和 空格 检视，松开后恢复。

地下城的环境、地下城牌堆以及所有大厅阶层（包括 0、4）同样支持左键拖动视窗；单击大厅卡牌仍通过 `onHallCardClick` 交给调用方，拖拽结束时拦截该次点击。飞龙尖塔的上下两座地下城使用同样行为。

## 挂载

页面先加载 `shared/styles/global.css`，组件入口自动加载自身和底层组件样式。父容器负责公共区的可用高度及牌桌背景，例如 `height: 480px; display: grid; min-height: 0`。卡牌尺寸可通过父级 `--public-card-width` 设置，默认 112px。

```ts
import {PublicTableArea} from './shared/components/public-table-area/index.js';

const board = new PublicTableArea(document.getElementById('public-board')!, {
  overlayRoot: document.getElementById('game-overlays')!,
  background: [document.getElementById('game')!],
  onTabChange: tab => console.log(tab),
});

board.setState({
  dungeon: {dungeons: [{id: 'main', name: '主地下城', deckCount: 27, hall: [
    {rank: 1, card: {id: 'CI-101', cardId: 'TS-0592', name: '刺脊魔狼'}},
    {rank: 2, card: null}, {rank: 3, card: null},
  ]}]},
  village: {piles: [{id: 'village-thief', name: '村庄盗贼', kind: 'village', cards: [
    {cardId: 'TS-0301', name: '村庄扒手', count: 5, level: 1, tags: ['盗贼', '英雄', '村庄']},
    {cardId: 'TS-0300', name: '村庄强盗', count: 3, level: 2, tags: ['盗贼', '英雄', '村庄']},
  ]}]},
  players: [{id: 'alice', name: '玩家 1', isYou: true, isActive: true}, {id: 'bob', name: '玩家 2'}],
});

board.setTab('village');
board.openSupply('village-thief');
// 页面离开时停止手势；实际卸载时清理 DOM、覆盖层、监听器及尺寸观察。
board.finish();
board.dispose();
```

`overlayRoot` 默认 `document.body`，组件在其中创建并拥有独立覆盖层容器；它须位于 `background` 之外，避免弹窗一起被禁用。`background` 默认仅当前组件根节点。完整牌桌应传入包含其他游戏区域的父容器，弹窗打开时统一暂停交互。默认 ID 自动生成唯一前缀，同页可挂载多个实例。

## 状态与接口

| 字段／接口 | 含义 |
| --- | --- |
| `PublicTableState.dungeon` | [DungeonState](../table-areas/README.md)；包括可选环境和一个或多个地下城。隐藏牌堆仅提供数量。 |
| `PublicTableState.village` | [VillageState](../table-areas/README.md)；包含英雄、村庄及无限基础供应，保留所有英雄等级和已售罄等级。 |
| `PublicTableState.players` | 可选的玩家列表；按数组顺序竖排，不显示编号。每项为 `id`、`name`，可含 `isYou`、`isActive`、`avatarUrl`、`cards`。省略或空数组隐藏整个侧栏。 |
| `root` | 组件拥有的公共区域根节点。 |
| `setState(snapshot)` | 提交完整公开快照。先验证并复制所有区域，再更新 DOM；无效输入不会留下部分更新。 |
| `activeTab` | 当前 `dungeon` 或 `village`。 |
| `setTab(tab)` | 切换桌面，保留各自位置、缩放和已加载卡图；关闭玩家浏览，隐藏村庄时关闭英雄弹窗。 |
| `isBrowsing` | 是否正在打开英雄等级或玩家牌区弹窗。 |
| `openSupply(pileId)` | 切到村庄，打开指定英雄或村庄英雄供应的等级预览；普通供应不打开弹窗。 |
| `setPurchaseOptions([{cardId, price}])` | 高亮匹配的当前顶牌，不在卡面叠加价格标签；空数组清除。不会推算购买权限或修改库存。 |
| `setStatusOverrides(map \| null)` | 将宿主的本地持续效果投影显示到地下城大厅及环境牌的状态图标和 空格 检视中；不重新布局牌桌。空数组清除该牌状态，`null` 恢复权威快照。 |
| `setTabAttention(tabs)` | 未激活且包含待响应目标的公共桌面 Tab 高亮，不自动切换桌面。 |
| `setCardTargets(ids, selected)` | 在玩家原有浏览窗口标出授权目标，通过 `onCardTargetClick` 回传；不会公开隐藏手牌身份或牌堆次序。 |
| `supplyCardRect(cardId)` | 返回村庄当前可见顶牌的屏幕坐标，用于宿主在快照更新前捕获飞牌来源；隐藏、空堆或非顶牌返回 `null`。不返回隐藏牌序。 |
| `openPlayer(playerId, zone = 'hand')` | 查看该玩家的 `hand`、`draw` 或 `discard`，与英雄弹窗互斥。也可直接点击侧栏头像／名称打开。 |
| `browsingPlayerId` / `closePlayer()` | 当前浏览的玩家 ID（否则 `null`），以及关闭并恢复玩家入口焦点。 |
| `closeBrowsers()` | 关闭玩家与英雄浏览、恢复背景交互并结束手势，适用于退出、取消或失去访问权限。 |
| `options.onHallCardClick(card)` | 大厅卡片点击回调，供宿主选择攻击目标；不自动发送命令或改变规则状态。 |
| `visibleHallCardRect(instanceId)` | 只在地下城 tab 激活、对应卡面与视窗和屏幕相交时返回屏幕坐标，供疾病等来源动画使用；其余返回 `null`。 |
| `resetView()` | 恢复当前桌面的初始位置和 150% 缩放，另一桌面不变。 |
| `showPlayerActivity(playerId, text, durationMs?)` / `clearPlayerActivity()` | 在右侧对应玩家条目旁显示向左展开的临时气泡，或清除；默认 4.5 秒，消息及触发时点由调用方决定 |
| `refresh()` | 重新测量当前可见桌面；外层容器重新显示或手动调整尺寸后可调用。 |
| `finish()` | 结束手势、释放指针捕获、清理悬停与检视，保留当前视野和库存。 |
| `dispose()` | 幂等卸载：关闭弹窗并恢复 `inert`，释放尺寸观察和事件，移除自有 DOM 与覆盖层。 |

状态更新不会替调用方购买、升级、补大厅、生成实例或推进回合；牌堆数量和公开卡面全部来自快照。当前 Tab 与相机位置属于本地展示状态，不写入对局状态。供应更新时，已打开的等级预览同步更新库存、顶牌及售罄标记，继续复用已解码卡图。玩家按 ID 保留对应视图，支持改名、顺序调整和当前玩家变化；名字始终以纯文本显示。

## 玩家头像与牌区

`avatarUrl` 指向圆形裁切的头像图片；省略或加载失败时显示默认人物轮廓。玩家名称旁保留“你”和当前回合标记。自己的列表条目仅展示信息，点击无操作且不进入 Tab 焦点；自己的手牌与牌堆直接在底部玩家牌组区域操作。其他玩家入口采用原生按钮，支持键盘操作；打开牌区后可切换手牌、抽牌堆、弃牌堆，卡牌按网格展示且支持 空格 检视，卡图下不显示名称和编号。

```ts
const opponent = {
  id: 'bob', name: '玩家 2', avatarUrl: '/avatars/mage.svg',
  cards: {
    hand: [
      {id: 'opaque-hand-1', revealed: false},
      {id: 'CI-102', revealed: true, cardId: 'TS-0003', name: '火把'},
    ],
    draw: [{id: 'CI-103', cardId: 'TS-0001', name: '民兵'}],
    discard: [{id: 'CI-104', cardId: 'TS-0002', name: '匕首'}],
  },
};
```

- 每张手牌必须提供独立的 `revealed: boolean`。查看自己（`isYou: true`）时显示全部手牌；查看别人时仅 `revealed: true` 的牌显示正面。自身及已公开手牌必须有 `cardId`、`name`；未公开对手手牌只需不透露定义的实例 ID 和 `revealed: false`。
- 未公开手牌的名称和定义编号在快照复制时被丢弃，不交给卡图提供器；小图和 空格 原图都使用统一牌背。公开状态撤回或观察者身份变化时，旧正面视图及原图会释放，不留在隐藏 DOM 中。
- `draw`、`discard` 是可查看的卡牌清单，组件复制后统一按卡牌 ID 排序，相同定义按实例 ID 排序；不展示、改变或通过排列传递实际牌堆顺序。自身底部弃牌堆浏览的原有顺序保持其独立定义。
- 窗口打开期间，`setState()` 同步手牌公开状态、卡牌移动、牌堆数量和头像名称；保留仍存在的卡牌视图、焦点及滚动位置。玩家被移除时关闭窗口。空牌区显示空状态；未提供 `cards` 时显示数据尚未提供。
- `revealed` 属于每局每个手牌实例的运行时投影字段，不是 `cards.csv` 的卡牌定义字段。组件由调用方传入当前观察者可见的快照，不判定哪些游戏事件应公开手牌。正式接入时由服务端记录公开状态并提供相应投影，隐藏手牌不发送定义编号或名称，抽牌堆清单不发送实际顺序。

probe 的己方牌区跟随底部玩家牌组变化，己方名称和头像由页面读取当前登录账号；未登录时使用示例身份，登录账号没有头像时使用默认人物轮廓。其他玩家使用本地演示快照和 `public/avatars/` 下的 SVG。账号请求及刷新生命周期留在页面的 `profile-binding.ts` 中，组件只接收快照。外部“测试手牌公开同步（2 秒）”会打开玩家 2 的手牌窗口，2 秒后公开第一张手牌，窗口即时显示其正面。

## 选项

- `initialTab`：默认 `dungeon`，也可从 `village` 开始。
- `onTabChange(tab)`：实际切换时通知调用方，初始化或重复设置当前 Tab 不回调。
- `onTakeTop(selection)` / `takeLabel`：沿用村庄供应的可选动作接口。未传回调时等级弹窗仅预览。组件不扣减库存，由调用方提交命令并回传新快照。
- `onSupplyClick(selection)`：任意非空供应顶牌的单击回调；返回 `true` 接管点击，返回 `false` 或不返回则继续默认英雄预览。当前 `pileId`、`cardId`、`level`、`infinite` 由组件快照提供；宿主仍须核对权威合法选项。
- `images.front(cardId)` / `images.back`：自定义卡图来源。
- `idPrefix`：自定义实例 ID 前缀。
- `elementId(key)`：旧页面的 DOM ID 适配钩子；通常不需要设置。probe 在页面自己的 `element-ids.ts` 中保留原有钩子。

## 交互与内部职责

`setHallSelection(highlightedInstanceIds, selectedInstanceIds)` 和 `setSupplySelection(highlightedCardIds, selectedCardIds)` 将调用方授权的候选／选中状态同步到大厅或供应顶牌；刷新快照后仍应用到当前对应卡面。它们只负责展示，不决定目标或购买是否合法。正式页用这两个接口完成效果点选和战斗目标选择；购买价格继续独立使用 `setPurchaseOptions()`。

`hallCardRect(id)`、`dungeonDeckRect(laneId)`、`playerRect(playerId)` 提供当前展示位置，`hideHallCard(id)` 隐藏正在移出的顶面；`animateDungeon(snapshot)` 将已确定的大厅快照以补位／翻牌方式展示。调用方决定顺序、卡牌归属和最终快照，组件不抽牌或执行陷阱。`finish()` 立即结束当前公共动画，正式页的跨区域队列负责同步最终牌桌及玩家库存。

地下城和村庄各有一个 [TableViewport](../table-viewport/README.md)，初始缩放 150%，默认居中，边界外预留 240px 平移余量，以鼠标为中心进行 80%～250% 滚轮缩放。左键可拖空白处、牌堆和公共卡牌，中键拖任意位置，方向键平移，Home 恢复默认位置及 150% 缩放。切换 Tab 支持左右键、Home／End；复位按钮和玩家列表固定在移动内容之外。鼠标拖动时使用抓握光标，停止立即恢复斜向指示手。

地下城和村庄卡牌由 [table-areas](../table-areas/README.md) 渲染；空格 检视复用 [game-card](../game-card/README.md) 的跨区域协调，同一时刻只显示一个大图。公共区独立使用时也加载共享光标样式，不要求同时挂载玩家牌组组件。复位按钮沿用 Lucide `focus` 定位图标及现有 ISC 授权文件。

- `public-table-area.ts`：对外接口、Tab、相机和子区域生命周期。
- `view.ts`：自有 DOM、无障碍关联、定位图标和覆盖层容器。
- [player-list](../player-list/README.md)：独立玩家列表、快照复制、牌区浏览与生命周期；本组件只负责组合和弹窗互斥。
- [player-avatar](../player-avatar/index.ts)：设置页、房间、列表与窗口共用的圆形头像及加载失败回退。
- `model.ts` / `types.ts`：完整公开快照的契约、复制及验证。
- `style.css`：组件作用域内的布局和响应式样式。

`tests/fixtures/game-probe/public-demo-controller.ts` 只保存场景、示例库存及演示按钮，把快照交给本组件。测试面板与示例玩家数据均留在页面层；组件中没有测试控件。`tests/public-table-area.test.mjs` 验证独立挂载、多实例、原子更新、视野保持、弹窗同步、回调及卸载；`tests/player-browser.test.mjs` 验证头像、手牌隐私、排序、公开状态同步和玩家窗口生命周期。原 probe 和桌面测试继续覆盖已验收交互。
