import {CardInteractions, createCardElements, defaultCardImages, type PhysicalCard} from '../game-card/index.js';
import {CardMotion, type Flight, type Reflow} from './card-motion.js';
import {allDeckCards, copyDeckState, sortHandByCardId} from './model.js';
import {HandArea} from './hand-area.js';
import {CardStack as PileArea} from '../game-card/index.js';
import {PileBrowser} from './pile-browser.js';
import {ShuffleMotion} from './shuffle-motion.js';
import {DestroyMotion} from './destroy-motion.js';
import {UpgradeMotion} from './upgrade-motion.js';
import {EquipmentMotion} from './equipment-motion.js';
import {createPlayerDeckView, type PlayerDeckElements} from './view.js';
import {PlayerCardTabs} from './card-tabs.js';
import {PlayerResponseArea} from './response-area.js';
import {PlayerResourceDisplay} from './resources.js';
import type {CardImageSource, DeckAnimationStep, DeckTransition, HandBattleDisplay, PlayerCardTab, PlayerDeckCard, PlayerDeckOptions, PlayerDeckState, PlayerResponse, PlayerResources} from './types.js';
import type {CardStatus} from '../game-card/types.js';

/** Player-owned card presentation. The host supplies every gameplay state change. */
export class PlayerDeckArea {
  private state: PlayerDeckState = {hand: [], draw: [], discard: []};
  private readonly view: PlayerDeckElements;
  private readonly images: CardImageSource;
  private readonly interactions: CardInteractions;
  private readonly cards = new Map<string, PhysicalCard>();
  private statusOverrides: Record<string, readonly CardStatus[]> = {};
  private readonly selected = new Set<string>();
  private readonly highlighted = new Set<string>();
  private targetIds = new Set<string>();
  private targetSelection = new Set<string>();
  private readonly cleanup: (() => void)[] = [];
  private readonly cardCleanup: (() => void)[] = [];
  private readonly hand: HandArea;
  private readonly auxiliary: Record<'treasures' | 'aside' | 'revealed', HandArea>;
  private readonly tabs: PlayerCardTabs;
  private readonly response: PlayerResponseArea;
  private readonly resources: PlayerResourceDisplay;
  private readonly draw: PileArea;
  private readonly discard: PileArea;
  private readonly browser: PileBrowser;
  private readonly motion: CardMotion;
  private readonly shuffle: ShuffleMotion;
  private readonly destruction: DestroyMotion;
  private readonly upgrade: UpgradeMotion;
  private readonly equipmentMotion = new EquipmentMotion();
  private sequenceFinal: PlayerDeckState | null = null;
  private sequenceRevision = 0;
  private autoArrange = false;
  private arranging = false;
  private moving = false;
  private disposed = false;
  private revision = 0;
  private lastBusy = false;
  private interactionLocked = false;
  private battleDisplay: HandBattleDisplay = {mandatoryIds: [], equipment: {}};
  private battleLayoutDirty = false;

