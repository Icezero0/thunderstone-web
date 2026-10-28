import type {Transition} from '../turn/transaction.js';
import {Calculation} from '../effects/context.js';
import {combatValues, monsterHealth} from './combat.js';
import {equipmentCapacity, weaponBurden} from './equipment-values.js';
import {equipmentPairs} from '../effects/context.js';
import {isHero, isMonster, stat, tags} from '../catalog/cards.js';
import {StatusEvidence} from './status-evidence.js';
import {economySources} from '../effects/economy.js';
import {activeGlobalRules} from '../effects/durations.js';
import type {CardStatus} from './status-evidence.js';
import type {CalculationInput, CombatTrace} from '../types.js';
export type {CardStatus} from './status-evidence.js';
export {statStatus} from './status-evidence.js';

/** Public, player-wide effects. These are never modifiers on individual cards. */
export function publicEffectStatuses(tx: Transition): CardStatus[] {
  return activeGlobalRules(tx.evaluation().state, 'light').filter(rule => rule.scope === 'all').map(rule => {
    const source = rule.source_card_id ?? (rule.source_instance_id ? tx.state.instances[rule.source_instance_id]?.card_id : undefined);
    return {kind: rule.amount >= 0 ? 'buff' : 'debuff', ...(source ? {source_card_id: source} : {}),
      source_name: source ? tx.cards[source]?.name ?? '公共效果' : '公共效果',
      description: `所有玩家光照 ${rule.amount >= 0 ? '+' : ''}${rule.amount}。`};
  });
}

/** Presentation evidence, stored separately from numeric rule inputs. */
export function recordCardStatus(tx: Transition, instance: string, source: string | undefined, ability: string,
  kind: CardStatus['kind'], description: string): void {
  const sourceCard = source && tx.state.instances[source] ? tx.printedCard(source).card_id
    : tx.ruleset.abilities.find(item => item.id === ability)?.source_card_id;
  const status: CardStatus = {kind, ...(sourceCard ? {source_card_id: sourceCard} : {}),
    source_name: sourceCard ? tx.cards[sourceCard].name : '卡牌效果', description};
  const context = tx.state.battle_context;
  if (context) ((context.card_statuses ??= {})[instance] ??= []).push(status);
}
/** The browser draft and authoritative match use the same aura/status projection. */
export function continuousCardStatuses(input: CalculationInput, trace?: CombatTrace, collected?: StatusEvidence): Record<string, CardStatus[]> {
  const tx = new Calculation(input), evidence = collected ?? new StatusEvidence(input);
  const targetId = tx.context.target_instance_id;
  const target = targetId && tx.state.instances[targetId] ? tx.card(targetId) : null;
  const inBattle = !!tx.context.battle_team;
  // A local draft supplies its collector, so numerical rules are not evaluated twice.
  const calculation = inBattle ? collected && trace ? trace : combatValues(input, tx.context.target_rank ?? 0, target, evidence) : null;
  const pairs = calculation?.equipped_pairs ?? equipmentPairs(tx.context);
  for (const id of tx.hand()) {
    if (tx.context.zero_weapon_weight && tags(tx.card(id)).includes('武器')) evidence.text(id,
      tx.context.flag_sources?.zero_weapon_weight ?? '', '重量视为 0');
    if ((tx.context.convert_all_magic && !tags(tx.card(id)).includes('疾病'))
      || tx.context.convert_equipped_magic && pairs.flat().includes(id)) evidence.text(id,
        tx.context.flag_sources?.[tx.context.convert_all_magic ? 'convert_all_magic' : 'convert_equipped_magic'] ?? '', '攻击转化为魔法攻击');
    if (tx.context.cannot_defeat && calculation?.components.some(item => item.instance_id === id)) evidence.text(id,
      tx.context.flag_sources?.cannot_defeat ?? '', '本场战斗无法击败怪物', 'debuff');
  }
  for (const [source, rule] of tx.handRules()) {
    if (rule.op === 'extra_equipment') {
      const hero = isHero(tx.card(source)) ? source : pairs.find(([, weapon]) => weapon === source)?.[0];
      if (hero) evidence.text(hero, rule.source_card_id, `可装备武器：${equipmentCapacity(input, hero, pairs) >= 100 ? '不限张数' : `${equipmentCapacity(input, hero, pairs)} 张`}`);
    }
    if (rule.op === 'equipment_discount') {
      const hero = pairs.find(([, weapon]) => weapon === source)?.[0];
      if (hero && tags(tx.card(hero)).includes(rule.params.hero_tag ?? '')) evidence.text(source, rule.source_card_id,
        `装备所需力量：${weaponBurden(input, hero, source)}（减免 ${Math.min(stat(tx.card(source), 'weight'), rule.params.amount ?? 0)}）`);
    }
  }
  // Health and global hall effects apply to every visible dungeon, even before a target is selected.
  for (const [zone, pile] of Object.entries(tx.state.zones)) if (zone.startsWith('hall:')) for (const [index, id] of pile.entries()) {
    if (!id || !isMonster(tx.card(id))) continue;
    monsterHealth(input, tx.card(id), zone.endsWith(':rank0') ? 0 : index + 1, id, evidence);
  }
  for (const [source, rule] of tx.hallRules()) {
    if (rule.op === 'hall_aura') {
      if (rule.params.light) evidence.text(source, rule.source_card_id, `队伍光照 ${rule.params.light > 0 ? '+' : ''}${rule.params.light}`, rule.params.light > 0 ? 'buff' : 'debuff');
      if (rule.params.double_darkness) evidence.text(source, rule.source_card_id, '普通阶层的光照需求翻倍', 'debuff');
    }
    if (rule.op === 'hall_target_restriction') evidence.text(source, rule.source_card_id, `不能攻击其他${rule.params.protected_tag}怪物`, 'buff');
    if (['immovable', 'hall_movement_lock', 'dungeon_deck_lock'].includes(rule.op)) evidence.text(source, rule.source_card_id, rule.source_line, 'buff');
  }
  for (const [source, rule] of economySources(tx)) {
    if (source) evidence.text(source, rule.source_card_id, rule.params.monster_gold_zero ? '怪物卡的金币值视为 0'
      : rule.params.one_purchase ? '每回合至多购买 1 张牌'
      : rule.params.all_surcharge ? `所有牌购买价格 +${rule.params.all_surcharge}`
      : `英雄购买价格 ${((rule.params.hero_surcharge ?? 0) - (rule.params.hero_discount ?? 0)) >= 0 ? '+' : ''}${(rule.params.hero_surcharge ?? 0) - (rule.params.hero_discount ?? 0)}`,
      rule.params.hero_discount ? 'buff' : 'debuff');
    if (rule.params.monster_gold_zero) for (const id of tx.hand()) if (isMonster(tx.card(id)) && stat(tx.card(id), 'gold'))
      evidence.text(id, rule.source_card_id, '金币值视为 0', 'debuff');
  }
  for (const cardId of tx.state.active_settings) {
    const source = Object.entries(tx.state.instances).find(([, instance]) => instance.card_id === cardId)?.[0];
    if (source && ['TS-0193', 'TS-0194'].includes(cardId)) evidence.text(source, cardId,
      cardId === 'TS-0193' ? '普通阶层的光照需求为 1' : '所有阶层没有光照惩罚');
  }
  return evidence.result();
}

