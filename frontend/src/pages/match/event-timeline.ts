import type {DeckMotionStep, MatchView, TableMotionStep} from '../../shared/api/types.js';
import type {PublicTableArea, PublicTableState} from '../../shared/components/public-table-area/index.js';
import type {PlayerDeckArea, PlayerDeckState} from '../../shared/components/player-deck-area/index.js';
import type {DungeonState, TableCard} from '../../shared/components/table-areas/index.js';
import {PublicCardMotion} from './public-card-motion.js';
import {deckTransitions} from './deck-transitions.js';
import {withoutDeckCards} from '../../shared/components/player-deck-area/model.js';
import {isDestructionEvent, isUpgradeDestruction, isDiseaseGainDestruction} from './animation-events.js';
import {traceCardMotion} from '../../shared/components/game-card/motion-trace.js';
import {effectMotion} from './effect-motion.js';
import {TableMotion} from './table-motion.js';
import {CardAttachments} from '../../shared/components/game-card/card-attachments.js';
import {animationSchedule} from './animation-schedule.js';
import {BattleMotion} from './battle-motion.js';

type Snapshot = {table: PublicTableState; deck: PlayerDeckState};
type Event = MatchView['event_log'][number];
const kinds = new Set(['monster_defeated', 'monster_returned_to_deck', 'effect_hall_relocated', 'thunderstone_acquired', 'thunderstone_returned_to_deck', 'hall_cards_swapped', 'hall_card_repositioned', 'battle_resolved', 'hall_card_entered', 'trap_revealed', 'trap_removed', 'treasure_claimed', 'guardian_entered_rank_0']);
export const hasEventTimeline = (events: readonly Event[], previous?: DungeonState, final?: DungeonState): boolean =>
  events.some(event => kinds.has(event.kind) || isDestructionEvent(event) && !isUpgradeDestruction(event, events)
    || event.kind === 'player_card_motion'
    || event.kind === 'table_card_motion' || event.kind === 'dungeon_shuffle_motion' || event.kind === 'player_shuffle_motion'
    || event.kind === 'card_destruction_replaced'
    || event.kind.startsWith('disease_gain_') || event.kind === 'disease_redirected')
  || !!previous && !!final && JSON.stringify(previous.dungeons.map(lane => [lane.id, lane.hall.map(slot => slot.rank)]))
    !== JSON.stringify(final.dungeons.map(lane => [lane.id, lane.hall.map(slot => slot.rank)]));

