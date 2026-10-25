# PlayerDeckArea

原生 TypeScript 玩家牌组组件，负责两侧抽牌堆／弃牌堆、中间手牌／宝藏／旁置 Tab、操作响应区、牌堆浏览、E 原图检视和展示动画。样式随入口模块加载，颜色和字体复用 `shared/styles/global.css`。`game-probe` 是它的演示调用方。

牌堆浏览采用全局 [browse-dialog.css](../../styles/browse-dialog.css) 的共用弹窗样式与打开动画，与玩家牌区及英雄等级弹窗一致；组件只管理卡牌内容与弹窗交互。

## 挂载

页面先加载全局样式，并提供牌组及弹窗的挂载位置：

```html
<link rel="stylesheet" href="/src/shared/styles/global.css">
<main id="game"><div id="my-deck"></div></main>
<div id="deck-overlays"></div>
```

```ts
import {PlayerDeckArea, type PlayerDeckState} from './shared/components/player-deck-area/index.js';

const deck = new PlayerDeckArea(document.getElementById('my-deck')!, {
  overlayRoot: document.getElementById('deck-overlays')!,
  background: [document.getElementById('game')!],
  onSelectionChange: instanceIds => console.log('当前选中', instanceIds),
  onHandOrderChange: instanceIds => console.log('本地显示顺序', instanceIds),
  onBusyChange: busy => console.log('展示操作是否进行中', busy),
  onResponse: (responseId, choiceId) => console.log('玩家响应', responseId, choiceId),
});

const view: PlayerDeckState = {
  hand: [{id: 'CI-001', cardId: 'TS-0001', name: '民兵'}],
  draw: [{id: 'CI-002', cardId: 'TS-0002', name: '匕首'}],
  discard: [],
};
deck.setState(view);
deck.setResources({gold: 0, xp: 0}); // 手牌标题栏：叠币图标＋数字、XP＋数字。
// 生产前可追加由引擎提供的预估，显示 0(+10)；省略该字段隐藏括号。
deck.setResources({gold: 0, goldIncomePreview: 10, xp: 0});
// 非村庄时仅显示经验值；传 null 则隐藏整个资源栏。
// deck.setResources({xp: 3});
// 仅在调用方需要玩家响应时设置；初始响应区为空白。
deck.setResponse({id: 'turn-action', prompt: '回合开始：请选择行动', choices: [
  {id: 'village', label: '村庄'}, {id: 'dungeon', label: '地下城'}, {id: 'rest', label: '休整'},
]});

// 收到已确定的下一份展示数据后，也可以播放一次抽牌动画。
await deck.animateTo({hand: [...view.hand, view.draw[0]], draw: [], discard: []}, {
  kind: 'draw', instanceIds: ['CI-002'],
});

// 离开页面或卸载组件时调用；重复调用安全。
deck.dispose();
```

`overlayRoot` 默认使用 `document.body`；它应位于 `background` 区域之外，避免打开浏览窗口时一同被设为 `inert`。`background` 默认只暂停组件自身，页面可以传入整个游戏区和页头。多个组件默认生成不同的 DOM ID；检视窗口在鼠标悬停与键盘聚焦之间统一选择一个所属组件。

## 数据与边界

| 字段 | 含义 |
| --- | --- |
| `PlayerDeckCard.id` | 实例身份，同一组件生命周期内唯一；相同实例保持同一个 `cardId`。 |
| `PlayerDeckCard.cardId` | 图鉴／资产编号，可以有多张相同编号的实例。 |
| `PlayerDeckCard.name` | 无障碍标签使用的名称，可随快照更新。 |
| `PlayerDeckState.hand` | 当前手牌。组件保留已有牌的本地排序，新牌加入后按当前自动理牌设置显示。 |
| `PlayerDeckState.draw` | 当前展示的抽牌堆，首项为堆顶。浏览副本按 `cardId` 排序。 |
| `PlayerDeckState.discard` | 当前展示的弃牌堆，末项为堆顶。浏览副本按堆顶到堆底排列。 |
| `PlayerDeckState.treasures` | 可选的宝藏实例数组；有牌时显示手牌之后的“宝藏”Tab，省略或清空时隐藏。 |
| `PlayerDeckState.aside` | 可选的旁置实例数组；有牌时显示“旁置”Tab，排列在宝藏之后。 |
| `PlayerDeckState.revealed` | 可选的临时翻开实例数组；有牌时显示“翻开”Tab。宿主只传入观看者获准查看的牌，支持原位高亮和选卡。 |
| `PlayerAuxiliaryCard.faceUp` | 宝藏／旁置牌的朝向，默认 `true`。`false` 时桌面及 E 检视均只显示牌背。 |

