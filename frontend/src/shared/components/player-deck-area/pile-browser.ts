import {CardInteractions, createCardElements, type PhysicalCard} from '../game-card/index.js';
import type {PlayerDeckCard, CardImageSource} from './types.js';
import type {BrowserElements} from './view.js';
type BrowserItem = {element: HTMLElement; card: PhysicalCard};

/** Independent card views keep browsing and display sorting away from pile state. */
export class PileBrowser {
  private readonly items = new Map<string, BrowserItem>();
  private current: BrowserItem[] = [];
  private returnFocus: HTMLElement | null = null;
  private inertBefore: boolean[] = [];
  private kind: 'draw' | 'discard' | null = null;
  isOpen = false;

  constructor(private interactions: CardInteractions, private view: BrowserElements,
    private background: readonly HTMLElement[],
    private images: CardImageSource, private id: (key: string) => string) {
    this.closeButton.addEventListener('click', this.closeClicked);
    this.overlay.addEventListener('click', this.backdropClicked);
    window.addEventListener('keydown', this.keydown);
  }

  private get overlay(): HTMLElement {return this.view.overlay;}
  private get grid(): HTMLElement {return this.view.grid;}
  private get closeButton(): HTMLButtonElement {return this.view.close;}
  get pile(): 'draw' | 'discard' | null {return this.kind;}

  open(kind: 'draw' | 'discard', cards: readonly PlayerDeckCard[], trigger: HTMLElement): void {
    if (this.isOpen) return;
    this.isOpen = true; this.kind = kind;
    this.refresh(cards, trigger);
    this.overlay.dataset.pile = kind; this.overlay.hidden = false;
    this.grid.scrollTop = 0;
    this.inertBefore = this.background.map(element => element.inert);
    this.background.forEach(element => {element.inert = true;});
    this.interactions.setScope(this.grid);
    this.closeButton.focus({preventScroll: true});
  }

  /** Reconcile an open browser without reopening the modal or resetting its scroll position. */
  refresh(cards: readonly PlayerDeckCard[], trigger: HTMLElement): void {
    if (!this.kind) return;
    this.returnFocus = trigger;
    const kind = this.kind, scroll = this.grid.scrollTop;
    const focused = this.grid.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    const ordered = kind === 'draw' ? [...cards].sort((a, b) => a.cardId.localeCompare(b.cardId, 'en', {numeric: true}))
      : [...cards].reverse();
    const present = new Set(cards.map(card => card.id));
    for (const item of this.current) {
      if (!present.has(item.card.elements.button.dataset.instanceId!)) {
        item.card.setVisible(false); item.element.remove();
      }
    }
    this.current = ordered.map(data => {
      let item = this.items.get(data.id);
      if (!item) {
        const elements = createCardElements(data.cardId, this.images);
        elements.button.id = this.id(`browse-${data.id}`); elements.button.dataset.instanceId = data.id;
        const element = document.createElement('article'); element.className = 'pile-browser-entry';
        element.append(elements.button);
        item = {element, card: this.interactions.add(elements, data.name)}; this.items.set(data.id, item);
      }
      item.element.hidden = false; item.card.setName(data.name); item.card.setFaceUp(true, false); item.card.setVisible(true);
      return item;
    });
    // Leave unchanged elements in place so a focused/inspected card keeps its identity.
    let next = this.view.empty.nextElementSibling;
    for (const item of this.current) {
      if (item.element !== next) this.grid.insertBefore(item.element, next);
      next = item.element.nextElementSibling;
    }
    this.view.title.textContent = kind === 'draw' ? '抽牌堆' : '弃牌堆';
    this.view.count.textContent = `${cards.length} 张`;
    this.view.empty.hidden = cards.length > 0;
    if (focused) {
      const retained = this.current.some(item => item.card.elements.button === focused);
      (retained ? focused : this.closeButton).focus({preventScroll: true});
    }
    this.grid.scrollTop = scroll;
    this.interactions.refresh();
  }

  close(restoreFocus = true): void {
    if (!this.isOpen) return;
    this.isOpen = false; this.kind = null;
    for (const item of this.current) {item.card.setVisible(false); item.element.hidden = true;}
    this.current = []; this.overlay.hidden = true;
    this.background.forEach((element, index) => {element.inert = this.inertBefore[index];});
    this.interactions.setScope(null);
    if (restoreFocus && this.returnFocus?.isConnected && !this.returnFocus.hidden) {
      this.returnFocus.focus({preventScroll: true});
    }
    this.returnFocus = null;
  }
  private closeClicked = (): void => {this.close();};
  private backdropClicked = (event: MouseEvent): void => {if (event.target === this.overlay) this.close();};
  private keydown = (event: KeyboardEvent): void => {
    if (!this.isOpen || event.isComposing) return;
    if (event.key === 'Escape') {event.preventDefault(); this.close(); return;}
    if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
    const targets: HTMLElement[] = [this.closeButton, ...this.current.map(item => item.card.elements.button)];
    const index = targets.indexOf(document.activeElement as HTMLElement);
    if (event.shiftKey && index <= 0) {event.preventDefault(); targets.at(-1)!.focus();}
    else if (!event.shiftKey && (index < 0 || index === targets.length - 1)) {
      event.preventDefault(); targets[0].focus();
    }
  };
  dispose(): void {
    this.close(false);
    this.items.clear();
    this.closeButton.removeEventListener('click', this.closeClicked);
    this.overlay.removeEventListener('click', this.backdropClicked);
    window.removeEventListener('keydown', this.keydown);
  }
}
