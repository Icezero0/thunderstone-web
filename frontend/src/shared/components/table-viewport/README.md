# TableViewport

用于游戏桌面的平移与缩放视窗。视窗固定大小、裁切超出内容，桌面保留原始布局尺寸，通过二维位移与可选的缩放展示不同范围，不依靠嵌套滚动区域。100% 时只保留整数像素位移。

公共游戏区域由上层 [PublicTableArea](../public-table-area/README.md) 组合两个本组件，并管理 Tab、复位和卡牌交互；本模块继续负责通用相机操作，不依赖上层组件或页面。

```ts
import {TableViewport} from './shared/components/table-viewport/index.js';

const camera = new TableViewport(viewport, desktop, {
  centerContent: true, // 能放下的方向默认居中，超出的方向从起始边显示。
  panPadding: 240, // 内容边界外留出手动调整视野的余量。
  zoom: {min: .8, max: 2.5, initial: 1.5}, // 80%～250%，初始与复位为 150%。
  onPanningChange: active => {
    dungeon.setInteractionSuspended(active);
    village.setInteractionSuspended(active);
  },
});
camera.focusArea(areaContainer); // 可选：定位到该桌面内的某个区域。
camera.reset(); // 恢复默认位置和配置的初始缩放；也可由外部复位按钮调用。
// 离开页面时清理事件、指针捕获和 ResizeObserver；桌面 DOM 由调用方管理。
camera.dispose();
```

`viewport` 使用 `.table-viewport`，其直接子元素 `desktop` 使用 `.table-desktop`。入口加载基础样式；桌面内容由调用方决定。切换 Tab 和复位按钮不放进会移动的 `desktop`。空格 检视等固定覆盖层同样应挂在桌面外，因此大图保持原始尺寸。

## 操作

- 左键拖动空白处，在任意方向平移。按钮、卡牌和输入控件默认保留左键操作；控件设置 `data-pan-start` 可同时支持点击和左键拖动视窗，`data-no-pan` 优先禁止左键平移。地下城的环境、大厅卡牌和牌堆，以及村庄的所有供应牌堆均允许左键平移；大厅卡牌单击保留目标选择，英雄供应单击仍打开等级预览。
- 鼠标中键可从卡牌上开始平移，同时阻止浏览器中键自动滚动。
- 移动达到 5 像素才视为拖动，届时才捕获指针；阈值内松开仍保留原控件的点击目标。拖动后的点击被拦截，下一次正常卡牌点击不受影响。
- 游戏区域的光标根据 `data-panning="true"` 切换为抓握手，松开或取消立即恢复。
- 按 空格／Ctrl／Meta 时不开始平移。平移期间通过回调暂停卡牌悬停和检视，结束后恢复。
- 启用缩放后，滚轮以鼠标所在位置为中心缩放；支持像素、行、页三种滚轮单位。空格／Ctrl／Meta、输入控件或 `data-no-zoom` 内的滚轮保留原行为。缩放边界按实际显示尺寸计算，拖动距离始终按屏幕像素计算。
- 聚焦视窗本身后，可用方向键移动；Shift 加大步长，Home 恢复默认位置和配置的初始缩放（开启居中时回到居中位置）。键盘聚焦视窗外沿之外的卡牌时，自动平移使其进入可视范围。
- 松开、Esc、失焦、页面隐藏、指针取消或捕获丢失时停止平移，保留已移动的位置。打开模态窗口后，`inert` 区域不能继续平移。

## 接口

| 接口 | 用途 |
| --- | --- |
| `position` | 当前桌面 `{x, y}` 位移的新对象。 |
| `zoom` | 当前缩放比例，初始取 `options.zoom.initial`，省略时为 `1`。 |
| `isPanning` | 是否已越过阈值并正在平移。 |
| `panTo(x, y)` | 直接移动并限制在桌面边界内。 |
| `setZoom(zoom, anchorX?, anchorY?)` | 按限定范围缩放，锚点是视窗内的屏幕坐标，默认视窗中心；未启用缩放时忽略。 |
| `reset()` | 恢复当前内容的初始位置和配置的初始缩放。 |
| `focusArea(element, margin = 24)` | 定位到桌面内的指定区域，默认保留 24 像素边距。 |
| `refresh()` | 内容／视窗尺寸改变后重新计算边界，钳制当前位置。 |
| `finish()` | 停止当前手势，保留位置。 |
| `dispose()` | 清理事件、尺寸观察和指针捕获。 |
| `options.centerContent` | 默认 `false`。开启后，在能完整放下的方向居中；尺寸变化时保留用户相对默认位置的调整。 |
| `options.panPadding` | 默认 `0`。允许在内容四周额外平移的像素数，即使内容已全部显示仍可拖动；边界保留至少 64 像素桌面可见。 |
| `options.zoom` | `{min, max, initial?}`，三个值均须为有限正数，范围须包含 `initial`（省略为 `1`）；省略整个选项时禁用缩放。公共视窗使用 `0.8`～`2.5`，`initial: 1.5`。 |
| `options.onPanningChange(active)` | 平移开始／停止，供调用方暂停及恢复卡牌交互。 |
| `options.onViewChange(position)` | 位置更新，供调用方更新区域定位标记。 |
| `options.onZoomChange(zoom)` | 缩放比例改变，供调用方清理因卡牌位置变化而过期的悬停与检视。 |

通过 `ResizeObserver` 观察视窗及完整桌面；不支持时仍处理窗口 resize，内容变化可主动调用 `refresh()`。隐藏／`inert` 时忽略尺寸重算和 `panTo()`，保留当前位置；重新显示后由调用方调用 `refresh()`，按新尺寸限制在有效边界内。不开启额外余量时仍限制在内容边缘；开启后四周可向外移动，同时避免完全丢失桌面。组件不导入页面、卡牌、规则引擎或网络模块。

`game-probe` 的公共视窗仅显示地下城／村庄 Tab，不重复显示视窗标题。两个独立桌面各自持有一个 `TableViewport`，均启用居中、240 像素额外余量和 80%～250% 滚轮缩放，初始为 150%，通过 Tab 显示其中一个并保留各自平移位置及缩放。右下角复位按钮位于两个视窗的外层，其层级高于视窗内容，仅调用当前 Tab 的 `reset()`。按钮只显示 [Lucide focus](https://lucide.dev/icons/focus) 定位图标，保留 title 与无障碍标签；ISC 授权保存在 `frontend/public/licenses/lucide.txt` 并随构建复制。切换前调用 `finish()` 释放指针捕获，隐藏区域停止卡牌交互。玩家牌组与右侧示例玩家列表在桌面外固定显示。场景、数量、供应取牌等演示控件在牌桌外的“演示与测试”面板中。
