# Game cards and Alt inspection

游戏区域通用的实体卡牌、程序翻面和 Alt 原图检视模块。玩家牌组、牌堆浏览、村庄和地下城都可以使用；不依赖玩家牌组、页面、网络或规则引擎。入口自动加载基础卡牌与检视样式，页面仍须先加载 `shared/styles/global.css`。

```ts
import {CardInteractions, createCardElements, createCardInspection} from './shared/components/game-card/index.js';

// 检视层放在游戏区外，避免打开模态窗口时一起被设为 inert。
const inspection = createCardInspection(document.getElementById('game-overlays')!);
const interactions = new CardInteractions(inspection.overlay, inspection.content);
const elements = createCardElements('TS-0592');
document.getElementById('dungeon-hall')!.append(elements.button);
const monster = interactions.add(elements, '树精');

// 正反面由展示状态决定；没有给玩家提供翻面按键。
monster.setFaceUp(false, false);

// 隐藏、移走卡牌或改变其祖先的 hidden/inert 后，刷新检视状态。
monster.setVisible(false);
interactions.refresh();

// 页面卸载时移除注册的卡牌、监听及检视层。
interactions.dispose();
inspection.dispose();
```

同一游戏区可以共用一个 `CardInteractions`，也可以按组件分别持有。各组件通过共享的悬停／焦点所属记录协调，整个页面只检视当前鼠标指向的牌；没有悬停牌时，才检视键盘聚焦的牌。`PlayerDeckArea` 已使用这套模块，不需要额外注册其内部卡牌。

检视使用捕获阶段的键盘监听。一旦本次 Alt 用于检视，即使鼠标移开、卡牌移除或组件暂停，也会取消该次松键的默认行为，避免漏拦截后进入浏览器菜单。输入控件、输入法组合输入及 Alt 组合快捷键不用于检视。窗口失焦仍立即关闭大图；若切换窗口导致松键事件丢失，下次按键会清除旧记录。浏览器菜单本身已取得焦点时，页面不能接收它的键盘输入，需要先按 Esc 或点击页面返回。

- `createCardElements(cardId, images?, descriptionId?)`：创建实体卡牌和固定的检视图片；可覆盖正面 URL 生成器和公用牌背 URL。
- `createCardInspection(host?, ids?)`：创建独立的检视覆盖层；默认挂到 `document.body`，可指定覆盖层／内容的 DOM ID。
- `CardInteractions.add(elements, name, faceUp?)`：注册任意区域的卡牌，自动挂载检视图片，返回 `PhysicalCard`。
- `setScope(element | null)`：模态窗口打开时，只接收该范围内的卡牌交互。
- `setSuspended(boolean)`：拖动、动画等期间暂停本组交互。
- `refresh()`：重新检查可见性、模态范围及检视对象。隐藏、未连接或位于 `inert` 区域内的牌不能被检视。
- `PhysicalCard.prepared`：图片准备结束的 Promise；图片失败通过 `failed` 标记。`setName`、`setVisible`、`setFaceUp` 仅改变展示状态。
- `CardStack(slot, counter, faceUp, options?)`：共用的牌堆侧边、顶牌与空牌位。`showTop(card | null)` / `setFaceUp(value)` 控制展示，`setCount(count)` 显示有限张数；`setCount(null)` 显示 `∞`，默认采用 8 张牌的厚度。`options.browse: false` 适用于隐藏地城牌堆，不暴露浏览入口。玩家牌组、地城和村庄供应均复用它。

按住 Alt 显示当前朝向的原尺寸卡图，不附带卡名、编号或印刷数值详情。正面存在状态时，在卡图右侧追加当前全部状态，按增益、减益、摧毁标记分组；状态栏高度取原图像素高度，长内容内部滚动且隐藏滚动条。Alt 检视期间，滚轮优先滚动过长的状态栏。无状态时只显示卡图，背面朝上只显示统一牌背。松开 Alt、移出卡牌、失焦或隐藏页面时收起。初始化时加载、解码固定图片，后续检视不更换 `src`。原尺寸超过视窗时，按住 Alt 滚动查看。

`PhysicalCard.setStatuses(statuses)` 同时更新右上角状态图标和检视侧栏。每项含 `kind`（`buff`、`debuff`、`destroy`）、`source_name`、`description` 与可选 `source_card_id`。内容以纯文本渲染；组件不计算效果、时点或数值。

`PhysicalCard.setAttachments(cards, images, onPick?)` 显示左下角附着牌组与数量；每项提供 `id`、`cardId`、`name`、`kind`。点击打开使用共享样式的浏览窗口，支持 Alt 检视，武器、囚禁、附着疾病等分开标明类型。`attachmentRect()` 给动画提供缩略牌组位置。组件仅展示关系，不改变卡牌的规则区域或所有权。

`PhysicalCard.setGlow(true / false)` 控制卡牌周围的光晕，独立于悬停、选中和翻面，用于提示效果的可选对象。光晕跟随卡牌外框尺寸，不改变卡图、检视原图或实例状态。默认使用主题金色，宿主可通过卡牌上的 `--card-glow-color` 自定义颜色；卡牌各区域均可使用此能力。
