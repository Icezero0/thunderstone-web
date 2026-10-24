import type {Card} from '../types.js';
import type {CatalogGroup} from '../setup/contracts.js';
import {isHero, stat} from './cards.js';

export const isSupplyZone = (zone: string): boolean => zone.startsWith('hero_supply:') || zone.startsWith('village_supply:');

/** Placement remains village/hero; members with hero identity share a level-ordered stack. */
export function hasHeroLevels(group: CatalogGroup, cards: Record<string, Card>): boolean {
  return group.kind === 'hero' || group.kind === 'village' && group.members.length > 1 && group.members.every(id => isHero(cards[id]));
}
export function supplyZone(group: CatalogGroup, cards: Record<string, Card>, cardId = group.members[0]): string {
  return `${group.kind}_supply:${hasHeroLevels(group, cards) ? group.randomizer_id : cardId}`;
}
export function orderedSupplyMembers(group: CatalogGroup, cards: Record<string, Card>): string[] {
  const members = [...group.members];
  return hasHeroLevels(group, cards) ? members.sort((a, b) => stat(cards[a], 'level') - stat(cards[b], 'level') || (a < b ? -1 : a > b ? 1 : 0)) : members;
}
export function heroGroup(card: Card, groups: readonly CatalogGroup[]): CatalogGroup | undefined {
  return isHero(card) ? groups.find(group => ['hero', 'village'].includes(group.kind) && group.members.includes(card.card_id)) : undefined;
}
export function sameHeroSeries(source: Card, target: Card, groups: readonly CatalogGroup[]): boolean {
  if (!isHero(source) || !isHero(target)) return false;
  const group = heroGroup(source, groups);
  // Standalone callers may inject a small catalog without a setup index.
  return group ? group.members.includes(target.card_id) : !!source.subcategory && source.subcategory === target.subcategory;
}
