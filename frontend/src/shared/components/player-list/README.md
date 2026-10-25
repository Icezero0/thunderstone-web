# PlayerList

独立的玩家列表与牌区浏览组件。负责圆形头像、名称、“你”与当前回合标记，以及他人手牌／抽牌堆／弃牌堆弹窗。使用全局主题、共用浏览弹窗动画和游戏光标，不依赖公共桌面、村庄、页面代码、网络或规则引擎。

## 挂载

页面先加载 `shared/styles/global.css`；组件入口加载自己的作用域样式及卡牌依赖。调用方提供容器和当前观察者可见的完整快照。

```ts
import {PlayerList} from './shared/components/player-list/index.js';

const players = new PlayerList(document.getElementById('players')!, {
  overlayRoot: document.getElementById('game-overlays')!,
  background: [document.getElementById('game')!],
  onBeforeOpen: () => {
    // 调用方在此结束桌面手势、关闭其他浏览弹窗。
  },
});
players.setPlayers([
  {id: 'alice', name: '阿莉丝', isYou: true, isActive: true, avatarUrl: '/api/v1/users/avatars/example.png'},
  {id: 'bob', name: '鲍勃', cards: {
    hand: [{id: 'opaque-hand-1', revealed: false},
      {id: 'CI-102', cardId: 'TS-0003', name: '火把', revealed: true}],
    draw: [{id: 'CI-103', cardId: 'TS-0001', name: '民兵'}],
    discard: [{id: 'CI-104', cardId: 'TS-0002', name: '匕首'}],
  }},
]);

// 用于调用方的显式打开操作；列表中点击自己始终无响应。
players.openPlayer('bob', 'discard');
players.closePlayer();
players.showActivity('bob', '展示了手牌'); // 默认 4.5 秒，新消息覆盖旧消息。
players.clearActivity();
// 离开展示或卸载。
players.finish();
players.dispose();
```

默认 `overlayRoot` 为 `document.body`，`background` 为组件自身。完整牌桌应传入整个游戏背景；覆盖层必须位于背景之外。组件拥有自己的列表根节点和覆盖层，卸载只移除自己创建的内容。默认 ID 自动生成，多实例不冲突；`idPrefix` 或 `elementId(key)` 可保留调用方原有 DOM 钩子。

## 接口与数据

| 接口／字段 | 含义 |
| --- | --- |
| `setPlayers(players)` | 验证、复制并更新完整玩家快照；无效输入不会部分修改列表或已打开窗口。空数组隐藏列表并关闭已移除玩家的窗口。 |
| `PlayerListPlayer.id` / `name` | 唯一玩家标识和纯文本显示名称；数组顺序决定竖排顺序。 |
| `isYou` / `isActive` / `avatarUrl` | 可选的己方身份、当前回合标记和头像 URL；头像缺失或加载失败时显示默认轮廓。 |
| `cards.hand` | 每张牌必须有实例 `id` 和 `revealed`；己方或已公开牌还必须有 `cardId`、`name`。 |
| `cards.draw` / `cards.discard` | 无序卡牌清单，每张含 `id`、`cardId`、`name`；两者均按卡牌 ID 排序展示，相同定义按实例 ID 排序。 |
| `root` | 列表根节点；调用方负责它在牌桌中的位置和可用尺寸。 |
| `openPlayer(id, zone?)` | 打开指定玩家牌区，默认 `hand`；显式 API 可查看己方，列表点击自己无响应。 |
| `closePlayer(restoreFocus = true)` | 关闭窗口，默认恢复入口焦点；父组件协调弹窗时可传 `false`。 |
| `isBrowsing` / `browsingPlayerId` | 当前窗口是否打开、正在查看的玩家 ID（否则 `null`）。 |
| `finish()` | 清理悬停和 E 检视，保留当前窗口及快照。 |
| `showActivity(playerId, text, durationMs = 4500)` | 在对应玩家行旁向左展开气泡；使用纯文本并替换当前气泡，正数时长结束后移除。列表不判定何时显示或是否为自身消息 |
| `clearActivity()` | 取消当前气泡、入场动画及消失计时器 |
| `dispose()` | 幂等卸载，关闭弹窗、恢复背景状态、释放卡牌视图、监听器和覆盖层。 |

