import {RuleError} from '../types.js';
import {EffectEvaluation} from './evaluator.js';
import type {Bindings, EvaluationInput, Expression} from './dsl.js';

export type Cost = {op: 'spend_xp'; amount: Expression}|
  {op: 'discard'|'destroy'; target: {var: string}};
export interface CostInput {
  evaluation: EvaluationInput;
  cost: Cost;
  bindings: Bindings;
}
export interface CostResult {
  payable: boolean;
  subject_id: string;
  instance_id?: string;
  location?: string|null;
  amount?: number;
}

/** Check whether one effect cost can be paid from the current immutable zones. */
export function evaluateCost(input: CostInput): CostResult {
  const evaluation = new EffectEvaluation(input.evaluation);
  const subject = input.bindings._subject ?? evaluation.playerId;
  if (typeof subject !== 'string') throw new RuleError('invalid effect cost subject');
  if (input.cost.op === 'spend_xp') {
    const amount = evaluation.expression(input.cost.amount, input.bindings);
    const xp = evaluation.evaluationState.players[subject]?.xp;
    if (xp === undefined) throw new RuleError('invalid effect cost subject');
    return {payable: amount >= 0 && xp >= amount, subject_id: subject, amount};
  }
  const name = input.cost.target.var, instance = input.bindings[name];
  if (typeof instance !== 'string') throw new RuleError(`unbound card target: ${name}`);
  const zones = evaluation.evaluationState.zones;
  const location = Object.entries(zones).find(([, pile]) => pile.includes(instance))?.[0] ?? null;
  const owned = location === `player:${subject}:hand` || location === `player:${subject}:control` ||
    location?.startsWith(`player:${subject}:revealed_`);
  const supplyTop = location !== null &&
    (location.startsWith('village_supply:') || location.startsWith('hero_supply:')) &&
    zones[location][0] === instance;
  const payable = Boolean(owned || input.cost.op === 'destroy' &&
    (location === `player:${subject}:discard` || location === `player:${subject}:aside` || supplyTop));
  return {payable, subject_id: subject, instance_id: instance, location};
}
