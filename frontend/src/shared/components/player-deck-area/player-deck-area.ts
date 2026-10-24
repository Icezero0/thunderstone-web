import {CardInteractions, createCardElements, defaultCardImages, type PhysicalCard} from '../game-card/index.js';
import {CardMotion, type Flight, type Reflow} from './card-motion.js';
import {allDeckCards, copyDeckState, sortHandByCardId} from './model.js';
import {HandArea} from './hand-area.js';
import {CardStack as PileArea} from '../game-card/index.js';
import {PileBrowser} from './pile-browser.js';
import {ShuffleMotion} from './shuffle-motion.js';
import {DestroyMotion} from './destroy-motion.js';
import {createPlayerDeckView, type PlayerDeckElements} from './view.js';
import {PlayerCardTabs} from './card-tabs.js';
import {PlayerResponseArea} from './response-area.js';
import type {CardImageSource, DeckAnimationStep, DeckTransition, PlayerCardTab, PlayerDeckCard, PlayerDeckOptions, PlayerDeckState, PlayerResponse} from './types.js';

/** Player-owned card presentation. The host supplies every gameplay state change. */
export class PlayerDeckArea {
  private state: PlayerDeckState = {hand: [], draw: [], discard: []};
  private readonly view: PlayerDeckElements;
  private readonly images: CardImageSource;
  private readonly interactions: CardInteractions;
  private readonly cards = new Map<string, PhysicalCard>();
  private readonly selected = new Set<string>();
  private readonly highlighted = new Set<string>();
  private readonly cleanup: (() => void)[] = [];
  private readonly hand: HandArea;
  private readonly auxiliary: Record<'treasures' | 'aside', HandArea>;
  private readonly tabs: PlayerCardTabs;
  private readonly response: PlayerResponseArea;
  private readonly draw: PileArea;
  private readonly discard: PileArea;
  private readonly browser: PileBrowser;
  private readonly motion: CardMotion;
  private readonly shuffle: ShuffleMotion;
  private readonly destruction: DestroyMotion;
  private sequenceFinal: PlayerDeckState | null = null;
  private sequenceRevision = 0;
  private autoArrange = false;
  private arranging = false;
  private moving = false;
  private disposed = false;
  private revision = 0;
  private lastBusy = false;

  constructor(host: HTMLElement, private readonly options: PlayerDeckOptions = {}) {
    this.view = createPlayerDeckView(host, options);
    this.images = {front: options.images?.front ?? defaultCardImages.front, back: options.images?.back ?? defaultCardImages.back};
    this.interactions = new CardInteractions(this.view.inspectOverlay, this.view.inspectContent, this.view.notice);
    this.browser = new PileBrowser(this.interactions, this.view.browser,
      options.background ?? [this.view.root], this.images, this.view.id);
    this.motion = new CardMotion(this.view.motion); this.shuffle = new ShuffleMotion(this.view.motion, this.view.cache);
    this.destruction = new DestroyMotion(this.view.motion, this.view.cache);
    this.draw = new PileArea(this.view.drawSlot, this.view.drawCount, false, {name: '抽牌堆'});
    this.discard = new PileArea(this.view.discardSlot, this.view.discardCount, true, {name: '弃牌堆'});
    this.bind(this.draw.empty, 'click', () => this.browse('draw', this.draw.empty));
    this.bind(this.discard.empty, 'click', () => this.browse('discard', this.discard.empty));
    this.hand = new HandArea(this.view.handTrack, this.view.handEmpty, () => this.finish(), {
      canDrag: () => this.tabs.active === 'hand' && !this.blocked && !this.browser.isOpen && !this.autoArrange,
      started: () => {this.arranging = true; this.interactions.setSuspended(true); this.updateControls();},
      committed: cards => {
        const items = new Map(this.state.hand.map(item => [item.id, item]));
        this.state = {...this.state, hand: cards.map(card => items.get(card.elements.button.dataset.instanceId!)!)};
        this.options.onHandOrderChange?.(this.handOrder);
      },
      finished: () => {this.arranging = false; this.interactions.setSuspended(this.moving); this.updateControls();},
    });
    const auxiliaryRow = (kind: 'treasures' | 'aside') => new HandArea(this.view.panels[kind], this.view.auxiliaryEmpty[kind], () => {}, {
      canDrag: () => false, started: () => {}, committed: () => {}, finished: () => {},
    });
    this.auxiliary = {treasures: auxiliaryRow('treasures'), aside: auxiliaryRow('aside')};
    this.tabs = new PlayerCardTabs(this.view, () => {
      this.finish(); this.interactions.setSuspended(true);
      this.hand.layout(); this.auxiliary.treasures.layout(); this.auxiliary.aside.layout();
      this.interactions.setSuspended(this.isBusy);
    });
    this.response = new PlayerResponseArea(this.view.response, this.view.id, options.onResponse);
    this.bind(this.view.autoSort, 'change', () => this.setAutoSort(this.view.autoSort.checked));
    window.addEventListener('blur', this.finish);
    window.addEventListener('pagehide', this.finish);
    document.addEventListener('visibilitychange', this.visibility);
    this.render();
  }

