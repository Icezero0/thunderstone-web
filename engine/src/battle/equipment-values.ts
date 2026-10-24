import {stat, tags} from '../catalog/cards.js';
import {Calculation, equipmentPairs} from '../effects/context.js';
import type {CalculationInput, Card} from '../types.js';

/** All weight queries share active weight changes, including cards outside hand. */
export function effectiveWeight(input: CalculationInput, card: Card): number {
  return input.state.battle_context?.zero_weapon_weight && tags(card).includes('武器') ? 0 : stat(card, 'weight');
}

export function equipmentCapacity(input: CalculationInput, heroId: string, pairs = equipmentPairs(input.state.battle_context ?? {})): number {
  const tx = new Calculation(input), carried = pairs.filter(([hero]) => hero === heroId).map(([, weapon]) => weapon);
  const rules = tx.handRules('extra_equipment').filter(([source]) => source === heroId || carried.includes(source));
  return Math.max(1, ...rules.map(([, rule]) => rule.params.capacity ?? 1))
    + rules.reduce((sum, [, rule]) => sum + (rule.params.extra_capacity ?? 0), 0);
}

/** A cleric's mace discount reduces that weapon's burden, never other weapons. */
export function weaponBurden(input: CalculationInput, heroId: string, weaponId: string): number {
  const tx = new Calculation(input), hero = tx.card(heroId), weapon = tx.card(weaponId);
  const discount = tx.mechanics.filter(rule => rule.source_card_id === weapon.card_id && rule.op === 'equipment_discount'
    && tags(hero).includes(rule.params.hero_tag ?? '')).reduce((sum, rule) => sum + (rule.params.amount ?? 0), 0);
  return Math.max(0, effectiveWeight(input, weapon) - discount);
}

/** Stable equipment order decides which weapons remain after a strength loss. */
export function supportedEquipment(input: CalculationInput, pairs: [string, string][], strength: Record<string, number>): [string, string][] {
  const loads: Record<string, number> = {}, counts: Record<string, number> = {};
  return pairs.filter(([hero, weapon]) => {
    const weight = weaponBurden(input, hero, weapon), load = (loads[hero] ?? 0) + weight;
    if ((counts[hero] ?? 0) >= equipmentCapacity(input, hero, pairs) || load > Math.max(0, strength[hero] ?? 0)) return false;
    loads[hero] = load; counts[hero] = (counts[hero] ?? 0) + 1;
    return true;
  });
}
