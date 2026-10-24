import {DungeonArea, VillageArea} from '../table-areas/index.js';
import {TableViewport} from '../table-viewport/index.js';
import {copyPublicTableState} from './model.js';
import {PlayerList} from '../player-list/index.js';
import {createPublicTableView, type PublicTableElements} from './view.js';
import type {PlayerBrowseZone, PublicTableOptions, PublicTableState, PublicTableTab} from './types.js';

/** Public board presentation. Snapshots and gameplay commands belong to the host. */
export class PublicTableArea {
  readonly root: HTMLElement;
  private readonly view: PublicTableElements;
  private readonly dungeon: DungeonArea;
  private readonly village: VillageArea;
  private readonly players: PlayerList;
  private readonly viewports: Record<PublicTableTab, TableViewport>;
  private readonly cleanup: (() => void)[] = [];
  private active: PublicTableTab;
  private disposed = false;
  get activeTab(): PublicTableTab {return this.active;}
  get isBrowsing(): boolean {return this.village.isBrowsing || this.players.isBrowsing;}
  get browsingPlayerId(): string | null {return this.players.browsingPlayerId;}

  constructor(host: HTMLElement, private options: PublicTableOptions = {}) {
    this.active = options.initialTab ?? 'dungeon'; this.checkTab(this.active);
    this.view = createPublicTableView(host, options); this.root = this.view.root;
    const areaOptions = {overlayRoot: this.view.overlays, background: options.background ?? [this.root], images: options.images,
      onHallCardClick: options.onHallCardClick};
    this.dungeon = new DungeonArea(this.view.hosts.dungeon, {...areaOptions, idPrefix: this.view.id('dungeon-cards')});
    this.village = new VillageArea(this.view.hosts.village, {...areaOptions, idPrefix: this.view.id('village-cards'),
      onTakeTop: options.onTakeTop, takeLabel: options.takeLabel, onSupplyClick: options.onSupplyClick});
    this.players = new PlayerList(this.root, {...areaOptions, elementId: this.view.id,
      onBeforeOpen: () => {this.finish(); this.village.closeSupply(false);}});
    this.viewports = {} as Record<PublicTableTab, TableViewport>;
    for (const kind of ['dungeon', 'village'] as const) {
      const area = kind === 'dungeon' ? this.dungeon : this.village;
      this.viewports[kind] = new TableViewport(this.view.panels[kind], this.view.desktops[kind], {
        centerContent: true, panPadding: 240, zoom: {min: .8, max: 2.5, initial: 1.5},
        onPanningChange: panning => area.setInteractionSuspended(panning), onZoomChange: () => this.clearHover(kind),
      });
      this.bind(this.view.tabs[kind], 'click', () => {if (!this.blocked()) this.setTab(kind);});
      this.bind(this.view.tabs[kind], 'keydown', event => this.tabKey(event as KeyboardEvent, kind));
    }
    this.bind(this.view.reset, 'click', () => {if (!this.blocked()) this.resetView();});
    this.showTab();
  }
  setState(state: PublicTableState): void {
    this.assertAlive(); const snapshot = copyPublicTableState(state);
    this.dungeon.setState(snapshot.dungeon); this.village.setState(snapshot.village);
    const browsingPlayer = this.players.isBrowsing;
    this.players.setPlayers(snapshot.players ?? []);
    if (browsingPlayer && !this.players.isBrowsing) {this.root.tabIndex = -1; this.root.focus({preventScroll: true});}
    this.root.dataset.hasPlayers = String(!!snapshot.players?.length);
    this.refresh();
  }
  setTab(tab: PublicTableTab): void {
    this.assertAlive(); this.checkTab(tab);
    const changed = this.active !== tab;
    this.players.closePlayer(false);
    this.finish(); this.active = tab; this.showTab();
    if (changed) this.options.onTabChange?.(tab);
  }
  resetView(): void {this.assertAlive(); this.viewports[this.active].reset(); this.clearHover(this.active);}
  refresh(): void {this.assertAlive(); this.viewports[this.active].refresh();}
  openSupply(pileId: string): void {this.setTab('village'); this.village.openSupply(pileId);}
  setPurchaseOptions(options: readonly {cardId: string; price: number}[]): void {
    this.assertAlive(); this.village.setPurchaseOptions(options);
  }
  supplyCardRect(cardId: string): DOMRect | null {
    this.assertAlive(); return this.active === 'village' ? this.village.topCardRect(cardId) : null;
  }
  openPlayer(playerId: string, zone: PlayerBrowseZone = 'hand'): void {
    this.assertAlive(); this.players.openPlayer(playerId, zone);
  }
  closePlayer(): void {this.assertAlive(); this.players.closePlayer();}
  showPlayerActivity(playerId: string, text: string, durationMs?: number): void {
    this.assertAlive(); this.players.showActivity(playerId, text, durationMs);
  }
  clearPlayerActivity(): void {this.assertAlive(); this.players.clearActivity();}
  closeBrowsers(): void {this.assertAlive(); this.players.closePlayer(false); this.village.closeSupply(false); this.finish();}
  finish(): void {
    if (this.disposed) return;
    Object.values(this.viewports).forEach(viewport => viewport.finish());
    this.players.finish();
    this.clearHover('dungeon'); this.clearHover('village');
  }
  private showTab(): void {
    this.view.reset.setAttribute('aria-controls', this.view.panels[this.active].id);
    for (const kind of ['dungeon', 'village'] as const) {
      const active = kind === this.active, tab = this.view.tabs[kind];
      this.view.panels[kind].hidden = !active; tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
    }
    this.dungeon.setVisible(this.active === 'dungeon'); this.village.setVisible(this.active === 'village'); this.refresh();
  }
  private clearHover(kind: PublicTableTab): void {
    const area = kind === 'dungeon' ? this.dungeon : this.village;
    area.setInteractionSuspended(true); area.setInteractionSuspended(false);
  }
  private tabKey(event: KeyboardEvent, kind: PublicTableTab): void {
    if (this.blocked() || event.isComposing || event.altKey || event.ctrlKey || event.metaKey ||
        !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const target = event.key === 'Home' ? 'dungeon' : event.key === 'End' ? 'village' : kind === 'dungeon' ? 'village' : 'dungeon';
    this.setTab(target); this.view.tabs[target].focus({preventScroll: true});
  }
  private blocked(): boolean {
    for (let element: HTMLElement | null = this.root; element; element = element.parentElement) if (element.hidden || element.inert) return true;
    return this.disposed;
  }
  private checkTab(tab: PublicTableTab): void {if (!['dungeon', 'village'].includes(tab)) throw new Error('Unknown public table tab.');}
  private assertAlive(): void {if (this.disposed) throw new Error('PublicTableArea has been disposed.');}
  private bind(element: HTMLElement, type: string, handler: (event: Event) => void): void {
    element.addEventListener(type, handler); this.cleanup.push(() => element.removeEventListener(type, handler));
  }
  dispose(): void {
    if (this.disposed) return;
    this.finish(); this.disposed = true; this.cleanup.forEach(cleanup => cleanup());
    Object.values(this.viewports).forEach(viewport => viewport.dispose());
    this.players.dispose(); this.village.dispose(); this.dungeon.dispose(); this.view.dispose();
  }
}
