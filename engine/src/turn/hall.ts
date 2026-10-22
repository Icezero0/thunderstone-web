import {RuleError} from '../types.js';
import {isMonster, isThunderstone} from '../catalog/cards.js';
import {hallCapacity, MONSTER_MARKERS} from '../setup/rules.js';
import {queueSteps} from './workflow.js';
import {settleGame} from './settlement.js';
import type {Transition} from './transaction.js';

export function rememberFronts(tx: Transition) {
  const fronts = tx.state.hall_fronts ??= {};
  for (const [zone, pile] of Object.entries(tx.state.zones) as [string, string[]][]) if (zone.startsWith('hall:') && !zone.endsWith(':rank0'))
    fronts[zone] ??= pile[0] ?? null;
}
const eventStep = (event: string, instance: string, hall: string, details: Record<string, any> = {}) =>
  ({op: 'event', event, context: {source_instance_id: instance, hall_zone: hall, ...details}});
export function settleOnStone(tx: Transition, stoneId: string, acquire: boolean): boolean {
  const ritual = tx.state.active_settings.includes('TS-0199'), stoneZone = tx.location(stoneId)!;
  if (Object.entries(tx.state.zones).some(([zone, pile]) => zone.startsWith('hall:') && zone.endsWith(':rank0') && (pile as string[]).length)) acquire = false;
  if (acquire) {
    tx.state.instances[stoneId].owner_player_id = tx.playerId;
    tx.move(stoneId, stoneZone, `player:${tx.playerId}:discard`);
    const acquired = tx.state.acquired_stones ??= [];
    if (!acquired.includes(stoneId)) acquired.push(stoneId);
    tx.event('thunderstone_acquired', {player_id: tx.playerId, instance_id: stoneId});
    if (ritual || tx.state.active_settings.includes('TS-0198') && acquired.length < 2) return false;
  } else if (ritual) {
    const deckZone = stoneZone.replace('hall:', 'dungeon:');
    tx.move(stoneId, stoneZone, deckZone);
    tx.event('thunderstone_returned_to_deck', {instance_id: stoneId, deck_zone: deckZone, reason: 'banishing_ritual_breach'});
    return false;
  }
  settleGame(tx, 'thunderstone_entered_rank_1', {instance_id: stoneId, acquired_by: acquire ? tx.playerId : null});
  return true;
}
export function refillStep(tx: Transition, step: Record<string, any>) {
  const hallZone = step.hall_zone;
  if (!step.before_refill_done) {
    queueSteps(tx, [{op: 'event', event: 'BEFORE_HALL_REFILL', context: {
      hall_zone: hallZone, defeated_instance_id: step.defeated_instance_id ?? null}},
      {...step, before_refill_done: true}], true);
    return;
  }
  const hall = tx.state.zones[hallZone], deckZone = hallZone.replace('hall:', 'dungeon:'), deck = tx.state.zones[deckZone];
  const targetSize = hallCapacity(hall.map((id: string) => tx.card(id).card_id), tx.state.active_settings);
  if (hall.length && ['陷阱', '宝藏'].includes(tx.card(hall[0]).subcategory)) {
    const instance = hall[0];
    if (tx.card(instance).subcategory === '陷阱') {
      tx.move(instance, hallZone, `revealed:${hallZone.slice(5)}`);
      tx.event('trap_revealed', {instance_id: instance});
      queueSteps(tx, [eventStep('TRAP_REVEALED', instance, hallZone, {defeated_instance_id: step.defeated_instance_id ?? null}),
        {op: 'dispose_revealed', instance_id: instance}, step], true);
    } else {
      tx.state.instances[instance].owner_player_id = tx.playerId;
      tx.move(instance, hallZone, `player:${tx.playerId}:control`);
      tx.event('treasure_claimed', {player_id: tx.playerId, instance_id: instance});
      queueSteps(tx, [step], true);
    }
    return;
  }
  if (hall.length < targetSize && deck.length) {
    const instance = deck[0];
    if (MONSTER_MARKERS.has(tx.card(instance).card_id)) {
      deck.shift();
      (tx.state.zones.monster_markers ??= []).push(instance);
      const reserve = tx.state.zones[`monster_reserve:${tx.card(instance).card_id}`] ?? [];
      const replacement = reserve.shift() ?? null;
      tx.event('monster_marker_replaced', {marker_instance_id: instance, instance_id: replacement, at_setup: false});
      if (replacement) deck.unshift(replacement);
      queueSteps(tx, [step], true); return;
    }
    const category = tx.card(instance).subcategory;
    if (['陷阱', '宝藏'].includes(category) && !tx.state.active_settings.includes('TS-0188')) {
      if (category === '陷阱') {
        tx.move(instance, deckZone, `revealed:${hallZone.slice(5)}`);
        tx.event('trap_revealed', {instance_id: instance});
        queueSteps(tx, [eventStep('TRAP_REVEALED', instance, hallZone, {defeated_instance_id: step.defeated_instance_id ?? null}),
          {op: 'dispose_revealed', instance_id: instance}, step], true);
      } else {
        tx.state.instances[instance].owner_player_id = tx.playerId;
        tx.move(instance, deckZone, `player:${tx.playerId}:control`);
        tx.event('treasure_claimed', {player_id: tx.playerId, instance_id: instance});
        queueSteps(tx, [step], true);
      }
    } else {
      tx.move(instance, deckZone, hallZone);
      tx.event('hall_card_entered', {hall_zone: hallZone, instance_id: instance, rank: hall.length});
      queueSteps(tx, [eventStep('HALL_REVEALED', instance, hallZone), step], true);
    }
    return;
  }
  if (hall.length < targetSize) tx.event('hall_deck_exhausted', {hall_zone: hallZone, missing: targetSize - hall.length});
  if (!hall.length) { (tx.state.hall_fronts ??= {})[hallZone] = null; return; }
  const instance = hall[0], category = tx.card(instance).subcategory;
  const previous = (tx.state.hall_fronts ??= {})[hallZone];
  tx.state.hall_fronts[hallZone] = instance;
  if (category === '守护者') {
    if (tx.card(instance).card_id === 'TS-0683') {
      tx.event('rule_timing', {event: 'BREACH', context: {source_instance_id: instance, hall_zone: hallZone}});
      settleGame(tx, 'heart_of_doom_breached', {instance_id: instance}); return;
    }
    queueSteps(tx, [eventStep('BREACH', instance, hallZone),
      {op: 'guardian_to_rank0', instance_id: instance, hall_zone: hallZone}, step], true);
  } else if (isThunderstone(tx.card(instance))) {
    if (!settleOnStone(tx, instance, step.acquire_stone ?? false)) queueSteps(tx, [step], true);
  } else if (instance !== previous) queueSteps(tx, [eventStep('BREACH', instance, hallZone)], true);
}
export function canMoveMonster(tx: Transition, instance: string) {
  const cardId = tx.card(instance).card_id;
  return !tx.ruleset.mechanics.some(rule => rule.op === 'immovable' && rule.source_card_id === cardId) &&
    !tx.hallRules('hall_movement_lock').length;
}
export function relocate(tx: Transition, instance: string, destination: string, defeat = false): Record<string, any>[] {
  const hall = tx.location(instance), monster = isMonster(tx.card(instance)), stone = isThunderstone(tx.card(instance));
  if (!hall?.startsWith('hall:') || !(monster || stone && destination === 'dungeon_bottom' && !defeat))
    throw new RuleError('hall relocation needs a monster in a hall');
  if (monster && !defeat && !canMoveMonster(tx, instance)) throw new RuleError('this monster cannot leave the hall unless defeated');
  const rank = hall.endsWith(':rank0') ? 0 : tx.state.zones[hall].indexOf(instance) + 1;
  if (rank === 0 && destination === 'rank3') throw new RuleError('rank zero does not participate in normal hall repositioning');
  rememberFronts(tx);
  if (rank === 1 && destination !== 'rank3') tx.state.hall_fronts[hall] = null;
  if (destination === 'dungeon_bottom') tx.move(instance, hall, hall.replace('hall:', 'dungeon:').replace(/:rank0$/, ''));
  else if (destination === 'discard') {
    tx.state.instances[instance].owner_player_id = tx.playerId;
    tx.move(instance, hall, `player:${tx.playerId}:discard`);
  } else if (destination === 'rank3') {
    const pile = tx.state.zones[hall];
    pile.splice(pile.indexOf(instance), 1); pile.splice(Math.min(2, pile.length), 0, instance);
    tx.event('hall_card_repositioned', {instance_id: instance, hall_zone: hall, rank: Math.min(3, pile.length)});
  } else throw new RuleError('unsupported hall relocation');
  tx.event('effect_hall_relocated', {instance_id: instance, card_id: tx.card(instance).card_id,
    hall_zone: hall, destination, defeat});
  const steps: Record<string, any>[] = [];
  if (defeat) {
    (tx.state.turn_defeated_monsters ??= []).push(instance);
    const xp = Number(tx.card(instance).defeat_xp_reward || 0);
    tx.player.xp += xp;
    tx.event('monster_defeated', {player_id: tx.playerId, target_instance_id: instance, xp_gained: xp, by_effect: true});
    steps.push(eventStep('MONSTER_DEFEATED', instance, hall, {rank}));
    if (tx.card(instance).card_id === 'TS-0683') steps.push({op: 'heart_of_doom_outcome', instance_id: instance, won: true});
  }
  if (rank !== 0) steps.push({op: 'refill_hall', hall_zone: hall, acquire_stone: defeat && rank === 1,
    defeated_instance_id: defeat ? instance : null});
  return steps;
}
export function swapHall(tx: Transition, first: string, second: string): Record<string, any>[] {
  const hall = tx.location(first);
  if (first === second || !hall?.startsWith('hall:') || hall.endsWith(':rank0') || tx.location(second) !== hall ||
      [first, second].some(id => !isMonster(tx.card(id)) || !canMoveMonster(tx, id))) throw new RuleError('invalid hall swap');
  const pile = tx.state.zones[hall], a = pile.indexOf(first), b = pile.indexOf(second);
  if (Math.abs(a-b) !== 1) throw new RuleError('hall swap requires adjacent monsters');
  rememberFronts(tx); [pile[a], pile[b]] = [pile[b], pile[a]];
  tx.event('hall_cards_swapped', {first, second, hall_zone: hall});
  return [{op: 'refill_hall', hall_zone: hall}];
}
export function exchangeHall(tx: Transition, target: string, replacement: string): Record<string, any>[] {
  const hall = tx.location(target), origin = tx.location(replacement);
  if (!hall?.startsWith('hall:') || hall.endsWith(':rank0') || !origin || origin.endsWith(':rank0') ||
      !isMonster(tx.card(target)) || !isMonster(tx.card(replacement)) || !canMoveMonster(tx, target) ||
      origin.startsWith('hall:') && !canMoveMonster(tx, replacement)) throw new RuleError('invalid monster exchange');
  rememberFronts(tx);
  const rank = tx.state.zones[hall].indexOf(target), owner = tx.state.instances[replacement].owner_player_id;
  tx.state.instances[replacement].owner_player_id = null;
  tx.state.instances[target].owner_player_id = owner;
  tx.move(target, hall, origin); tx.move(replacement, origin, hall);
  const pile = tx.state.zones[hall]; pile.splice(pile.indexOf(replacement), 1); pile.splice(rank, 0, replacement);
  tx.event('hall_monster_exchanged', {target, replacement, hall_zone: hall, origin});
  return [eventStep('HALL_REVEALED', replacement, hall), {op: 'refill_hall', hall_zone: hall}];
}
export function shuffleHallTop(tx: Transition, target: string, count: number): Record<string, any>[] {
  const hall = tx.location(target);
  if (!hall?.startsWith('hall:') || !isMonster(tx.card(target)) || !canMoveMonster(tx, target)) throw new RuleError('invalid hall shuffle');
  rememberFronts(tx);
  const deck = hall.replace('hall:', 'dungeon:').replace(/:rank0$/, '');
  const top = [...tx.state.zones[deck].slice(0, count)];
  tx.move(target, hall, deck); top.push(target);
  for (const item of top) tx.state.zones[deck].splice(tx.state.zones[deck].indexOf(item), 1);
  tx.rng.shuffle(top); tx.state.zones[deck].unshift(...top);
  tx.event('dungeon_top_shuffled', {hall_zone: hall, instance_ids: top});
  return hall.endsWith(':rank0') ? [] : [{op: 'refill_hall', hall_zone: hall}];
}
export function shuffleDestroyedTraps(tx: Transition, bindings: Record<string, any>, dungeonZone: (tx: Transition, bindings: Record<string, any>) => string) {
  let deck = (tx.state.event_context?.hall_zone ?? '').replace('hall:', 'dungeon:');
  if (!tx.state.zones[deck]) deck = dungeonZone(tx, bindings);
  const top = [...tx.state.zones[deck].slice(0, 10)];
  for (const item of [...tx.state.zones.destroyed]) if (tx.card(item).subcategory === '陷阱') {
    tx.move(item, 'destroyed', deck); top.push(item);
  }
  for (const item of top) tx.state.zones[deck].splice(tx.state.zones[deck].indexOf(item), 1);
  tx.rng.shuffle(top); tx.state.zones[deck].unshift(...top);
  tx.event('destroyed_traps_shuffled', {deck_zone: deck, instance_ids: top});
}