/** Internal read model. Backend must filter instance keys to the viewer's visible cards. */
export function cardStatuses(tx: Transition): Record<string, CardStatus[]> {
  const output: Record<string, CardStatus[]> = {}, context = tx.state.battle_context;
  for (const [id, instance] of Object.entries(tx.state.instances) as [string, any][]) {
    const flags = instance.flags ?? {}, marked = flags.pending_after_battle_destruction || flags.pending_turn_end_destruction;
    const records: CardStatus[] = (context?.card_statuses?.[id] ?? []).filter((item: CardStatus) => item.kind !== 'destroy' || marked);
    const statuses = records.map(item => ({...item}));
    if (marked && !statuses.some(item => item.kind === 'destroy')) statuses.push({kind: 'destroy', source_name: '摧毁标记',
      description: flags.pending_after_battle_destruction ? '本场战斗结束后摧毁，仍参与本场战斗结算' : '本回合结束时摧毁'});
    for (const buff of flags.turn_buffs ?? []) if (buff.expires_after_turn === tx.state.turn_number && buff.buff === 'discard_instead_of_destroy') {
      const source = tx.ruleset.abilities.find(ability => ability.id === buff.ability_id)?.source_card_id
        ?? tx.ruleset.mechanics.find(rule => rule.id === buff.ability_id)?.source_card_id;
      statuses.push({kind: 'buff', ...(source ? {source_card_id: source} : {}), source_name: source ? tx.cards[source].name : '保护效果',
        description: '本回合摧毁时改为弃牌'});
    }
    if (statuses.length) output[id] = statuses;
  }
  for (const [id, statuses] of Object.entries(continuousCardStatuses(tx.evaluation())))
    (output[id] ??= []).push(...statuses);
  return output;
}
