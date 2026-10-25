import {Calculation} from '../effects/context.js';
import {teamSourceSelected} from './participation.js';
import type {Mechanic} from '../types.js';

/** One application per participating source and legally equipped weapon.
 * The weapon's own hero may be benched; that only gates its combat contribution.
 */
export function weaponAuraApplications(tx: Calculation, pairs: readonly [string, string][]): {source: string; weapon: string; rule: Mechanic}[] {
  const weapons = [...new Set(pairs.map(([, weapon]) => weapon))];
  return tx.handRules('weapon_aura').filter(([source]) => teamSourceSelected(tx, source)
    && !tx.context.excluded_participants?.includes(source))
    .flatMap(([source, rule]) => weapons.map(weapon => ({source, weapon, rule})));
}
