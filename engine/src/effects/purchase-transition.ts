import {RuleError, type CardFilter} from '../types.js';
import {matches} from '../catalog/cards.js';
import {Calculation} from './context.js';
import {printedGold, purchasePrice, economyRules} from './economy.js';
import type {Transition} from '../turn/transaction.js';

export function offerPurchase(tx: Transition, filter: CardFilter, maximumCost: number|null = null, spendGold = false) {
  if (maximumCost === null && (tx.state.turn_purchases?.[tx.playerId] ?? 0) > 0 &&
      economyRules(new Calculation(tx.evaluation())).some(rule => rule.params.one_purchase)) return [];
  const budget = spendGold ? tx.player.temporary_gold : maximumCost ?? tx.zone('hand')
    .reduce((sum, id) => sum + printedGold(new Calculation(tx.evaluation()), tx.card(id)), 0);
  const available = new Set<string>(tx.state.supply_rules.basic_card_ids);
  for (const [zone, pile] of Object.entries(tx.state.zones) as [string, string[]][]) if (pile.length &&
      (zone.startsWith('village_supply:') || zone.startsWith('hero_supply:'))) available.add(tx.card(pile[0]).card_id);
  return [...available].sort().filter(cardId => matches(tx.cards[cardId], filter) &&
    purchasePrice(tx.evaluation(), tx.cards[cardId]) <= budget).map(card_id =>
    ({card_id, price: purchasePrice(tx.evaluation(), tx.cards[card_id]), budget}));
}
export function buyEffectCard(tx: Transition, cardId: string, filter: CardFilter, destination: string,
                              abilityId: string, maximumCost: number|null = null, spendGold = false): Record<string, any>[] {
  const option = offerPurchase(tx, filter, maximumCost, spendGold).find(row => row.card_id === cardId);
  if (!option) throw new RuleError('card is not affordable for this effect purchase');
  let supply: string|null = null, instance: string;
  const zone = `player:${tx.playerId}:${destination}`;
  if (tx.state.supply_rules.basic_card_ids.includes(cardId)) instance = tx.createOwned(cardId, zone, 'effect_purchase');
  else {
    supply = Object.entries(tx.state.zones).find(([place, pile]) => (place.startsWith('village_supply:') || place.startsWith('hero_supply:')) &&
      (pile as string[]).length && tx.card((pile as string[])[0]).card_id === cardId)![0];
    instance = tx.state.zones[supply][0];
    tx.state.instances[instance].owner_player_id = tx.playerId;
    tx.move(instance, supply, zone);
  }
  if (maximumCost === null) {
    const made = tx.state.turn_purchases ??= {};
    made[tx.playerId] = (made[tx.playerId] ?? 0) + 1;
  }
  if (spendGold) tx.player.temporary_gold -= option.price;
  tx.event(maximumCost === null ? 'effect_purchase_completed' : 'effect_card_gained', {
    ability_id: abilityId, player_id: tx.playerId, card_id: cardId, instance_id: instance,
    source: supply ?? `basic_supply:${cardId}`, destination: zone,
    price: option.price, budget: option.budget, ...(spendGold ? {gold_remaining: tx.player.temporary_gold} : {})});
  return maximumCost !== null ? [] : [{op: 'event', event: 'CARD_PURCHASED', context: {
    source_instance_id: instance, supply_zone: supply, price: option.price}}];
}