  get root(): HTMLElement {return this.view.root;}
  get isBusy(): boolean {return this.moving || this.arranging || this.sequenceFinal !== null;}
  get isBrowsing(): boolean {return this.browser.isOpen;}
  get autoSortEnabled(): boolean {return this.autoArrange;}
  get handOrder(): readonly string[] {return this.state.hand.map(card => card.id);}
  get selectedIds(): readonly string[] {return this.state.hand.filter(card => this.selected.has(card.id)).map(card => card.id);}
  get activeTab(): PlayerCardTab {return this.tabs.active;}
  setActiveTab(tab: PlayerCardTab): boolean {this.assertActive(); return this.tabs.select(tab);}
  setResponse(response: PlayerResponse | null): void {
    this.assertActive();
    const wasFocused = document.activeElement instanceof HTMLElement && this.view.response.contains(document.activeElement);
    this.response.set(response);
    if (wasFocused && !response?.choices?.length) this.view.tabs[this.activeTab].focus({preventScroll: true});
  }
  private get blocked(): boolean {return this.isBusy || this.disposed;}
  private assertActive(): void {if (this.disposed) throw new Error('PlayerDeckArea has been disposed.');}
  private copyState(state: PlayerDeckState): PlayerDeckState {
    const copied = copyDeckState(state);
    for (const item of allDeckCards(copied)) {
      const existing = this.cards.get(item.id);
      if (existing && existing.elements.button.dataset.cardId !== item.cardId) {
        throw new Error(`Card instance ${item.id} changed catalog identity.`);
      }
    }
    return copied;
  }

  /** A newer host snapshot interrupts visual work; surviving cards retain their local display order. */
  setState(state: PlayerDeckState, options: {clearSelection?: boolean; resetHandOrder?: boolean; closeBrowser?: boolean} = {}): void {
    this.assertActive();
    const copied = this.copyState(state);
    this.finish();
    this.applyState(copied, options);
  }
  private applyState(copied: PlayerDeckState, options: {clearSelection?: boolean; resetHandOrder?: boolean; closeBrowser?: boolean} = {}): void {
    if (options.closeBrowser) this.browser.close(false);
    this.state = this.orderState(copied, options.resetHandOrder);
    if (options.clearSelection) {this.selected.clear(); this.highlighted.clear();}
    this.pruneSelection(); this.render(); this.emitSelection();
  }

  setAutoSort(enabled: boolean): void {
    this.assertActive();
    if (this.blocked || this.browser.isOpen) {this.view.autoSort.checked = this.autoArrange; return;}
    this.autoArrange = enabled;
    if (enabled) {
      this.state = {...this.state, hand: sortHandByCardId(this.state.hand)};
      this.hand.setCards(this.state.hand.map(item => this.getCard(item)), this.activeTab === 'hand');
    }
    this.updateControls(); this.options.onAutoSortChange?.(enabled);
  }

