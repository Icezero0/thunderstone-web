import {CardStack, type PhysicalCard} from '../game-card/index.js';
import {AreaCards} from './card-views.js';
import {copyVillageState, isHeroSupply, supplyCount, supplyTop} from './model.js';
import {SupplyBrowser} from './supply-browser.js';
import {node, reconcile} from '../../dom/elements.js';
import type {SupplyPile, VillageOptions, VillageState} from './types.js';

interface PileView {root: HTMLElement; title: HTMLElement; slot: HTMLElement; stack: CardStack; card?: PhysicalCard | null;}
let sequence = 0;

export class VillageArea {
  readonly root: HTMLElement;
  private readonly cards: AreaCards;
  private readonly browser: SupplyBrowser;
  private readonly groups = new Map<SupplyPile['kind'], {root: HTMLElement; grid: HTMLElement}>();
  private readonly entries = new Map<string, PileView>();
  private readonly bound = new WeakSet<HTMLElement>();
  private readonly cleanup: (() => void)[] = [];
  private state: VillageState = {piles: []};
  private readonly prefix: string;
  private disposed = false;
  private highlighted = new Map<string, number>();
  private targets = new Set<string>();
  private selected = new Set<string>();
  get isBrowsing(): boolean {return this.browser.pileId !== null;}

