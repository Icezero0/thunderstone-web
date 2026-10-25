import type {SupplySelection} from '../../../src/shared/components/table-areas/index.js';
import {PublicTableArea} from '../../../src/shared/components/public-table-area/index.js';
import {createDungeonDemo, createPublicPlayersDemo, createVillageDemo, takeDemoSupply} from './public-demo-state.js';
import {probePublicElementId} from './element-ids.js';
import type {PlayerDeckState} from '../../../src/shared/components/player-deck-area/index.js';
import type {User} from '../../../src/shared/api/types.js';
import {GameResultsDialog} from '../../../src/shared/components/game-results/index.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class PublicAreaDemo {
  private readonly area: PublicTableArea;
  private readonly results: GameResultsDialog;
  private dungeon = createDungeonDemo({spire: false, rankZero: false, rankFour: false});
  private players = createPublicPlayersDemo();
  private readonly guestIdentity = {name: this.players[0].name, avatarUrl: this.players[0].avatarUrl};
  private ownCardsStamp = '';
  private revealTimer: number | null = null;
  private disposed = false;
  private supply = createVillageDemo();
  private readonly cleanup: (() => void)[] = [];
  constructor(private receive: (selection: SupplySelection) => boolean) {
    this.area = new PublicTableArea($('public-table-area'), {overlayRoot: $('player-deck-overlays'),
      background: [$('probe-shell'), $('probe-header')], elementId: probePublicElementId});
    this.results = new GameResultsDialog($('player-deck-overlays'), [$('probe-shell'), $('probe-header')], () => location.assign('/play?view=room'));
    this.renderDungeon();
    for (const id of ['dungeon-demo-layout', 'show-rank-zero', 'show-rank-four']) {
      this.bind($(id), 'change', () => {this.renderDungeon(); this.area.setTab('dungeon');});
    }
    this.bind($('reset-supplies'), 'click', () => {this.resetSupplies(); this.area.setTab('village');});
    const supplyPicker = $<HTMLSelectElement>('take-supply-id');
    for (const pile of this.supply.piles) {
      const option = document.createElement('option'); option.value = pile.id; option.textContent = pile.name; supplyPicker.append(option);
    }
    supplyPicker.value = this.supply.piles[0].id;
    this.bind(supplyPicker, 'change', () => this.updateSupplyControls()); this.updateSupplyControls();
    this.bind($('take-supply-top'), 'click', () => this.takeSupply(supplyPicker.value));
    this.bind($('test-player-reveal'), 'click', () => this.testReveal());
    this.bind($('demo-player-activity'), 'click', () => this.area.showPlayerActivity('player-2', '展示了手牌'));
    this.bind($('demo-player-destroy'), 'click', () => this.area.showPlayerActivity('player-2', '摧毁了 民兵'));
    this.bind($('demo-game-results'), 'click', () => {
      this.area.closeBrowsers();
      const scores = this.players.map((player, index) => {
        const xp = index === 0 ? Math.max(0, Math.trunc(Number($<HTMLInputElement>('demo-xp').value)) || 0) : index === 1 ? 4 : 2;
        const cardPoints = index === 0 ? 28 : index === 1 ? 24 : 15;
        return {id: player.id, name: player.name, avatarUrl: player.avatarUrl,
          total: cardPoints + xp, cardPoints, experiencePoints: xp, thunderstones: index === 1 ? 1 : 0, winner: false};
      });
      const highest = Math.max(...scores.map(player => player.total));
      const hasStone = scores.some(player => player.total === highest && player.thunderstones > 0);
      this.results.show(scores.map(player => ({...player, winner: player.total === highest && (!hasStone || player.thunderstones > 0)})));
    });
  }
  private bind(element: HTMLElement, type: string, callback: (event: Event) => void): void {
    element.addEventListener(type, callback); this.cleanup.push(() => element.removeEventListener(type, callback));
  }
  private render(): void {this.area.setState({dungeon: this.dungeon, village: this.supply, players: this.players});}
  private takeSupply(pileId: string): void {
    const pile = this.supply.piles.find(pile => pile.id === pileId);
    const top = pile?.cards.find(card => card.count === null || card.count > 0);
    if (!pile || !top) return;
    const selection = {pileId, cardId: top.cardId, name: top.name, level: top.level, infinite: pile.kind === 'basic'};
    if (!this.receive(selection)) return;
    this.supply = takeDemoSupply(this.supply, selection); this.render(); this.updateSupplyControls(); this.area.setTab('village');
  }
  private renderDungeon(): void {
    const scene = $<HTMLSelectElement>('dungeon-demo-layout').value;
    this.dungeon = createDungeonDemo({spire: scene === 'spire', forest: scene === 'forest',
      rankZero: $<HTMLInputElement>('show-rank-zero').checked, rankFour: $<HTMLInputElement>('show-rank-four').checked});
    this.render();
  }
  private updateSupplyControls(): void {
    const pile = this.supply.piles.find(pile => pile.id === $<HTMLSelectElement>('take-supply-id').value);
    const available = !!pile?.cards.some(card => card.count === null || card.count > 0);
    const button = $<HTMLButtonElement>('take-supply-top'); button.disabled = !available;
    button.textContent = available ? '演示取顶牌' : '供应已用尽';
  }
  resetSupplies(): void {this.supply = createVillageDemo(); this.render(); this.updateSupplyControls();}
  setProfile(user: User | null): void {
    if (this.disposed) return;
    const name = user ? user.username || `玩家 ${user.id}` : this.guestIdentity.name;
    const avatarUrl = user ? user.avatar_url || undefined : this.guestIdentity.avatarUrl;
    const own = this.players.find(player => player.isYou);
    if (own?.name === name && own.avatarUrl === avatarUrl) return;
    this.players = this.players.map(player => player.isYou ? {...player, name, avatarUrl} : player);
    this.render();
  }
  setOwnCards(state: PlayerDeckState): void {
    if (this.disposed) return;
    const own = this.players.find(player => player.isYou);
    const publicIds = new Set(own?.cards?.hand.filter(card => card.revealed).map(card => card.id));
    const cards = {hand: state.hand.map(card => ({...card, revealed: publicIds.has(card.id)})),
      draw: state.draw.map(card => ({...card})), discard: state.discard.map(card => ({...card}))};
    const stamp = JSON.stringify(cards); if (this.ownCardsStamp === stamp) return;
    this.ownCardsStamp = stamp; this.players = this.players.map(player => player.isYou ? {...player, cards} : player); this.render();
  }
  private testReveal(): void {
    if (this.revealTimer !== null) window.clearTimeout(this.revealTimer);
    const setRevealed = (revealed: boolean) => {
      this.players = this.players.map(player => player.id === 'player-2' && player.cards ? {...player,
        cards: {...player.cards, hand: player.cards.hand.map(card => card.id === 'p2-hand-1' ? {...card, revealed} : card)}} : player);
      this.render();
    };
    setRevealed(false); this.area.openPlayer('player-2');
    this.revealTimer = window.setTimeout(() => {this.revealTimer = null; setRevealed(true);}, 2000);
  }
  finish(): void {this.area.finish();}
  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    if (this.revealTimer !== null) window.clearTimeout(this.revealTimer);
    this.cleanup.forEach(cleanup => cleanup()); this.results.dispose(); this.area.dispose();
  }
}
