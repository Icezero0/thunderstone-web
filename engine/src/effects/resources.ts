import {RuleError, type BattleContext} from '../types.js';

export type ResourceOp = 'gain_xp'|'spend_xp'|'lose_xp'|'mod_gold'|'grant_buy'|
  'mod_attack'|'mod_magic_attack'|'mod_light';
export interface ResourceEffectInput {
  op: ResourceOp;
  amount: number;
  subject_id: string;
  active_player_id: string;
  subject_xp: number;
  active_gold: number;
  active_purchases: number;
  chosen_action: string|null;
  battle_context: BattleContext|null;
  source_instance_id: string|null;
}
export type ResourceEffectResult =
  {player_id: string; field: 'xp'|'temporary_gold'|'purchases_remaining'; value: number}|
  {battle_context: BattleContext};

/** Pure resource atom. The caller commits this patch and emits the rule event. */
export function applyResourceEffect(input: ResourceEffectInput): ResourceEffectResult {
  const {op, amount} = input;
  if (!Number.isSafeInteger(amount)) throw new RuleError('resource amount must be an exact integer');
  if (op === 'gain_xp') {
    if (amount < 0) throw new RuleError('gain_xp needs nonnegative amount');
    return {player_id: input.subject_id, field: 'xp', value: input.subject_xp + amount};
  }
  if (op === 'spend_xp') {
    if (amount < 0 || input.subject_xp < amount) throw new RuleError('insufficient XP for effect');
    return {player_id: input.subject_id, field: 'xp', value: input.subject_xp - amount};
  }
  if (op === 'lose_xp') {
    if (amount < 0) throw new RuleError('lose_xp needs nonnegative amount');
    return {player_id: input.subject_id, field: 'xp', value: Math.max(0, input.subject_xp - amount)};
  }
  if (op === 'mod_gold') {
    if (input.chosen_action !== 'village') throw new RuleError('gold modification requires village action');
    return {player_id: input.active_player_id, field: 'temporary_gold',
      value: Math.max(0, input.active_gold + amount)};
  }
  if (op === 'grant_buy') {
    if (input.chosen_action !== 'village' || amount < 0 || input.active_purchases + amount > 100) {
      throw new RuleError('invalid additional village purchase');
    }
    return {player_id: input.active_player_id, field: 'purchases_remaining',
      value: input.active_purchases + amount};
  }
  const fields = {mod_attack: 'attack', mod_magic_attack: 'magic_attack', mod_light: 'light'} as const;
  if (!Object.hasOwn(fields, op)) throw new RuleError(`unsupported resource effect: ${op}`);
  if (input.chosen_action !== 'dungeon' || input.battle_context === null) {
    throw new RuleError('battle modifier requires dungeon preparation');
  }
  const field = fields[op as keyof typeof fields], context = input.battle_context;
  return {battle_context: {...context,
    modifiers: {...context.modifiers, [field]: (context.modifiers?.[field] ?? 0) + amount},
    modifier_sources: [...(context.modifier_sources ?? []),
      {source_instance_id: input.source_instance_id, field, amount}]}};
}