/** Presentation of one committed command. No rules, RNG or speculative card draws. */
export class MatchEventTimeline {
  private readonly spotlight: PublicCardMotion;
  private readonly disease: PublicCardMotion;
  private readonly removal: PublicCardMotion;
  private readonly transfers: TableMotion;
  private readonly battle: BattleMotion;
  private pendingDisease: MatchView['pending_disease'] = null;
  private displayedDisease: string | null = null;
  private target: Snapshot | null = null;
  private revision = 0;
  private inertBefore = false;
  private treasureTab = false;
  private finishing = false;
  private battlePlayback = false;
  private camera: ReturnType<PublicTableArea['captureCamera']> | null = null;
  private readonly skip = document.createElement('button');
  get isBusy(): boolean {return this.target !== null || this.finishing;}
  get isBattleSettlement(): boolean {return this.target !== null && this.battlePlayback;}
  constructor(private area: PublicTableArea, private deck: PlayerDeckArea, host: HTMLElement, private changed: () => void) {
    this.spotlight = new PublicCardMotion(host);
    this.disease = new PublicCardMotion(host);
    this.removal = new PublicCardMotion(host);
    this.transfers = new TableMotion(area, deck, host);
    this.battle = new BattleMotion(host);
    this.skip.type = 'button'; this.skip.className = 'button secondary match-animation-skip game-cursor';
    this.skip.textContent = '跳过动画'; this.skip.hidden = true;
    this.skip.addEventListener('click', this.finish); host.append(this.skip);
    window.addEventListener('blur', this.finish); window.addEventListener('resize', this.finish);
    document.addEventListener('visibilitychange', this.visibility);
  }
  syncDisease(pending: MatchView['pending_disease']): void {
    this.pendingDisease = pending ?? null;
    if (this.isBusy) return;
    if (!pending) {this.disease.finish(); this.displayedDisease = null;}
    else if (this.displayedDisease !== pending.gain_id) {
      this.displayedDisease = pending.gain_id;
      void this.disease.present(pending.card_id).then(() => {if (!this.isBusy && this.pendingDisease?.gain_id === pending.gain_id) this.disease.hold(true);});
    } else this.disease.hold(true);
  }
  syncPending(view: MatchView): void {
    this.syncDisease(view.status === 'active' ? view.pending_disease : null);
  }
  cueBattle(targetId: string, participants: readonly string[]): void {
    if (this.isBusy) return;
    this.battle.cue(this.area.hallCardRect(targetId), participants.flatMap(id => {
      const rect = this.deck.cardRect(id); return rect ? [rect] : [];
    }));
  }
  async play(previous: Snapshot, final: Snapshot, view: MatchView, events: readonly Event[]): Promise<void> {
    traceCardMotion('timeline:start', {version: view.version, events: events.map(event => event.kind)});
    this.finish(); CardAttachments.closeAll(); this.area.closeBrowsers(); this.deck.closeBrowser();
    this.camera = this.area.captureCamera();
    this.treasureTab = events.some(event => event.kind === 'treasure_claimed' && event.player_id === view.viewer_player_id);
    if (document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches || typeof this.deck.root.animate !== 'function') {
      traceCardMotion('timeline:skipped', {hidden: document.hidden, reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches, animate: typeof this.deck.root.animate});
      this.camera = null;
      this.area.setState(final.table); this.deck.setState(final.deck); if (this.treasureTab) this.deck.setActiveTab('treasures');
      if (final.deck.revealed?.length) this.deck.setActiveTab('revealed'); return;
    }
    if (events.some(event => kinds.has(event.kind) || event.kind === 'card_destroyed' && event.hall_zone)) this.area.setTab('dungeon');
    this.area.setState(previous.table); this.deck.setState(previous.deck);
    this.pendingDisease = view.pending_disease ?? null;
    this.target = final; this.battlePlayback = view.turn?.chosen_action === 'dungeon'
      && ['BATTLE_EFFECTS', 'BATTLE_AFTER_EFFECTS', 'ACTION_END', 'GAME_END'].includes(view.turn.subphase); const revision = ++this.revision;
    this.disease.hold(false);
    this.inertBefore = this.area.root.inert; this.area.root.inert = true; this.deck.setInteractionLocked(true); this.skip.hidden = false; this.changed();
    let dungeon = structuredClone(previous.table.dungeon), owned = previous.deck;
    const alive = () => revision === this.revision;
    const laneFor = (event: Event) => typeof event.hall_zone === 'string' ? event.hall_zone.replace(/^hall:/, '').replace(/:rank0$/, '')
      : dungeon.dungeons.length === 1 ? dungeon.dungeons[0].id : final.table.dungeon.dungeons.find(lane => lane.hall.some(slot => slot.card?.cardId === event.card_id))?.id;
    const find = (id: string) => dungeon.dungeons.flatMap(lane => lane.hall).find(slot => slot.card?.id === id)?.card;
    const resize = (lane: DungeonState['dungeons'][number], requested: unknown) => {
      const count = typeof requested === 'number' && Number.isSafeInteger(requested) && requested >= 3 ? requested
        : Math.max(3, ...lane.hall.map(slot => slot.rank));
      const size = Math.max(count, ...lane.hall.filter(slot => slot.card).map(slot => slot.rank));
      return {...lane, hall: [...lane.hall.filter(slot => slot.rank === 0), ...Array.from({length: size}, (_, i) =>
        lane.hall.find(slot => slot.rank === i + 1) ?? {rank: i + 1, card: null})]};
    };
    const remove = (id: string, count?: unknown) => {
      dungeon = {...dungeon, dungeons: dungeon.dungeons.map(lane => {
        if (!lane.hall.some(slot => slot.card?.id === id)) return lane;
        const remaining = lane.hall.filter(slot => slot.rank > 0).sort((a, b) => a.rank - b.rank).flatMap(slot => slot.card && slot.card.id !== id ? [slot.card] : []);
        let index = 0;
        const fallback = Math.min(Math.max(3, ...lane.hall.map(slot => slot.rank)),
          Math.max(3, ...final.table.dungeon.dungeons.find(final => final.id === lane.id)?.hall.map(slot => slot.rank) ?? []));
        return resize({...lane, hall: [...lane.hall].sort((a, b) => a.rank - b.rank)
          .filter(slot => slot.rank !== 0 || slot.card?.id !== id).map(slot => ({rank: slot.rank,
            card: slot.rank === 0 ? slot.card : remaining[index++] ?? null}))}, count ?? fallback);
      })};
    };
    const takeDeck = (laneId: string) => {dungeon = {...dungeon, dungeons: dungeon.dungeons.map(lane => lane.id === laneId ? {...lane, deckCount: Math.max(0, lane.deckCount - 1)} : lane)};};
    const place = (laneId: string, rank: number, card: TableCard, count?: unknown) => {
      dungeon = {...dungeon, dungeons: dungeon.dungeons.map(lane => lane.id !== laneId ? lane : resize({...lane,
        hall: lane.hall.some(slot => slot.rank === rank) ? lane.hall.map(slot => slot.rank === rank ? {rank, card} : slot) : [...lane.hall, {rank, card}]}, count))};
    };
    const departingCard = (event: Event) => {
      const candidates = dungeon.dungeons.filter(lane => !event.hall_zone || lane.id === laneFor(event)).flatMap(lane => lane.hall)
        .filter(slot => slot.card?.cardId === event.card_id && (typeof event.rank !== 'number' || slot.rank === event.rank));
      return candidates.length === 1 ? candidates[0].card : null;
    };
    const finalOwned = new Set([...final.deck.hand, ...final.deck.draw, ...final.deck.discard,
      ...final.deck.treasures ?? [], ...final.deck.aside ?? [], ...final.deck.revealed ?? []].map(card => card.id));
    try {
      for (const event of animationSchedule(events)) {
        if (!alive()) return;
        if (event.kind === 'battle_resolved') {
          const trace = event.calculation as {attack?: number; magic_attack?: number; effective_attack?: number} | undefined;
          if (!trace || ![trace.attack, trace.magic_attack, trace.effective_attack, event.health].every(value => typeof value === 'number' && Number.isFinite(value))
            || !['win', 'loss'].includes(String(event.outcome))) continue;
          const candidates = dungeon.dungeons.filter(lane => !event.hall_zone || lane.id === laneFor(event)).flatMap(lane => lane.hall)
            .filter(slot => slot.card?.cardId === event.target_card_id && slot.rank === event.rank);
          const victim = candidates.length === 1 ? candidates[0].card : null;
          if (!victim) continue;
          const target = this.area.focusHall(victim.id); if (!target) continue;
          const attacker = typeof event.player_id === 'string' ? event.player_id : view.turn?.active_player_id;
          const available = [...owned.hand];
          const sources = attacker === view.viewer_player_id
            ? (Array.isArray(event.participants) ? event.participants as {card_id: string}[] : []).flatMap(participant => {
              const index = available.findIndex(card => card.cardId === participant.card_id); if (index < 0) return [];
              const [card] = available.splice(index, 1), rect = this.deck.cardRect(card.id); return rect ? [rect] : [];
            }) : [];
          const player = attacker ? this.area.playerAvatarRect(attacker) ?? this.area.playerRect(attacker) : null;
          const ownAttack = attacker === view.viewer_player_id;
          if (ownAttack) this.deck.setActiveTab('hand', {duringAnimation: true});
          const origin = ownAttack ? this.deck.handRect() : player;
          await this.battle.play({target, origin, sources: sources.length ? sources : origin ? [origin] : [],
            attack: trace.attack!, magic: trace.magic_attack!, total: trace.effective_attack!, health: event.health as number,
            won: event.outcome === 'win', shake: (frames, options) => this.area.animateHallCard(victim.id, frames, options)});
        } else if (event.kind === 'table_card_motion') {
          const result = await this.transfers.play(event.steps as TableMotionStep[], owned, dungeon, view, event.fast === true);
          owned = result.owned; dungeon = result.dungeon;
        } else if (event.kind === 'dungeon_shuffle_motion') {
          await this.transfers.shuffle(String(event.dungeon_id), Number(event.count));
        } else if (event.kind === 'player_shuffle_motion') {
          await this.transfers.shufflePlayer(String(event.player_id), Number(event.count));
        } else if (event.kind === 'player_card_motion' && event.player_id === view.viewer_player_id) {
          for (const step of event.steps as DeckMotionStep[]) {
            if (!alive()) return;
            const origin = step.kind === 'gain' ? this.area.focusSupply(step.cards[0]?.card_id) : null;
            const plan = effectMotion(owned, step, view, origin);
            if (!plan) continue;
            owned = plan.state;
            if (plan.animation?.kind === 'transfer') plan.animation.fast = event.fast === true;
            if (plan.animation) await this.deck.animateSequence(owned, [plan.animation]); else this.deck.setState(owned);
          }
        } else if (event.kind === 'disease_gain_started' && typeof event.card_id === 'string') {
          const lane = typeof event.source_hall_zone === 'string' ? event.source_hall_zone.replace(/^hall:/, '').replace(/:rank0$/, '') : null;
          const source = dungeon.dungeons.find(item => item.id === lane)?.hall
            .find(slot => slot.rank === event.source_rank && slot.card?.cardId === event.source_card_id)?.card;
          this.displayedDisease = String(event.gain_id);
          await this.disease.generate(event.card_id, source ? this.area.focusHall(source.id) : null);
        } else if (event.kind === 'disease_gain_completed' && typeof event.card_id === 'string') {
          const center = this.disease.rect() ?? await this.disease.present(event.card_id); if (!alive()) return;
          if (center && event.player_id === view.viewer_player_id) {
            const destination = event.destination === 'hand' || event.destination === 'draw' ? event.destination : 'discard';
            const currentIds = new Set([...owned.hand, ...owned.draw, ...owned.discard, ...owned.treasures ?? [], ...owned.aside ?? [], ...owned.revealed ?? []].map(card => card.id));
            const card = final.deck[destination].find(card => card.cardId === event.card_id && !currentIds.has(card.id))
              ?? {id: `disease-${event.gain_id}`, cardId: event.card_id, name: view.cards[event.card_id]?.name ?? event.card_id};
            owned = {...owned, [destination]: [...owned[destination], card]}; this.disease.hide();
            await this.deck.animateSequence(owned, [{kind: 'gain', state: owned, destination, instanceIds: [card.id], origins: {[card.id]: center}}]);
          } else if (center && typeof event.player_id === 'string') {
            const to = this.area.playerRect(event.player_id); if (to) await this.disease.fly(event.card_id, center, to);
          }
          this.disease.finish(); this.displayedDisease = null;
        } else if (event.kind === 'disease_gain_destroyed' && typeof event.card_id === 'string') {
          if (!this.disease.rect()) await this.disease.present(event.card_id); if (!alive()) return;
          await this.disease.destroy(); this.displayedDisease = null;
        } else if (event.kind === 'card_destruction_replaced' && event.player_id === view.viewer_player_id && event.cause !== 'hero_upgrade') {
          const card = owned.hand.find(card => card.cardId === event.card_id && final.deck.discard.some(item => item.id === card.id));
          if (!card) continue;
          this.deck.setActiveTab('hand', {duringAnimation: true});
          owned = {...owned, hand: owned.hand.filter(item => item.id !== card.id), discard: [...owned.discard, card]};
          await this.deck.animateSequence(owned, [{kind: 'discard', state: owned, instanceIds: [card.id]}]);
        } else if (event.kind === 'card_destroyed' && typeof event.card_id === 'string') {
          if (event.cause === 'trap_resolved' || isUpgradeDestruction(event, events) || isDiseaseGainDestruction(event, events)) continue;
          if (events.some(row => row.sequence === event.sequence && row.kind === 'player_card_motion'
            && (row.steps as DeckMotionStep[]).some(step => step.kind === 'destroy'))) continue;
          // The event is the only destruction playback trigger. Never forecast
          // future victims or defer this event to an end-of-command inventory diff.
          const hallVictim = typeof event.hall_zone === 'string' ? departingCard(event) : null;
          if (hallVictim) {
            const from = this.area.focusHall(hallVictim.id); this.area.hideHallCard(hallVictim.id);
            if (from) await this.removal.reveal(event.card_id, from, false); else await this.removal.present(event.card_id);
            if (!alive()) return; await this.removal.destroy();
            if (!alive()) return; remove(hallVictim.id); await this.area.animateDungeon(dungeon);
          } else if (event.player_id === view.viewer_player_id) {
            const victim = [...owned.hand, ...owned.draw, ...owned.discard, ...owned.treasures ?? [], ...owned.aside ?? [], ...owned.revealed ?? []]
              .find(card => card.cardId === event.card_id && !finalOwned.has(card.id));
            if (victim) {
              this.deck.setActiveTab('hand', {duringAnimation: true});
              owned = withoutDeckCards(owned, new Set([victim.id]));
              await this.deck.animateSequence(owned, [{kind: 'destroy', state: owned, instanceIds: [victim.id]}]);
            } else {await this.removal.present(event.card_id); if (alive()) await this.removal.destroy();}
          } else if (typeof event.player_id === 'string') {
            const from = this.area.playerRect(event.player_id);
            if (from) await this.removal.reveal(event.card_id, from, false); else await this.removal.present(event.card_id);
            if (alive()) await this.removal.destroy();
          } else {
            const supply = typeof event.source_supply === 'string' ? this.area.focusSupply(event.card_id) : null;
            if (supply && supply.width > 0 && supply.height > 0) await this.removal.reveal(event.card_id, supply, false);
            else await this.removal.present(event.card_id);
            if (alive()) await this.removal.destroy();
          }
        } else if (event.kind === 'monster_defeated' || event.kind === 'thunderstone_acquired'
          || event.kind === 'effect_hall_relocated' && event.destination === 'discard' && !event.defeat) {
          const gains = final.deck.discard.filter(card => find(card.id) && card.cardId === event.card_id && !owned.discard.some(old => old.id === card.id));
          const candidates = dungeon.dungeons.filter(lane => !event.hall_zone || lane.id === laneFor(event)).flatMap(lane => lane.hall)
            .filter(slot => slot.card?.cardId === event.card_id && (typeof event.rank !== 'number' || slot.rank === event.rank));
          const card = gains.length === 1 ? gains[0] : candidates.length === 1 ? candidates[0].card : null;
          traceCardMotion('timeline:monster', {cardId: event.card_id, own: event.player_id === view.viewer_player_id, gains: gains.length, candidates: candidates.length, found: !!card});
          if (!card) continue;
          const gain = gains.find(item => item.id === card.id) ?? (event.player_id === view.viewer_player_id ? card : null);
          const from = this.area.focusHall(card.id); this.area.hideHallCard(card.id);
          if (from && event.player_id === view.viewer_player_id && gain) {
            owned = {...owned, discard: [...owned.discard, gain]};
            await this.deck.animateSequence(owned, [{kind: 'gain', state: owned, instanceIds: [gain.id], origins: {[gain.id]: from}}]);
          } else if (from && typeof event.player_id === 'string') {
            const to = this.area.playerRect(event.player_id); if (to) await this.spotlight.fly(card.cardId, from, to);
          }
          if (!alive()) return; remove(card.id, event.hall_rank_count); await this.area.animateDungeon(dungeon);
        } else if (event.kind === 'monster_returned_to_deck' || event.kind === 'thunderstone_returned_to_deck'
          || event.kind === 'effect_hall_relocated' && event.destination === 'dungeon_bottom') {
          const card = departingCard(event), laneId = laneFor(event); if (!card || !laneId) continue;
          const from = this.area.focusHall(card.id), to = this.area.dungeonDeckRect(laneId);
          this.area.hideHallCard(card.id);
          if (from && to) await this.spotlight.fly(card.cardId, from, to);
          if (!alive()) return;
          dungeon = {...dungeon, dungeons: dungeon.dungeons.map(lane => lane.id === laneId ? {...lane, deckCount: lane.deckCount + 1} : lane)};
          remove(card.id, event.hall_rank_count); await this.area.animateDungeon(dungeon);
        } else if (event.kind === 'hall_cards_swapped' || event.kind === 'hall_card_repositioned') {
          const laneId = laneFor(event);
          dungeon = {...dungeon, dungeons: dungeon.dungeons.map(lane => {
            if (lane.id !== laneId) return lane;
            const slots = lane.hall.filter(slot => slot.rank > 0).sort((a, b) => a.rank - b.rank);
            const cards = slots.map(slot => slot.card);
            const from = Number(event.kind === 'hall_cards_swapped' ? event.first_rank : event.from_rank) - 1;
            const to = Number(event.kind === 'hall_cards_swapped' ? event.second_rank : event.rank) - 1;
            if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < 0 || from >= cards.length || to >= cards.length) return lane;
            if (event.kind === 'hall_cards_swapped') [cards[from], cards[to]] = [cards[to], cards[from]];
            else cards.splice(to, 0, cards.splice(from, 1)[0]);
            return {...lane, hall: [...lane.hall.filter(slot => slot.rank === 0), ...slots.map((slot, index) => ({...slot, card: cards[index]}))]};
          })};
          await this.area.animateDungeon(dungeon);
        } else if (event.kind === 'trap_removed') {
          const card = departingCard(event); if (!card) continue;
          const from = this.area.focusHall(card.id);
          this.area.hideHallCard(card.id);
          if (from) await this.removal.dismiss(card.cardId, from);
          if (!alive()) return;
          remove(card.id, event.hall_rank_count); await this.area.animateDungeon(dungeon);
        } else if (event.kind === 'hall_card_entered' || event.kind === 'trap_revealed') {
          const laneId = laneFor(event); if (!laneId || typeof event.card_id !== 'string' || typeof event.rank !== 'number') continue;
          // A trap already in the hall needs no second reveal animation.
          if (event.kind === 'trap_revealed' && event.origin === 'hall') continue;
          const currentIds = new Set(dungeon.dungeons.flatMap(lane => lane.hall.flatMap(slot => slot.card ? [slot.card.id] : [])));
          const real = final.table.dungeon.dungeons.find(lane => lane.id === laneId)?.hall
            .find(slot => slot.card && slot.card.cardId === event.card_id && !currentIds.has(slot.card.id))?.card;
          // A revealed card can leave again in the same command. Its temporary
          // visual identity never becomes an engine instance or a command target.
          const card = real ?? {id: `revealed-${event.sequence}`, cardId: event.card_id, name: view.cards[event.card_id]?.name ?? event.card_id};
          this.area.focusDungeon(laneId); takeDeck(laneId); place(laneId, event.rank, card, event.hall_rank_count); await this.area.animateDungeon(dungeon);
        } else if (event.kind === 'guardian_entered_rank_0') {
          const laneId = laneFor(event), card = dungeon.dungeons.find(lane => lane.id === laneId)?.hall.find(slot => slot.card?.cardId === event.card_id)?.card;
          if (laneId && card) {remove(card.id, event.hall_rank_count); place(laneId, 0, card, event.hall_rank_count); await this.area.animateDungeon(dungeon);}
        } else if (event.kind === 'treasure_claimed') {
          const laneId = laneFor(event); if (!laneId || typeof event.card_id !== 'string') continue;
          const hallCard = event.origin === 'hall' ? dungeon.dungeons.find(lane => lane.id === laneId)?.hall.find(slot => slot.card?.cardId === event.card_id)?.card : null;
          const from = hallCard ? this.area.focusHall(hallCard.id) : this.area.focusDungeon(laneId);
          if (!from) continue;
          if (hallCard) {this.area.hideHallCard(hallCard.id); remove(hallCard.id, event.hall_rank_count);} else takeDeck(laneId);
          const center = await this.spotlight.reveal(event.card_id, from, !hallCard); if (!alive()) return;
          const treasure = final.deck.treasures?.find(card => card.cardId === event.card_id && !owned.treasures?.some(old => old.id === card.id));
          if (center && treasure && event.player_id === view.viewer_player_id) {
            this.spotlight.hide(); owned = {...owned, treasures: [...owned.treasures ?? [], treasure]};
            await this.deck.receiveTreasure(owned, treasure.id, center);
          } else if (center && typeof event.player_id === 'string') {
            const to = this.area.playerRect(event.player_id); if (to) await this.spotlight.fly(event.card_id, center, to);
          }
          this.spotlight.clear();
          if (!alive()) return; await this.area.animateDungeon(dungeon);
        }
      }
      if (!alive()) return;
      await this.area.animateDungeon(final.table.dungeon); if (!alive()) return;
      const hasOwnMotion = events.some(event => event.kind === 'player_card_motion' && event.player_id === view.viewer_player_id);
      // The exact movement stream has already handled these. In particular a
      // second cleanup inference would discard the newly refilled hand again.
      const covered = new Set(['cards_drawn', 'player_deck_shuffled', 'turn_hand_discarded', 'hero_upgraded', 'card_bought', 'effect_card_gained', 'effect_purchase_completed']);
      const steps = deckTransitions(owned, final.deck, events.filter(event => !isDestructionEvent(event) && (!hasOwnMotion || !covered.has(event.kind))), view.viewer_player_id);
      if (steps.length) await this.deck.animateSequence(final.deck, steps);
    } finally {if (alive()) this.finish();}
  }
  finish = (): void => {
    this.battle.finish();
    this.skip.hidden = true;
    if (this.target) traceCardMotion('timeline:finish', {stack: new Error().stack?.split('\n').slice(1, 5).join('\n')});
    this.revision++; this.spotlight.finish(); this.removal.finish(); this.disease.settle(); this.transfers.finish();
    const final = this.target; this.target = null;
    if (final) {
      this.finishing = true;
      this.area.finish(); this.deck.finish(); this.area.root.inert = this.inertBefore;
      this.area.setState(final.table); this.deck.setState(final.deck);
      if (this.camera) {this.area.restoreCamera(this.camera); this.camera = null;}
      this.deck.setInteractionLocked(false);
      if (this.treasureTab) this.deck.setActiveTab('treasures');
      if (final.deck.revealed?.length) this.deck.setActiveTab('revealed');
      this.finishing = false;
      this.syncDisease(this.pendingDisease);
      this.changed();
    }
  };
  private visibility = (): void => {if (document.hidden) this.finish();};
  dispose(): void {
    this.skip.removeEventListener('click', this.finish); this.skip.remove();
    this.finish(); this.battle.dispose(); this.spotlight.dispose(); this.removal.dispose(); this.disease.dispose(); window.removeEventListener('blur', this.finish); window.removeEventListener('resize', this.finish);
    document.removeEventListener('visibilitychange', this.visibility);
  }
}
