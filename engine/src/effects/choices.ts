import {combatValues} from '../battle/combat.js';
import {matches, stat} from '../catalog/cards.js';
import {RuleError, type CardFilter} from '../types.js';
import {EffectEvaluation} from './evaluator.js';
import {evaluateCost} from './costs.js';
import type {Bindings, EvaluationInput, Query} from './dsl.js';

export interface EffectSelectChoice {
  kind: string;
  ability_id: string;
  source_instance_id: string;
  candidate_instance_ids: string[];
  min_count?: number;
  max_count?: number;
  query: Query;
  bindings: Bindings;
  constraints?: {filter: CardFilter; maximum: number}[];
  highest_by?: string|null;
}
export interface EffectSelectionInput {
  evaluation: EvaluationInput;
  choice: EffectSelectChoice|null;
  frame: {ability_id: string; source_instance_id: string}|null;
  source_card_id: string|null;
  selected_id: unknown;
}

function sourceMatches(evaluation: EffectEvaluation, source: string, cardId: string|null): boolean {
  return !!cardId && Object.hasOwn(evaluation.state.instances, source) &&
    (evaluation.card(source).card_id === cardId ||
     (evaluation.state.copied_heroes?.[source]?.card_ids ?? []).includes(cardId));
}

/** Revalidate a pending card choice against the current authoritative snapshot. */
export function validateEffectSelection(input: EffectSelectionInput): string[] {
  const choice = input.choice;
  if (!choice || choice.kind !== 'effect_select') throw new RuleError('no effect choice is pending');
  const selected = Array.isArray(input.selected_id) ? input.selected_id : [input.selected_id];
  if (selected.length < (choice.min_count ?? 1) || selected.length > (choice.max_count ?? 1) ||
      selected.some(item => typeof item !== 'string') || new Set(selected).size !== selected.length) {
    throw new RuleError('chosen cards do not satisfy choice count bounds');
  }
  const evaluation = new EffectEvaluation(input.evaluation);
  const candidates = evaluation.effectTargets(choice.query, choice.bindings);
  if (selected.some(item => !choice.candidate_instance_ids.includes(item) || !candidates.includes(item))) {
    throw new RuleError('chosen card is no longer a legal candidate');
  }
  for (const constraint of choice.constraints ?? []) {
    if (selected.filter(item => matches(evaluation.card(item), constraint.filter)).length > constraint.maximum) {
      throw new RuleError('chosen cards violate the selection constraints');
    }
  }
  if (choice.highest_by && selected.length > 0) {
    const values = new Map(candidates.map(item => [item, stat(evaluation.card(item), choice.highest_by!)]));
    if (choice.highest_by === 'strength' && evaluation.state.battle_context) {
      const targetId = evaluation.context.target_instance_id;
      const target = targetId && evaluation.state.instances[targetId] ? evaluation.card(targetId) : null;
      for (const [item, value] of Object.entries(combatValues(input.evaluation, 1, target).hero_strength)) {
        if (values.has(item)) values.set(item, value);
      }
    }
    const minimum = Math.min(...selected.map(item => values.get(item)!));
    if (candidates.some(item => !selected.includes(item) && values.get(item)! > minimum)) {
      throw new RuleError('chosen cards must keep the highest values');
    }
  }
  if (input.frame?.ability_id !== choice.ability_id ||
      input.frame?.source_instance_id !== choice.source_instance_id) {
    throw new RuleError('effect continuation does not match the choice');
  }
  const source = choice.source_instance_id;
  if (!sourceMatches(evaluation, source, input.source_card_id)) {
    throw new RuleError('ability continuation has an invalid source');
  }
  return selected as string[];
}

export interface EffectPurchaseChoice {
  kind: string;
  ability_id: string;
  source_instance_id: string;
  options: {card_id: string}[];
  payment: string;
  may_skip?: boolean;
  bindings: Bindings;
}
export interface EffectPurchaseInput {
  evaluation: EvaluationInput;
  choice: EffectPurchaseChoice|null;
  source_card_id: string|null;
  card_id: unknown;
}

/** Check a pending effect purchase before the transaction calculates and commits its price. */
export function validateEffectPurchase(input: EffectPurchaseInput): {payment_op: 'discard'|'destroy'|null} {
  const choice = input.choice;
  if (!choice || choice.kind !== 'effect_purchase') throw new RuleError('no effect purchase is pending');
  if (input.card_id === null && choice.may_skip === false) throw new RuleError('this effect requires gaining a card');
  if (input.card_id !== null && (typeof input.card_id !== 'string' ||
      !choice.options.some(option => option.card_id === input.card_id))) {
    throw new RuleError('invalid effect purchase card');
  }
  const evaluation = new EffectEvaluation(input.evaluation);
  if (!sourceMatches(evaluation, choice.source_instance_id, input.source_card_id)) {
    throw new RuleError('invalid effect purchase continuation');
  }
  if (input.card_id === null || ['none', 'gold'].includes(choice.payment)) return {payment_op: null};
  const op = choice.payment === 'discard_source' ? 'discard' : 'destroy';
  if (!evaluateCost({evaluation: input.evaluation,
    cost: {op, target: {var: 'source'}}, bindings: choice.bindings}).payable) {
    throw new RuleError('effect purchase payment is unavailable');
  }
  return {payment_op: op};
}
