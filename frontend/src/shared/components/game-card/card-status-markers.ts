import type {CardStatus} from './types.js';

const names = {buff: '增益', debuff: '减益', destroy: '摧毁标记'};
const paths = {
  buff: 'M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7ZM8 12l4-4 4 4M12 8v9',
  debuff: 'M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7ZM8 12l4 4 4-4M12 7v9',
  destroy: 'M8 20v-4H5v-5a7 7 0 0 1 14 0v5h-3v4ZM8 10l3 3m-3 0 3-3m2 0 3 3m-3 0 3-3M11 16v4m2-4v4',
};

/** One badge per status kind. Tooltip content is host-supplied plain text. */
export class CardStatusMarkers {
  private static opened: CardStatusMarkers | null = null;
  private readonly badges = document.createElement('span');
  private tooltip: HTMLElement | null = null;
  private signature = '';
  private suspended = false;
  private cleanup: (() => void)[] = [];
  constructor(private card: HTMLButtonElement, lift: HTMLElement) {
    this.badges.className = 'card-status-markers'; this.badges.hidden = true; lift.append(this.badges);
  }
  set(statuses: readonly CardStatus[] = []): void {
    const signature = JSON.stringify(statuses); if (signature === this.signature) return;
    this.signature = signature; this.hide(); this.cleanup.forEach(fn => fn()); this.cleanup = []; this.badges.textContent = '';
    this.badges.hidden = !statuses.length;
    for (const kind of ['buff', 'debuff', 'destroy'] as const) {
      const rows = statuses.filter(item => item.kind === kind).map(item => `${item.source_name}：${item.description}`);
      if (!rows.length) continue;
      const badge = document.createElement('span'); badge.className = 'card-status-icon'; badge.dataset.kind = kind; badge.tabIndex = 0;
      badge.setAttribute('role', 'img'); badge.setAttribute('aria-label', `${names[kind]}：${rows.join('；')}`);
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      for (const [key, value] of Object.entries({viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true'})) svg.setAttribute(key, value);
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', paths[kind]); svg.append(path); badge.append(svg); this.badges.append(badge);
      const bind = (event: string, fn: (event: Event) => void) => {badge.addEventListener(event, fn); this.cleanup.push(() => badge.removeEventListener(event, fn));};
      bind('pointerenter', event => this.show(names[kind], rows, event as PointerEvent, badge));
      bind('pointermove', event => this.position((event as PointerEvent).clientX, (event as PointerEvent).clientY));
      bind('pointerleave', this.hide); bind('blur', this.hide);
      bind('focus', event => this.show(names[kind], rows, event, badge));
      for (const event of ['pointerdown', 'click']) bind(event, event => {event.stopPropagation(); event.preventDefault();});
      bind('keydown', event => {if ((event as KeyboardEvent).key === 'Escape') {this.hide(); event.stopPropagation();}});
    }
  }
  setSuspended(value: boolean): void {this.suspended = value; if (value) this.hide();}
  hide = (): void => {this.tooltip?.remove(); this.tooltip = null; if (CardStatusMarkers.opened === this) CardStatusMarkers.opened = null;};
  private show(title: string, rows: string[], event: Event, badge: HTMLElement): void {
    if (this.suspended || this.card.dataset.face !== 'front') return;
    for (let node: HTMLElement | null = this.card; node; node = node.parentElement) if (node.hidden || node.inert) return;
    CardStatusMarkers.opened?.hide(); CardStatusMarkers.opened = this;
    const panel = document.createElement('div'); panel.className = 'card-status-tooltip game-cursor'; panel.setAttribute('role', 'tooltip');
    const heading = document.createElement('strong'); heading.textContent = title; panel.append(heading);
    for (const row of rows) {const text = document.createElement('div'); text.textContent = row; panel.append(text);}
    document.body.append(panel); this.tooltip = panel;
    const pointer = event as PointerEvent, rect = badge.getBoundingClientRect();
    this.position(Number.isFinite(pointer.clientX) ? pointer.clientX : rect.right, Number.isFinite(pointer.clientY) ? pointer.clientY : rect.top);
  }
  private position(x: number, y: number): void {
    if (!this.tooltip) return;
    const rect = this.tooltip.getBoundingClientRect();
    this.tooltip.style.left = `${Math.max(8, Math.min(x + 14, window.innerWidth - rect.width - 8))}px`;
    this.tooltip.style.top = `${Math.max(8, Math.min(y + 14, window.innerHeight - rect.height - 8))}px`;
  }
  dispose(): void {this.hide(); this.cleanup.forEach(fn => fn()); this.badges.remove();}
}
