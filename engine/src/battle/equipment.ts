import {RuleError} from '../types.js';
import {equipmentChoices} from './combat.js';
import type {Transition, GameState, GameRules} from '../turn/transaction.js';
import {queueSteps} from '../turn/workflow.js';

/** Conservative public hint: only equipment with no possible trigger is a local draft. */
export function equipmentNeedsResolution(state: GameState, rules: GameRules, weaponId: string): boolean {
  const sources = new Set([state.instances[weaponId]?.card_id, ...(state.copied_heroes?.[weaponId]?.card_ids ?? [])]);
  return rules.abilities.some(ability => ability.kind === 'triggered' && ability.event === 'CARD_EQUIPPED'
    && (ability.source_zone !== 'event_source' || sources.has(ability.source_card_id)))
    || [...state.registered_triggers ?? [], ...state.scheduled_effects ?? []].some(item => item.event === 'CARD_EQUIPPED');
}

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
    if (strength !== 0) continue;
    const marked = context.zero_strength_marked_heroes ??= [];
    if (marked.includes(hero)) continue;
    marked.push(hero);
    if (!flags.pending_after_battle_destruction) {
      flags.pending_after_battle_destruction = true;
      tx.event('hero_zero_strength_marked', {instance_id: hero});
    }
  }
  return trace;
}
export function equipmentOptions(tx: Transition): {hero_instance_id: string; weapon_instance_id: string}[] {
  return equipmentChoices(tx.evaluation());
}
export function unequipWeapon(tx: Transition, weaponId: string): void {
  const pairs = equipmentPairs(tx.state.battle_context), pair = pairs.find(([, weapon]) => weapon === weaponId);
  if (!pair || !tx.zone('hand').includes(weaponId)) throw new RuleError('weapon is not equipped in the current hand');
  const mapping: Record<string, string[]> = {};
  for (const [hero, weapon] of pairs) if (weapon !== weaponId) (mapping[hero] ??= []).push(weapon);
  tx.state.battle_context.equipped_weapon_by_hero = mapping;
  tx.event('weapon_unequipped', {player_id: tx.playerId, hero_instance_id: pair[0], weapon_instance_id: weaponId, reason: 'player'});
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
