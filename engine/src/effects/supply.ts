import type {Card} from '../types.js';
import {RuleError} from '../types.js';
import {isHero} from '../catalog/cards.js';
import {heroGroup, orderedSupplyMembers, sameHeroSeries, supplyZone} from '../catalog/supplies.js';
import type {Transition} from '../turn/transaction.js';

export const settingRule = (tx: Transition, op: string) => tx.ruleset.mechanics.some(rule =>
  rule.op === op && tx.state.active_settings.includes(rule.source_card_id));
export function matchingSupply(tx: Transition, card: Card, family = false): string | undefined {
  return Object.entries(tx.state.zones).find(([zone, pile]) =>
    (zone.startsWith('village_supply:') || zone.startsWith('hero_supply:')) && (pile as string[]).length &&
    (pile as string[]).some(item => tx.card(item).card_id === card.card_id ||
      family && sameHeroSeries(card, tx.card(item), tx.setupIndex.groups ?? [])))?.[0];
}
export function returnDestroyedToSupply(tx: Transition, item: string, source: string, reason: string): Record<string, any> | null {
  const card = tx.printedCard(item);
  if (!settingRule(tx, 'return_destroyed_to_supply') || !['英雄牌', '村庄牌', '基础牌'].includes(card.card_type)) return null;
  tx.state.instances[item].owner_player_id = null;
  let destination: string;
  if (tx.state.supply_rules.basic_card_ids.includes(card.card_id)) destination = 'basic_supply';
  else {
    const group = heroGroup(card, tx.setupIndex.groups ?? []);
    destination = matchingSupply(tx, card, isHero(card)) ?? (group ? supplyZone(group, tx.cards, card.card_id) :
      (card.card_type === '英雄牌' ? `hero_supply:${tx.state.instances[item].origin}` : `village_supply:${card.card_id}`));
  }
  tx.state.zones[destination] ??= [];
  tx.move(item, source, destination);
  if (isHero(card)) tx.state.zones[destination].sort((a: string, b: string) =>
    Number(tx.card(a)['wiki_英雄等级'] || 0) - Number(tx.card(b)['wiki_英雄等级'] || 0));
  const details = {instance_id: item, card_id: card.card_id, source, destination};
  tx.event('destruction_returned_to_supply', {...details, reason});
  return details;
}
export function replenishEmptySupplies(tx: Transition) {
  if (!settingRule(tx, 'refill_empty_supply')) return;
  if (!tx.setupIndex) throw new RuleError('supply replenishment requires the injected catalog index');
  const used = tx.state.used_supply_randomizers ??= Object.fromEntries(['hero', 'village'].map(kind =>
    [kind, [...tx.state.selected_groups[kind]]]));
  for (const [zone, pile] of Object.entries(tx.state.zones) as [string, string[]][]) {
    if (pile.length || !(zone.startsWith('hero_supply:') || zone.startsWith('village_supply:'))) continue;
    const kind = zone.startsWith('hero_supply:') ? 'hero' : 'village';
    const available = tx.setupIndex.groups.filter((group: any) => group.kind === kind && !used[kind].includes(group.randomizer_id));
    if (!available.length) continue;
    const group = available[tx.rng.randbelow(available.length)];
    used[kind].push(group.randomizer_id);
    delete tx.state.zones[zone];
    const destination = supplyZone(group, tx.cards);
    tx.state.zones[destination] = [];
    const members = orderedSupplyMembers(group, tx.cards);
    for (const cardId of members) for (let i = 0; i < Number(tx.cards[cardId].initial_copy_count) * tx.state.frozen_config.instance_multipliers[kind]; i++) {
      const item = tx.createOwned(cardId, destination, group.randomizer_id, tx.playerId, false);
      tx.state.instances[item].owner_player_id = null;
    }
    tx.event('empty_supply_replenished', {exhausted_zone: zone, zone: destination,
      randomizer_id: group.randomizer_id, instance_ids: [...tx.state.zones[destination]]});
  }
}
export function destroyMatching(tx: Transition, instance: string, count: number, family: boolean, bottom: boolean, abilityId: string) {
  const card = tx.card(instance);
  if (tx.state.supply_rules.basic_card_ids.includes(card.card_id)) {
    tx.event('infinite_supply_destruction', {card_id: card.card_id, count, ability_id: abilityId}); return;
  }
  const zone = matchingSupply(tx, card, family);
  if (zone) for (const item of (bottom ? [...tx.state.zones[zone]].reverse() : [...tx.state.zones[zone]]).slice(0, count))
    tx.destroyCard(item, abilityId);
}
export function destroyPurchased(tx: Transition, abilityId: string) {
  const context = tx.state.event_context ?? {}, zone = context.supply_zone;
  if (zone && tx.state.zones[zone]?.length) tx.destroyCard(tx.state.zones[zone][0], abilityId);
  else if (tx.state.instances[context.source_instance_id]) {
    const cardId = tx.card(context.source_instance_id).card_id;
    if (tx.state.supply_rules.basic_card_ids.includes(cardId))
      tx.event('infinite_supply_destruction', {card_id: cardId, count: 1, ability_id: abilityId});
  }
}