  /** Apply a host's local draft selection without emitting a user selection event. */
  setSelectedIds(ids: readonly string[]): void {
    this.assertActive();
    const present = new Set(this.state.hand.map(card => card.id));
    if (new Set(ids).size !== ids.length || ids.some(id => !present.has(id))) throw new Error('Selected cards must be unique hand instances.');
    this.selected.clear(); ids.forEach(id => this.selected.add(id)); this.updateSelection();
  }

  /** Glow is a host-supplied hint; it never grants permission to use a card. */
  setHighlightedIds(ids: readonly string[]): void {
    this.assertActive();
    const present = new Set(this.state.hand.map(card => card.id));
    if (new Set(ids).size !== ids.length || ids.some(id => !present.has(id))) throw new Error('Highlighted cards must be unique hand instances.');
    this.highlighted.clear(); ids.forEach(id => this.highlighted.add(id)); this.updateSelection();
  }

  private orderState(state: PlayerDeckState, resetOrder = false): PlayerDeckState {
    const incoming = new Map(state.hand.map(card => [card.id, card]));
    const previousIds = new Set(this.handOrder);
    const ordered = resetOrder ? [...state.hand] : [
      ...this.state.hand.filter(card => incoming.has(card.id)).map(card => incoming.get(card.id)!),
      ...state.hand.filter(card => !previousIds.has(card.id)),
    ];
    return {...state, hand: this.autoArrange ? sortHandByCardId(ordered) : ordered};
  }
  private bind(element: HTMLElement, type: string, callback: (event: Event) => void): void {
    element.addEventListener(type, callback); this.cleanup.push(() => element.removeEventListener(type, callback));
  }
  private getCard(item: PlayerDeckCard): PhysicalCard {
    let card = this.cards.get(item.id);
    if (card) {
      if (card.elements.button.dataset.cardId !== item.cardId) throw new Error(`Card instance ${item.id} changed catalog identity.`);
      card.setName(item.name);
      return card;
    }
    const elements = createCardElements(item.cardId, this.images, this.view.descriptionId);
    const first = this.cards.size === 0;
    elements.button.id = this.view.id(first ? 'first-card' : `card-${item.id}`);
    if (first) {
      for (const [key, node] of Object.entries({
        'card-body': elements.surface, 'card-front': elements.front, 'card-back': elements.back,
        'front-image': elements.frontImage, 'back-image': elements.backImage,
        'first-inspection': elements.inspection, 'inspect-image': elements.largeFront, 'inspect-back-image': elements.largeBack,
      })) node.id = this.view.id(key);
    }
    this.view.cache.append(elements.button);
    card = this.interactions.add(elements, item.name); card.setVisible(false);
    this.cards.set(item.id, card); elements.button.dataset.instanceId = item.id;
    this.bind(elements.button, 'click', event => {
      if (this.hand.consumeClick(elements.button, event as MouseEvent) || this.blocked || this.browser.isOpen) return;
      for (let node: HTMLElement | null = elements.button; node; node = node.parentElement) if (node.hidden || node.inert) return;
      if (this.state.draw[0]?.id === item.id) {this.browse('draw', elements.button); return;}
      if (this.state.discard.at(-1)?.id === item.id) {this.browse('discard', elements.button); return;}
      if (this.activeTab !== 'hand' || !this.state.hand.some(data => data.id === item.id)) return;
      if (this.options.onHandCardClick?.(item.id) === true) return;
      if (this.selected.has(item.id)) this.selected.delete(item.id); else this.selected.add(item.id);
      this.updateSelection(); this.emitSelection();
    });
    return card;
  }
  private browse(kind: 'draw' | 'discard', trigger: HTMLElement): void {
    if (!this.blocked) this.browser.open(kind, this.state[kind], trigger);
  }
  private pileTrigger(kind: 'draw' | 'discard'): HTMLElement {
    const top = kind === 'draw' ? this.state.draw[0] : this.state.discard.at(-1);
    return top ? this.getCard(top).elements.button : (kind === 'draw' ? this.draw : this.discard).empty;
  }
  openPileBrowser(kind: 'draw' | 'discard'): void {
    this.assertActive(); this.browse(kind, this.pileTrigger(kind));
  }
  private pruneSelection(): void {
    const present = new Set(this.handOrder);
    for (const id of this.selected) if (!present.has(id)) this.selected.delete(id);
    for (const id of this.highlighted) if (!present.has(id)) this.highlighted.delete(id);
  }
  private emitSelection(): void {this.options.onSelectionChange?.(this.selectedIds);}
  private updateSelection(): void {
    const handIds = new Set(this.handOrder);
    for (const [id, card] of this.cards) card.setGlow(handIds.has(id) && this.highlighted.has(id));
    for (const item of this.state.hand) {
      const button = this.getCard(item).elements.button, selected = this.selected.has(item.id);
      button.dataset.selected = String(selected); button.setAttribute('aria-pressed', String(selected));
    }
  }
  private updateControls(): void {
    this.view.autoSort.checked = this.autoArrange; this.view.autoSort.disabled = this.blocked;
    this.tabs.setDisabled(this.blocked); this.response.setDisabled(this.blocked);
    this.hand.track.dataset.autoSort = String(this.autoArrange);
    this.root.setAttribute('aria-busy', String(this.isBusy));
    if (this.lastBusy !== this.isBusy) {
      this.lastBusy = this.isBusy; this.options.onBusyChange?.(this.isBusy);
    }
  }
  private render(): void {
    for (const item of allDeckCards(this.state)) this.getCard(item);
    for (const card of this.cards.values()) {
      card.setVisible(false); card.elements.button.dataset.selected = 'false'; card.elements.button.removeAttribute('aria-pressed');
    }
    this.draw.showTop(this.state.draw[0] ? this.getCard(this.state.draw[0]) : null);
    const discardTop = this.state.discard.at(-1);
    this.discard.showTop(discardTop ? this.getCard(discardTop) : null);
    this.draw.setCount(this.state.draw.length); this.discard.setCount(this.state.discard.length);
    this.hand.setCards(this.state.hand.map(item => this.getCard(item)));
    for (const kind of ['treasures', 'aside'] as const) {
      const items = this.state[kind] ?? [];
      this.auxiliary[kind].setCards(items.map(item => this.getCard(item)));
      for (const item of items) this.getCard(item).setFaceUp(item.faceUp ?? true, false);
    }
    this.tabs.update(this.state.treasures?.length ?? 0, this.state.aside?.length ?? 0);
    this.hand.layout(); this.auxiliary.treasures.layout(); this.auxiliary.aside.layout();
    if (this.browser.pile) this.browser.refresh(this.state[this.browser.pile], this.pileTrigger(this.browser.pile));
    this.updateSelection(); this.updateControls(); this.interactions.refresh();
  }

