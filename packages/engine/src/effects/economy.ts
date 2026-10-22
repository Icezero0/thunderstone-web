import {isHero, isMonster, stat} from '../catalog/cards.js';
import type {Card} from '../types.js';
import {Calculation} from './context.js';

export function economyRules(tx: Calculation) {
  return [...tx.handRules('economy').map(([, rule]) => rule).filter(rule => rule.params.scope !== 'hall'),
    ...tx.hallRules('economy').map(([, rule]) => rule).filter(rule => rule.params.scope !== 'hand'),
    ...tx.mechanics.filter(rule => rule.op === 'economy' && tx.state.active_settings.includes(rule.source_card_id))];
}
export function printedGold(tx: Calculation, card: Card): number {
  if (isMonster(card) && economyRules(tx).some(rule => rule.params.monster_gold_zero)) return 0;
  return stat(card, 'gold');
}
export function purchasePrice(input: ConstructorParameters<typeof Calculation>[0], card: Card): number {
  if (!(card.wiki_购买价格 ?? '')) return 10 ** 9;
  const tx = new Calculation(input);
  let price = stat(card, 'cost');
  for (const {params: p} of economyRules(tx)) {
    price += p.all_surcharge ?? 0;
    if (isHero(card)) price += (p.hero_surcharge ?? 0) - (p.hero_discount ?? 0);
  }
  return Math.max(0, price);
}