  constructor(host: HTMLElement, private readonly options: PlayerDeckOptions = {}) {
    this.view = createPlayerDeckView(host, options);
    this.resources = new PlayerResourceDisplay(this.view.resources, this.view.id);
    this.images = {front: options.images?.front ?? defaultCardImages.front, back: options.images?.back ?? defaultCardImages.back};
    this.interactions = new CardInteractions(this.view.inspectOverlay, this.view.inspectContent, this.view.notice);
    this.browser = new PileBrowser(this.interactions, this.view.browser,
      options.background ?? [this.view.root], this.images, this.view.id, id => {if (!this.blocked) this.options.onCardTargetClick?.(id);});
    this.motion = new CardMotion(this.view.motion); this.shuffle = new ShuffleMotion(this.view.motion, this.view.cache);
    this.destruction = new DestroyMotion(this.view.motion, this.view.cache);
    this.upgrade = new UpgradeMotion(this.view.motion, this.view.cache);
    this.draw = new PileArea(this.view.drawSlot, this.view.drawCount, false, {name: '抽牌堆'});
    this.discard = new PileArea(this.view.discardSlot, this.view.discardCount, true, {name: '弃牌堆'});
    this.bind(this.draw.empty, 'click', () => this.browse('draw', this.draw.empty));
    this.bind(this.discard.empty, 'click', () => this.browse('discard', this.discard.empty));
    this.hand = new HandArea(this.view.handTrack, this.view.handEmpty, () => this.finish(), {
      canDrag: () => this.tabs.active === 'hand' && !this.blocked && !this.browser.isOpen && !this.autoArrange,
      started: () => {this.arranging = true; this.interactions.setSuspended(true); this.updateControls();},
      committed: cards => {
        const items = new Map(this.state.hand.map(item => [item.id, item]));
        const order = cards.flatMap(card => {const id = card.elements.button.dataset.instanceId!; return [id, ...this.battleDisplay.equipment[id] ?? []];});
        this.state = {...this.state, hand: order.filter(id => items.has(id)).map(id => items.get(id)!)};
        this.options.onHandOrderChange?.(this.handOrder);
      },
      finished: () => {this.arranging = false; this.interactions.setSuspended(this.moving); this.updateControls();},
    });
    const auxiliaryRow = (kind: 'treasures' | 'aside' | 'revealed') => new HandArea(this.view.panels[kind], this.view.auxiliaryEmpty[kind], () => {}, {
      canDrag: () => false, started: () => {}, committed: () => {}, finished: () => {},
    });
    this.auxiliary = {treasures: auxiliaryRow('treasures'), aside: auxiliaryRow('aside'), revealed: auxiliaryRow('revealed')};
    this.tabs = new PlayerCardTabs(this.view, interrupt => {
      if (interrupt) this.finish(); this.interactions.setSuspended(true);
      this.hand.layout(); this.auxiliary.treasures.layout(); this.auxiliary.aside.layout(); this.auxiliary.revealed.layout();
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
  get isBusy(): boolean {return this.interactionLocked || this.moving || this.arranging || this.sequenceFinal !== null;}
  get isBrowsing(): boolean {return this.browser.isOpen;}
  get autoSortEnabled(): boolean {return this.autoArrange;}
  get handOrder(): readonly string[] {return this.state.hand.map(card => card.id);}
  get selectedIds(): readonly string[] {return this.state.hand.filter(card => this.selected.has(card.id)).map(card => card.id);}
  get activeTab(): PlayerCardTab {return this.tabs.active;}
  setActiveTab(tab: PlayerCardTab, options: {duringAnimation?: boolean} = {}): boolean {this.assertActive(); return this.tabs.select(tab, !!options.duringAnimation);}
  setResources(resources: PlayerResources | null): void {this.assertActive(); this.resources.set(resources);}
  setInteractionLocked(locked: boolean): void {this.interactionLocked = locked; this.interactions.setSuspended(this.isBusy); this.updateControls();}
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

  /** New match/history epoch: discard cached identities before loading an authoritative snapshot. */
  resetState(state: PlayerDeckState): void {
    this.assertActive(); const copied = copyDeckState(state);
    this.finish(); this.browser.resetCards(); this.hand.resetCards();
    for (const area of Object.values(this.auxiliary)) area.resetCards();
    this.cardCleanup.splice(0).forEach(cleanup => cleanup());
    for (const card of this.cards.values()) this.interactions.remove(card);
    this.cards.clear(); this.statusOverrides = {}; this.battleDisplay = {mandatoryIds: [], equipment: {}};
    this.state = {hand: [], draw: [], discard: []}; this.targetIds.clear(); this.selected.clear(); this.highlighted.clear();
    this.applyState(copied, {clearSelection: true, resetHandOrder: true, closeBrowser: true});
  }
  /** Ordinary snapshots preserve decoded identities, local display order and live pile browsing. */
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

  setAutoSort(enabled: boolean, options: {notify?: boolean} = {}): void {
    this.assertActive();
    if (this.blocked || this.browser.isOpen) {
      if (options.notify === false) this.pendingAutoSort = enabled;
      this.view.autoSort.checked = this.autoArrange; return;
    }
    this.autoArrange = enabled;
    if (enabled) {
      this.state = {...this.state, hand: sortHandByCardId(this.state.hand)};
      this.renderHand(this.activeTab === 'hand');
    }
    this.updateControls(); if (options.notify !== false) this.options.onAutoSortChange?.(enabled);
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
  /** Effect targets stay in their original hand, auxiliary area or pile browser. */
  setCardTargets(ids: readonly string[], selected: readonly string[] = []): void {
    this.targetIds = new Set(ids); this.targetSelection = new Set(selected);
    this.browser.setCardTargets(ids, selected);
    this.tabs.setAttention((['hand', 'treasures', 'aside', 'revealed'] as const).filter(kind => (this.state[kind] ?? []).some(card => this.targetIds.has(card.id))));
    this.updateSelection();
  }
  /** Equipment is attached visually; every instance remains in state.hand. */
  setBattleDisplay(display: HandBattleDisplay): void {
    this.assertActive();
    const key = (equipment: HandBattleDisplay['equipment']) => JSON.stringify(Object.entries(equipment).filter(([, ids]) => ids.length).sort(([a], [b]) => a.localeCompare(b)));
    const changed = key(display.equipment) !== key(this.battleDisplay.equipment);
    this.battleLayoutDirty ||= changed;
    const before = changed && !this.isBusy && !this.isBrowsing && this.activeTab === 'hand'
      ? new Map(this.state.hand.map(item => {const button = this.getCard(item).elements.button; return [button, button.getBoundingClientRect()];})) : null;
    if (changed) this.equipmentMotion.finish();
    this.battleDisplay = {mandatoryIds: [...display.mandatoryIds], equipment: Object.fromEntries(Object.entries(display.equipment).map(([id, values]) => [id, [...values]]))};
    if (!this.isBusy) {
      // Participation only changes markers. Moving all card nodes on each click
      // disturbs focus/pointer capture and needlessly recalculates hand geometry.
      if (this.battleLayoutDirty) this.renderHand();
      this.updateSelection(); if (before) this.equipmentMotion.play(before);
    }
  }
  /** Host-calculated local continuous effects; the authoritative snapshot is retained. */
  setStatusOverrides(statuses: Readonly<Record<string, readonly CardStatus[]>> | null): void {
    this.assertActive(); this.statusOverrides = Object.fromEntries(Object.entries(statuses ?? {})
      .map(([id, rows]) => [id, rows.map(row => ({...row}))]));
    if (!this.isBusy) for (const item of this.state.hand) this.getCard(item);
  }
  private renderHand(animate = false): void {
    const available = new Map(this.state.hand.map(item => [item.id, this.getCard(item)])), attached = new Set<string>();
    const attachments: {card: PhysicalCard; hero: PhysicalCard; index: number}[] = [];
    for (const [hero, weapons] of Object.entries(this.battleDisplay.equipment)) if (available.has(hero) && !this.state.hand.find(card => card.id === hero)?.attachments?.length)
      weapons.forEach((id, index) => {if (id !== hero && available.has(id) && !attached.has(id)) {attached.add(id); attachments.push({card: available.get(id)!, hero: available.get(hero)!, index});}});
    for (const [id, card] of this.cards) {
      const button = card.elements.button;
      if (!attached.has(id) && button.dataset.equippedTo) delete button.dataset.equippedTo;
    }
    const grouped = new Set(this.state.hand.flatMap(item => item.attachments?.length
      ? [...item.attachments.map(card => card.id), ...this.battleDisplay.equipment[item.id] ?? []] : []));
    this.hand.setCards(this.state.hand.filter(item => !attached.has(item.id) && !grouped.has(item.id)).map(item => this.getCard(item)), animate);
    for (const entry of attachments) entry.card.elements.button.dataset.equippedTo = entry.hero.elements.button.dataset.instanceId!;
    this.hand.setAttachments(attachments);
    for (const id of grouped) this.cards.get(id)?.setVisible(false);
    this.battleLayoutDirty = false;
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
  private bind(element: HTMLElement, type: string, callback: (event: Event) => void, cleanup = this.cleanup): void {
    element.addEventListener(type, callback); cleanup.push(() => element.removeEventListener(type, callback));
  }
  private getCard(item: PlayerDeckCard): PhysicalCard {
    const attach = (card: PhysicalCard) => {
      const weapons = item.attachments?.length ? (this.battleDisplay.equipment[item.id] ?? []).flatMap(id => {
        const weapon = this.state.hand.find(data => data.id === id); return weapon ? [{...weapon, kind: 'weapon'}] : [];
      }) : [];
      card.setAttachments([...item.attachments ?? [], ...weapons], this.images, id => {
        if (this.targetIds.has(id)) this.options.onCardTargetClick?.(id);
        else if (weapons.some(item => item.id === id)) this.options.onHandCardClick?.(id);
      });
    };
    let card = this.cards.get(item.id);
    if (card) {
      if (card.elements.button.dataset.cardId !== item.cardId) throw new Error(`Card instance ${item.id} changed catalog identity.`);
      card.setName(item.name);
      card.setStatuses(this.state.hand.some(data => data.id === item.id) ? this.statusOverrides[item.id] ?? item.statuses : item.statuses);
      attach(card);
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
    card = this.interactions.add(elements, item.name);
    attach(card);
    card.setStatuses(this.state.hand.some(data => data.id === item.id) ? this.statusOverrides[item.id] ?? item.statuses : item.statuses); card.setVisible(false);
    this.cards.set(item.id, card); elements.button.dataset.instanceId = item.id;
    this.bind(elements.button, 'click', event => {
      if (this.hand.consumeClick(elements.button, event as MouseEvent) || this.blocked || this.browser.isOpen) return;
      for (let node: HTMLElement | null = elements.button; node; node = node.parentElement) if (node.hidden || node.inert) return;
      if (this.state.draw[0]?.id === item.id) {this.browse('draw', elements.button); return;}
      if (this.state.discard.at(-1)?.id === item.id) {this.browse('discard', elements.button); return;}
      if (this.activeTab !== 'hand') {
        if (this.targetIds.has(item.id) && this.state[this.activeTab]?.some(card => card.id === item.id)) this.options.onCardTargetClick?.(item.id);
        return;
      }
      if (!this.state.hand.some(data => data.id === item.id)) return;
      if (this.options.onHandCardClick?.(item.id) === true) return;
      if (this.selected.has(item.id)) this.selected.delete(item.id); else this.selected.add(item.id);
      this.updateSelection(); this.emitSelection();
    }, this.cardCleanup);
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
    for (const [id, card] of this.cards) {
      const pileTarget = (this.state.draw[0]?.id === id && this.state.draw.some(card => this.targetIds.has(card.id)))
        || (this.state.discard.at(-1)?.id === id && this.state.discard.some(card => this.targetIds.has(card.id)));
      card.setGlow(handIds.has(id) && this.highlighted.has(id) || this.targetIds.has(id) || pileTarget);
      card.setTargetSelected(this.targetSelection.has(id));
      if (!handIds.has(id)) card.setActive(this.targetSelection.has(id));
      card.elements.button.dataset.forced = String(handIds.has(id) && this.battleDisplay.mandatoryIds.includes(id));
    }
    for (const item of this.state.hand) {
      const button = this.getCard(item).elements.button, selected = this.selected.has(item.id);
      const mandatory = this.battleDisplay.mandatoryIds.includes(item.id);
      button.dataset.forced = String(mandatory); button.dataset.selected = String(selected || mandatory); button.setAttribute('aria-pressed', String(selected || mandatory));
    }
  }
  private pendingAutoSort: boolean | null = null;
  private updateControls(): void {
    if (!this.blocked && !this.browser.isOpen && this.pendingAutoSort !== null) {
      const enabled = this.pendingAutoSort; this.pendingAutoSort = null; this.setAutoSort(enabled, {notify: false});
    }
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
    this.renderHand();
    for (const kind of ['treasures', 'aside', 'revealed'] as const) {
      const attached = new Set(allDeckCards(this.state).flatMap(card => card.attachments?.map(entry => entry.id) ?? []));
      const items = (this.state[kind] ?? []).filter(card => !attached.has(card.id));
      this.auxiliary[kind].setCards(items.map(item => this.getCard(item)));
      for (const item of items) this.getCard(item).setFaceUp(item.faceUp ?? true, false);
    }
    this.tabs.update(this.state.treasures?.length ?? 0, this.state.aside?.length ?? 0, this.state.revealed?.length ?? 0);
    this.hand.layout(); this.auxiliary.treasures.layout(); this.auxiliary.aside.layout(); this.auxiliary.revealed.layout();
    if (this.browser.pile) this.browser.refresh(this.state[this.browser.pile], this.pileTrigger(this.browser.pile));
    this.updateSelection(); this.updateControls(); this.interactions.refresh();
  }

  closeBrowser(): void {this.assertActive(); this.browser.close(false); this.finish();}
  discardRect(): DOMRect {return this.discard.slot.getBoundingClientRect();}
  drawRect(): DOMRect {return this.draw.slot.getBoundingClientRect();}
  handRect(): DOMRect {return this.view.handTrack.getBoundingClientRect();}
  cardRect(id: string): DOMRect | null {
    const anchor = allDeckCards(this.state).find(card => card.attachments?.some(item => item.id === id));
    if (anchor) {this.cardRect(anchor.id); return this.cards.get(anchor.id)?.attachmentRect() ?? null;}
    for (const kind of ['hand', 'treasures', 'aside', 'revealed'] as const) if (this.state[kind]?.some(card => card.id === id)) {
      this.tabs.select(kind, true); return this.cards.get(id)?.elements.surface.getBoundingClientRect() ?? null;
    }
    return this.state.draw.some(card => card.id === id) ? this.drawRect() : this.state.discard.some(card => card.id === id) ? this.discardRect() : null;
  }
  attachmentRect(anchor: string): DOMRect | null {this.cardRect(anchor); return this.cards.get(anchor)?.attachmentRect() ?? this.cardRect(anchor);}
  hideCard(id: string): void {this.cards.get(id)?.setVisible(false);}
  /** An already-claimed treasure arrives from the public reveal, then stays in control. */
  async receiveTreasure(state: PlayerDeckState, id: string, from: {left: number; top: number; width: number; height: number}): Promise<void> {
    this.finish(); const copied = this.copyState(state), item = copied.treasures?.find(card => card.id === id);
    if (!item) throw new Error('A treasure arrival requires a committed treasure instance.');
    this.state = this.orderState(copied); this.render(); this.tabs.select('treasures', true);
    const card = this.getCard(item), generation = ++this.revision;
    this.moving = true; this.interactions.setSuspended(true); this.updateControls();
    await card.prepared;
    if (generation !== this.revision || this.disposed) return;
    try {if (this.canAnimate([card])) await this.motion.play([{card, from, to: card.elements.button.getBoundingClientRect(),
      destination: this.view.panels.treasures, reveal: false, departed: () => {}, landed: () => {}}], []);}
    finally {if (generation === this.revision && !this.disposed) this.completeMovement();}
  }

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
    const previous = this.state;
    const victims = instanceIds.map(id => allDeckCards(previous).find(card => card.id === id));
    if (new Set(instanceIds).size !== instanceIds.length || victims.some(card => !card) ||
      allDeckCards(copied).some(card => instanceIds.includes(card.id))) throw new Error('Destroyed instances must leave the player owned zones.');
    if (this.browser.isOpen) {this.applyState(copied, {clearSelection: true}); return;}
    this.finishMovement(); const generation = ++this.revision;
    const origins = new Map(victims.map(item => [item!.id, this.cardRect(item!.id)]));
    this.state = this.orderState(copied); this.moving = true; this.selected.clear(); this.highlighted.clear();
    this.interactions.setSuspended(true); this.updateControls(); this.emitSelection();
    try {
      for (const item of victims) {
        const card = this.getCard(item!); await card.prepared;
        if (generation !== this.revision || this.disposed) return;
        const origin = previous.discard.some(data => data.id === item!.id) ? this.discard.slot
          : previous.draw.some(data => data.id === item!.id) ? this.draw.slot : card.elements.surface;
        if (this.canAnimate([card])) await this.destruction.play(card, origins.get(item!.id) ?? origin.getBoundingClientRect());
        if (generation !== this.revision || this.disposed) return;
      }
    } finally {if (generation === this.revision && !this.disposed) this.completeMovement();}
  }

  /** Fly a newly owned card from a captured external source into the discard pile. */
  private async gainStep(step: Extract<DeckAnimationStep, {kind: 'gain'}>): Promise<void> {
    const copied = this.copyState(step.state), ids = [...step.instanceIds], previous = this.state;
    const destination = step.destination ?? 'discard';
    const owned = new Set(allDeckCards(previous).map(card => card.id));
    if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => owned.has(id)
      || !copied[destination].some(card => card.id === id))) throw new Error('Gained instances must be new cards entering the requested player zone.');
    for (const id of ids) {
      const rect = step.origins[id];
      if (!rect || ![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0)
        throw new Error('Gained cards require positive, finite origin bounds.');
    }
    this.finishMovement(); const generation = ++this.revision;
    this.state = this.orderState(copied); this.moving = true; this.selected.clear();
    this.interactions.setSuspended(true); this.updateControls(); this.emitSelection();
    const cards = ids.map(id => this.getCard(copied[destination].find(card => card.id === id)!));
    await Promise.all(cards.map(card => card.prepared));
    if (generation !== this.revision || this.disposed) return;
    try {
      this.render();
      if (this.canAnimate(cards)) {
        const pile = destination === 'draw' ? this.draw : this.discard;
        if (destination !== 'hand') {
          const top = destination === 'draw' ? previous.draw[0] : previous.discard.at(-1);
          pile.showTop(top ? this.getCard(top) : null); pile.setCount(previous[destination].length);
        }
        await this.motion.play(cards.map((card, index) => ({card, from: step.origins[ids[index]],
          to: destination === 'hand' ? card.elements.button.getBoundingClientRect() : pile.slot.getBoundingClientRect(),
          destination: destination === 'hand' ? this.hand.track : pile.slot, reveal: false,
          departed: () => {}, landed: () => {if (destination !== 'hand') {pile.showTop(card); pile.setCount(previous[destination].length + index + 1);}},
        })), []);
      }
    } finally {if (generation === this.revision && !this.disposed) this.completeMovement();}
  }

  /** Known own cards may move between any owned zones, not just hand/discard. */
  private async transferStep(step: Extract<DeckAnimationStep, {kind: 'transfer'}>): Promise<void> {
    const {source, destination, instanceIds: ids} = step;
    if (source === 'draw' && destination === 'hand' || source === 'hand' && destination === 'discard') {
      await this.moveTo(step.state, {kind: source === 'draw' ? 'draw' : 'discard', instanceIds: ids}); return;
    }
    const previous = this.state, copied = this.copyState(step.state);
    const items = ids.map(id => previous[source]?.find(card => card.id === id));
    if (source === destination || new Set(ids).size !== ids.length || items.some(card => !card)
      || ids.some(id => !copied[destination]?.some(card => card.id === id))) throw new Error('Transfers require known source and destination cards.');
    this.finishMovement(); const generation = ++this.revision;
    const isTab = (zone: keyof PlayerDeckState): zone is PlayerCardTab => zone === 'hand' || zone === 'aside' || zone === 'treasures' || zone === 'revealed';
    if (isTab(source)) this.tabs.select(source, true);
    const from = items.map(item => source === 'draw' ? this.draw.slot.getBoundingClientRect()
      : source === 'discard' ? this.discard.slot.getBoundingClientRect() : this.cardRect(item!.id) ?? this.getCard(item!).elements.surface.getBoundingClientRect());
    const cards = items.map(item => this.getCard(item!));
    this.state = this.orderState(copied); this.moving = true; this.selected.clear();
    this.interactions.setSuspended(true); this.updateControls(); this.emitSelection();
    await Promise.all(cards.map(card => card.prepared));
    if (generation !== this.revision || this.disposed) return;
    try {
      this.render(); if (isTab(destination)) this.tabs.select(destination, true);
      if (this.canAnimate(cards)) {
        const pile = destination === 'draw' ? this.draw : destination === 'discard' ? this.discard : null;
        const originPile = source === 'draw' ? this.draw : source === 'discard' ? this.discard : null;
        originPile?.setCount(previous[source]?.length ?? 0);
        if (pile) {
          const top = destination === 'draw' ? previous.draw[0] : previous.discard.at(-1);
          pile.showTop(top ? this.getCard(top) : null); pile.setCount(previous[destination]?.length ?? 0);
        }
        await this.motion.play(cards.map((card, index) => ({card, from: from[index],
          to: pile ? pile.slot.getBoundingClientRect() : card.elements.button.getBoundingClientRect(),
          destination: pile ? pile.slot : destination === 'hand' ? this.hand.track : this.view.panels[destination as PlayerCardTab],
          reveal: source === 'draw',
          departed: () => originPile?.setCount((previous[source]?.length ?? 0) - index - 1),
          landed: () => {if (pile) {pile.showTop(card); pile.setCount((previous[destination]?.length ?? 0) + index + 1);}},
        })), [], step.fast ? {duration: 100, stagger: 12} : {});
      }
    } finally {if (generation === this.revision && !this.disposed) this.completeMovement();}
  }

  private async upgradeStep(step: Extract<DeckAnimationStep, {kind: 'upgrade'}>): Promise<void> {
    const copied = this.copyState(step.state), previous = this.state;
    const source = previous.hand.find(card => card.id === step.sourceInstanceId);
    const target = copied.discard.find(card => card.id === step.targetInstanceId);
    if (!source || !target || allDeckCards(copied).some(card => card.id === source.id)
      || allDeckCards(previous).some(card => card.id === target.id)) throw new Error('Upgrades must replace a hand instance with a new discard instance.');
    this.finishMovement(); const generation = ++this.revision;
    const oldCard = this.getCard(source), newCard = this.getCard(target), from = oldCard.elements.surface.getBoundingClientRect();
    this.state = this.orderState(copied); this.moving = true; this.selected.clear(); this.highlighted.clear();
    this.interactions.setSuspended(true); this.updateControls(); this.emitSelection();
    await Promise.all([oldCard.prepared, newCard.prepared]);
    if (generation !== this.revision || this.disposed) return;
    try {
      this.render();
      if (this.canAnimate([oldCard, newCard])) {
        this.discard.showTop(previous.discard.length ? this.getCard(previous.discard.at(-1)!) : null);
        this.discard.setCount(previous.discard.length);
        await this.upgrade.play(oldCard, newCard, from, this.discard.slot.getBoundingClientRect());
      }
    } finally {if (generation === this.revision && !this.disposed) this.completeMovement();}
  }

  /** One committed result, several visual steps. Interruptions snap directly to that final result. */
  async animateSequence(state: PlayerDeckState, steps: readonly DeckAnimationStep[]): Promise<void> {
    this.assertActive(); const final = this.copyState(state);
    const copied = steps.map(step => ({...step, state: this.copyState(step.state),
      // DOMRect fields are inherited accessors in browsers. Object spread would
      // silently turn a valid hall/spotlight origin into an empty object.
      ...(step.kind === 'gain' ? {origins: Object.fromEntries(Object.entries(step.origins).map(([id, rect]) => [id,
        {left: rect.left, top: rect.top, width: rect.width, height: rect.height}]))} : {}),
      ...('instanceIds' in step ? {instanceIds: [...step.instanceIds]} : {})})) as DeckAnimationStep[];
    this.finish();
    if (!copied.length || this.browser.isOpen || document.hidden ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches || typeof this.view.motion.animate !== 'function') {
      this.applyState(final, {clearSelection: true}); return;
    }
    this.tabs.select('hand', true);
    const generation = ++this.sequenceRevision; this.sequenceFinal = final;
    this.interactions.setSuspended(true); this.updateControls();
    try {
      for (const step of copied) {
        if (generation !== this.sequenceRevision || this.disposed) return;
        if (step.kind === 'shuffle') await this.shuffleStep(step.state);
        else if (step.kind === 'gain') await this.gainStep(step);
        else if (step.kind === 'upgrade') await this.upgradeStep(step);
        else if (step.kind === 'transfer') await this.transferStep(step);
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
    this.equipmentMotion.finish();
    this.hand.finish(); this.auxiliary.treasures.finish(); this.auxiliary.aside.finish(); this.auxiliary.revealed.finish();
    if (!this.moving) return;
    ++this.revision; this.motion.finish(); this.shuffle.finish(); this.destruction.finish(); this.upgrade.finish(); this.completeMovement();
  }
  private visibility = (): void => {if (document.hidden) this.finish();};
  dispose(): void {
    if (this.disposed) return;
    this.finish(); this.browser.dispose(); this.disposed = true; ++this.revision;
    this.hand.dispose(); this.auxiliary.treasures.dispose(); this.auxiliary.aside.dispose(); this.auxiliary.revealed.dispose(); this.tabs.dispose(); this.response.dispose();
    this.draw.showTop(null); this.discard.showTop(null);
    this.cleanup.forEach(cleanup => cleanup()); this.cardCleanup.splice(0).forEach(cleanup => cleanup()); this.interactions.dispose(); this.view.notice.textContent = ''; this.view.dispose();
    this.cards.clear(); this.selected.clear(); this.highlighted.clear(); this.state = {hand: [], draw: [], discard: []};
    window.removeEventListener('blur', this.finish); window.removeEventListener('pagehide', this.finish);
    document.removeEventListener('visibilitychange', this.visibility);
  }
}
