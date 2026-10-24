import type {PhysicalCard} from './card-interaction.js';

/** A top card plus at most five paper edges; exact size is shown by the counter. */
export class CardStack {
  private top: PhysicalCard | null = null;
  private readonly edges: HTMLElement[] = [];
  private browsable = true;
  private readonly name: string;
  readonly empty: HTMLButtonElement;

  constructor(readonly slot: HTMLElement, private label: HTMLElement, private faceUp: boolean,
    options: {name?: string; browse?: boolean} = {}) {
    slot.className += ' card-stack';
    this.name = options.name ?? '牌堆';
    for (let index = 0; index < 5; index++) {
      const edge = document.createElement('span'); edge.className = 'pile-edge';
      edge.setAttribute('aria-hidden', 'true'); edge.hidden = true;
      edge.style.transform = `translateY(${(index + 1) * 1.5}px)`;
      edge.style.zIndex = String(5 - index); slot.append(edge); this.edges.push(edge);
    }
    this.empty = document.createElement('button'); this.empty.className = 'pile-empty'; this.empty.type = 'button';
    this.empty.textContent = '空牌堆'; this.empty.hidden = true; slot.append(this.empty);
    this.setBrowsable(options.browse ?? true);
  }
  setBrowsable(browsable: boolean): void {
    this.browsable = browsable; this.empty.disabled = !browsable;
    this.empty.setAttribute('aria-label', `${this.name}为空${browsable ? '，点击浏览' : ''}`);
    for (const button of [this.empty, this.top?.elements.button]) {
      if (!button) continue;
      if (browsable) button.setAttribute('aria-haspopup', 'dialog');
      else button.removeAttribute('aria-haspopup');
    }
  }
  setFaceUp(faceUp: boolean): void {this.faceUp = faceUp; this.top?.setFaceUp(faceUp, false);}

  showTop(card: PhysicalCard | null): void {
    // Detach the paper edges before the old top moves to the hand or animation layer.
    // The current top's visual container then lifts every layer together.
    if (this.top !== card) this.slot.append(...this.edges);
    if (this.top && this.top !== card) {
      this.top.elements.button.removeAttribute('aria-haspopup');
      this.top.elements.button.removeAttribute('title'); this.top.setVisible(false);
    }
    this.top = card;
    if (card) {
      this.slot.append(card.elements.button);
      card.elements.surface.parentElement!.append(...this.edges);
      if (this.browsable) card.elements.button.setAttribute('aria-haspopup', 'dialog');
      else card.elements.button.removeAttribute('aria-haspopup');
      card.elements.button.removeAttribute('title');
      card.elements.button.style.left = '0px'; card.elements.button.style.zIndex = '10';
      card.setFaceUp(this.faceUp, false); card.setVisible(true);
    }
  }
  setCount(count: number | null, infiniteVisualCount = 8): void {
    const layers = Math.min(5, Math.ceil(Math.max(0, (count ?? infiniteVisualCount) - 1) / 4));
    this.label.textContent = count === null ? '∞' : String(count);
    this.label.setAttribute('aria-label', count === null ? '无限供应' : `${count} 张`);
    this.slot.dataset.count = count === null ? 'infinite' : String(count); this.slot.dataset.layers = String(layers);
    this.edges.forEach((edge, index) => {edge.hidden = index >= layers;});
    this.empty.hidden = count === null || count > 0;
  }
}
