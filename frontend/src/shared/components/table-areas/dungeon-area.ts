import {CardStack} from '../game-card/index.js';
import {AreaCards} from './card-views.js';
import {copyDungeonState} from './model.js';
import {node, reconcile} from '../../dom/elements.js';
import type {DungeonLane, DungeonState, TableAreaOptions} from './types.js';

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
  }
  setState(state: DungeonState): void {
    if (this.disposed) throw new Error('DungeonArea has been disposed.');
    const copied = copyDungeonState(state); this.cards.begin();
    const environment = copied.environment;
    this.environment.hidden = !environment; this.root.dataset.hasEnvironment = String(!!environment);
    this.environment.dataset.cardId = environment?.cardId ?? '';
    const environmentCard = environment ? this.cards.card(`environment-${environment.id}-${environment.cardId}`, environment) : null;
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
    this.disposed = true; this.cards.dispose(); this.root.remove(); this.laneViews.clear();
  }
}