组件复制输入数据，不修改调用方数组或卡牌对象；六个区域之间实例 ID 重复、缺失或改换卡牌身份会被拒绝。自动理牌只作用于手牌，按 `cardId` 升序，同编号的已有实例保留相对顺序。手牌数量没有 probe 的 30 张限制。历史恢复可能在不同分支复用实例编号，此时宿主须调用 `resetState` 清理旧卡面缓存，不能按普通快照更新处理。

初始仅显示“手牌”Tab。新出现的宝藏／旁置不会自动抢占当前视图；当前 Tab 对应的牌全部移走时回到手牌，并处理被隐藏的键盘焦点。切换保留手牌顺序与选中状态，收起旧区域的检视，不重建卡图。Tab 支持左右方向键、Home／End；抽牌堆和弃牌堆始终在两侧。宝藏和旁置使用同样的独立／重叠布局和 E 检视，当前仅手牌支持选择及手动排序。

选中、手动排序、自动理牌开关和动画进度属于本地展示状态。组件不导入游戏引擎、页面模块或网络客户端，也不自行抽牌、弃牌、洗牌、生成实例或判断规则。实际对局数据由服务端维护，正式页面通过 `pages/match/table-state.ts` 传入允许展示的投影；probe 传入本地演示数据。

## 接口

| 接口 | 行为 |
| --- | --- |
| `setState(snapshot, options?)` | 直接显示新快照并中断旧动画；已打开的牌堆浏览视窗同步更新卡牌、排序、张数和空状态，保留滚动位置及仍存在的焦点牌。默认保留仍在手牌中的选中和显示顺序。 |
| `resetState(snapshot)` | 用于新对局或历史恢复。关闭浏览、清理旧卡面和事件绑定，重置选择、装备展示和局部排序；保留用户自动理牌偏好。 |
| `options.clearSelection` | 清除选中，用于重置演示等场景。 |
| `options.resetHandOrder` | 放弃现有手动顺序，采用输入顺序；开启自动理牌时仍排序。 |
| `options.closeBrowser` | 显式关闭浏览视窗，适用于用户重置演示等操作；普通外部快照保持视窗打开。 |
| `openPileBrowser('draw' \| 'discard')` | 打开指定牌堆的浏览视窗；忙碌或已经浏览时忽略。 |
| `animateTo(snapshot, {kind, instanceIds})` | 播放 `draw`／`discard` 移动；移动实例必须在前后快照对应的来源和目标区域中。最终状态在开始时确定。 |
| `shuffleTo(snapshot)` | 用当前弃牌堆的至多 6 张视图播放洗回动画，再显示调用方给出的最终快照；不计算随机次序。 |
| `destroyTo(snapshot, ids)` | 将指定已拥有的牌移至中央、放大并消散；支持手牌和牌堆中的卡牌，实例须离开所有拥有区域，实际摧毁由宿主先完成。 |
| `animateSequence(final, steps)` | 顺序播放 `discard`、`draw`、`shuffle`、`destroy`、`gain`、`upgrade`、`transfer` 步骤；每步包含宿主提供的区域快照及相应实例 ID。整个队列持续忙碌，中断直接显示 `final`。 |
| `setSelectedIds(ids)` | 同步宿主决定的手牌参战／选中标记；须为当前手牌中不重复的实例 ID，不触发用户选择回调。 |
| `setHighlightedIds(ids)` | 给指定手牌实例添加周围光晕；与选中独立，移出手牌自动取消，不自行决定卡牌是否合法。 |
| `setBattleDisplay({mandatoryIds, equipment})` | 紫色边缘标记强制选中牌；将武器缩小附在英雄左下方，右上角留给状态图标。装备／卸下时同一张已解码卡牌在两处平滑移动并缩放，约 220ms；相同映射不重播。仅改变显示，不移出手牌，规则及参战标记仍由宿主提供。 |
| `setStatusOverrides(map \| null)` | 宿主提供的本地手牌状态投影，用于勾选参战后的即时持续效果；按实例复制，清除后恢复快照原状态。手牌移到其他牌区后不再使用该投影，组件不计算加成。 |
| `setCardTargets(ids, selected)` | 效果目标在原宝藏／旁置区域及抽牌、弃牌浏览窗口中发光并显示选中。含目标的牌堆顶牌提示可进入浏览；非当前玩家牌区 Tab 高亮。通过 `onCardTargetClick` 返回目标，不创建候选区域。 |
| `setInteractionLocked(locked)` | 公共动画期间锁定点击、拖拽、浏览、Tab 和响应按钮；组件内部仍可播放已确定的动画。 |
| `receiveTreasure(snapshot, id, origin)` | 展示已获得的宝藏，从指定屏幕位置飞入宝藏区，自动切换到宝藏 Tab。 |
| `closeBrowser()` | 关闭牌堆浏览并结束当前手势／动画，供退出对局等生命周期处理使用。 |

