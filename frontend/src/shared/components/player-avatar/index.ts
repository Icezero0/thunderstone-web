import './style.css';

/** The same circular avatar in settings, rooms and game player lists. */
export class PlayerAvatar {
  readonly root = document.createElement('span');
  private readonly image = document.createElement('img');
  private readonly fallback = document.createElement('span');
  private source: string | undefined;
  constructor() {
    this.root.className = 'player-avatar'; this.fallback.className = 'player-avatar-fallback';
    this.root.setAttribute('aria-hidden', 'true'); this.image.alt = ''; this.image.draggable = false; this.image.hidden = true;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 40 40'); svg.setAttribute('fill', 'currentColor');
    const head = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    head.setAttribute('cx', '20'); head.setAttribute('cy', '14'); head.setAttribute('r', '7');
    const shoulders = document.createElementNS('http://www.w3.org/2000/svg', 'path'); shoulders.setAttribute('d', 'M7 37v-4a13 13 0 0 1 26 0v4Z');
    svg.append(head, shoulders); this.fallback.append(svg); this.root.append(this.fallback, this.image);
    this.image.addEventListener('error', this.failed);
  }
  setSource(value?: string | null): void {
    const source = value || undefined;
    if (this.source === source) return;
    this.source = source; this.fallback.hidden = !!source; this.image.hidden = !source;
    if (source) this.image.src = source; else this.image.removeAttribute('src');
  }
  private failed = (): void => {this.image.hidden = true; this.fallback.hidden = false;};
  dispose(): void {this.image.removeEventListener('error', this.failed);}
}
