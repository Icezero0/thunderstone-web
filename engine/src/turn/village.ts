import {RuleError} from '../types.js';
import {Calculation} from '../effects/context.js';
import {economyRules, printedGold, purchasePrice} from '../effects/economy.js';
import {stat} from '../catalog/cards.js';
import {queueSteps} from './workflow.js';
import type {Transition} from './transaction.js';

const gold = (tx: Transition, id: string) => printedGold(new Calculation(tx.evaluation()), tx.card(id));
const price = (tx: Transition, cardId: string) => purchasePrice(tx.evaluation(), tx.cards[cardId]);
const purchaseAllowed = (tx: Transition) => !economyRules(new Calculation(tx.evaluation()))
  .some(rule => rule.params.one_purchase && (tx.state.turn_purchases?.[tx.playerId] ?? 0) > 0);

export function enterVillage(tx: Transition) {
  tx.state.subphase = tx.state.timing_window = 'VILLAGE_ABILITIES';
  tx.event('village_abilities_started', {player_id: tx.playerId});
  queueSteps(tx, [{op: 'event', event: 'VILLAGE_ENTER'}, {op: 'village_entry_done'}]);
}
export function finishAbilities(tx: Transition) {
  tx.event('village_abilities_finished', {player_id: tx.playerId});
  tx.state.subphase = tx.state.timing_window = 'VILLAGE_BUY';
  const sources = tx.zone('hand').map(id => ({instance_id: id, gold: gold(tx, id)})).filter(item => item.gold);
  tx.player.temporary_gold = Math.max(0, tx.player.temporary_gold + sources.reduce((sum, item) => sum + item.gold, 0) + (tx.player.turn_gold_adjustment ?? 0));
  delete tx.player.turn_gold_adjustment;
  tx.event('village_gold_counted', {player_id: tx.playerId, sources, total: tx.player.temporary_gold});
}
export function purchasableCards(tx: Transition): string[] {
  if (!(tx.player.purchases_remaining > 0 || tx.player.extra_basic_purchases) || !purchaseAllowed(tx)) return [];
  const available = new Set<string>(tx.state.supply_rules.basic_card_ids);
  for (const [zone, pile] of Object.entries(tx.state.zones) as [string, string[]][]) if (pile.length &&
    (zone.startsWith('village_supply:') || zone.startsWith('hero_supply:')))
    available.add(tx.state.instances[pile[0]].card_id);
  return [...available].sort().filter(id => (tx.player.purchases_remaining > 0 || id === 'TS-0001') &&
    price(tx, id) <= tx.player.temporary_gold);
}
export function buyCard(tx: Transition, cardId: string) {
  if (!purchasableCards(tx).includes(cardId)) throw new RuleError(`card is not purchasable now: ${cardId}`);
  const cost = price(tx, cardId), destination = `player:${tx.playerId}:discard`;
  let supplyZone: string | null = null, instanceId: string;
  if (tx.state.supply_rules.basic_card_ids.includes(cardId))
    instanceId = tx.createOwned(cardId, destination, 'basic_supply');
  else {
    supplyZone = Object.entries(tx.state.zones).find(([zone, pile]) => (pile as string[]).length &&
      (zone.startsWith('village_supply:') || zone.startsWith('hero_supply:')) &&
      tx.state.instances[(pile as string[])[0]].card_id === cardId)?.[0] ?? null;
    if (!supplyZone) throw new RuleError(`no supply for ${cardId}`);
    instanceId = tx.state.zones[supplyZone][0];
    tx.state.instances[instanceId].owner_player_id = tx.playerId;
    tx.move(instanceId, supplyZone, destination);
  }
  tx.player.temporary_gold -= cost;
  if (cardId === 'TS-0001' && tx.player.extra_basic_purchases) tx.player.extra_basic_purchases--;
  else tx.player.purchases_remaining--;
  const made = tx.state.turn_purchases ??= {};
  made[tx.playerId] = (made[tx.playerId] ?? 0) + 1;
  tx.event('card_bought', {player_id: tx.playerId, card_id: cardId, instance_id: instanceId,
    price: cost, gold_remaining: tx.player.temporary_gold});
  queueSteps(tx, [{op: 'event', event: 'CARD_PURCHASED', context: {
    source_instance_id: instanceId, supply_zone: supplyZone, price: cost}}]);
}
export function finishBuying(tx: Transition) {
  tx.state.subphase = tx.state.timing_window = 'VILLAGE_UPGRADE';
  tx.event('village_upgrade_started', {player_id: tx.playerId});
}
export function upgradeOptions(tx: Transition): Record<string, any>[] {
  const options: Record<string, any>[] = [];
  for (const sourceId of tx.zone('hand')) {
    const source = tx.card(sourceId);
    if (tx.state.instances[sourceId].flags.upgraded_on_turn === tx.state.turn_number) continue;
    const militia = source.card_id === 'TS-0001';
    if (!militia && source.card_type !== '英雄牌') continue;
    const cost = source.upgrade_xp_cost === '' ? -1 : Number(source.upgrade_xp_cost);
    if (cost < 0 || tx.player.xp < cost) continue;
    const level = stat(source, 'level');
    for (const [zone, pile] of Object.entries(tx.state.zones) as [string, string[]][]) if (zone.startsWith('hero_supply:'))
      for (const item of pile) {
        const target = tx.card(item);
        if (stat(target, 'level') !== level + 1 || !militia && target.subcategory !== source.subcategory) continue;
        const option = {source_instance_id: sourceId, target_card_id: target.card_id, xp_cost: cost};
        if (!options.some(row => row.source_instance_id === sourceId && row.target_card_id === target.card_id)) options.push(option);
      }
  }
  return options;
}
export function performHeroUpgrade(tx: Transition, sourceId: string, targetCardId: string, destination = 'discard'): Record<string, any>[] {
  if (!['discard', 'hand'].includes(destination)) throw new RuleError('invalid hero upgrade destination');
  const option = upgradeOptions(tx).find(row => row.source_instance_id === sourceId && row.target_card_id === targetCardId);
  if (!option) throw new RuleError('invalid hero upgrade or insufficient XP/supply');
  const sourceCardId = tx.card(sourceId).card_id;
  const targetZone = Object.entries(tx.state.zones).find(([zone, pile]) => zone.startsWith('hero_supply:') &&
    (pile as string[]).some(id => tx.state.instances[id].card_id === targetCardId))![0];
  const targetId = tx.state.zones[targetZone].find((id: string) => tx.state.instances[id].card_id === targetCardId);
  tx.destroyCard(sourceId, 'hero_upgrade');
  tx.state.instances[targetId].owner_player_id = tx.playerId;
  tx.move(targetId, targetZone, `player:${tx.playerId}:${destination}`);
  tx.state.instances[targetId].flags.upgraded_on_turn = tx.state.turn_number;
  tx.player.xp -= option.xp_cost;
  tx.event('hero_upgraded', {player_id: tx.playerId, source_instance_id: sourceId,
    source_card_id: sourceCardId, target_instance_id: targetId, target_card_id: targetCardId, xp_cost: option.xp_cost});
  return [{op: 'event', event: 'HERO_UPGRADED', context: {
    source_instance_id: targetId, old_instance_id: sourceId, supply_zone: targetZone}}];
}
export function upgradeHero(tx: Transition, sourceId: string, targetCardId: string) {
  queueSteps(tx, performHeroUpgrade(tx, sourceId, targetCardId));
}
export function restDestroy(tx: Transition, instanceId: string) {
  if (!tx.zone('hand').includes(instanceId)) throw new RuleError('rest can only destroy a card in the current hand');
  const card = tx.card(instanceId), destination = tx.destroyCard(instanceId, 'rest').destination;
  tx.event('rest_card_destroyed', {player_id: tx.playerId, instance_id: instanceId, card_id: card.card_id, destination});
  tx.finishTurn();
}
