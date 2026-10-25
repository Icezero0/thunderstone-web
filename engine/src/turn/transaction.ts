import {RuleError, type Card, type Mechanic} from '../types.js';
import type {Ability} from '../effects/dsl.js';
import {isDisease, isHero} from '../catalog/cards.js';
import {combatValues, monsterHealth} from '../battle/combat.js';
import {RandomStream, RNG_VERSION} from '../random/stream.js';
import {drawCards, refillDrawPile} from './draw.js';
import {sampleDisease} from './disease.js';
import {destructionReplacement, expireTurnBuffs} from './buffs.js';
import {advanceTurn} from './advance.js';
import {runSteps, queueSteps} from './workflow.js';
import {returnBorrowed, detachDestroyed} from '../effects/ownership.js';
import {returnDestroyedToSupply, replenishEmptySupplies} from '../effects/supply.js';
import {reconcileEquipment} from '../battle/equipment.js';
import {expireRules} from '../effects/durations.js';
import {gainSteps} from '../effects/gain.js';
import {diseaseOrigin} from '../effects/disease-origin.js';

// The state is serialized after every command. No process-local game data lives here.
export type GameState = Record<string, any>;
export interface GameRules {abilities: Ability[]; mechanics: Mechanic[]; version: string}
export interface GameCatalog {cards: Record<string, Card>; setup_index: Record<string, any>}

