import type {PhysicalCard} from '../game-card/index.js';
import {AreaCards} from './card-views.js';
import {supplyCount, supplyTop} from './model.js';
import {node, reconcile} from '../../dom/elements.js';
import type {SupplyPile, VillageOptions} from './types.js';

interface LevelView {
  root: HTMLElement; level: HTMLElement; status: HTMLElement; name: HTMLElement;
  caption: HTMLElement; view: PhysicalCard;
}

/** Level previews never select a purchasable card: the action always requests the current pile top. */
export class SupplyBrowser {
  readonly overlay: HTMLElement;
  private readonly title = node('h2');
  private readonly count = node('span', 'supply-browser-count browse-dialog-count');
  private readonly closeButton = node('button', 'button secondary browse-dialog-close', '关闭 ×');
  private readonly grid = node('div', 'supply-browser-grid browse-dialog-body');
  private readonly take = node('button', 'button primary');
  private readonly items = new Map<string, LevelView>();
  private current: PhysicalCard[] = [];
  private targets = new Set<string>();
  private selected = new Set<string>();
  private trigger: HTMLElement | null = null;
  private pile: SupplyPile | null = null;
  setCardTargets(ids: readonly string[], selected: readonly string[]): void {
    this.targets = new Set(ids); this.selected = new Set(selected);
    for (const card of this.current) this.target(card);
  }
  private target(card: PhysicalCard): void {
    const id = card.elements.button.dataset.cardId!;
    card.setGlow(this.targets.has(id)); card.setActive(this.selected.has(id)); card.setTargetSelected(this.selected.has(id));
  }
  private inertBefore: boolean[] = [];
  get pileId(): string | null {return this.pile?.id ?? null;}
  constructor(private cards: AreaCards, private background: readonly HTMLElement[],
    overlayRoot: HTMLElement, prefix: string, private options: VillageOptions) {
    this.overlay = node('section', 'supply-browser-overlay browse-dialog game-cursor', undefined, `${prefix}-browser`);
    this.overlay.hidden = true; this.overlay.setAttribute('role', 'dialog'); this.overlay.setAttribute('aria-modal', 'true');
    this.title.id = `${prefix}-browser-title`; this.overlay.setAttribute('aria-labelledby', this.title.id);
    this.grid.id = `${prefix}-browser-grid`; this.count.id = `${prefix}-browser-count`;
    this.closeButton.id = `${prefix}-browser-close`; this.take.id = `${prefix}-browser-take`;
    this.closeButton.type = this.take.type = 'button';
    const panel = node('div', 'supply-browser-panel browse-dialog-panel panel'), header = node('header', 'supply-browser-heading browse-dialog-heading masthead');
    const group = node('div', 'browse-dialog-heading-group'); group.append(this.title, this.count); header.append(group, this.closeButton);
    panel.append(header, this.grid);
    if (options.onTakeTop) {const footer = node('footer', 'supply-browser-actions'); footer.append(this.take); panel.append(footer);}
    this.overlay.append(panel); overlayRoot.append(this.overlay);
    this.closeButton.addEventListener('click', this.closeClicked); this.overlay.addEventListener('click', this.backdropClicked);
    this.take.addEventListener('click', this.takeClicked); window.addEventListener('keydown', this.keydown);
  }
  open(pile: SupplyPile, trigger: HTMLElement): void {
    if (this.pile) return;
    this.refresh(pile, trigger); this.overlay.hidden = false;
    this.inertBefore = this.background.map(element => element.inert);
    this.background.forEach(element => {element.inert = true;});
    this.cards.interactions.setScope(this.grid); this.closeButton.focus({preventScroll: true}); this.grid.scrollTop = 0;
  }
  refresh(pile: SupplyPile, trigger: HTMLElement): void {
    this.pile = pile; this.trigger = trigger;
    const top = supplyTop(pile);
    this.overlay.style.setProperty('--supply-level-count', String(Math.min(4, pile.cards.length)));
    const scroll = this.grid.scrollTop, focused = this.grid.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    const ordered = pile.cards.map(card => {
      const key = `browse-${pile.id}-${card.cardId}`;
      const view = this.cards.card(key, {id: key, ...card});
      this.target(view);
      view.elements.button.onclick = () => {
        if (this.pile && this.targets.has(card.cardId)) this.options.onSupplyClick?.({pileId: this.pile.id, cardId: card.cardId,
          name: card.name, level: card.level, infinite: false, preview: true});
      };
      let item = this.items.get(key);
      if (!item) {
        const root = node('article', 'supply-browser-card'), heading = node('div', 'supply-level-heading');
        const level = node('span', 'supply-level-badge'), status = node('span', 'supply-level-status');
        const name = node('h3', 'supply-level-name'), caption = node('p', 'supply-card-quantity');
        heading.append(level, status); root.append(heading, name, view.elements.button, caption);
        item = {root, level, status, name, caption, view}; this.items.set(key, item);
      }
      item.root.dataset.depleted = String(card.count === 0);
      item.root.dataset.current = String(card.cardId === top?.cardId);
      item.level.textContent = `${card.level} 级`; item.name.textContent = card.name;
      item.status.textContent = card.cardId === top?.cardId ? '当前顶牌' : card.count === 0 ? '已售罄' : '';
      item.caption.textContent = `剩余 ${card.count} 张`;
      return item;
    });
    for (const view of this.current) if (!ordered.some(item => item.view === view)) view.setVisible(false);
    this.current = ordered.map(item => item.view); reconcile(this.grid, ordered.map(item => item.root));
    if (focused) (this.current.some(view => view.elements.button === focused) ? focused : this.closeButton).focus({preventScroll: true});
    this.grid.scrollTop = scroll; this.title.textContent = pile.name;
    const count = supplyCount(pile); this.count.textContent = `共 ${count} 张`;
    this.take.disabled = !top;
    this.take.textContent = top ? `${this.options.takeLabel ?? '选择顶牌'}：${top.name}` : '供应已用尽';
    this.cards.interactions.refresh();
  }
  close(restoreFocus = true): void {
    if (!this.pile) return;
    this.pile = null; this.overlay.hidden = true;
    this.current.forEach(view => view.setVisible(false)); this.current = [];
    this.background.forEach((element, index) => {element.inert = this.inertBefore[index];});
    this.cards.interactions.setScope(null);
    if (restoreFocus && this.trigger?.isConnected && !this.trigger.hidden) this.trigger.focus({preventScroll: true});
    this.trigger = null;
  }
  private takeClicked = (): void => {
    const pile = this.pile, top = pile && supplyTop(pile);
    if (pile && top) this.options.onTakeTop?.({pileId: pile.id, cardId: top.cardId, name: top.name, level: top.level, infinite: pile.kind === 'basic'});
  };
  private closeClicked = (): void => {this.close();};
  private backdropClicked = (event: MouseEvent): void => {if (event.target === this.overlay) this.close();};
  private keydown = (event: KeyboardEvent): void => {
    if (!this.pile || event.isComposing) return;
    if (event.key === 'Escape') {event.preventDefault(); this.close(); return;}
    if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
    const targets: HTMLElement[] = [this.closeButton, ...this.current.map(view => view.elements.button)];
    if (this.options.onTakeTop && !this.take.disabled) targets.push(this.take);
    const index = targets.indexOf(document.activeElement as HTMLElement);
    if (event.shiftKey && index <= 0) {event.preventDefault(); targets.at(-1)!.focus();}
    else if (!event.shiftKey && (index < 0 || index === targets.length - 1)) {event.preventDefault(); targets[0].focus();}
  };
  dispose(): void {
    this.close(false); this.closeButton.removeEventListener('click', this.closeClicked);
    this.overlay.removeEventListener('click', this.backdropClicked); this.take.removeEventListener('click', this.takeClicked);
    window.removeEventListener('keydown', this.keydown); this.overlay.remove(); this.items.clear();
  }
}
