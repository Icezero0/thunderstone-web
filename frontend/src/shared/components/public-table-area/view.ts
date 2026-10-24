import {node} from '../../dom/elements.js';
import type {PublicTableOptions, PublicTableTab} from './types.js';

export interface PublicTableElements {
  root: HTMLElement; tabs: Record<PublicTableTab, HTMLButtonElement>; panels: Record<PublicTableTab, HTMLElement>;
  desktops: Record<PublicTableTab, HTMLElement>; hosts: Record<PublicTableTab, HTMLElement>;
  reset: HTMLButtonElement; overlays: HTMLElement;
  id(key: string): string;
  dispose(): void;
}
let sequence = 0;

export function createPublicTableView(host: HTMLElement, options: PublicTableOptions): PublicTableElements {
  const prefix = options.idPrefix ?? `public-table-${++sequence}`;
  const id = options.elementId ?? ((key: string) => `${prefix}-${key}`);
  const root = node('section', 'public-table-area public-area-layout game-cursor', undefined, id('root'));
  root.setAttribute('aria-label', '公共游戏区域'); root.dataset.hasPlayers = 'false'; host.append(root);
  const frame = node('section', 'public-game-areas', undefined, id('window')); frame.setAttribute('aria-label', '公共视窗');
  const heading = node('div', 'public-window-heading'), tablist = node('div', 'public-area-tabs');
  tablist.setAttribute('role', 'tablist'); tablist.setAttribute('aria-label', '公共桌面');
  heading.append(tablist); frame.append(heading); root.append(frame);
  const views = node('div', 'public-table-views', undefined, id('viewport')); frame.append(views);
  const tabs = {} as PublicTableElements['tabs'], panels = {} as PublicTableElements['panels'];
  const desktops = {} as PublicTableElements['desktops'], hosts = {} as PublicTableElements['hosts'];
  for (const [kind, caption] of [['dungeon', '地下城'], ['village', '村庄']] as const) {
    const tab = node('button', 'public-area-tab', caption, id(`${kind}-tab`)); tab.type = 'button';
    tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', id(`${kind}-panel`));
    tab.setAttribute('aria-selected', String(kind === 'dungeon')); tab.tabIndex = kind === 'dungeon' ? 0 : -1;
    tablist.append(tab); tabs[kind] = tab;
    const panel = node('section', 'table-viewport', undefined, id(`${kind}-panel`));
    panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id); panel.tabIndex = 0;
    panel.hidden = kind !== 'dungeon'; panels[kind] = panel;
    const desktop = node('div', 'table-desktop', undefined, id(`${kind}-desktop`)); desktops[kind] = desktop;
    const area = node('div', 'desktop-area', undefined, id(`${kind}-host`)); hosts[kind] = area;
    desktop.append(area); panel.append(desktop); views.append(panel);
  }
  const reset = node('button', 'table-view-reset', undefined, id('reset-view')); reset.type = 'button';
  reset.setAttribute('aria-controls', panels.dungeon.id); reset.setAttribute('aria-label', '恢复当前桌面的默认位置和缩放');
  reset.setAttribute('title', '恢复默认视野');
  // Lucide focus, ISC license: frontend/public/licenses/lucide.txt.
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [name, value] of Object.entries({viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false'})) svg.setAttribute(name, value);
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('cx', '12'); circle.setAttribute('cy', '12'); circle.setAttribute('r', '3'); svg.append(circle);
  for (const d of ['M3 7V5a2 2 0 0 1 2-2h2', 'M17 3h2a2 2 0 0 1 2 2v2', 'M21 17v2a2 2 0 0 1-2 2h-2', 'M7 21H5a2 2 0 0 1-2-2v-2']) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', d); svg.append(path);
  }
  reset.append(svg); views.append(reset);
  const overlays = node('div', 'public-table-overlays', undefined, id('overlays'));
  (options.overlayRoot ?? document.body).append(overlays);
  return {root, tabs, panels, desktops, hosts, reset, overlays, id,
    dispose: () => {root.remove(); overlays.remove();}};
}