| `setAutoSort(enabled)` | 开关自动理牌；忙碌或浏览窗口打开时不更改设置。 |
| `activeTab` / `setActiveTab('hand' \| 'treasures' \| 'aside')` | 查询或切换本地显示 Tab；不可用或忙碌时返回 `false`。 |
| `setResponse(response \| null)` | 设置阶段提示与可选操作，或用 `null` 清空；始终保留牌区 Tab 右侧、自动理牌左侧的空白占位。 |
| `selectedIds` / `handOrder` | 按显示顺序返回选中实例／全部手牌实例 ID 的新数组。 |
| `autoSortEnabled` / `isBusy` / `isBrowsing` | 当前自动理牌、展示忙碌和浏览状态。 |
| `root` | 组件根元素，可用于布局和应用集成。 |
| `finish()` | 撤销未松手的拖动；已确定的动画立即完成。 |
| `dispose()` | 完成清理，移除自身 DOM、弹窗、事件、尺寸监听和待完成动画。销毁后不能继续更新。 |

`PlayerResponse.isCurrentTurn` 在响应区最左侧显示“你的回合”小旗帜；选项的 `tone` 可为 `gold`、`violet`、`blue`、`red`，文字标签始终保留，红色用于结束回合。`PlayerDeckOptions.onHandCardClick(instanceId)` 可处理手牌点选，返回 `true` 时消耗点击，不再切换普通选中状态；拖拽、牌堆浏览、隐藏或禁用的区域不会触发此回调。正式页用它接收休整的摧毁目标。

`PlayerResponse.combat` 接收 `{attack, magicAttack, light}`，以剑、书本和提灯图标显示数值；可选 `versusTarget` 提供同结构的目标预估值，在原数字后以括号显示。`battlePreview` 接收 `{outcome, rank, total}`，`outcome` 支持 `win`、`loss`、`cannot_attack` 和 `unknown`；未知结果用问号，并由宿主通过 `prompt` 提供“有效果待执行”。`error` 在响应区中央用红字及 `role="alert"` 展示操作失败信息。组件仅负责展示，不计算规则。`PlayerResponseChoice.pressed` 可独立表示“使用效果”等临时模式按钮的状态。装备附着不会影响手牌库存或实例 ID，拖动英雄时附着武器同步移动；`setActiveTab(tab, {duringAnimation: true})` 供宿主在动画锁定时主动展示效果目标所在区。

