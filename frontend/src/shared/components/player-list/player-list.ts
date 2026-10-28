import {copyPlayers} from './model.js';
import {PlayerRows} from './rows.js';
import {PlayerBrowser} from './player-browser.js';
import {createPlayerListView} from './view.js';
import {PlayerActivityBubble} from './activity-bubble.js';
import {CardStatusMarkers} from '../game-card/card-status-markers.js';
import type {CardStatus} from '../game-card/types.js';
import type {PlayerListOptions, PlayerListPlayer, PlayerBrowseZone} from './types.js';

/** Standalone player list and card browser. The host supplies the viewer's projection. */
export class PlayerList {
  readonly root: HTMLElement;
  private readonly view;
  private readonly rows: PlayerRows;
  private readonly browser: PlayerBrowser;
  private readonly activity: PlayerActivityBubble;
  private readonly publicEffects: CardStatusMarkers;
  private players: readonly PlayerListPlayer[] = [];
  private disposed = false;
  private selection: ReadonlySet<string> | null = null;
  get isBrowsing(): boolean {return this.browser.isOpen;}
  get browsingPlayerId(): string | null {return this.browser.playerId;}

  constructor(host: HTMLElement, private options: PlayerListOptions = {}) {
    this.view = createPlayerListView(host, options); this.root = this.view.root;
    this.publicEffects = new CardStatusMarkers(this.view.title, this.view.title, {requireFrontFace: false});
    this.rows = new PlayerRows(this.view.list, id => {
      if (this.blocked()) return;
      if (this.selection) {if (this.selection.has(id)) this.options.onPlayerClick?.(id);}
      else this.openPlayer(id);
    }, this.view.id('player-browser'));
    this.activity = new PlayerActivityBubble(this.view.id('player-activity'), this.root, this.view.list, id => this.rows.anchor(id));
    this.browser = new PlayerBrowser(this.view.overlays, options.background ?? [this.root], options.images,
      this.view.id, id => this.rows.trigger(id), options.onCardTargetClick);
  }
  setPlayers(players: readonly PlayerListPlayer[]): void {
    this.assertAlive(); const snapshot = copyPlayers(players);
    const wasBrowsing = this.isBrowsing;
    this.players = snapshot; this.rows.render(snapshot); this.browser.setPlayers(snapshot);
    this.activity.sync();
    this.root.hidden = snapshot.length === 0;
    if (wasBrowsing && !this.isBrowsing) {
      const target = this.root.hidden ? this.root.parentElement : this.root;
      if (target) {target.tabIndex = -1; target.focus({preventScroll: true});}
    }
  }
  setPublicEffects(effects: readonly CardStatus[]): void {this.assertAlive(); this.publicEffects.set(effects);}
  openPlayer(playerId: string, zone: PlayerBrowseZone = 'hand'): void {
    this.assertAlive();
    if (!['hand', 'draw', 'discard'].includes(zone)) throw new Error('Unknown player card zone.');
    if (!this.players.some(player => player.id === playerId)) return;
    this.options.onBeforeOpen?.(playerId, zone);
    this.browser.open(playerId, zone);
  }
  closePlayer(restoreFocus = true): void {this.assertAlive(); this.browser.close(restoreFocus);}
  setCardTargets(ids: readonly string[], selected: readonly string[]): void {this.browser.setCardTargets(ids, selected);}
  playerRect(playerId: string): DOMRect | null {return this.rows.anchor(playerId)?.getBoundingClientRect() ?? null;}
  playerAvatarRect(playerId: string): DOMRect | null {return this.rows.avatarAnchor(playerId)?.getBoundingClientRect() ?? null;}
  setPlayerSelection(ids: readonly string[] | null): void {
    this.assertAlive(); this.selection = ids === null ? null : new Set(ids);
    this.rows.setSelection(this.selection); this.rows.render(this.players);
    if (this.selection) this.browser.close(false);
  }
  showActivity(playerId: string, text: string, durationMs?: number): void {
    this.assertAlive(); if (!this.blocked()) this.activity.show(playerId, text, durationMs);
  }
  clearActivity(): void {this.assertAlive(); this.activity.clear();}
  finish(): void {if (!this.disposed) {this.browser.finish(); this.publicEffects.hide();}}
  private blocked(): boolean {
    if (this.disposed) return true;
    for (let element: HTMLElement | null = this.root; element; element = element.parentElement) if (element.hidden || element.inert) return true;
    return false;
  }
  private assertAlive(): void {if (this.disposed) throw new Error('PlayerList has been disposed.');}
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.publicEffects.dispose(); this.activity.dispose(); this.browser.dispose(); this.rows.dispose(); this.players = []; this.view.dispose();
  }
}
