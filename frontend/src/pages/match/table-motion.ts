import type {MatchView, MotionPlace, TableMotionStep} from '../../shared/api/types.js';
import type {PublicTableArea} from '../../shared/components/public-table-area/index.js';
import type {PlayerDeckArea, PlayerDeckState, CardFlightOrigin} from '../../shared/components/player-deck-area/index.js';
import type {DungeonState} from '../../shared/components/table-areas/index.js';
import {PublicCardMotion} from './public-card-motion.js';
import {allDeckCards, withoutDeckCards} from '../../shared/components/player-deck-area/model.js';
import type {PlayerDeckCard} from '../../shared/components/player-deck-area/types.js';

/** Cross-area committed movements. Hidden transfers use only an opaque card back. */
export class TableMotion {
  private flights: PublicCardMotion[] = [];
  private revision = 0;
  constructor(private area: PublicTableArea, private deck: PlayerDeckArea, private host: HTMLElement) {}
  private rect(place: MotionPlace, id: string, dungeon: DungeonState): CardFlightOrigin | null {
    if (place.kind === 'owned') return this.deck.cardRect(id) ?? (place.zone === 'draw' ? this.deck.drawRect() : this.deck.discardRect());
    if (place.kind === 'dungeon') return this.area.focusDungeon(place.dungeon_id);
    if (place.kind === 'attachment') return this.deck.attachmentRect(place.anchor_id) ?? this.area.focusAttachment(place.anchor_id)
      ?? (place.player_id ? this.area.playerRect(place.player_id) : null);
    if (place.kind === 'hall') {
      const card = dungeon.dungeons.find(lane => lane.id === place.dungeon_id)?.hall.find(slot => slot.rank === place.rank)?.card;
      return card ? this.area.focusHall(card.id) : this.area.focusDungeon(place.dungeon_id);
    }
    const avatar = this.area.playerRect(place.player_id);
    return avatar ? {left: avatar.left + (place.zone === 'draw' ? -25 : 0), top: avatar.top + (place.zone === 'draw' ? -70 : place.zone === 'discard' ? 25 : 0),
      width: 68, height: 95} : null;
  }
  async play(steps: readonly TableMotionStep[], owned: PlayerDeckState, dungeon: DungeonState, view: MatchView, fast = false) {
    const revision = this.revision;
    const origins = steps.map(step => this.rect(step.source, step.card.instance_id, dungeon));
    let next = owned;
    const board = {...dungeon, dungeons: dungeon.dungeons.map(lane => ({...lane, hall: lane.hall.map(slot => ({...slot}))}))};
    const items = steps.map(step => {
      const id = step.card.instance_id, cardId = step.card.card_id;
      const old = allDeckCards(owned).find(item => item.id === id);
      const fromHall = step.source.kind === 'hall' ? dungeon.dungeons.find(lane => lane.id === (step.source as Extract<MotionPlace, {kind: 'hall'}>).dungeon_id)
        ?.hall.find(slot => slot.rank === (step.source as Extract<MotionPlace, {kind: 'hall'}>).rank)?.card : null;
      return old ?? fromHall ?? {id, cardId: cardId ?? 'hidden-motion', name: cardId ? view.cards[cardId]?.name ?? cardId : '未知卡牌'};
    });
    // Remove all sources before placing destinations, so swaps remain atomic.
    for (const [i, step] of steps.entries()) {
      if (step.source.kind === 'owned' || step.source.kind === 'attachment') next = withoutDeckCards(next, new Set([items[i].id]));
      if (step.source.kind === 'hall') {
        const lane = board.dungeons.find(lane => lane.id === (step.source as Extract<MotionPlace, {kind: 'hall'}>).dungeon_id);
        if (lane) lane.hall = lane.hall.map(slot => slot.card?.id === items[i].id ? {...slot, card: null} : slot);
      }
      if (step.source.kind === 'dungeon') {
        const lane = board.dungeons.find(lane => lane.id === (step.source as Extract<MotionPlace, {kind: 'dungeon'}>).dungeon_id);
        if (lane) lane.deckCount = Math.max(0, lane.deckCount - 1);
      }
    }
    const arrivals: string[] = [];
    const updateAttachments = (anchor: string, update: (card: PlayerDeckCard) => PlayerDeckCard) => {
      next = Object.fromEntries(Object.entries(next).map(([zone, cards]) => [zone, cards.map((card: PlayerDeckCard) => card.id === anchor ? update(card) : card)])) as unknown as PlayerDeckState;
      for (const lane of board.dungeons) lane.hall = lane.hall.map(slot => slot.card?.id === anchor ? {...slot, card: update(slot.card)} : slot);
    };
    for (const [i, step] of steps.entries()) {
      const destination = step.destination, item = {...items[i], id: step.card.instance_id};
      if (step.source.kind === 'attachment') updateAttachments(step.source.anchor_id,
        card => ({...card, attachments: card.attachments?.filter(entry => entry.cardId !== item.cardId || entry.id !== item.id)}));
      if (destination.kind === 'attachment') updateAttachments(destination.anchor_id,
        card => ({...card, attachments: [...card.attachments ?? [], {...item, kind: destination.attachment_kind ?? 'attachment'}]}));
      if (destination.kind === 'attachment') {
        const zone = (Object.keys(next) as (keyof PlayerDeckState)[]).find(zone => next[zone]?.some(card => card.id === destination.anchor_id));
        if (zone) next = {...next, [zone]: [...next[zone] ?? [], item]};
      }
      if (destination.kind === 'owned') next = {...next, [destination.zone]: [...next[destination.zone] ?? [], item]};
      if (destination.kind === 'hall') {
        const lane = board.dungeons.find(lane => lane.id === destination.dungeon_id);
        const actual = view.dungeons.find(lane => lane.id === destination.dungeon_id)?.hall.find(slot => slot.rank === destination.rank && slot.card_id === item.cardId);
        const placed = {...item, id: actual?.instance_id ?? item.id}; arrivals.push(placed.id);
        if (lane) lane.hall = lane.hall.map(slot => slot.rank === destination.rank ? {...slot, card: placed} : slot);
      }
      if (destination.kind === 'dungeon') {
        const lane = board.dungeons.find(lane => lane.id === destination.dungeon_id); if (lane) lane.deckCount++;
      }
    }
    this.deck.setState(next); this.area.stageDungeon(board);
    const targets = steps.map(step => this.rect(step.destination, step.card.instance_id, board));
    for (const step of steps) if (step.destination.kind === 'owned') this.deck.hideCard(step.card.instance_id);
    for (const id of arrivals) this.area.hideHallCard(id);
    await Promise.all(steps.map(async (step, i) => {
      if (!origins[i] || !targets[i]) return;
      const motion = new PublicCardMotion(this.host); this.flights.push(motion);
      await motion.fly(step.card.card_id ?? null, origins[i]!, targets[i]!, fast);
      motion.dispose(); this.flights = this.flights.filter(item => item !== motion);
    }));
    if (revision === this.revision) {this.deck.setState(next); this.area.stageDungeon(board);}
    return {owned: next, dungeon: board};
  }
  async shuffle(dungeonId: string, count: number): Promise<void> {
    const from = this.area.focusDungeon(dungeonId); if (!from) return;
    await this.shuffleAt(from, count);
  }
  async shufflePlayer(player: string, count: number): Promise<void> {
    const avatar = this.area.playerRect(player); if (!avatar) return;
    await this.shuffleAt({left: avatar.left, top: avatar.top - 40, width: 68, height: 95}, count);
  }
  private async shuffleAt(from: CardFlightOrigin, count: number): Promise<void> {
    const revision = this.revision;
    await Promise.all(Array.from({length: Math.min(6, Math.max(1, count))}, async (_, i) => {
      const motion = new PublicCardMotion(this.host); this.flights.push(motion);
      const to = {left: from.left + (i % 2 ? 1 : -1) * (25 + i * 7), top: from.top - 24 - i * 4, width: from.width, height: from.height};
      await motion.fly(null, from, to);
      if (revision === this.revision) await motion.fly(null, to, from);
      motion.dispose(); this.flights = this.flights.filter(item => item !== motion);
    }));
  }
  finish(): void {this.revision++; const flights = this.flights; this.flights = []; flights.forEach(item => item.dispose());}
}
