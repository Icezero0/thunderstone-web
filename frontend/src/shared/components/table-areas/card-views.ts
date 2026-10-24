import {CardInteractions, createCardElements, createCardInspection, defaultCardImages, type PhysicalCard} from '../game-card/index.js';
import type {TableAreaOptions, TableCard} from './types.js';
import {node} from '../../dom/elements.js';

/** Shared presentation lifecycle for public game areas; no game rules or instance creation. */
export class AreaCards {
  private readonly inspection;
  private readonly cache = node('div');
  private readonly views = new Map<string, PhysicalCard>();
  private used = new Set<string>();
  readonly interactions: CardInteractions;
  private readonly images;
  constructor(root: HTMLElement, private prefix: string, options: TableAreaOptions) {
    this.images = {front: options.images?.front ?? defaultCardImages.front, back: options.images?.back ?? defaultCardImages.back};
    this.inspection = createCardInspection(options.overlayRoot, {overlay: `${prefix}-inspect`, content: `${prefix}-inspect-content`});
    this.cache.hidden = true; root.append(this.cache);
    const notice = node('p', 'table-area-notice'); notice.setAttribute('role', 'status'); root.append(notice);
    this.interactions = new CardInteractions(this.inspection.overlay, this.inspection.content, notice);
  }
  begin(): void {this.used.clear();}
  card(key: string, data: TableCard, faceUp = true, hiddenDeck = false): PhysicalCard {
    this.used.add(key);
    let view = this.views.get(key);
    if (!view) {
      const elements = createCardElements(data.cardId, hiddenDeck ? {front: () => this.images.back, back: this.images.back} : this.images);
      elements.button.id = `${this.prefix}-${key}`; elements.button.dataset.instanceId = data.id;
      this.cache.append(elements.button); view = this.interactions.add(elements, data.name, faceUp); this.views.set(key, view);
    }
    if (view.elements.button.dataset.cardId !== data.cardId) throw new Error('A cached card view cannot change catalog identity.');
    view.elements.button.dataset.instanceId = data.id;
    view.setName(data.name); view.setFaceUp(faceUp, false); view.setVisible(true); return view;
  }
  end(): void {
    for (const [key, view] of this.views) if (!this.used.has(key)) view.setVisible(false);
    this.interactions.refresh();
  }
  dispose(): void {this.interactions.dispose(); this.inspection.dispose(); this.views.clear();}
}
