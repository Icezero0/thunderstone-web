import {node} from '../../dom/elements.js';
import type {PlayerResources} from './types.js';

/** Read-only counters and optional production income; the host supplies all values. */
export class PlayerResourceDisplay {
  private readonly gold = node('span', 'player-resource player-resource-gold');
  private readonly goldValue = node('span', 'player-resource-value');
  private readonly goldPreview = node('span', 'player-resource-forecast');
  private readonly xp = node('span', 'player-resource player-resource-xp');
  private readonly xpValue = node('span', 'player-resource-value');
  constructor(private root: HTMLElement, id: (key: string) => string) {
    root.setAttribute('role', 'group'); root.setAttribute('aria-label', '我的资源');
    this.gold.id = id('gold-resource'); this.goldValue.id = id('gold-value');
    this.goldPreview.id = id('gold-income-preview');
    this.xp.id = id('xp-resource'); this.xpValue.id = id('xp-value');
    this.gold.title = '金币'; this.xp.title = '经验值';
    for (const counter of [this.gold, this.xp]) {counter.setAttribute('role', 'status'); counter.setAttribute('aria-live', 'polite');}
    // A low stack with an upright coin, drawn at the same weight as combat icons.
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false'})) svg.setAttribute(key, value);
    for (const d of ['M3 13c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3Z',
      'M3 13v4c0 1.7 3.1 3 7 3s7-1.3 7-3v-4', 'M3 17v3c0 1.7 3.1 3 7 3s7-1.3 7-3v-3',
      'M16 3c-2.8 0-5 2.2-5 5v2c3.5.2 6 1.4 6 3v1a5 5 0 0 0-1-11Z', 'M16 6v4']) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', d); svg.append(path);
    }
    const amount = node('span', 'player-resource-amount'); amount.append(this.goldValue, this.goldPreview);
    this.gold.append(svg, amount); this.xp.append(node('span', 'player-resource-label', 'XP'), this.xpValue);
    root.append(this.gold, this.xp); this.set(null);
  }
  set(resources: PlayerResources | null): void {
    if (resources && (![resources.xp, ...(resources.gold === undefined ? [] : [resources.gold])]
      .every(value => Number.isSafeInteger(value) && value >= 0))) throw new Error('Player resources must be nonnegative integers.');
    if (resources?.goldIncomePreview !== undefined && (!Number.isSafeInteger(resources.goldIncomePreview) || resources.gold === undefined))
      throw new Error('Gold income preview requires an integer and a visible gold counter.');
    this.root.hidden = resources === null;
    this.gold.hidden = resources?.gold === undefined;
    this.goldValue.textContent = String(resources?.gold ?? 0); this.xpValue.textContent = String(resources?.xp ?? 0);
    const income = resources?.goldIncomePreview;
    this.goldPreview.hidden = income === undefined;
    this.goldPreview.textContent = income === undefined ? '' : `(${income >= 0 ? '+' : ''}${income})`;
    this.gold.setAttribute('aria-label', `金币 ${resources?.gold ?? 0}${income === undefined ? '' : `，预计生产${income < 0 ? '减少' : '增加'} ${Math.abs(income)}`}`);
    this.gold.title = income === undefined ? '金币' : '金币 · 括号内为按当前状态预计生产的增量';
    this.xp.setAttribute('aria-label', `经验值 ${resources?.xp ?? 0}`);
  }
}
