import {node} from '../../dom/elements.js';

/** A transient message anchored to a player row, outside the pannable desktop. */
export class PlayerActivityBubble {
  private readonly root: HTMLElement;
  private timer: number | null = null;
  private animation: Animation | null = null;
  private generation = 0;
  private playerId: string | null = null;
  constructor(id: string, private anchor: (playerId: string) => HTMLElement | undefined) {
    this.root = node('div', 'player-activity-bubble', undefined, id);
    this.root.setAttribute('role', 'status'); this.root.setAttribute('aria-live', 'polite');
    this.root.setAttribute('aria-atomic', 'true');
    window.addEventListener('pagehide', this.clear);
    document.addEventListener('visibilitychange', this.visibility);
  }
  show(playerId: string, text: string, durationMs = 4500): void {
    if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('Activity duration must be positive and finite.');
    this.clear(); const anchor = this.anchor(playerId);
    if (!anchor || document.hidden || !text.trim()) return;
    this.playerId = playerId; this.root.textContent = text;
    this.root.dataset.playerId = playerId; anchor.append(this.root);
    if (this.root.animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.animation = this.root.animate([{opacity: 0, transform: 'translateX(12px) scaleX(.9)'},
        {opacity: 1, transform: 'translateX(0) scaleX(1)'}], {duration: 180, easing: 'ease-out'});
    }
    const generation = this.generation;
    this.timer = window.setTimeout(() => {if (this.generation === generation) this.clear();}, durationMs);
  }
  sync(): void {if (this.playerId && this.root.parentElement !== this.anchor(this.playerId)) this.clear();}
  clear = (): void => {
    this.generation++;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null; this.animation?.cancel(); this.animation = null;
    this.playerId = null; this.root.remove(); this.root.textContent = '';
  };
  private visibility = (): void => {if (document.hidden) this.clear();};
  dispose(): void {
    this.clear(); window.removeEventListener('pagehide', this.clear);
    document.removeEventListener('visibilitychange', this.visibility);
  }
}
