import {combatValues} from '../battle/combat.js';
import {RuleError} from '../types.js';
import {EffectEvaluation} from './evaluator.js';
import type {Bindings, EvaluationInput, Expression} from './dsl.js';

interface ModifierNode {
  target: {var: string};
  amount: Expression;
  stat?: string;
}
interface ModifierInput {
  evaluation: EvaluationInput;
  node: ModifierNode;
  bindings: Bindings;
  subphase?: string;
}
function target(input: ModifierInput): string {
  const value = input.bindings[input.node.target.var];
  if (typeof value !== 'string') throw new RuleError(`unbound card target: ${input.node.target.var}`);
  return value;
}

/** Compute one card-local combat modifier without mutating the battle context. */
export function planCardModifier(input: ModifierInput): {
  instance_id: string; field: string; amount: number; value: number; reconcile_equipment: boolean;
} {
  const evaluation = new EffectEvaluation(input.evaluation);
  const instance = target(input);
  const context = evaluation.state.battle_context;
  if (!evaluation.hand().includes(instance) || context === null) {
    throw new RuleError('card modifier needs an active hand card in a dungeon action');
  }
  let amount = evaluation.expression(input.node.amount, input.bindings);
  let field = input.node.stat!;
  if (field === 'attack' && amount < 0 && input.subphase === 'BATTLE_EFFECTS') {
    const trace = combatValues(input.evaluation, context.target_rank ?? 1);
    const component = trace.components.find(item => item.instance_id === instance);
    if ((component?.attack ?? 0) <= 0) {
      if ((component?.magic_attack ?? 0) > 0) field = 'magic_attack';
      else amount = 0;
    }
  }
  return {instance_id: instance, field, amount,
    value: (context.card_modifiers?.[instance]?.[field as 'attack'|'magic_attack'|'light'|'strength'] ?? 0) + amount,
    reconcile_equipment: input.node.stat === 'strength'};
}

/** Compute one monster health patch before Python commits it to the encounter. */
export function planMonsterHealthModifier(input: ModifierInput): {instance_id: string; value: number} {
  const evaluation = new EffectEvaluation(input.evaluation);
  const instance = target(input);
  const context = evaluation.state.battle_context;
  if (context === null) throw new RuleError('monster health modifier needs a dungeon battle');
  return {instance_id: instance,
    value: (context.monster_health_modifiers?.[instance] ?? 0) +
      evaluation.expression(input.node.amount, input.bindings)};
}
