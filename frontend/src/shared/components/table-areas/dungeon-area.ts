import {CardStack, type PhysicalCard} from '../game-card/index.js';
import {CardMotion, type Reflow} from '../game-card/card-motion.js';
import {AreaCards} from './card-views.js';
import {copyDungeonState} from './model.js';
import {node, reconcile} from '../../dom/elements.js';
import type {DungeonLane, DungeonState, TableAreaOptions} from './types.js';
import type {CardStatus} from '../game-card/types.js';

interface PileView {root: HTMLElement; slot: HTMLElement; stack: CardStack;}
interface LaneView {root: HTMLElement; deck: PileView; hall: HTMLElement; ranks: Map<number, HTMLElement>;}
let sequence = 0;

/** Public dungeon projection. Hidden decks expose only a count and common back. */
export class DungeonArea {
  readonly root: HTMLElement;
  private readonly cards: AreaCards;
  private readonly environment: HTMLElement;
  private readonly environmentSlot: HTMLElement;
  private readonly board: HTMLElement;
  private readonly lanes = node('div', 'dungeon-lanes');
  private readonly laneViews = new Map<string, LaneView>();
  private readonly prefix: string;
  private disposed = false;
  private highlighted = new Set<string>();
  private selected = new Set<string>();
  private effectSelected = new Set<string>();
  private readonly hallCards = new Map<string, PhysicalCard>();
  private environmentCard: {id: string; card: PhysicalCard} | null = null;
  private readonly motion: CardMotion;
  private readonly motionLayer = node('div', 'card-motion-layer dungeon-motion-layer');
  private motionRevision = 0;
  private layoutCompletions: (() => void)[] = [];

