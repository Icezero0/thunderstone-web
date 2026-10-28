import {CardInteractions, createCardElements, defaultCardImages, type PhysicalCard, type CardImageSource} from '../game-card/index.js';
import {node, reconcile} from '../../dom/elements.js';
import {createPlayerBrowserView} from './player-browser-view.js';
import type {PlayerBrowseZone, PublicPlayerHandCard, PlayerListPlayer} from './types.js';

interface CardView {key: string; identity?: string; root: HTMLElement; card: PhysicalCard;}
const zones: readonly PlayerBrowseZone[] = ['hand', 'draw', 'discard'];
const key = (playerId: string, instanceId: string) => JSON.stringify([playerId, instanceId]);

/** Receives only the viewer's projection: hidden hand cards have no front identity. */
export class PlayerBrowser {
  private readonly view;
  private readonly interactions: CardInteractions;
  private readonly images: CardImageSource;
  private readonly items = new Map<string, CardView>();
  private readonly cleanup: (() => void)[] = [];
  private players: readonly PlayerListPlayer[] = [];
  private current: CardView[] = [];
  private selectedPlayer: string | null = null;
  private selectedZone: PlayerBrowseZone = 'hand';
  private returnFocus: HTMLElement | null = null;
  private inertBefore: boolean[] = [];
  private sequence = 0;
  private targets = new Set<string>();
  private selected = new Set<string>();
  setCardTargets(ids: readonly string[], selected: readonly string[]): void {
    this.targets = new Set(ids); this.selected = new Set(selected);
    for (const item of this.current) this.target(item);
  }
  private target(item: CardView): void {
    const id = item.card.elements.button.dataset.instanceId!;
    item.card.setGlow(!!item.identity && this.targets.has(id)); item.card.setActive(this.selected.has(id)); item.card.setTargetSelected(this.selected.has(id));
  }
  get playerId(): string | null {return this.selectedPlayer;}
  get zone(): PlayerBrowseZone {return this.selectedZone;}
  get isOpen(): boolean {return this.selectedPlayer !== null;}

