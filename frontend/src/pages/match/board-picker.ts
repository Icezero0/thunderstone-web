import type {MatchView} from '../../shared/api/types.js';
import type {PlayerResponseChoice} from '../../shared/components/player-deck-area/index.js';
import type {SupplySelection} from '../../shared/components/table-areas/index.js';

export interface PickCard {
  key: string;
  cardId: string;
  instanceId?: string;
  label?: string;
}
export interface CardPick {
  prompt: string;
  cards: PickCard[];
  min?: number;
  max?: number;
  ordered?: boolean;
  immediate?: boolean;
  autoSingle?: boolean;
  actions?: {label: string; run: () => void}[];
  cancel?: () => void;
  submit: (keys: string[]) => void;
}

/** A temporary board interaction, never a second copy of authoritative game state. */
export class BoardPicker {
  private view: MatchView | null = null;
  private key = '';
  private request: CardPick | null = null;
  private selected: string[] = [];
  private busy = false;
  private generation = 0;
  private focused: string | null = null;
  private autoAttempted = -1;
  constructor(private changed: () => void) {}
  receive(view: MatchView, busy: boolean): void {
    const key = `${view.id}:${view.version}:${view.status}:${view.actor_player_id}:${!!view.unavailable_reason}`;
    if (key !== this.key) this.clear();
    this.view = view; this.key = key; this.busy = busy;
    this.autoSelect();
  }
  start(request: CardPick): void {
    this.request = request; this.selected = []; this.focused = null; this.generation++; this.changed();
    this.autoSelect();
  }
  clear(): void {this.request = null; this.selected = []; this.focused = null; this.generation++;}
  get active(): boolean {return !!this.request;}
  get revision(): number {return this.generation;}
  get prompt(): string {
    const request = this.request;
    if (!request) return '';
    if (this.clickCommits) return request.prompt;
    const min = request.min ?? 1, max = request.max ?? 1;
    const order = request.ordered && this.selected.length ? ` · ${this.selected.map(key => this.name(key)).join(' → ')}` : '';
    return `${request.prompt}（${min === max ? min : `${min}～${max}`} 张，已选 ${this.selected.length}）${order}`;
  }
  get choices(): PlayerResponseChoice[] {
    if (!this.request) return [];
    // A card with several abilities exposes its individual lines only after it
    // is clicked. Entries without a permanent board position use response text.
    const options = this.request.cards.filter(card => this.focused ? card.instanceId === this.focused : !this.located(card));
    return [...options.map(card => ({id: `pick:card:${this.request!.cards.indexOf(card)}`, label: this.name(card.key),
        pressed: this.selected.includes(card.key)})),
      ...(this.request.actions ?? []).map((action, index) => ({id: `pick:action:${index}`, label: action.label})),
      ...(this.clickCommits && !this.request.immediate && (this.request.min ?? 1) === 0
        ? [{id: 'pick:skip', label: '跳过'}] : []),
      ...(!this.clickCommits ? [{id: 'pick:confirm', label: this.request.ordered ? '确认顺序' : '确认选择', tone: 'gold' as const,
      disabled: !this.valid}] : []), ...(this.request.cancel ? [{id: 'pick:cancel', label: '取消'}] : [])];
  }
  get highlightedIds(): string[] {
    return !this.busy ? [...new Set(this.request?.cards.flatMap(card => card.instanceId ? [card.instanceId] : []) ?? [])] : [];
  }
  get selectedIds(): string[] {
    return [...new Set(this.request?.cards.filter(card => this.selected.includes(card.key)).flatMap(card => card.instanceId ? [card.instanceId] : []) ?? [])];
  }
  get supplyIds(): string[] {
    return !this.busy ? this.request?.cards.filter(card => !card.instanceId).map(card => card.cardId) ?? [] : [];
  }
  get selectedSupplyIds(): string[] {
    return this.request?.cards.filter(card => !card.instanceId && this.selected.includes(card.key)).map(card => card.cardId) ?? [];
  }
  clickInstance(id: string): boolean {
    if (!this.request) return false;
    const matches = this.request.cards.filter(card => card.instanceId === id);
    if (matches.length === 1) this.pick(matches[0].key);
    else if (matches.length > 1 && !this.busy) {this.focused = id; this.changed();}
    return true;
  }
  clickSupply(item: SupplySelection): boolean {
    if (!this.request) return false;
    const matches = this.request.cards.filter(card => !card.instanceId && card.cardId === item.cardId);
    const pile = this.view?.supplies.find(pile => pile.zone_id === item.pileId);
    if (!item.preview && (pile?.cards.filter(card => this.supplyIds.includes(card.card_id)).length ?? 0) > 1) return false;
    if (matches.length === 1 && pile?.cards.some(card => card.card_id === item.cardId)) this.pick(matches[0].key);
    else if (pile?.cards.some(card => this.supplyIds.includes(card.card_id))) return false; // Open this hero's level browser.
    return true;
  }
  choose(id: string): boolean {
    if (!this.request || !id.startsWith('pick:')) return false;
    if (!this.busy && id.startsWith('pick:card:')) {const card = this.request.cards[Number(id.slice(10))]; if (card) this.pick(card.key);}
    if (!this.busy && id.startsWith('pick:action:')) this.request.actions?.[Number(id.slice(12))]?.run();
    if (!this.busy && id === 'pick:cancel') {const cancel = this.request.cancel; this.clear(); cancel?.(); this.changed();}
    if (!this.busy && id === 'pick:confirm' && !this.clickCommits && this.valid) this.request.submit([...this.selected]);
    if (!this.busy && id === 'pick:skip' && this.clickCommits && (this.request.min ?? 1) === 0) this.request.submit([]);
    return true;
  }
  private get valid(): boolean {
    return !!this.request && this.selected.length >= (this.request.min ?? 1) && this.selected.length <= (this.request.max ?? 1);
  }
  private get clickCommits(): boolean {
    return !!this.request && (!!this.request.immediate || !this.request.ordered && (this.request.max ?? 1) === 1);
  }
  /** Defer until rendering/animations and the previous request finish; never auto-retry a failed command. */
  private autoSelect(): void {
    const request = this.request, generation = this.generation;
    if (!request?.autoSingle || this.busy || this.autoAttempted === generation || request.cards.length !== 1
      || (request.min ?? 1) !== 1 || (request.max ?? 1) !== 1 || request.ordered) return;
    queueMicrotask(() => {
      if (this.request !== request || this.generation !== generation || this.busy || this.autoAttempted === generation) return;
      this.autoAttempted = generation; this.pick(request.cards[0].key);
    });
  }
  private name(key: string): string {
    const card = this.request?.cards.find(card => card.key === key);
    return card?.label ?? (card ? this.view?.cards[card.cardId]?.name ?? card.cardId : key);
  }
  private pick(key: string): void {
    const request = this.request;
    if (!request || this.busy || !request.cards.some(card => card.key === key)) return;
    if (this.clickCommits) {request.submit([key]); return;}
    if (this.selected.includes(key)) this.selected = this.selected.filter(id => id !== key);
    else if (this.selected.length < (request.max ?? 1)) this.selected.push(key);
    else if ((request.max ?? 1) === 1) this.selected = [key];
    this.changed();
  }
  private located(card: PickCard): boolean {
    if (!this.view) return false;
    if (!card.instanceId) return this.view.supplies.some(pile => pile.cards.some(item => item.card_id === card.cardId));
    return [...this.view.hand, ...this.view.draw ?? [], ...this.view.discard, ...this.view.aside ?? [], ...this.view.revealed ?? [],
      ...this.view.players.flatMap(player => [...player.control, ...player.cards?.hand ?? [], ...player.cards?.draw ?? [], ...player.cards?.discard ?? []]),
      ...this.view.dungeons.flatMap(dungeon => dungeon.hall), ...this.view.settings].some(item => item.instance_id === card.instanceId);
  }
  dispose(): void {this.clear();}
}
