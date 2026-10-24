import {RuleError} from '../types.js';
import {Calculation} from '../effects/context.js';
import {economyRules, printedGold, purchasePrice} from '../effects/economy.js';
import {isHero, stat, tags} from '../catalog/cards.js';
import {isSupplyZone, sameHeroSeries} from '../catalog/supplies.js';
import {queueSteps} from './workflow.js';
import type {Transition} from './transaction.js';

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
  const {sources, total} = villageGoldProduction(tx);
  tx.player.temporary_gold = total;
  delete tx.player.turn_gold_adjustment;
  tx.event('village_gold_counted', {player_id: tx.playerId, sources, total: tx.player.temporary_gold});
}
/** The immediate production result, without activating abilities, drawing or consuming adjustments. */
function villageGoldProduction(tx: Transition) {
  const input = tx.evaluation();
  const calculation = new Calculation({...input, state: {...tx.state, chosen_action: 'village',
    subphase: 'VILLAGE_BUY', timing_window: 'VILLAGE_BUY'}});
  const sources = tx.zone('hand').map(id => ({instance_id: id, gold: printedGold(calculation, tx.card(id))})).filter(item => item.gold);
  const total = Math.max(0, tx.player.temporary_gold + sources.reduce((sum, item) => sum + item.gold, 0)
    + (tx.player.turn_gold_adjustment ?? 0));
  return {sources, total};
}
export function goldIncomePreview(tx: Transition, playerId: string): number | null {
  if (tx.state.phase !== 'PLAYING' || playerId !== tx.playerId
    || !['TURN_START', 'VILLAGE_ABILITIES'].includes(tx.state.subphase)) return null;
  return villageGoldProduction(tx).total - tx.player.temporary_gold;
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
/** Quote the same effective prices charged by buyCard, including current effects. */
export function purchaseOptions(tx: Transition): {card_id: string; price: number}[] {
  return purchasableCards(tx).map(card_id => ({card_id, price: price(tx, card_id)}));
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
/** Run only after effects and continuations settle; never consume a pending choice or end the turn. */
export function advanceVillageStages(tx: Transition): void {
  if (tx.state.phase !== 'PLAYING' || tx.state.pending_choice !== null || tx.state.workflow_steps?.length) return;
  if (tx.state.subphase === 'VILLAGE_BUY' && (tx.state.turn_purchases?.[tx.playerId] ?? 0) > 0
    && !purchasableCards(tx).length) finishBuying(tx);
  if (tx.state.subphase === 'VILLAGE_UPGRADE' && !upgradeOptions(tx).length) tx.awaitTurnEnd();
}
export function upgradeOptions(tx: Transition): Record<string, any>[] {
  const options: Record<string, any>[] = [];
  for (const sourceId of tx.zone('hand')) {
    const source = tx.card(sourceId);
    if (tx.state.instances[sourceId].flags.upgraded_on_turn === tx.state.turn_number) continue;
    if (!isHero(source)) continue;
    const militia = tags(source).includes('民兵') && stat(source, 'level') === 0;
    const rawCost = source.upgrade_xp_cost;
    const cost = rawCost === undefined || rawCost.trim() === '' ? -1 : Number(rawCost);
    if (!Number.isSafeInteger(cost) || cost < 0 || tx.player.xp < cost) continue;
    const targetLevel = militia ? 1 : stat(source, 'level') + 1;
    for (const [zone, pile] of Object.entries(tx.state.zones) as [string, string[]][]) if (isSupplyZone(zone))
      for (const item of pile) {
        const target = tx.card(item);
        if (!isHero(target) || stat(target, 'level') !== targetLevel ||
            !militia && !sameHeroSeries(source, target, tx.setupIndex.groups ?? [])) continue;
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
  const targetZone = Object.entries(tx.state.zones).find(([zone, pile]) => isSupplyZone(zone) &&
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
  if (tx.player.rest_destroyed_on_turn === tx.state.turn_number) throw new RuleError('rest destruction has already been used this turn');
  if (!tx.zone('hand').includes(instanceId)) throw new RuleError('rest can only destroy a card in the current hand');
  tx.player.rest_destroyed_on_turn = tx.state.turn_number;
  const card = tx.card(instanceId), destination = tx.destroyCard(instanceId, 'rest').destination;
  tx.event('rest_card_destroyed', {player_id: tx.playerId, instance_id: instanceId, card_id: card.card_id, destination});
  tx.awaitTurnEnd();
}