  constructor(host: HTMLElement, private background: readonly HTMLElement[], images: Partial<CardImageSource> | undefined,
    private id: (key: string) => string, private trigger: (playerId: string) => HTMLElement | undefined, private onPick?: (id: string) => void) {
    this.view = createPlayerBrowserView(host, id);
    this.images = {front: images?.front ?? defaultCardImages.front, back: images?.back ?? defaultCardImages.back};
    this.interactions = new CardInteractions(this.view.inspection.overlay, this.view.inspection.content, this.view.notice);
    this.bind(this.view.close, 'click', () => this.close());
    this.bind(this.view.overlay, 'click', event => {if (event.target === this.view.overlay) this.close();});
    for (const zone of zones) {
      this.bind(this.view.tabs[zone], 'click', () => this.setZone(zone));
      this.bind(this.view.tabs[zone], 'keydown', event => this.tabKey(event as KeyboardEvent, zone));
    }
    window.addEventListener('keydown', this.keydown);
  }
  setPlayers(players: readonly PlayerListPlayer[]): void {
    const hadGridFocus = this.view.grid.contains(document.activeElement);
    this.players = players;
    const allowed = new Map<string, string | undefined>();
    for (const player of players) if (player.cards) for (const zone of zones)
      for (const card of player.cards[zone]) allowed.set(key(player.id, card.id), card.cardId);
    for (const [cacheKey, item] of this.items) if (!allowed.has(cacheKey) || item.identity !== allowed.get(cacheKey)) {
      this.interactions.remove(item.card); item.root.remove(); this.items.delete(cacheKey);
      this.current = this.current.filter(current => current !== item);
    }
    if (!this.isOpen) return;
    const player = this.players.find(player => player.id === this.playerId);
    if (!player) {this.close(false); return;}
    this.refresh(player);
    if (hadGridFocus && !this.view.grid.contains(document.activeElement)) this.view.close.focus({preventScroll: true});
  }
  open(playerId: string, zone: PlayerBrowseZone = 'hand'): void {
    this.checkZone(zone);
    const player = this.players.find(player => player.id === playerId), trigger = this.trigger(playerId);
    if (!player || !trigger) return;
    const alreadyOpen = this.isOpen;
    this.returnFocus?.setAttribute('aria-expanded', 'false'); this.returnFocus = trigger; trigger.setAttribute('aria-expanded', 'true');
    this.selectedPlayer = playerId; this.selectedZone = zone; this.refresh(player);
    this.view.overlay.hidden = false;
    if (!alreadyOpen) {
      this.inertBefore = this.background.map(element => element.inert); this.background.forEach(element => {element.inert = true;});
    }
    this.interactions.setScope(this.view.grid); this.view.close.focus({preventScroll: true}); this.view.grid.scrollTop = 0;
  }
  private refresh(player: PlayerListPlayer): void {
    const scroll = this.view.grid.scrollTop, focused = this.view.grid.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    const cards = player.cards?.[this.zone] ?? [];
    const ordered = cards.map(data => {
      const cacheKey = key(player.id, data.id); let item = this.items.get(cacheKey);
      if (!item) {
        const shown = data.cardId !== undefined;
        const elements = shown ? createCardElements(data.cardId!, this.images)
          : createCardElements('hidden', {front: () => this.images.back, back: this.images.back});
        elements.button.id = this.id(`player-card-${++this.sequence}`); elements.button.dataset.instanceId = data.id;
        elements.button.addEventListener('click', () => {if (this.isOpen && data.cardId && this.targets.has(data.id)) this.onPick?.(data.id);});
        if (!shown) delete elements.button.dataset.cardId;
        const card = this.interactions.add(elements, data.name ?? '未公开手牌', shown);
        const root = node('article', 'player-browser-entry'); root.append(elements.button);
        item = {key: cacheKey, identity: data.cardId, root, card}; this.items.set(cacheKey, item);
      }
      item.card.setName(data.name ?? '未公开手牌'); item.card.setStatuses(data.cardId ? data.statuses : []); item.card.setFaceUp(data.cardId !== undefined, false); item.card.setVisible(true);
      this.target(item);
      item.root.dataset.revealed = String(this.zone === 'hand' && (data as PublicPlayerHandCard).revealed);
      return item;
    });
    for (const old of this.current) if (!ordered.includes(old)) old.card.setVisible(false);
    this.current = ordered; reconcile(this.view.grid, [this.view.empty, ...ordered.map(item => item.root)]);
    if (focused && !this.current.some(item => item.card.elements.button === focused)) this.view.close.focus({preventScroll: true});
    this.view.title.textContent = player.name; this.view.avatar.setSource(player.avatarUrl);
    this.view.overlay.dataset.playerId = player.id; this.view.overlay.dataset.zone = this.zone;
    this.view.grid.setAttribute('aria-labelledby', this.view.tabs[this.zone].id);
    for (const zone of zones) {
      this.view.tabs[zone].setAttribute('aria-selected', String(zone === this.zone)); this.view.tabs[zone].tabIndex = zone === this.zone ? 0 : -1;
      this.view.counts[zone].textContent = player.cards ? String(player.cards[zone].length) : '—';
    }
    this.view.empty.textContent = player.cards ? '暂无卡牌' : '暂无可查看的牌区数据'; this.view.empty.hidden = cards.length > 0;
    this.view.grid.scrollTop = scroll; this.interactions.refresh();
  }
  private setZone(zone: PlayerBrowseZone): void {
    this.checkZone(zone); if (!this.isOpen || zone === this.zone) return;
    const hadGridFocus = this.view.grid.contains(document.activeElement); this.selectedZone = zone;
    this.refresh(this.players.find(player => player.id === this.playerId)!);
    this.interactions.setScope(this.view.grid); this.view.grid.scrollTop = 0;
    if (hadGridFocus) this.view.tabs[zone].focus({preventScroll: true});
  }
  close(restoreFocus = true): void {
    if (!this.isOpen) return;
    this.selectedPlayer = null; this.view.overlay.hidden = true;
    this.current.forEach(item => item.card.setVisible(false)); this.current = [];
    this.background.forEach((element, index) => {element.inert = this.inertBefore[index];}); this.interactions.setScope(null);
    this.returnFocus?.setAttribute('aria-expanded', 'false');
    if (restoreFocus && this.returnFocus?.isConnected) this.returnFocus.focus({preventScroll: true});
    this.returnFocus = null;
  }
  finish(): void {this.interactions.setScope(this.isOpen ? this.view.grid : null);}
  private checkZone(zone: PlayerBrowseZone): void {if (!zones.includes(zone)) throw new Error('Unknown player card zone.');}
  private tabKey(event: KeyboardEvent, zone: PlayerBrowseZone): void {
    if (!this.isOpen || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = zones.indexOf(zone), next = event.key === 'Home' ? 'hand' : event.key === 'End' ? 'discard' : zones[(index + (event.key === 'ArrowRight' ? 1 : 2)) % 3];
    this.setZone(next); this.view.tabs[next].focus({preventScroll: true});
  }
  private keydown = (event: KeyboardEvent): void => {
    if (!this.isOpen || event.isComposing) return;
    if (event.key === 'Escape') {event.preventDefault(); this.close(); return;}
    if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
    const targets = [this.view.close, this.view.tabs[this.zone], ...this.current.map(item => item.card.elements.button)];
    const index = targets.indexOf(document.activeElement as HTMLButtonElement);
    if (event.shiftKey && index <= 0) {event.preventDefault(); targets.at(-1)!.focus();}
    else if (!event.shiftKey && (index < 0 || index === targets.length - 1)) {event.preventDefault(); targets[0].focus();}
  };
  private bind(element: HTMLElement, type: string, handler: (event: Event) => void): void {
    element.addEventListener(type, handler); this.cleanup.push(() => element.removeEventListener(type, handler));
  }
  dispose(): void {
    this.close(false); this.cleanup.forEach(cleanup => cleanup()); window.removeEventListener('keydown', this.keydown);
    this.interactions.dispose(); this.items.clear(); this.view.dispose();
  }
}
