import {node} from '../../dom/elements.js';

/** A transient message anchored to a player row, outside the pannable desktop. */
export class PlayerActivityBubble {
  private readonly root: HTMLElement;
  private readonly message = node('span', 'player-activity-message');
  private timer: number | null = null;
  private animation: Animation | null = null;
  private generation = 0;
  private playerId: string | null = null;
  private observer: ResizeObserver | null = null;
  constructor(id: string, private host: HTMLElement, private scroller: HTMLElement,
    private anchor: (playerId: string) => HTMLElement | undefined) {
    this.root = node('div', 'player-activity-bubble', undefined, id);
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrow.setAttribute('class', 'player-activity-arrow'); arrow.setAttribute('viewBox', '0 0 9 16');
    arrow.setAttribute('aria-hidden', 'true'); arrow.setAttribute('focusable', 'false');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M0 0C0 2.5 2.2 4.5 7 6.7Q9 8 7 9.3C2.2 11.5 0 13.5 0 16Z');
    arrow.append(path); this.root.append(this.message, arrow);
    this.root.setAttribute('role', 'status'); this.root.setAttribute('aria-live', 'polite');
    this.root.setAttribute('aria-atomic', 'true');
    window.addEventListener('pagehide', this.clear);
    document.addEventListener('visibilitychange', this.visibility);
    scroller.addEventListener('scroll', this.position, {passive: true});
    window.addEventListener('resize', this.position);
  }
  show(playerId: string, text: string, durationMs = 4500): void {
    if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('Activity duration must be positive and finite.');
    this.clear(); const anchor = this.anchor(playerId);
    if (!anchor || document.hidden || !text.trim()) return;
    this.playerId = playerId; this.message.textContent = text;
    this.root.dataset.playerId = playerId; this.host.append(this.root); this.position();
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(this.position);
      this.observer.observe(this.host); this.observer.observe(this.scroller); this.observer.observe(anchor);
    }
    if (this.root.animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.animation = this.root.animate([{opacity: 0, transform: 'translateX(12px) scaleX(.9)'},
        {opacity: 1, transform: 'translateX(0) scaleX(1)'}], {duration: 180, easing: 'ease-out'});
    }
    const generation = this.generation;
    this.timer = window.setTimeout(() => {if (this.generation === generation) this.clear();}, durationMs);
  }
  sync(): void {
    if (this.playerId && !this.anchor(this.playerId)) this.clear();
    else this.position();
  }
  private position = (): void => {
    const anchor = this.playerId ? this.anchor(this.playerId) : null;
    if (!anchor) return;
    const row = anchor.getBoundingClientRect(), list = this.scroller.getBoundingClientRect(), host = this.host.getBoundingClientRect();
    const top = Math.max(row.top, list.top), bottom = Math.min(row.bottom, list.bottom);
    this.root.hidden = bottom <= top;
    this.root.style.left = `${row.left - host.left - 14}px`;
    this.root.style.top = `${(top + bottom) / 2 - host.top}px`;
  };
  clear = (): void => {
    this.generation++;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null; this.animation?.cancel(); this.animation = null;
    this.observer?.disconnect(); this.observer = null;
    this.playerId = null; this.root.remove(); this.message.textContent = '';
  };
  private visibility = (): void => {if (document.hidden) this.clear();};
  dispose(): void {
    this.clear(); window.removeEventListener('pagehide', this.clear);
    document.removeEventListener('visibilitychange', this.visibility);
    this.scroller.removeEventListener('scroll', this.position); window.removeEventListener('resize', this.position);
  }
}
