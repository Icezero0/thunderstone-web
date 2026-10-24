import type {DungeonState, SupplyCard, SupplyPile, TableCard, VillageState} from './types.js';

function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Card and pile identifiers/names must be non-empty strings.');
}
function count(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Counts and ranks must be non-negative integers.');
}
function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) throw new Error('Identifiers must be unique.');
}
function cardCopy(card: TableCard): TableCard {
  text(card.id); text(card.cardId); text(card.name); return {...card};
}
export function copyDungeonState(state: DungeonState): DungeonState {
  unique(state.dungeons.map(lane => lane.id));
  const environment = state.environment ? cardCopy(state.environment) : null;
  const ids: string[] = environment ? [environment.id] : [];
  const dungeons = state.dungeons.map(lane => {
    text(lane.id); text(lane.name); count(lane.deckCount);
    unique(lane.hall.map(slot => String(slot.rank)));
    const hall = lane.hall.map(slot => {
      count(slot.rank); if (slot.card) ids.push(slot.card.id);
      return {rank: slot.rank, card: slot.card ? cardCopy(slot.card) : null};
    });
    for (const rank of [1, 2, 3]) if (!hall.some(slot => slot.rank === rank)) hall.push({rank, card: null});
    return {...lane, hall: hall.sort((a, b) => a.rank - b.rank)};
  });
  unique(ids); return {environment, dungeons};
}
export function copyVillageState(state: VillageState): VillageState {
  unique(state.piles.map(pile => pile.id));
  const piles = state.piles.map(pile => {
    text(pile.id); text(pile.name);
    if (!['hero', 'village', 'basic'].includes(pile.kind) || !pile.cards.length) throw new Error('Invalid supply pile.');
    unique(pile.cards.map(card => card.cardId));
    const hero = isHeroSupply(pile);
    if (!hero && pile.cards.length !== 1) throw new Error('Only hero supplies contain multiple card levels.');
    const cards = pile.cards.map(card => {
      text(card.cardId); text(card.name);
      if (pile.kind === 'basic') {
        if (card.count !== null) throw new Error('Basic supplies must have an infinite (null) count.');
      } else {
        if (card.count === null) throw new Error('Finite supplies require a count.');
        count(card.count);
      }
      card.tags?.forEach(text);
      const minimumLevel = pile.kind === 'hero' ? 1 : 0;
      if (hero && (!Number.isSafeInteger(card.level) || card.level! < minimumLevel)) throw new Error('Hero supplies require a valid level.');
      return {...card, ...(card.tags ? {tags: [...card.tags]} : {})};
    });
    if (hero) {unique(cards.map(card => String(card.level))); cards.sort((a, b) => a.level! - b.level!);}
    return {...pile, cards};
  });
  return {piles};
}
/** Display placement is independent of hero identity; basic militia has no level browser. */
export function isHeroSupply(pile: SupplyPile): boolean {
  return pile.kind === 'hero' || pile.kind === 'village' && pile.cards.every(card => card.tags?.includes('英雄'));
}
export function supplyCount(pile: SupplyPile): number | null {
  return pile.kind === 'basic' ? null : pile.cards.reduce((total, card) => total + (card.count ?? 0), 0);
}
/** Presentation order mirrors the pile: low-level heroes are exposed before higher levels. */
export function supplyTop(pile: SupplyPile): SupplyCard | null {
  return [...pile.cards].sort((a, b) => (a.level ?? 0) - (b.level ?? 0)).find(card => card.count === null || card.count > 0) ?? null;
}
