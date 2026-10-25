import type {PlayerCardTab, PlayerDeckOptions} from './types.js';
import {createCardInspection} from '../game-card/index.js';

export interface BrowserElements {
  overlay: HTMLElement; grid: HTMLElement; close: HTMLButtonElement;
  title: HTMLElement; count: HTMLElement; empty: HTMLElement;
}
export interface PlayerDeckElements {
  root: HTMLElement; handTrack: HTMLElement; handEmpty: HTMLElement; autoSort: HTMLInputElement;
  tabs: Record<PlayerCardTab, HTMLButtonElement>; panels: Record<PlayerCardTab, HTMLElement>;
  auxiliaryEmpty: Record<'treasures' | 'aside' | 'revealed', HTMLElement>; response: HTMLElement; resources: HTMLElement;
  drawSlot: HTMLElement; drawCount: HTMLElement; discardSlot: HTMLElement; discardCount: HTMLElement;
  cache: HTMLElement; motion: HTMLElement; browser: BrowserElements;
  inspectOverlay: HTMLElement; inspectContent: HTMLElement; notice: HTMLElement; descriptionId: string;
  id: (key: string) => string;
  dispose(): void;
}
let sequence = 0;

/** Own the complete deck region and its overlays; no page selectors or global IDs are required. */
export function createPlayerDeckView(host: HTMLElement, options: PlayerDeckOptions): PlayerDeckElements {
  const prefix = options.idPrefix ?? `player-deck-${++sequence}`;
  const id = options.elementId ?? ((key: string) => `${prefix}-${key}`);
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, key: string, className: string,
    parent: HTMLElement, text?: string): HTMLElementTagNameMap[K] => {
    const element = document.createElement(tag); element.id = id(key); element.className = className;
    if (text !== undefined) element.textContent = text;
    parent.append(element); return element;
  };
  const root = node('section', 'player-zone', 'player-deck-area player-zone game-cursor', host);
  root.setAttribute('aria-label', '玩家牌组区');
  const pile = (kind: 'draw' | 'discard', caption: string) => {
    const area = node('section', `${kind}-area`, 'pile-area', root);
    area.setAttribute('aria-labelledby', id(`${kind}-heading`));
    const heading = node('div', `${kind}-zone-heading`, 'zone-heading', area);
    node('h2', `${kind}-heading`, '', heading, caption);
    const count = node('span', `${kind}-count`, 'pile-count', heading, '0');
    count.setAttribute('aria-label', `${caption}张数`);
    return {area, count, slot: node('div', `${kind}-pile`, 'pile-slot', area)};
  };
  const draw = pile('draw', '抽牌堆');
  const handArea = node('section', 'hand-area', 'hand-area', root);
  handArea.setAttribute('aria-label', '玩家卡牌区');
  const handHeading = node('div', 'hand-zone-heading', 'zone-heading', handArea);
  const tablist = node('div', 'card-tabs', 'player-card-tabs', handHeading);
  tablist.setAttribute('role', 'tablist'); tablist.setAttribute('aria-label', '玩家牌区');
  const tabs = {} as Record<PlayerCardTab, HTMLButtonElement>;
  for (const [kind, caption] of [['hand', '手牌'], ['treasures', '宝藏'], ['aside', '旁置'], ['revealed', '翻开']] as const) {
    const tab = node('button', kind === 'hand' ? 'hand-heading' : `${kind}-tab`, 'player-card-tab', tablist, caption);
    tab.type = 'button'; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', id(`${kind === 'hand' ? 'hand' : kind}-track`));
    tab.setAttribute('aria-selected', String(kind === 'hand')); tab.tabIndex = kind === 'hand' ? 0 : -1;
    tab.hidden = kind !== 'hand'; tabs[kind] = tab;
  }
  const response = node('div', 'player-response', 'player-response', handHeading);
  response.setAttribute('role', 'group'); response.setAttribute('aria-label', '操作响应区'); response.dataset.empty = 'true';
  const resources = node('div', 'resources', 'player-resources', handHeading); resources.hidden = true;
  const label = node('label', 'auto-sort-label', 'hand-auto-sort', handHeading);
  label.title = '自动理牌：金色表示开启，灰色表示关闭；开启时按卡牌 ID 排序，关闭后可拖动调整顺序';
  node('span', 'auto-sort-caption', 'sr-only', label, '自动理牌');
  const autoSort = node('input', 'auto-sort-hand', '', label); autoSort.type = 'checkbox';
  autoSort.setAttribute('role', 'switch');
  const icon = node('span', 'auto-sort-track', 'hand-auto-sort-icon', label); icon.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', focusable: 'false'})) svg.setAttribute(key, value);
  // Circular reorder arrows surround a two-card stack.
  for (const d of ['M3.3 8A9 9 0 0 1 19 5.6L21 8', 'M21 3.5V8h-4.5',
    'M20.7 16A9 9 0 0 1 5 18.4L3 16', 'M3 20.5V16h4.5',
    'M9.5 6.5H15a1 1 0 0 1 1 1V15']) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', d); svg.append(path);
  }
  const card = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  for (const [key, value] of Object.entries({x: '7.5', y: '8', width: '7', height: '9.5', rx: '1'})) card.setAttribute(key, value);
  svg.append(card); icon.append(svg);
  const handTrack = node('div', 'hand-track', 'hand-track', handArea);
  handTrack.setAttribute('role', 'tabpanel'); handTrack.setAttribute('aria-labelledby', id('hand-heading'));
  const handEmpty = node('p', 'empty-hand', 'empty-hand', handTrack, '暂无手牌');
  const panels = {} as Record<PlayerCardTab, HTMLElement>; panels.hand = handTrack;
  const auxiliaryEmpty = {} as Record<'treasures' | 'aside' | 'revealed', HTMLElement>;
  for (const [kind, caption] of [['treasures', '宝藏'], ['aside', '旁置'], ['revealed', '翻开']] as const) {
    const track = node('div', `${kind}-track`, 'hand-track auxiliary-track', handArea); track.hidden = true;
    track.setAttribute('role', 'tabpanel'); track.setAttribute('aria-labelledby', tabs[kind].id);
    auxiliaryEmpty[kind] = node('p', `${kind}-empty`, 'empty-hand', track, `暂无${caption}`); panels[kind] = track;
  }
  const discard = pile('discard', '弃牌堆');
  const descriptionId = options.descriptionId ?? id('card-shortcuts');
  if (!options.descriptionId) {
    node('p', 'card-shortcuts', 'sr-only', root, '点击手牌选中；关闭自动理牌后可拖动排序；点击牌堆浏览；按住 Alt 检视原图。');
  }
  const notice = options.notice ?? node('p', 'card-notice', 'player-deck-notice', root);
  notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');

  const overlays = node('div', 'overlays', 'player-deck-overlays game-cursor', options.overlayRoot ?? document.body);
  const overlay = node('section', 'pile-browser', 'pile-browser-overlay browse-dialog game-cursor', overlays); overlay.hidden = true;
  overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', id('pile-browser-title'));
  const panel = node('div', 'pile-browser-panel', 'pile-browser-panel browse-dialog-panel panel', overlay);
  const heading = node('header', 'pile-browser-heading', 'pile-browser-heading browse-dialog-heading masthead', panel);
  const titleGroup = node('div', 'pile-browser-title-group', 'browse-dialog-heading-group', heading);
  const title = node('h2', 'pile-browser-title', '', titleGroup, '牌堆浏览');
  const count = node('span', 'pile-browser-count', 'pile-browser-count browse-dialog-count', titleGroup);
  const close = node('button', 'close-pile-browser', 'button secondary browse-dialog-close', heading, '关闭 ×'); close.type = 'button';
  const grid = node('div', 'pile-browser-grid', 'pile-browser-grid browse-dialog-body browse-dialog-grid', panel);
  const empty = node('p', 'pile-browser-empty', 'pile-browser-empty browse-dialog-empty', grid, '牌堆为空。'); empty.hidden = true;
  const {overlay: inspectOverlay, content: inspectContent} = createCardInspection(overlays,
    {overlay: id('inspect-overlay'), content: id('inspect-content')});
  const cache = node('div', 'card-cache', '', overlays); cache.hidden = true;
  const motion = node('div', 'card-motion-layer', 'card-motion-layer', overlays); motion.setAttribute('aria-hidden', 'true');
  return {root, handTrack, handEmpty, autoSort, tabs, panels, auxiliaryEmpty, response, resources, drawSlot: draw.slot, drawCount: draw.count,
    discardSlot: discard.slot, discardCount: discard.count, cache, motion,
    browser: {overlay, grid, close, title, count, empty}, inspectOverlay, inspectContent,
    notice, descriptionId, id, dispose: () => {root.remove(); overlays.remove();}};
}
