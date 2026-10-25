import {EffectEvaluation} from './evaluator.js';
import {sourceInstances} from './availability.js';
import type {Ability, Bindings, Condition, EffectNode, EvaluationInput} from './dsl.js';
import {RuleError} from '../types.js';
import {isMonster} from '../catalog/cards.js';

export interface RegisteredTrigger {
  event: string;
  ability_id: string;
  source_instance_id: string;
  body: EffectNode;
  bindings: Bindings;
  conditions: Condition[];
  once: boolean;
}
export interface ScheduledEffect {
  event: string;
  turn_number: number;
  player_id: string;
  ability_id: string;
  source_instance_id: string;
  body: EffectNode;
  bindings: Bindings;
}
export interface EventCandidate {
  ability_id: string;
  source_instance_id: string;
  body: EffectNode;
  bindings: Bindings;
  resolution_order?: 'player';
}
export interface EventDispatchInput {
  evaluation: EvaluationInput;
  abilities: Ability[];
  listeners: RegisteredTrigger[];
  scheduled: ScheduledEffect[];
  event: string;
  turn_number: number;
  repeatable_ability_ids: string[];
}
export interface EventDispatchPlan {
  mode: 'none'|'single'|'battle'|'sequence'|'choice';
  candidates: EventCandidate[];
  consumed_listener_indices: number[];
  consumed_scheduled_indices: number[];
}

function compareIds(a: EventCandidate, b: EventCandidate): number {
  for (const key of ['source_instance_id', 'ability_id'] as const) {
    if (a[key] < b[key]) return -1;
    if (a[key] > b[key]) return 1;
  }
  return 0;
}

/** Resolve event eligibility, scheduling and battle repetition without changing game state. */
export function planEventDispatch(input: EventDispatchInput): EventDispatchPlan {
  const evaluation = new EffectEvaluation(input.evaluation);
  const player = evaluation.playerId;
  const candidates: EventCandidate[] = [];
  const consumedListeners: number[] = [], consumedScheduled: number[] = [];
  input.listeners.forEach((listener, index) => {
    if (listener.event !== input.event ||
        !listener.conditions.every(condition => evaluation.condition(condition, listener.bindings))) return;
    candidates.push({ability_id: listener.ability_id, source_instance_id: listener.source_instance_id,
      body: listener.body, bindings: listener.bindings});
    if (listener.once) consumedListeners.push(index);
  });
  for (const ability of input.abilities) {
    if (ability.kind !== 'triggered' || ability.event !== input.event) continue;
    for (const source of sourceInstances(evaluation, ability)) {
      const bindings = {source, _subject: player};
      if (!ability.conditions.every(condition => evaluation.condition(condition, bindings))) continue;
      candidates.push({ability_id: ability.id, source_instance_id: source,
        body: ability.body, bindings, ...(ability.resolution_order ? {resolution_order: ability.resolution_order} : {})});
    }
  }
  input.scheduled.forEach((scheduled, index) => {
    const due = scheduled.event === input.event && scheduled.player_id === player &&
      (input.event === 'TURN_START' ? scheduled.turn_number <= input.turn_number :
        scheduled.turn_number === input.turn_number);
    if (!due) return;
    candidates.push({ability_id: scheduled.ability_id, source_instance_id: scheduled.source_instance_id,
      body: scheduled.body, bindings: scheduled.bindings});
    consumedScheduled.push(index);
  });
  if (candidates.length === 0) return {mode: 'none', candidates,
    consumed_listener_indices: consumedListeners,
    consumed_scheduled_indices: consumedScheduled};
  // A trap is revealed and completely resolved before the next card is drawn.
  // Its own printed lines form one ordered effect, not simultaneous choices.
  const trapSource = evaluation.evaluationState.event_context?.source_instance_id;
  if (input.event === 'TRAP_REVEALED' && candidates.length > 1 && candidates.every(item => item.source_instance_id === trapSource)) {
    candidates.sort(compareIds);
    return {mode: 'sequence', candidates, consumed_listener_indices: consumedListeners, consumed_scheduled_indices: consumedScheduled};
  }
  const positions = new Map<string, {rank: number; zone: string}>();
  for (const [zone, pile] of Object.entries(evaluation.state.zones)) if (zone.startsWith('hall:'))
    pile.forEach((id, index) => {if (id && isMonster(evaluation.card(id))) positions.set(id, {rank: zone.endsWith(':rank0') ? 0 : index + 1, zone});});
  candidates.sort((a, b) => {
    const left = positions.get(a.source_instance_id), right = positions.get(b.source_instance_id);
    if (left && right) return left.rank - right.rank || left.zone.localeCompare(right.zone) || compareIds(a, b);
    return left ? -1 : right ? 1 : compareIds(a, b);
  });
  if (input.event === 'BATTLE_BEFORE_OUTCOME') {
    const zones = evaluation.state.zones;
    const extra = evaluation.hallRules('repeat_battle').reduce((sum, [source, rule]) =>
      sum + (Object.entries(zones).some(([zone, pile]) =>
        zone.endsWith(':rank0') && pile.includes(source)) ? rule.params.extra ?? 0 : 0), 0);
    const groups = new Map<string, EventCandidate[]>();
    for (const candidate of candidates) {
      const group = groups.get(candidate.source_instance_id) ?? []; group.push(candidate); groups.set(candidate.source_instance_id, group);
    }
    candidates.length = 0;
    for (const group of groups.values()) {
      candidates.push(...group);
      for (let count = 0; count < extra; count++) candidates.push(...group.filter(candidate => input.repeatable_ability_ids.includes(candidate.ability_id)));
    }
  }
  return {mode: candidates.length > 1 ? candidates.some(candidate => candidate.resolution_order === 'player') ? 'choice'
    : input.event === 'BATTLE_BEFORE_OUTCOME' ? 'battle' : 'sequence' : 'single',
    candidates, consumed_listener_indices: consumedListeners,
    consumed_scheduled_indices: consumedScheduled};
}

export interface OrderedEventEffect extends EventCandidate {effect_id: string}

/** Revalidate a player's requested order against the exact pending effect set. */
export function resolveEventOrder(choice: {kind: string; effects: OrderedEventEffect[]}|null,
                                  effectIds: unknown): OrderedEventEffect[] {
  if (!choice || choice.kind !== 'effect_order') throw new RuleError('no effect order is pending');
  const effects = new Map(choice.effects.map(item => [item.effect_id, item]));
  if (!Array.isArray(effectIds) || effectIds.length !== effects.size ||
      effectIds.some(item => typeof item !== 'string') ||
      new Set(effectIds).size !== effects.size ||
      effectIds.some(item => !effects.has(item))) {
    throw new RuleError('effect order must contain every effect once');
  }
  return effectIds.map(id => effects.get(id)!);
}
