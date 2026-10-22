import {RuleError, type Card} from '../types.js';
import type {GroupCounts, GroupKind, RulesConfig} from './contracts.js';

export const RULESET_VERSION = 'classic-setup-v1';
export const GROUP_KINDS: readonly GroupKind[] = ['village','hero','monster'];
export const STARTER_CARDS: Readonly<Record<string, number>> = {'TS-0001': 6, 'TS-0002': 2, 'TS-0003': 2, 'TS-0004': 2};
export const SPECIAL_DISEASE_RANDOMIZERS = new Set(['TS-0034','TS-0035','TS-0148']);
export const MONSTER_MARKERS = new Set(['TS-0550','TS-0626']);
export const EXTRA_RANK_CARDS = new Set(['TS-0571','TS-0572','TS-0573','TS-0574','TS-0575']);
export interface EnvironmentRule {
  count_delta?: Partial<Record<GroupKind, number>>; count_override?: Partial<Record<GroupKind, number>>;
  thunderstone_target?: number;
}
export const ENVIRONMENT_SETUP_RULES: Readonly<Record<string, EnvironmentRule>> = {
  'TS-0191': {count_delta: {monster: 1}}, 'TS-0192': {count_delta: {village: 2, hero: -1}},
  'TS-0198': {count_override: {monster: 4}, thunderstone_target: 2}, 'TS-0199': {thunderstone_target: 7},
};
export function effectiveGroupCounts(counts: GroupCounts, environment?: string|null): Record<GroupKind, number> {
  const rule = ENVIRONMENT_SETUP_RULES[environment ?? ''] ?? {};
  return Object.fromEntries(GROUP_KINDS.map(kind => [kind, rule.count_override?.[kind] ?? (counts[`${kind}_groups`] + (rule.count_delta?.[kind] ?? 0))])) as Record<GroupKind, number>;
}
export function effectiveCopyCount(card: Card, config: RulesConfig): number {
  const count = Number(card.initial_copy_count);
  if (!Number.isSafeInteger(count)) throw new RuleError(`invalid initial_copy_count: ${card.card_id}`);
  const kind = card.card_type === '村庄牌' ? 'village' : card.card_type === '英雄牌' ? 'hero' : card.subcategory === '怪物' ? 'monster' : null;
  return count * (kind ? config.instance_multipliers[kind] : 1);
}
export const baseHallCapacity = (settings: string[]): number => settings.includes('TS-0188') ? 4 : 3;
export const hallCapacity = (cardIds: string[], settings: string[]): number => baseHallCapacity(settings) + cardIds.filter(id => EXTRA_RANK_CARDS.has(id)).length;
