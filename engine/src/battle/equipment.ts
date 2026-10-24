import {RuleError} from '../types.js';
import {equipmentChoices} from './combat.js';
import type {Transition} from '../turn/transaction.js';
import {queueSteps} from '../turn/workflow.js';

export function equipmentPairs(context: Record<string, any>): [string, string][] {
  return Object.entries(context?.equipped_weapon_by_hero ?? {}).flatMap(([hero, value]) =>
    (Array.isArray(value) ? value : [value]).map(weapon => [hero, weapon] as [string, string]));
}
export function reconcileEquipment(tx: Transition, duringBattle = false) {
  const context = tx.state.battle_context;
  if (!context) return {};
  const target = context.target_instance_id && tx.state.instances[context.target_instance_id]
    ? tx.card(context.target_instance_id) : null;
  let trace = tx.combat(context.target_rank ?? 1, target);
  for (let i = 0; i < equipmentPairs(context).length + 1; i++) {
    trace = tx.combat(context.target_rank ?? 1, target);
    const valid = new Set(trace.equipped_pairs.map(([hero, weapon]) => `${hero}\0${weapon}`));
    const old = equipmentPairs(context), dropped = old.filter(([hero, weapon]) => !valid.has(`${hero}\0${weapon}`));
    if (!dropped.length) break;
    const mapping = context.equipped_weapon_by_hero;
    for (const key of Object.keys(mapping)) delete mapping[key];
    for (const [hero, weapon] of old) if (valid.has(`${hero}\0${weapon}`)) {
      const previous = mapping[hero];
      mapping[hero] = previous ? [...(Array.isArray(previous) ? previous : [previous]), weapon] : weapon;
    }
    for (const [hero, weapon] of dropped) tx.event('weapon_dropped', {hero_instance_id: hero,
      weapon_instance_id: weapon, reason: 'insufficient_strength_or_missing_card'});
  }
  if (duringBattle || context.negative_effects_committed) for (const [hero, strength] of Object.entries(trace.hero_strength)) {
    const flags = tx.state.instances[hero].flags;
    if (strength === 0 && !flags.pending_turn_end_destruction) {
      flags.pending_turn_end_destruction = true;
      tx.event('hero_zero_strength_marked', {instance_id: hero});
    }
  }
  return trace;
}
export function equipmentOptions(tx: Transition): {hero_instance_id: string; weapon_instance_id: string}[] {
  return equipmentChoices(tx.evaluation());
}
export function equipWeapon(tx: Transition, heroId: string, weaponId: string, deferEvents = false): Record<string, any>[] {
  const hand = tx.zone('hand');
  if (!hand.includes(heroId) || !hand.includes(weaponId) || heroId === weaponId)
    throw new RuleError('hero and weapon must be distinct cards in the current hand');
  if (!equipmentOptions(tx).some(row => row.hero_instance_id === heroId && row.weapon_instance_id === weaponId))
    throw new RuleError('a hero or weapon is already equipped or too heavy');
  const equipped = tx.state.battle_context.equipped_weapon_by_hero;
  const previous = equipped[heroId];
  equipped[heroId] = previous ? [...(Array.isArray(previous) ? previous : [previous]), weaponId] : weaponId;
  tx.event('weapon_equipped', {player_id: tx.playerId, hero_instance_id: heroId, weapon_instance_id: weaponId});
  const steps = [{op: 'event', event: 'CARD_EQUIPPED', context: {source_instance_id: weaponId, hero_instance_id: heroId}}];
  if (!deferEvents) queueSteps(tx, steps);
  return steps;
}