export function number(card: Card, field: string, fallback = 0): number {
  const raw = card[field];
  if (raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new RuleError(`invalid numeric card field ${field}: ${raw}`);
  return value;
}
export const activePlayers = (state: GameState): string[] => state.player_order.filter((id: string) => !state.players[id].eliminated);

export class Transition {
  state: GameState;
  readonly cards: Record<string, Card>;
  readonly ruleset: GameRules;
  readonly setupIndex: Record<string, any>;
  readonly events: Record<string, any>[] = [];
  readonly effectTrace: Record<string, any>[] | null;
  readonly rng: RandomStream;
  workflowRunning = false;
  effectSteps = 0;
  constructor(state: GameState, catalog: GameCatalog, ruleset: GameRules, traceEffects = false) {
    this.state = structuredClone(state);
    this.cards = catalog.cards;
    this.setupIndex = catalog.setup_index;
    this.ruleset = ruleset;
    this.effectTrace = traceEffects ? [] : null;
    if (state.rng_state?.algorithm !== RNG_VERSION) throw new RuleError('unsupported random state');
    this.rng = new RandomStream(state.rng_state.seed, state.rng_state.counter);
  }
  get playerId(): string {return this.state.active_player_id;}
  get player(): Record<string, any> {return this.state.players[this.playerId];}
  zone(part: string, playerId = this.playerId): string[] {return this.state.zones[`player:${playerId}:${part}`];}
  card(instanceId: string): Card {
    const copy = this.state.copied_heroes?.[instanceId];
    return copy?.full_card ? this.cards[copy.card_ids[0]] : this.printedCard(instanceId);
  }
  printedCard(instanceId: string): Card {return this.cards[this.state.instances[instanceId].card_id];}
  location(instanceId: string): string | undefined {
    return Object.entries(this.state.zones).find(([, pile]) => (pile as string[]).includes(instanceId))?.[0];
  }
  evaluation() {return {cards: this.cards, mechanics: this.ruleset.mechanics, state: this.state} as any;}
  combat(rank: number, target: Card | null = null) {return combatValues(this.evaluation(), rank, target);}
  health(target: Card, rank: number, targetId: string) {return monsterHealth(this.evaluation(), target, rank, targetId);}
  event(kind: string, details: Record<string, any> = {}) {
    const sequence = this.state.next_event_sequence++;
    this.events.push({sequence, kind, ...details});
  }
  trace(abilityId: string, sourceId: string, node: Record<string, any>, bindings: Record<string, any>, details: Record<string, any> = {}) {
    if (this.effectTrace) this.effectTrace.push({index: this.effectTrace.length + 1,
      ability_id: abilityId, source_instance_id: sourceId, op: node.op,
      node: structuredClone(node), bindings: structuredClone(bindings), ...details});
  }
  move(instanceId: string, source: string, destination: string) {
    const pile = this.state.zones[source] as string[];
    const index = pile?.indexOf(instanceId) ?? -1;
    if (index < 0) throw new RuleError(`${instanceId} is not in ${source}`);
    pile.splice(index, 1);
    (this.state.zones[destination] ??= []).push(instanceId);
    this.event('card_moved', {instance_id: instanceId, source, destination,
      ...(source.startsWith('hall:') ? {source_rank: source.endsWith(':rank0') ? 0 : index + 1} : {}),
      ...(destination.startsWith('hall:') ? {destination_rank: destination.endsWith(':rank0') ? 0 : this.state.zones[destination].length} : {})});
  }
  createOwned(cardId: string, destination: string, origin: string, owner = this.playerId, emitEvent = true): string {
    const instanceId = `CI-${String(this.state.next_instance_sequence++).padStart(6, '0')}`;
    if (Object.hasOwn(this.state.instances, instanceId)) throw new RuleError(`duplicate instance ID: ${instanceId}`);
    this.state.instances[instanceId] = {card_id: cardId, owner_player_id: owner, origin, flags: {}};
    this.state.zones[destination].push(instanceId);
    if (emitEvent) this.event('card_created', {instance_id: instanceId, card_id: cardId,
      owner_player_id: owner, destination, origin});
    return instanceId;
  }
  takeDisease(destination = 'discard', playerId = this.playerId, sourceId?: string): string {
    if (!['hand', 'discard'].includes(destination)) throw new RuleError('invalid disease destination');
    const supply = this.state.supply_rules;
    const sample = sampleDisease(supply, this.rng.snapshot());
    this.rng.counter = sample.counter;
    if (!this.state.players[playerId]) throw new RuleError('unknown disease recipient');
    if (this.state.players[playerId].eliminated) throw new RuleError('eliminated player cannot receive a disease');
    const zone = `player:${playerId}:${destination}`;
    const instanceId = this.createOwned(sample.card_id, zone, 'disease_supply', playerId, false);
    this.event('disease_taken_from_supply', {player_id: playerId, zone, instance_id: instanceId,
      card_id: sample.card_id, disease_mode: supply.disease_mode, roll: sample.roll,
      total_weight: sample.total_weight, candidates: sample.candidates});
    queueSteps(this, [{op: 'resolve_disease_gain', gain: {instance_id: instanceId,
      player_id: playerId, destination, used_sources: [], monster_source: diseaseOrigin(this, sourceId)}}], true);
    return instanceId;
  }
  destroyCard(instanceId: string, reason = 'effect'): Record<string, any> {
    const source = this.location(instanceId);
    if (!source) throw new RuleError('destroyed card has no zone');
    const hallOrigin = source.startsWith('hall:') ? {hall_zone: source,
      rank: source.endsWith(':rank0') ? 0 : this.state.zones[source].indexOf(instanceId) + 1} : {};
    const card = this.printedCard(instanceId), instance = this.state.instances[instanceId];
    const replacement = destructionReplacement(instance, card, this.state.turn_number);
    delete instance.flags.pending_after_battle_destruction;
    delete instance.flags.pending_turn_end_destruction;
    if (replacement) {
      const destination = `player:${instance.owner_player_id}:discard`;
      if (source !== destination) this.move(instanceId, source, destination);
      const details = {instance_id: instanceId, card_id: card.card_id, source, destination};
      this.event('card_destruction_replaced', {...details, reason, replacement});
      return details;
    }
    detachDestroyed(this, instanceId);
    const returned = returnDestroyedToSupply(this, instanceId, source, reason);
    if (returned) return returned;
    let destination: string;
    if (isDisease(card)) {
      this.state.zones[source].splice(this.state.zones[source].indexOf(instanceId), 1);
      delete this.state.instances[instanceId];
      destination = 'disease_supply';
    } else {
      instance.owner_player_id = null;
      this.move(instanceId, source, 'destroyed');
      destination = 'destroyed';
    }
    const details = {instance_id: instanceId, card_id: card.card_id, source, destination};
    this.event('card_destroyed', {...details, ...hallOrigin, reason});
    return details;
  }
  playerDrawPile(playerId = this.playerId): string[] {
    const draw = this.zone('draw', playerId);
    const shuffled = refillDrawPile(draw, this.zone('discard', playerId), this.rng);
    if (shuffled) this.event('player_deck_shuffled', {player_id: playerId, order: shuffled});
    return draw;
  }
  draw(count: number, playerId = this.playerId): string[] {
    const result = drawCards({draw: this.zone('draw', playerId), discard: this.zone('discard', playerId),
      hand: this.zone('hand', playerId), count, rng: this.rng.snapshot()});
    this.state.zones[`player:${playerId}:draw`] = result.draw;
    this.state.zones[`player:${playerId}:discard`] = result.discard;
    this.state.zones[`player:${playerId}:hand`] = result.hand;
    this.rng.counter = result.counter;
    for (const order of result.shuffle_orders) this.event('player_deck_shuffled', {player_id: playerId, order});
    this.event('cards_drawn', {player_id: playerId, instance_ids: result.taken, requested: count});
    const context = this.state.battle_context;
    if (playerId === this.playerId && context) {
      const equipped = new Set(this.combat(1).equipped_pairs.map(([, weapon]) => weapon));
      for (const [source, rule] of this.handRules('draw_attack')) if (equipped.has(source)) {
        const counts = context.equipment_draw_counts ??= {};
        counts[source] = (counts[source] ?? 0) + result.taken.length;
      }
    }
    return result.taken;
  }
  handRules(op?: string): [string, Mechanic][] {
    const sources = new Map<string, string[]>();
    for (const instance of this.zone('hand')) {
      const ids = [this.card(instance).card_id, ...(this.state.copied_heroes?.[instance]?.card_ids ?? [])];
      for (const cardId of ids) {
        const list = sources.get(cardId) ?? [];
        if (!list.includes(instance)) list.push(instance);
        sources.set(cardId, list);
      }
    }
    return this.ruleset.mechanics.filter(rule => !op || rule.op === op)
      .flatMap(rule => (sources.get(rule.source_card_id) ?? []).map(source => [source, rule] as [string, Mechanic]));
  }
  hallRules(op?: string): [string, Mechanic][] {
    const result: [string, Mechanic][] = [];
    for (const [zone, pile] of Object.entries(this.state.zones)) if (zone.startsWith('hall:'))
      for (const instance of pile as string[]) for (const rule of this.ruleset.mechanics)
        if (rule.source_card_id === this.card(instance).card_id && (!op || rule.op === op) &&
            (!rule.params.rank0_only || zone.endsWith(':rank0'))) result.push([instance, rule]);
    return result;
  }
  /** Normal actions stop here until their owner explicitly ends the turn. */
  awaitTurnEnd() {
    if (this.state.phase !== 'PLAYING') return;
    // An eliminated player cannot submit commands; advance them automatically.
    if (this.player.eliminated) {this.finishTurn(); return;}
    this.state.subphase = this.state.timing_window = 'ACTION_END';
  }
  finishTurn() {
    const current = this.playerId;
    if (this.player.eliminated) {
      this.state.turn_hand_public = false;
      for (const item of [...this.zone('hand')]) this.move(item, `player:${current}:hand`, `player:${current}:discard`);
      queueSteps(this, [{op: 'pass_turn'}, {op: 'event', event: 'TURN_START'}]);
      return;
    }
    this.event('ACTION_WILL_EXIT', {player_id: current, action: this.state.chosen_action});
    this.event('ACTION_EXITED', {player_id: current, action: this.state.chosen_action});
    this.state.subphase = 'ACTION_EXIT_EFFECTS';
    this.state.timing_window = 'ACTION_EXITED';
    queueSteps(this, [{op: 'event', event: 'ACTION_EXITED'}, {op: 'turn_will_end'}, {op: 'cleanup_turn'}]);
  }
  resumeAfterEffects() {
    const stage = this.state.effect_resume;
    delete this.state.effect_resume;
    if (stage !== 'workflow') throw new RuleError('no effect stage to resume');
    runSteps(this);
  }
  cleanupTurn() {
    const current = this.playerId;
    for (const [id, instance] of Object.entries(this.state.instances) as [string, any][]) if (instance.flags.pending_turn_end_destruction) {
      const destination = this.destroyCard(id, 'zero_strength_or_deferred_turn_end').destination;
      this.event(destination === 'destroyed' ? 'zero_strength_hero_destroyed' : 'zero_strength_hero_discarded', {instance_id: id});
    }
    returnBorrowed(this, 'turn_end');
    // New refill cards stay private even if a gain/replacement pauses cleanup.
    this.state.turn_hand_public = false;
    const hand = this.zone('hand'), discard = this.zone('discard'), discarded = [...hand];
    discard.push(...hand); hand.length = 0;
    this.event('turn_hand_discarded', {player_id: current, instance_ids: discarded});
    const bonus = this.player.next_hand_bonus ?? 0;
    delete this.player.next_hand_bonus;
    this.draw(Math.max(0, 6 + bonus));
    const additions = `player:${current}:refill_add`;
    const gains: Record<string, any>[] = [];
    for (const id of [...(this.state.zones[additions] ?? [])]) {
      const owner = this.state.instances[id].owner_player_id;
      this.move(id, additions, `player:${current}:hand`);
      gains.push(...gainSteps(this, id, additions, owner, 'refill_set_aside'));
    }
    queueSteps(this, [...gains, {op: 'event', event: 'HAND_REFILL_COMPLETE'},
      {op: 'pass_turn'}, {op: 'event', event: 'TURN_START'}]);
  }
  passTurn() {
    const current = this.playerId;
    for (const change of expireTurnBuffs({turn_number: this.state.turn_number,
      instances: Object.entries(this.state.instances).filter(([, item]: [string, any]) => item.flags.turn_buffs?.length)
        .map(([instance_id, instance]: [string, any]) => ({instance_id, turn_buffs: instance.flags.turn_buffs}))})) {
      if (change.remaining.length) this.state.instances[change.instance_id].flags.turn_buffs = change.remaining;
      else delete this.state.instances[change.instance_id].flags.turn_buffs;
      this.event('hero_turn_buffs_expired', {instance_id: change.instance_id, buffs: change.expired});
    }
    expireRules(this, 'owner_next_turn_end');
    this.state.registered_triggers = this.state.registered_triggers.filter((item: any) => item.turn_number !== this.state.turn_number);
    delete this.state.effect_collections; delete this.state.copied_heroes;
    this.player.temporary_gold = 0; this.player.purchases_remaining = 1;
    delete this.player.extra_basic_purchases;
    delete this.state.turn_purchases?.[current];
    this.state.ability_uses = {}; this.state.used_cards = []; this.state.battle_context = null;
    this.state.chosen_action = null; delete this.state.turn_defeated_monsters;
    delete this.player.turn_gold_adjustment;
    this.event('TURN_ENDED', {player_id: current});
    const next = advanceTurn({player_order: this.state.player_order, first_player_id: this.state.first_player_id,
      current_player_id: current, players: this.state.players, turn_number: this.state.turn_number,
      round_number: this.state.round_number});
    if (next.extra_turn) this.player.extra_turns = next.remaining_extra_turns;
    this.state.active_player_id = next.next_player_id;
    this.state.turn_hand_public = true;
    this.state.turn_number = next.turn_number; this.state.round_number = next.round_number;
    this.state.subphase = 'TURN_START'; this.state.timing_window = 'TURN_START_BEFORE';
    this.event('turn_passed', {from_player_id: current, to_player_id: next.next_player_id, turn_number: this.state.turn_number});
  }
  finish() {
    if (this.state.phase === 'PLAYING' && this.state.pending_choice === null) replenishEmptySupplies(this);
    this.state.rng_state.counter = this.rng.counter;
    this.state.game_version++;
    return {state: this.state, events: this.events, ...(this.effectTrace ? {effect_trace: this.effectTrace} : {})};
  }
}