`cards` 未提供时仍显示玩家，但浏览窗口提示数据尚未提供；不伪造空牌堆。卡牌实例 ID 必须在该玩家三个牌区中唯一。快照会清除未公开对手手牌的名称与定义编号，正面图不进入 DOM 或卡图提供器；公开状态撤回时立即释放旧正面和检视大图。

窗口内数据随 `setPlayers()` 更新，保留仍存在的卡牌视图、焦点和滚动位置；改名、换头像、玩家重排与回合标记也同步更新。玩家移除会关闭对应窗口。Esc、遮罩和关闭按钮、Tab 焦点循环及牌区方向键导航均由组件管理。打开窗口前调用可选 `onBeforeOpen(id, zone)`，让调用方协调其他弹窗；组件不依赖其他区域的实现。

默认独立背景为全局深色标题栏配色；`--player-list-background` 可由所在牌桌覆盖。窄屏保留竖排列表，把各项头像和名称上下排列。卡图与牌背可通过 `images.front(cardId)`／`images.back` 覆盖，E 检视与其他卡牌区域共用当前检视对象。

标题固定，玩家条目在剩余高度内滚动，滚动条隐藏，条目不压缩或溢出容器。气泡挂在滚动列表外层，依据玩家行位置更新；列表滚动和尺寸变化时重新定位，目标行完全移出可见范围时暂时隐藏，回到可见范围且消息尚未过期时重新显示。卸载及消息清除时释放定位监听器和尺寸观察器。

气泡参考 [Radix Themes 的浮层](https://www.radix-ui.com/themes/docs/components/tooltip)和 [Floating UI 的圆角箭头](https://floating-ui.com/docs/floatingarrow)：单一暖白底色、轻阴影、圆角与圆润 SVG 尾角，没有顶条、金色侧线或分区装饰。配色和字体引用项目变量；只借鉴视觉设计，沿用已有定位和生命周期，无需安装组件库。消息始终以纯文本显示，尾角不参与读屏，保留向左展开动画及减少动态效果支持。

## 职责与接入边界

- `player-list.ts`：公开 API、生命周期与调用方协调。
- `rows.ts`：按玩家 ID 保留列表元素、头像和点击入口。
- `activity-bubble.ts`：独立于桌面平移缩放的临时气泡、入场动画、替换与自动清理。玩家移除、页面隐藏及卸载时清除。
- `player-browser.ts` / `player-browser-view.ts`：牌区弹窗、卡牌视图、焦点和检视。
- `model.ts` / `types.ts`：快照契约、复制、排序和可见性检查。
- `view.ts` / `style.css`：组件 DOM 和作用域样式。

[PublicTableArea](../public-table-area/README.md) 组合本组件，负责右侧摆放、完整牌桌快照验证及与英雄预览的互斥，并提供 `showPlayerActivity`／`clearPlayerActivity` 转发。probe 的示例数据和定时公开按钮留在页面中；正式对局由 `pages/match/player-activity.ts` 将新的公开事件与回合变化转换为消息。本组件不判定何时公开手牌，也不维护权威游戏状态。

`tests/player-list.test.mjs` 直接验证独立挂载、多实例、隐私、原子更新、宿主背景与卸载；`tests/player-browser.test.mjs` 和 `tests/public-table-area.test.mjs` 保留 probe 及公共视窗的组合回归。

## 玩家目标选择

setPlayerSelection(ids) 开启玩家目标选择：仅给传入玩家 ID 高亮并启用点击，其他条目禁用；点击触发 onPlayerClick(id)，不打开牌区浏览窗口。传入 null 退出，恢复普通浏览及“自己不可点击”的行为，空数组表示暂时禁用全部目标。候选与网络忙碌状态由宿主提供，组件不判断卡牌规则。PublicTableArea 同名方法将此状态转交给玩家列表。