  constructor(host: HTMLElement, private options: TableAreaOptions = {}) {
    this.prefix = options.idPrefix ?? `dungeon-area-${++sequence}`;
    this.root = node('section', 'dungeon-area game-cursor', undefined, this.prefix);
    this.root.setAttribute('aria-label', '地下城'); host.append(this.root);
    this.environment = node('article', 'table-area dungeon-environment', undefined, `${this.prefix}-environment`);
    this.environment.setAttribute('aria-labelledby', `${this.prefix}-environment-heading`);
    this.environmentSlot = node('div', 'hall-card-slot', undefined, `${this.prefix}-environment-slot`);
    this.environment.append(node('h3', 'table-group-heading environment-heading', '环境', `${this.prefix}-environment-heading`), this.environmentSlot);
    this.environment.hidden = true; this.root.dataset.hasEnvironment = 'false';
    this.board = node('div', 'table-area dungeon-board', undefined, `${this.prefix}-board`);
    this.board.append(this.lanes); this.root.append(this.environment, this.board);
    this.cards = new AreaCards(this.root, this.prefix, options);
    (options.overlayRoot ?? document.body).append(this.motionLayer); this.motion = new CardMotion(this.motionLayer);
  }
  setState(state: DungeonState): void {
    if (this.disposed) throw new Error('DungeonArea has been disposed.');
    const copied = copyDungeonState(state); this.cards.begin(); this.hallCards.clear();
    const environment = copied.environment;
    this.environment.hidden = !environment; this.root.dataset.hasEnvironment = String(!!environment);
    this.environment.dataset.cardId = environment?.cardId ?? '';
    const environmentCard = environment ? this.cards.card(`environment-${environment.id}-${environment.cardId}`, environment) : null;
    this.environmentCard = environment && environmentCard ? {id: environment.id, card: environmentCard} : null;
    if (environmentCard && environment) environmentCard.elements.button.onclick = () => {
      if (!this.root.hidden && !this.root.inert && this.highlighted.has(environment.id)) this.options.onHallCardClick?.(environment);
    };
    environmentCard?.setTargetSelected(!!environment && this.effectSelected.has(environment.id));
    environmentCard?.elements.button.setAttribute('data-pan-start', '');
    reconcile(this.environmentSlot, environmentCard ? [environmentCard.elements.button] : []);
    const lanes = copied.dungeons.map(lane => this.renderLane(lane));
    reconcile(this.lanes, lanes); this.lanes.dataset.count = String(lanes.length);
    this.cards.end();
  }
  setVisible(visible: boolean): void {
    if (this.disposed) throw new Error('DungeonArea has been disposed.');
    this.root.hidden = !visible; this.cards.interactions.refresh();
  }
  setInteractionSuspended(suspended: boolean): void {this.cards.interactions.setSuspended(suspended);}
  setStatusOverrides(statuses: Readonly<Record<string, readonly CardStatus[]>> | null): void {this.cards.setStatusOverrides(statuses);}
  cardRect(id: string): DOMRect | null {return this.hallCards.get(id)?.elements.surface.getBoundingClientRect() ?? null;}
  animateCard(id: string, frames: Keyframe[], options: KeyframeAnimationOptions): Animation | null {
    return this.hallCards.get(id)?.elements.surface.animate(frames, options) ?? null;
  }
  attachmentRect(id: string): DOMRect | null {return this.hallCards.get(id)?.attachmentRect() ?? this.cardRect(id);}
  deckRect(lane: string): DOMRect | null {return this.laneViews.get(lane)?.deck.slot.getBoundingClientRect() ?? null;}
  hideCard(id: string): void {this.hallCards.get(id)?.setVisible(false);}
  private rankViews(): Map<string, {rank: number; cell: HTMLElement}> {
    return new Map([...this.laneViews].flatMap(([id, lane]) => lane.root.parentElement !== this.lanes ? [] :
      [...lane.ranks].filter(([, cell]) => cell.parentElement === lane.hall).map(([rank, cell]) => [`${id}:${rank}`, {rank, cell}] as const)));
  }
  private layoutTargets(): Map<string, HTMLElement> {
    const targets = new Map<string, HTMLElement>();
    if (!this.environment.hidden) targets.set('environment', this.environment);
    for (const [id, lane] of this.laneViews) if (lane.root.parentElement === this.lanes) targets.set(`deck:${id}`, lane.deck.root);
    for (const [id, {cell}] of this.rankViews()) {
      targets.set(`label:${id}`, cell.children[0] as HTMLElement);
      const empty = cell.children[1]?.children[0] as HTMLElement | undefined;
      if (empty?.className === 'hall-empty') targets.set(`empty:${id}`, empty);
    }
    return targets;
  }
  private layoutEffect(element: HTMLElement, frames: Keyframe[], cleanup: () => void = () => {}): Promise<void> {
    return new Promise(resolve => {
      let animation: Animation | null = null, finished = false;
      const done = () => {
        if (finished) return; finished = true;
        if (animation) {animation.onfinish = animation.oncancel = null; animation.cancel();}
        cleanup(); this.layoutCompletions = this.layoutCompletions.filter(item => item !== done); resolve();
      };
      this.layoutCompletions.push(done);
      try {animation = element.animate(frames, {duration: 220, easing: 'ease-out', fill: 'both'}); animation.onfinish = animation.oncancel = done;}
      catch {done();}
    });
  }
  async animateTo(state: DungeonState, afterLayout?: () => void): Promise<void> {
    this.finish(); const revision = this.motionRevision;
    const previous = new Map([...this.hallCards].map(([id, card]) => [id, card.elements.button.getBoundingClientRect()]));
    const oldRanks = new Map([...this.rankViews()].map(([id, {rank, cell}]) => [id,
      {rank, rect: cell.getBoundingClientRect(), scale: cell.offsetWidth ? cell.getBoundingClientRect().width / cell.offsetWidth : 1}]));
    const oldLayout = new Map([...this.layoutTargets()].map(([id, element]) => [id, element.getBoundingClientRect()]));
    this.setState(state); afterLayout?.();
    const entrants = [...this.hallCards].filter(([id]) => !previous.has(id));
    await Promise.all(entrants.map(([, card]) => card.prepared));
    if (revision !== this.motionRevision || this.disposed || this.root.hidden || document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const flights = entrants.flatMap(([id, card]) => {
      const lane = state.dungeons.find(lane => lane.hall.some(slot => slot.card?.id === id)), from = lane && this.deckRect(lane.id);
      return from && card.ready ? [{card, from, to: card.elements.button.getBoundingClientRect(), destination: card.elements.button.parentElement!,
        reveal: true, departed: () => {}, landed: () => {}}] : [];
    });
    const reflows: Reflow[] = [...this.hallCards].flatMap(([id, card]) => previous.has(id) ? [{element: card.elements.button,
      from: previous.get(id)!, to: card.elements.button.getBoundingClientRect()}] : []);
    for (const [id, element] of this.layoutTargets()) if (oldLayout.has(id))
      reflows.push({element, from: oldLayout.get(id)!, to: element.getBoundingClientRect()});
    const currentRanks = this.rankViews(), effects: Promise<void>[] = [];
    for (const [id, {cell}] of currentRanks) if (!oldRanks.has(id))
      effects.push(this.layoutEffect(cell, [{opacity: 0}, {opacity: 1}]));
    for (const [id, {rank, rect, scale}] of oldRanks) if (!currentRanks.has(id)) {
      // Only the departing slot is copied. Its monster has already flown away
      // or moved to another rank; never duplicate the old card face here.
      const ghost = node('article', 'dungeon-rank-ghost'); ghost.dataset.rank = String(rank);
      Object.assign(ghost.style, {left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`});
      const label = node('h4', 'hall-rank-label', rank === 0 ? '阶层 0 · 守护者' : `阶层 ${rank}`);
      label.style.height = `${33 * scale}px`; label.style.fontSize = `${11 * scale}px`;
      const empty = node('div', 'hall-empty'); empty.style.height = `${Math.max(0, rect.height - 33 * scale)}px`;
      ghost.append(label, empty); this.motionLayer.append(ghost);
      effects.push(this.layoutEffect(ghost, [{opacity: 1, transform: 'translateX(0px) scale(1)'},
        {opacity: 0, transform: 'translateX(-12px) scale(.86)'}], () => ghost.remove()));
    }
    await Promise.all([this.motion.play(flights, reflows), ...effects]);
  }
  finish(): void {
    this.motionRevision++; this.motion.finish();
    const completions = this.layoutCompletions; this.layoutCompletions = []; completions.forEach(complete => complete());
  }
  setEffectSelection(selected: readonly string[]): void {
    this.effectSelected = new Set(selected);
    for (const [id, card] of this.hallCards) card.setTargetSelected(this.effectSelected.has(id));
    if (this.environmentCard) this.environmentCard.card.setTargetSelected(this.effectSelected.has(this.environmentCard.id));
  }
  setCardSelection(highlighted: readonly string[], selected: readonly string[]): void {
    this.highlighted = new Set(highlighted); this.selected = new Set(selected);
    for (const [id, card] of [...this.hallCards, ...(this.environmentCard ? [[this.environmentCard.id, this.environmentCard.card] as const] : [])]) {
      card.setGlow(this.highlighted.has(id)); card.elements.button.dataset.selected = String(this.selected.has(id));
      card.elements.button.setAttribute('aria-pressed', String(this.selected.has(id)));
    }
  }
  private pile(id: string, caption: string, faceUp = false): PileView {
    const root = node('article', 'public-pile'), header = node('div', 'public-pile-heading');
    const title = node('h4', '', caption), count = node('span', 'public-pile-count');
    const slot = node('div', 'public-card-slot', undefined, `${this.prefix}-${id}-slot`);
    header.append(title, count); root.append(header, slot);
    const stack = new CardStack(slot, count, faceUp, {name: caption, browse: false});
    stack.empty.setAttribute('data-pan-start', '');
    return {root, slot, stack};
  }
  private renderLane(lane: DungeonLane): HTMLElement {
    let view = this.laneViews.get(lane.id);
    if (!view) {
      const root = node('section', 'dungeon-lane', undefined, `${this.prefix}-lane-${lane.id}`);
      const row = node('div', 'dungeon-track');
      const deck = this.pile(`deck-${lane.id}`, '地下城'), hall = node('div', 'dungeon-hall');
      hall.setAttribute('aria-label', '地下城大厅'); row.append(deck.root, hall); root.append(row);
      view = {root, deck, hall, ranks: new Map()}; this.laneViews.set(lane.id, view);
    }
    view.root.setAttribute('aria-label', lane.name); view.deck.stack.setCount(lane.deckCount);
    const deck = lane.deckCount ? this.cards.card(`deck-${lane.id}`, {id: `back-${lane.id}`, cardId: 'hidden-deck', name: '地下城'}, false, true) : null;
    deck?.elements.button.setAttribute('data-pan-start', '');
    view.deck.stack.showTop(deck);
    const ranks = [...lane.hall].sort((a, b) => b.rank - a.rank).map(slot => {
      let cell = view!.ranks.get(slot.rank);
      if (!cell) {
        cell = node('article', 'hall-rank', undefined, `${this.prefix}-${lane.id}-rank-${slot.rank}`);
        cell.dataset.rank = String(slot.rank);
        cell.append(node('h4', 'hall-rank-label', slot.rank === 0 ? '阶层 0 · 守护者' : `阶层 ${slot.rank}`));
        cell.append(node('div', 'hall-card-slot')); view!.ranks.set(slot.rank, cell);
      }
      const target = cell.children[1] as HTMLElement;
      if (slot.card) {
        const card = this.cards.card(`hall-${slot.card.id}-${slot.card.cardId}`, slot.card);
        this.hallCards.set(slot.card.id, card);
        card.setTargetSelected(this.effectSelected.has(slot.card.id));
        card.setGlow(this.highlighted.has(slot.card.id)); card.elements.button.dataset.selected = String(this.selected.has(slot.card.id));
        card.elements.button.setAttribute('aria-pressed', String(this.selected.has(slot.card.id)));
        card.elements.button.setAttribute('data-pan-start', '');
        card.elements.button.onclick = () => {
          for (let element: HTMLElement | null = this.root; element; element = element.parentElement) if (element.hidden || element.inert) return;
          if (!this.disposed) this.options.onHallCardClick?.(slot.card!);
        };
        reconcile(target, [card.elements.button]);
      } else {
        if (!target.children.length || (target.children[0] as HTMLElement).className !== 'hall-empty') reconcile(target, [node('div', 'hall-empty', '空阶层')]);
      }
      return cell;
    });
    reconcile(view.hall, ranks); return view.root;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.finish(); this.motionLayer.remove(); this.cards.dispose(); this.root.remove(); this.laneViews.clear();
  }
}
