import {isDisease, isHero, isMonster, isThunderstone, tags} from '../catalog/cards.js';
import type {Calculation} from '../effects/context.js';
import type {Card} from '../types.js';

/** Mandatory hand trophies and diseases are never optional battle support. */
export function isBattleSupport(card: Card): boolean {
  return !isHero(card) && !isDisease(card) && !isMonster(card) && !isThunderstone(card)
    && !tags(card).includes('武器');
}

/** Selection changes contribution, not hand membership or ownership. */
export function teamSourceSelected(tx: Calculation, instanceId: string): boolean {
  const team = tx.context.battle_team;
  if (!team || !tx.hand().includes(instanceId)) return true;
  const card = tx.card(instanceId);
  if (isHero(card)) return team.hero_instance_ids.includes(instanceId);
  if (tags(card).includes('武器')) return Object.entries(tx.context.equipped_weapon_by_hero ?? {})
    .some(([hero, weapons]) => team.hero_instance_ids.includes(hero)
      && (Array.isArray(weapons) ? weapons : [weapons]).includes(instanceId));
  return !isBattleSupport(card) || team.support_instance_ids.includes(instanceId);
}