  constructor(host: HTMLElement, private options: VillageOptions = {}) {
    this.prefix = options.idPrefix ?? `village-area-${++sequence}`;
    this.root = node('section', 'table-area village-area game-cursor', undefined, this.prefix);
    this.root.setAttribute('aria-label', '村庄供应'); host.append(this.root);
    const groups = node('div', 'village-groups'); this.root.append(groups);
    for (const [kind, label] of [['hero', '英雄供应'], ['village', '村庄供应'], ['basic', '基础牌']] as const) {
      const root = node('section', `supply-group supply-group-${kind}`), grid = node('div', 'supply-grid');
      root.dataset.kind = kind; root.setAttribute('aria-label', label); root.append(grid); groups.append(root);
      this.groups.set(kind, {root, grid}); root.hidden = true;
    }
    this.cards = new AreaCards(this.root, this.prefix, options);
    this.browser = new SupplyBrowser(this.cards, options.background ?? [this.root], options.overlayRoot ?? document.body, this.prefix, options);
  }
  setState(state: VillageState): void {
    if (this.disposed) throw new Error('VillageArea has been disposed.');
    const copied = copyVillageState(state); this.state = copied; this.cards.begin();
    for (const [kind, group] of this.groups) {
      const piles = copied.piles.filter(pile => pile.kind === kind);
      reconcile(group.grid, piles.map(pile => this.renderPile(pile))); group.root.hidden = !piles.length;
    }
    const browsing = copied.piles.find(pile => pile.id === this.browser.pileId);
    if (browsing && isHeroSupply(browsing)) this.browser.refresh(browsing, this.trigger(browsing));
    else if (this.isBrowsing) {this.browser.close(false); this.root.tabIndex = -1; this.root.focus({preventScroll: true});}
    this.cards.end();
  }
  setVisible(visible: boolean): void {
    if (this.disposed) throw new Error('VillageArea has been disposed.');
    if (!visible) this.browser.close(false);
    this.root.hidden = !visible; this.cards.interactions.refresh();
  }
  setInteractionSuspended(suspended: boolean): void {this.cards.interactions.setSuspended(suspended);}
  private renderPile(pile: SupplyPile): HTMLElement {
    let view = this.entries.get(pile.id);
    if (!view) {
      const root = node('article', 'public-pile supply-pile', undefined, `${this.prefix}-pile-${pile.id}`);
      const header = node('div', 'public-pile-heading'), title = node('h4'), count = node('span', 'public-pile-count');
      const slot = node('div', 'public-card-slot', undefined, `${this.prefix}-${pile.id}-slot`);
      header.append(title, count); root.append(header, slot);
      const stack = new CardStack(slot, count, true, {name: pile.name, browse: isHeroSupply(pile)});
      stack.empty.setAttribute('data-pan-start', '');
      view = {root, title, slot, stack}; this.entries.set(pile.id, view);
    }
    const top = supplyTop(pile); view.root.setAttribute('aria-label', pile.name); view.root.dataset.kind = pile.kind;
    view.title.textContent = pile.name;
    view.root.dataset.topCardId = top?.cardId ?? ''; view.root.dataset.topLevel = top?.level !== undefined ? String(top.level) : '';
    const card = top ? this.cards.card(`top-${pile.id}-${top.cardId}`, {id: `${pile.id}-${top.cardId}`, ...top}) : null;
    card?.elements.button.setAttribute('data-pan-start', '');
    this.bind(view.stack.empty, pile.id);
    if (card) this.bind(card.elements.button, pile.id);
    view.card = card;
    view.stack.setBrowsable(isHeroSupply(pile));
    view.stack.showTop(card); view.stack.setCount(supplyCount(pile), 16);
    this.highlight(pile, view);
    return view.root;
  }
  private bind(button: HTMLElement, pileId: string): void {
    if (this.bound.has(button)) return;
    this.bound.add(button); const clicked = () => {
      for (let element: HTMLElement | null = this.root; element; element = element.parentElement) if (element.hidden || element.inert) return;
      if (this.disposed) return;
      const pile = this.state.piles.find(item => item.id === pileId), top = pile && supplyTop(pile);
      const entry = this.entries.get(pileId);
      if (button !== (top ? entry?.card?.elements.button : entry?.stack.empty)) return;
      if (pile && top && this.options.onSupplyClick?.({pileId, cardId: top.cardId, name: top.name,
        level: top.level, infinite: pile.kind === 'basic'})) return;
      this.openSupply(pileId);
    };
    button.addEventListener('click', clicked); this.cleanup.push(() => button.removeEventListener('click', clicked));
  }
  private trigger(pile: SupplyPile): HTMLElement {
    const top = supplyTop(pile), entry = this.entries.get(pile.id)!;
    return top ? this.cards.card(`top-${pile.id}-${top.cardId}`, {id: `${pile.id}-${top.cardId}`, ...top}).elements.button : entry.stack.empty;
  }
  openSupply(pileId: string): void {
    if (this.disposed) throw new Error('VillageArea has been disposed.');
    const pile = this.state.piles.find(pile => pile.id === pileId);
    if (pile && isHeroSupply(pile)) this.browser.open(pile, this.trigger(pile));
  }
  closeSupply(restoreFocus = true): void {this.browser.close(restoreFocus);}
  /** Capture before replacing a depleted pile's top. Never expose hidden supply order. */
  topCardRect(cardId: string): DOMRect | null {
    if (this.disposed || !this.root.isConnected) return null;
    // Animation locks interaction with inert before framing its supply origin.
    // A locked card is still visible: geometry must not depend on clickability.
    for (let element: HTMLElement | null = this.root; element; element = element.parentElement) if (element.hidden) return null;
    const pile = this.state.piles.find(pile => supplyTop(pile)?.cardId === cardId);
    const rect = pile && this.entries.get(pile.id)?.card?.elements.surface.getBoundingClientRect();
    return rect && rect.width > 0 && rect.height > 0 ? rect : null;
  }
  /** Host-supplied legal top-card prices. No price or affordability rules live here. */
  setPurchaseOptions(options: readonly {cardId: string; price: number}[]): void {
    this.highlighted = new Map(options.map(item => [item.cardId, item.price]));
    for (const pile of this.state.piles) {const view = this.entries.get(pile.id); if (view) this.highlight(pile, view);}
  }
  setCardSelection(highlighted: readonly string[], selected: readonly string[]): void {
    this.targets = new Set(highlighted); this.selected = new Set(selected);
    this.browser.setCardTargets(highlighted, selected);
    for (const pile of this.state.piles) {const view = this.entries.get(pile.id); if (view) this.highlight(pile, view);}
  }
  private highlight(pile: SupplyPile, view: PileView): void {
    const top = supplyTop(pile), price = top && this.highlighted.get(top.cardId);
    view.card?.setGlow(price !== undefined || pile.cards.some(card => this.targets.has(card.cardId)));
    view.card?.setActive(!!top && this.selected.has(top.cardId));
    view.root.dataset.purchasePrice = price === undefined ? '' : String(price);
    if (view.card) {
      view.card.elements.button.dataset.purchasePrice = price === undefined ? '' : String(price);
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.browser.dispose(); this.cards.dispose(); this.cleanup.forEach(cleanup => cleanup());
    this.root.remove(); this.entries.clear(); this.groups.clear();
  }
}