摧毁表现分为约 300ms 的移入中央和约 980ms 的粒子消散。`card-dissolve.ts` 适配 [Vanilla Disintegrate](https://github.com/uvarov-frontend/vanilla-disintegrate) 的底层粒子入口，将现有卡图绘制为有圆角的临时 Canvas，再由 WebGL2 按原图颜色拆成颗粒；不截图整个 DOM，也不请求新卡图。分辨率上限为 2 倍 CSS 像素，并限定纹理与渲染面积。完成或取消时释放纹理、临时画布与渲染节点；库自行复用少量 WebGL 上下文。许可保存在 `public/licenses/vanilla-disintegrate.txt`。WebGL 不可用时，`card-shards.ts` 用共享图片背景构成 35 块边缘相接的不规则纸片，错开时序散开；这条路径不依赖 Canvas 或 WebGL。

新的 `setState`／`animateTo` 可以中断旧展示，迟到的图片解码和动画完成回调不会覆盖新数据。缩放、失焦、页面隐藏或离开也会结束当前展示；系统减少动态效果设置生效时直接显示结果。

`animateSequence()` 也支持外部来源的 `{kind: 'gain', instanceIds, origins, destination?, state}` 步骤：`origins` 按新实例 ID 提供 `left`、`top`、`width`、`height`，均为屏幕 CSS 像素；卡牌必须是先前各牌区都不存在的新实例，`destination` 可为 `hand`、`draw`、`discard`，默认弃牌堆。组件复用飞牌动画，不操作供应、金币或规则。正式页面通过 `PublicTableArea.supplyCardRect(cardId)` 在供应更新前捕获顶牌坐标，结合已提交的获得事件构建步骤。减少动态效果、浏览中断、新快照和卸载遵守与抽弃牌相同的收敛规则。

已有卡牌跨区移动使用 `{kind: 'transfer', source, destination, instanceIds, state}`，区域为 `hand`、`draw`、`discard`、`treasures`、`aside`。实例必须存在于原区域及目标快照的对应区域；手牌抽取／弃牌复用原有队列，其余移动按实际牌堆或卡片位置飞行。来源或目标是 Tab 时由展示组件切换，规则状态由宿主提供。临时揭牌不属于这五个区域，由页面的事件适配层处理，组件不推断规则中的隐藏区域。

升级使用 `{kind: 'upgrade', sourceInstanceId, targetInstanceId, state}`：原实例必须从手牌移出，新实例此前不存在并进入弃牌堆。约 320ms 将原卡移到屏幕中央并放大，1000ms 播放旋转光环、汇聚粒子、亮光和新卡显现，再以 300ms 飞入弃牌堆。两张卡分别使用各自固定的已解码图片，保持实例和卡牌定义身份不变；不复用摧毁动画。`upgrade-motion.ts` 管理时间轴及中断，`upgrade-energy.ts` 生成有数量上限的临时特效，使用浏览器原生 [Web Animations API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Animations_API)，无需新增依赖。新快照、失焦、隐藏、调整窗口或卸载会清理动画；减少动态效果、浏览状态或渲染失败时直接显示权威结果。

浏览视窗打开时，`animateTo`／`shuffleTo` 收到的外部更新直接同步最终状态，不在弹窗背后播放动画。已移走的牌立即退出浏览和检视；若被移走的牌正有键盘焦点，焦点回到关闭按钮。关闭后聚焦当前牌堆顶牌或空牌位。视窗只保留标题、张数及卡图，不显示操作／排序提示，牌堆顶牌也没有悬停提示。

查看宝藏／旁置时，抽弃牌更新直接显示最终状态，避免将卡牌飞入隐藏的手牌面板；不会切换正在查看的 Tab。卡牌移动及拖拽归位期间暂时禁用 Tab 和响应按钮。

### 响应区

响应区默认留白，保留布局位置。`PlayerResponse` 包含 `id`、`prompt` 及可选的 `choices: {id, label, disabled?}[]`；省略选项或传空数组时只显示阶段提示。可通过 `selectedId` 标明某项选择，或用 `disabled` 禁用整组；未设置 `selectedId` 时按钮作为普通操作，不渲染持续选中状态。

输入会被复制，选项 ID 必须唯一；替换或清除响应后，旧按钮不再触发回调。组件只调用 `onResponse(responseId, choiceId)`，显示哪些内容、何时清空或进入下一提示由调用方控制。清空或改为纯提示后，如果原响应按钮持有焦点，则焦点返回当前牌区 Tab。

```ts
deck.setResponse(null); // 空白，等待后续流程。
deck.setResponse({id: 'dungeon-preparation', prompt: '地下城准备：可使用能力并调整出战选择。'});
deck.setResponse({id: 'rest-choice', prompt: '休整：可选择 1 张手牌摧毁，或直接结束回合。', choices: [
  {id: 'destroy', label: '摧毁选中手牌', disabled: deck.selectedIds.length !== 1},
  {id: 'end-turn', label: '结束回合'},
]});
```

`game-probe` 的外部测试面板提供“演示回合开始／休整提示／阶段提示／清空响应区”。行动选择完成后清空或切换到休整提示；休整示例随手牌选择更新按钮，只确认显示，不摧毁卡牌、不推进真实回合，也不调用引擎。

E 检视使用独立的 [game-card 通用模块](../game-card/README.md)。其他游戏区域可注册自己的卡牌，与玩家牌组共享同一套检视行为及所属协调。

### 事件与资源选项

- `onSelectionChange(ids)`：选中变化或新快照删除了被选中的牌。
- `onHandOrderChange(ids)`：玩家完成手动拖拽；只是本地显示顺序。
- `onAutoSortChange(enabled)`：用户或调用方修改自动理牌开关。
- `onBusyChange(busy)`：移动、洗回、拖动或归位开始／结束，便于调用方暂时禁用操作。
- `onResponse(responseId, choiceId)`：玩家点击当前可用响应选项；不自动提交规则命令。
- `images.front(cardId)`、`images.back`：自定义正面图片 URL 生成器和公用牌背 URL，默认使用 `/cards/`。
- `notice`、`descriptionId`：可复用页面既有的错误提示元素和快捷键说明。
- `idPrefix`：自定义实例 ID 前缀；`elementId(key)` 可适配既有页面的 DOM 钩子，probe 用它保留原 ID。

两张光标及 CC0 授权位于 `cursors/`。平时统一使用斜向指示手，只有卡牌真实拖动或公共桌面平移标记出现时才变握手；松开立即恢复。原图和牌背保持固定图片元素并只解码一次，翻面由展示逻辑控制，玩家没有翻面快捷键。

## 内部组织

- `player-deck-area.ts`：对外接口、局部显示状态与各视图的组合。
- `view.ts`：组件自己的 DOM、无障碍关联和弹窗挂载。
- `card-tabs.ts`：动态 Tab、键盘导航和空区域回退。
- `response-area.ts`：受调用方控制的响应提示、按钮和禁用状态；`PlayerResponse.progress` 提供行动名、阶段名、步骤及总数，显示于回合标记右侧。组件不推断阶段和规则。
- `resources.ts`：受调用方控制的金币与 XP 计数，位于响应区和自动理牌之间。`setResources({xp, gold?, goldIncomePreview?})` 的现值接受非负整数，可选预估增量接受有符号整数并要求同时提供 `gold`。预估显示为较小的括号，如 `0(+10)`、`4(-2)`；省略预估则隐藏括号，省略 `gold` 隐藏金币，`null` 隐藏整个资源栏。仅显示调用方提供的权威值，不从手牌或卡文估算；叠币图标使用 [Lucide Coins](https://lucide.dev/icons/coins)，复用现有 ISC 授权，无新依赖。
- `types.ts` / `model.ts`：数据契约、验证、复制及稳定排序。
- `hand-area.ts` / `hand-layout.ts`：手牌布局、尺寸监听和有界拖拽。
- `pile-browser.ts`：浏览副本与焦点管理；牌堆侧边和顶牌复用 `../game-card/card-stack.ts`。
- `../game-card/`：固定图片、悬停、E 检视、程序翻面及状态标记，由所有游戏区域复用。`PlayerDeckCard.statuses` 传给 `PhysicalCard.setStatuses()`；每项含 `kind`（`buff`／`debuff`／`destroy`）、`source_name`、`description` 与可选 `source_card_id`。仅有对应状态时显示右上角图标，悬浮说明使用纯文本，牌背隐藏。组件不判断或产生游戏状态。
- `card-motion.ts` / `shuffle-motion.ts`：只移动既有视图的视觉动画。
- `equipment-motion.ts`：装备与卸下的 FLIP 位置及尺寸过渡，连带手牌让位；中断、失焦、卸载时取消动画并保留最终布局，尊重减少动态效果偏好。
- `upgrade-motion.ts` / `upgrade-energy.ts` / `upgrade-motion.css`：旧英雄到新英雄的进化时间轴、粒子与光环，仅处理展示。
- `style.css`：组件范围内的样式；共用光标状态已移至 `shared/styles/game-cursor.css`，由 `game-card/` 入口加载，`.game-cursor` 可用于外层游戏区域。