  closeBrowser(): void {this.assertActive(); this.browser.close(false); this.finish();}

  /** Animate already-decided card movements. This method never draws/discards according to game rules. */
  async animateTo(state: PlayerDeckState, transition: DeckTransition): Promise<void> {
    this.finish(); await this.moveTo(state, transition);
  }
  private async moveTo(state: PlayerDeckState, transition: DeckTransition): Promise<void> {
    this.assertActive();
    const copied = this.copyState(state), ids = [...transition.instanceIds], kind = transition.kind;
    if (!ids.length) {this.applyState(copied); return;}
    const source = kind === 'draw' ? this.state.draw : this.state.hand;
    const destination = kind === 'draw' ? copied.hand : copied.discard;
    if (new Set(ids).size !== ids.length || ids.some(id => !source.some(card => card.id === id) || !destination.some(card => card.id === id))) {
      throw new Error('Animated instances must exist in the source and destination zones.');
    }
    // Host events still update an open modal immediately; do not animate obscured piles behind it.
    if (this.browser.isOpen || this.activeTab !== 'hand') {this.applyState(copied, {clearSelection: true}); return;}
    this.finishMovement();
    const previous = this.state, generation = ++this.revision;
    const moved = ids.map(id => source.find(card => card.id === id)!);
    const oldRects = new Map(previous.hand.map(item => [item.id, this.getCard(item).elements.button.getBoundingClientRect()]));
    const sources = new Map(moved.map(item => [item.id, kind === 'draw'
      ? this.draw.slot.getBoundingClientRect() : this.getCard(item).elements.surface.getBoundingClientRect()]));
    this.state = this.orderState(copied); this.moving = true; this.selected.clear();
    this.interactions.setSuspended(true); this.updateControls(); this.emitSelection();
    const movedCards = moved.map(item => this.getCard(item));
    await Promise.all(movedCards.map(card => card.prepared));
    if (generation !== this.revision || this.disposed) return;
    try {
      this.render();
      if (this.canAnimate(movedCards)) {
        const reflows: Reflow[] = this.state.hand.filter(item => oldRects.has(item.id)).map(item => ({
          element: this.getCard(item).elements.button, from: oldRects.get(item.id)!,
          to: this.getCard(item).elements.button.getBoundingClientRect(),
        }));
        const flights: Flight[] = moved.map((item, index) => {
          const card = this.getCard(item);
          return {card, from: sources.get(item.id)!,
            to: kind === 'draw' ? card.elements.button.getBoundingClientRect() : this.discard.slot.getBoundingClientRect(),
            destination: kind === 'draw' ? this.hand.track : this.discard.slot, reveal: kind === 'draw',
            departed: () => {if (kind === 'draw') this.draw.setCount(previous.draw.length - index - 1);},
            landed: () => {
              if (kind === 'discard') {this.discard.showTop(card); this.discard.setCount(previous.discard.length + index + 1);}
            }};
        });
        if (kind === 'draw') this.draw.setCount(previous.draw.length);
        else {
          const oldTop = previous.discard.at(-1);
          this.discard.showTop(oldTop ? this.getCard(oldTop) : null); this.discard.setCount(previous.discard.length);
        }
        await this.motion.play(flights, reflows);
      }
    } finally {if (generation === this.revision && !this.disposed) this.completeMovement();}
  }

