import {isMonster, tags} from '../catalog/cards.js';
import type {Calculation} from './context.js';

/** Spell immunity is continuous while a monster is in the hall. */
export function immuneToSource(tx: Calculation, source: unknown, target: unknown): boolean {
  if (typeof source !== 'string' || typeof target !== 'string' ||
      !tx.state.instances[source] || !tx.state.instances[target] ||
      !tags(tx.card(source)).includes('法术') || !isMonster(tx.card(target))) return false;
  return Object.entries(tx.state.zones).some(([zone, cards]) => zone.startsWith('hall:') && cards.includes(target)) &&
    tx.mechanics.some(rule => rule.source_card_id === tx.card(target).card_id &&
      rule.op === 'target_restriction' && rule.params.immune_spells);
}
