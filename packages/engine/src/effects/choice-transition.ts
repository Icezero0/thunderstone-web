import {RuleError} from '../types.js';
import {EffectEvaluation} from './evaluator.js';
import {validateEffectSelection, validateEffectPurchase} from './choices.js';
import {validateReuseChoice, reusableAbilityIds} from './availability.js';
import {resolveEventOrder} from './events.js';
import {evaluateCost} from './costs.js';
import {buyEffectCard} from './purchase-transition.js';
import {upgradeOptions, performHeroUpgrade} from '../turn/village.js';
import {queueSteps} from '../turn/workflow.js';
import {runEffect, abilityFrames, atom, sourceMatches} from './execute.js';
import type {Transition} from '../turn/transaction.js';

const evalRule = (tx: Transition) => new EffectEvaluation(tx.evaluation());
export function dungeonZone(tx: Transition, bindings: Record<string, any>): string {
  const zones = Object.keys(tx.state.zones).filter(zone => zone.startsWith('dungeon:')).sort();
  if (zones.includes(bindings._dungeon)) return bindings._dungeon;
  if (zones.length === 1) return zones[0];
  throw new RuleError('choose a dungeon before targeting its deck');
}
export function valueOptions(tx: Transition, node: Record<string, any>, bindings: Record<string, any>): any[] {
  switch (node.kind) {
    case 'number': {
      const lower = evalRule(tx).expression(node.min ?? 0, bindings), upper = evalRule(tx).expression(node.max ?? 0, bindings);
      if (!(0 <= lower && lower <= upper && upper <= 100 && upper-lower <= 100)) throw new RuleError('invalid bounded number choice');
      return Array.from({length: upper-lower+1}, (_, i) => lower+i);
    }
    case 'player': return tx.state.player_order.filter((player: string) =>
      !tx.state.players[player].eliminated && ((node.scope ?? 'all') === 'all' || player !== tx.playerId));
    case 'dungeon': return Object.keys(tx.state.zones).filter(zone => zone.startsWith('dungeon:')).sort();
    default: return [...node.options];
  }
}
export function valueBindings(bindings: Record<string, any>, node: Record<string, any>, value: any) {
  return {...bindings, [node.bind]: value,
    ...(node.kind === 'player' && node.as_subject ? {_subject: value} : {}),
    ...(node.kind === 'dungeon' ? {_dungeon: value} : {})};
}
export function pause(tx: Transition, kind: string, node: Record<string, any>, bindings: Record<string, any>,
                      stack: Record<string, any>[], abilityId: string, sourceId: string, details: Record<string, any>) {
  const playerId = bindings._subject ?? tx.playerId;
  tx.state.pending_choice = {kind, player_id: playerId, ability_id: abilityId,
    source_instance_id: sourceId, node, bindings: structuredClone(bindings), ...details};
  tx.state.resolution_frames = [{ability_id: abilityId, source_instance_id: sourceId, stack: structuredClone(stack)}];
  tx.event('effect_choice_requested', {ability_id: abilityId, choice_kind: kind, player_id: playerId, ...details});
}
export function continuation(tx: Transition, choice: Record<string, any>): Record<string, any>[] {
  const frames = tx.state.resolution_frames, ability = tx.ruleset.abilities.find(item => item.id === choice.ability_id);
  if (frames.length !== 1 || frames[0].ability_id !== choice.ability_id ||
      frames[0].source_instance_id !== choice.source_instance_id || !ability ||
      !sourceMatches(tx, choice.source_instance_id, ability.source_card_id))
    throw new RuleError('invalid choice continuation source');
  return structuredClone(frames[0].stack);
}
export function resolveValue(tx: Transition, value: any): boolean {
  const choice = tx.state.pending_choice;
  if (choice?.kind !== 'effect_value') throw new RuleError('no value choice is pending');
  const options = valueOptions(tx, choice.node, choice.bindings);
  if (!options.some(option => typeof option === typeof value && option === value && choice.options.includes(option)))
    throw new RuleError('chosen value is not an offered option');
  const stack = continuation(tx, choice);
  let body = choice.node.then;
  if (choice.node.kind === 'player' && choice.node.as_subject) body = {op: '_respond_subject', body};
  stack.push({node: body, bindings: valueBindings(choice.bindings, choice.node, value)});
  tx.state.pending_choice = null; tx.state.resolution_frames = [];
  tx.event('effect_value_chosen', {ability_id: choice.ability_id, player_id: choice.player_id, value});
  return runEffect(tx, choice.ability_id, choice.source_instance_id, stack);
}
export function reorderCards(tx: Transition, node: Record<string, any>, bindings: Record<string, any>, ordered: string[]) {
  let destination: string;
  if (node.destination === 'dungeon_top') {
    destination = dungeonZone(tx, bindings);
    if (ordered.some(item => tx.state.instances[item].owner_player_id !== null)) throw new RuleError('owned cards cannot be reordered into a dungeon');
  } else {
    const player = bindings._subject ?? tx.playerId;
    destination = `player:${player}:draw`;
    if (ordered.some(item => tx.state.instances[item].owner_player_id !== player)) throw new RuleError('reordered cards belong to another player');
  }
  for (const item of ordered) tx.move(item, tx.location(item)!, destination);
  const pile = tx.state.zones[destination];
  tx.state.zones[destination] = [...ordered, ...pile.filter((item: string) => !ordered.includes(item))];
  tx.event('cards_reordered', {player_id: bindings._subject ?? tx.playerId, destination, instance_ids: ordered});
}
export function resolveReorder(tx: Transition, ordered: string[]): boolean {
  const choice = tx.state.pending_choice;
  if (choice?.kind !== 'effect_reorder') throw new RuleError('no card ordering choice is pending');
  const candidates = evalRule(tx).query(choice.node.query, choice.bindings);
  if (!Array.isArray(ordered) || ordered.some(item => typeof item !== 'string') ||
      ordered.length !== candidates.length || new Set(ordered).size !== ordered.length ||
      !ordered.every(item => candidates.includes(item) && choice.candidate_instance_ids.includes(item)))
    throw new RuleError('card order must contain every candidate exactly once');
  const stack = continuation(tx, choice);
  reorderCards(tx, choice.node, choice.bindings, ordered);
  tx.state.pending_choice = null; tx.state.resolution_frames = [];
  return runEffect(tx, choice.ability_id, choice.source_instance_id, stack);
}
export function resolveSelection(tx: Transition, selected: string|string[]): boolean {
  const choice = tx.state.pending_choice, frame = tx.state.resolution_frames[0];
  const ability = tx.ruleset.abilities.find(item => item.id === choice.ability_id);
  const ids = validateEffectSelection({evaluation: tx.evaluation(), choice, frame,
    source_card_id: ability?.source_card_id ?? null, selected_id: selected});
  const stack = structuredClone(frame.stack);
  stack.push({node: choice.then, bindings: {...choice.bindings, [choice.bind]: choice.multiple ? ids : ids[0]}});
  tx.state.pending_choice = null; tx.state.resolution_frames = [];
  tx.event('effect_choice_resolved', {ability_id: choice.ability_id, player_id: choice.player_id, selected_instance_id: selected});
  return runEffect(tx, choice.ability_id, choice.source_instance_id, stack);
}
export function resolvePurchase(tx: Transition, cardId: string|null): boolean {
  const choice = tx.state.pending_choice, frame = tx.state.resolution_frames[0];
  const ability = tx.ruleset.abilities.find(item => item.id === choice.ability_id);
  const payment = validateEffectPurchase({evaluation: tx.evaluation(), choice,
    source_card_id: ability?.source_card_id ?? null, card_id: cardId}).payment_op;
  const steps: Record<string, any>[] = [];
  if (cardId !== null) {
    steps.push(...buyEffectCard(tx, cardId, choice.filter, choice.destination, choice.ability_id, choice.maximum_cost));
    if (payment) atom(tx, {op: payment, target: {var: 'source'}}, choice.bindings, choice.ability_id);
  }
  tx.state.pending_choice = null; tx.state.resolution_frames = [];
  steps.push({op: 'effect_continuation', ability_id: choice.ability_id,
    source_instance_id: choice.source_instance_id, stack: structuredClone(frame.stack)});
  queueSteps(tx, steps, true);
  return tx.state.pending_choice === null;
}
export function resolveUpgrade(tx: Transition, sourceId: string|null, targetCardId: string|null): boolean {
  const choice = tx.state.pending_choice;
  if (choice?.kind !== 'effect_upgrade') throw new RuleError('no effect upgrade is pending');
  const stack = continuation(tx, choice), steps: Record<string, any>[] = [];
  if (sourceId !== null || targetCardId !== null) {
    if (!choice.options.some((option: any) => option.source_instance_id === sourceId && option.target_card_id === targetCardId &&
        upgradeOptions(tx).some(row => row.source_instance_id === sourceId && row.target_card_id === targetCardId)))
      throw new RuleError('invalid effect hero upgrade');
    if (choice.node.payment !== 'none') {
      if (!evaluateCost({evaluation: tx.evaluation(), cost: {op: 'discard', target: {var: 'source'}}, bindings: choice.bindings}).payable)
        throw new RuleError('effect upgrade payment is unavailable');
      if (sourceId === choice.source_instance_id) throw new RuleError('upgrade source cannot also pay the treasure cost');
    }
    steps.push(...performHeroUpgrade(tx, sourceId!, targetCardId!, choice.node.destination));
    if (choice.node.payment !== 'none') atom(tx, {op: 'discard', target: {var: 'source'}}, choice.bindings, choice.ability_id);
  }
  tx.state.pending_choice = null; tx.state.resolution_frames = [];
  steps.push({op: 'effect_continuation', ability_id: choice.ability_id,
    source_instance_id: choice.source_instance_id, stack});
  queueSteps(tx, steps, true);
  return tx.state.pending_choice === null;
}
export function resolveReuse(tx: Transition, selected: string): boolean {
  const choice = tx.state.pending_choice;
  validateReuseChoice({evaluation: tx.evaluation(), abilities: tx.ruleset.abilities,
    turn_number: tx.state.turn_number, ability_uses: tx.state.ability_uses}, choice, selected);
  const item = choice.reused_instance_id, stack = continuation(tx, choice);
  const ability = tx.ruleset.abilities.find(item => item.id === selected)!;
  tx.state.instances[item].flags.pending_turn_end_destruction = true;
  tx.state.ability_uses[`${item}:${selected}`] = tx.state.turn_number;
  tx.event('ability_activated', {ability_id: selected, source_instance_id: item, player_id: tx.playerId, reused: true});
  stack.push(...abilityFrames(selected, item, ability.body, {_subject: tx.playerId}));
  tx.state.pending_choice = null; tx.state.resolution_frames = [];
  return runEffect(tx, choice.ability_id, choice.source_instance_id, stack);
}
export function resolveOrder(tx: Transition, effectIds: string[]): boolean {
  const choice = tx.state.pending_choice, ordered = resolveEventOrder(choice, effectIds), stack: Record<string, any>[] = [];
  for (const item of [...ordered].reverse()) stack.push(...abilityFrames(item.ability_id, item.source_instance_id,
    item.body, item.bindings));
  tx.state.pending_choice = null; tx.state.resolution_frames = [];
  tx.event('effect_order_chosen', {event: choice.event, effect_ids: effectIds});
  return runEffect(tx, ordered[0].ability_id, ordered[0].source_instance_id, stack);
}