  /** Visual discard-to-draw transfer; the host supplies the final shuffled state. */
  async shuffleTo(state: PlayerDeckState): Promise<void> {
    this.finish(); await this.shuffleStep(state);
  }
  private async shuffleStep(state: PlayerDeckState): Promise<void> {
    this.assertActive();
    const copied = this.copyState(state);
    if (this.browser.isOpen) {this.applyState(copied, {clearSelection: true}); return;}
    this.finishMovement();
    const views = this.state.discard.slice(-6).map(item => this.getCard(item));
    const from = this.discard.slot.getBoundingClientRect(), to = this.draw.slot.getBoundingClientRect();
    const generation = ++this.revision;
    this.state = this.orderState(copied); this.moving = true; this.selected.clear();
    this.interactions.setSuspended(true); this.updateControls(); this.updateSelection(); this.emitSelection();
    await Promise.all(views.map(card => card.prepared));
    if (generation !== this.revision || this.disposed) return;
    try {
      if (this.canAnimate(views)) {
        this.discard.showTop(null); this.discard.setCount(0); await this.shuffle.play(views, from, to);
      }
    } finally {if (generation === this.revision && !this.disposed) this.completeMovement();}
  }
  async destroyTo(state: PlayerDeckState, instanceIds: readonly string[]): Promise<void> {
    this.finish(); await this.destroyStep(state, instanceIds);
  }
  private async destroyStep(state: PlayerDeckState, instanceIds: readonly string[]): Promise<void> {
    this.assertActive(); const copied = this.copyState(state);
    const victims = instanceIds.map(id => this.state.hand.find(card => card.id === id));
    if (new Set(instanceIds).size !== instanceIds.length || victims.some(card => !card) ||
      allDeckCards(copied).some(card => instanceIds.includes(card.id))) throw new Error('Destroyed instances must leave the player hand and owned zones.');
    if (this.browser.isOpen || this.activeTab !== 'hand') {this.applyState(copied, {clearSelection: true}); return;}
    this.finishMovement(); const generation = ++this.revision;
    this.state = this.orderState(copied); this.moving = true; this.selected.clear(); this.highlighted.clear();
    this.interactions.setSuspended(true); this.updateControls(); this.emitSelection();
    try {
      for (const item of victims) {
        const card = this.getCard(item!); await card.prepared;
        if (generation !== this.revision || this.disposed) return;
        if (this.canAnimate([card])) await this.destruction.play(card, card.elements.surface.getBoundingClientRect());
        if (generation !== this.revision || this.disposed) return;
      }
    } finally {if (generation === this.revision && !this.disposed) this.completeMovement();}
  }

  /** One committed result, several visual steps. Interruptions snap directly to that final result. */
  async animateSequence(state: PlayerDeckState, steps: readonly DeckAnimationStep[]): Promise<void> {
    this.assertActive(); const final = this.copyState(state);
    const copied = steps.map(step => ({...step, state: this.copyState(step.state),
      ...(step.kind !== 'shuffle' ? {instanceIds: [...step.instanceIds]} : {})})) as DeckAnimationStep[];
    this.finish();
    if (!copied.length || this.browser.isOpen || this.activeTab !== 'hand' || document.hidden ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches || typeof this.view.motion.animate !== 'function') {
      this.applyState(final, {clearSelection: true}); return;
    }
    const generation = ++this.sequenceRevision; this.sequenceFinal = final;
    this.interactions.setSuspended(true); this.updateControls();
    try {
      for (const step of copied) {
        if (generation !== this.sequenceRevision || this.disposed) return;
        if (step.kind === 'shuffle') await this.shuffleStep(step.state);
        else if (step.kind === 'destroy') await this.destroyStep(step.state, step.instanceIds);
        else await this.moveTo(step.state, {kind: step.kind, instanceIds: step.instanceIds});
      }
    } finally {
      if (generation === this.sequenceRevision && !this.disposed) {
        this.sequenceFinal = null; this.interactions.setSuspended(false); this.applyState(final, {clearSelection: true});
      }
    }
  }
  private canAnimate(cards: PhysicalCard[]): boolean {
    return !!cards.length && cards.every(card => card.ready) && !document.hidden
      && !window.matchMedia('(prefers-reduced-motion: reduce)').matches && typeof this.view.motion.animate === 'function';
  }
  private completeMovement(): void {
    this.moving = false; this.interactions.setSuspended(this.isBusy); this.render();
  }
  /** Drag cancellation reverts an uncommitted gesture; animations snap to their committed result. */
  finish = (): void => {
    ++this.sequenceRevision;
    const final = this.sequenceFinal;
    this.finishMovement();
    this.sequenceFinal = null;
    if (final) {this.interactions.setSuspended(false); this.applyState(final, {clearSelection: true});}
  };
  private finishMovement(): void {
    this.hand.finish(); this.auxiliary.treasures.finish(); this.auxiliary.aside.finish();
    if (!this.moving) return;
    ++this.revision; this.motion.finish(); this.shuffle.finish(); this.destruction.finish(); this.completeMovement();
  }
  private visibility = (): void => {if (document.hidden) this.finish();};
  dispose(): void {
    if (this.disposed) return;
    this.finish(); this.browser.dispose(); this.disposed = true; ++this.revision;
    this.hand.dispose(); this.auxiliary.treasures.dispose(); this.auxiliary.aside.dispose(); this.tabs.dispose(); this.response.dispose();
    this.draw.showTop(null); this.discard.showTop(null);
    this.cleanup.forEach(cleanup => cleanup()); this.interactions.dispose(); this.view.notice.textContent = ''; this.view.dispose();
    this.cards.clear(); this.selected.clear(); this.highlighted.clear(); this.state = {hand: [], draw: [], discard: []};
    window.removeEventListener('blur', this.finish); window.removeEventListener('pagehide', this.finish);
    document.removeEventListener('visibilitychange', this.visibility);
  }
}
